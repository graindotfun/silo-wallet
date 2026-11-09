import {PublicKey} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID,unpackMint,unpackAccount,getTransferFeeConfig,getTransferFeeAmount,getExtensionTypes,ExtensionType} from '@solana/spl-token';
import {LAUNCHPAD_PROGRAM,getPdaLaunchpadAuth} from '@raydium-io/raydium-sdk-v2';
import {REWARDS_POLICY} from './rewards-policy.mjs';

export function inspectRewardMint(mint,account,collector) {
  if (!account?.owner.equals(TOKEN_2022_PROGRAM_ID)) throw Error('A Token-2022 rewards mint is required.');
  const token=unpackMint(mint,account,TOKEN_2022_PROGRAM_ID),fee=getTransferFeeConfig(token);
  if(getExtensionTypes(token.tlvData).some(t=>![ExtensionType.TransferFeeConfig,ExtensionType.MetadataPointer,ExtensionType.TokenMetadata].includes(t)))throw Error('Unsupported rewards mint extension.');
  if (!fee || !fee.withdrawWithheldAuthority.equals(collector)) throw Error('Rewards collector authority mismatch.');
  if(![PublicKey.default,getPdaLaunchpadAuth(LAUNCHPAD_PROGRAM).publicKey,collector].some(authority=>fee.transferFeeConfigAuthority.equals(authority)))throw Error('Rewards tax authority must be revoked, LaunchLab-controlled or the pinned Grainpad collector.');
  if(fee.olderTransferFee.transferFeeBasisPoints!==fee.newerTransferFee.transferFeeBasisPoints||fee.olderTransferFee.maximumFee!==fee.newerTransferFee.maximumFee)throw Error('Scheduled transfer-tax changes require a new review.');
  if (token.decimals!==6 || token.mintAuthority || token.freezeAuthority) throw Error('Rewards mint authority or decimals mismatch.');
  if (![fee.olderTransferFee,fee.newerTransferFee].every(f=>REWARDS_POLICY.transferFeeBps.includes(f.transferFeeBasisPoints))) throw Error('Unsupported current or scheduled transfer tax.');
  return {token,fee};
}

export class RewardSnapshotContendedError extends Error{constructor(attempts){super(`The mint's withheld tax or supply changed during the holder scan (${attempts} attempts). No snapshot was taken; retry later.`);this.name='RewardSnapshotContendedError';this.code='snapshot-contended';}}
/**
 * Fail closed when live movement makes a complete supply reconciliation impossible.
 * Harvesting withheld tax to the mint is permissionless, so a harvest between the account scan
 * and the mint read would count the same tax twice. The mint is therefore read before and after
 * the scan. Mint-withheld only decreases through the collector's own withdrawal, which the
 * operator never runs during a snapshot, and supply can only fall (mint authority revoked). So
 * equal reads prove neither changed while the scan was taken. Anything else is retried, then
 * refused: no snapshot is produced and nothing is allocated, so a contended read can delay a
 * round but never overpay one.
 */
export async function readRewardSnapshot(connection,{mint,collector,excludedOwners=[],attempts=3}) {
  if(!Number.isSafeInteger(attempts)||attempts<1||attempts>10)throw Error('Snapshot attempts must be 1-10.');
  for(let attempt=1;;attempt++){
    const snapshot=await readRewardSnapshotOnce(connection,{mint,collector,excludedOwners});
    if(snapshot)return snapshot;
    if(attempt>=attempts)throw new RewardSnapshotContendedError(attempts);
  }
}
async function readRewardSnapshotOnce(connection,{mint,collector,excludedOwners}) {
  const before=await connection.getAccountInfoAndContext(mint,{commitment:'finalized'});
  const initial=inspectRewardMint(mint,before.value,collector);
  const scan=await connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID,{commitment:'finalized',withContext:true,
    // A validated TransferFeeConfig mint requires extended token accounts with AccountType.Account (2).
    // Base58 '3' encodes that byte. Do not constrain dataSize: account extensions vary.
    minContextSlot:before.context.slot,filters:[{memcmp:{offset:0,bytes:String(mint)}},{memcmp:{offset:165,bytes:'3'}}]});
  if (!scan?.context || !Array.isArray(scan.value)) throw Error('A complete contextual token-account scan is required.');
  const after=await connection.getAccountInfoAndContext(mint,{commitment:'finalized',minContextSlot:scan.context.slot});
  const {token,fee}=inspectRewardMint(mint,after.value,collector);
  if(initial.fee.withheldAmount!==fee.withheldAmount||initial.token.supply!==token.supply)return null;
  let accounted=fee.withheldAmount,withheldTotal=fee.withheldAmount;
  const seen=new Set(),holders=[],harvestAccounts=[];
  const excluded=new Set([String(collector),'1nc1nerator11111111111111111111111111111111',...excludedOwners]);
  for (const {pubkey,account} of scan.value) {
    if (seen.has(String(pubkey))) throw Error('Duplicate account in holder scan.');
    seen.add(String(pubkey));
    const a=unpackAccount(pubkey,account,TOKEN_2022_PROGRAM_ID);
    if (!a.mint.equals(mint) || !a.isInitialized) throw Error('Invalid holder token account.');
    const withheld=getTransferFeeAmount(a)?.withheldAmount||0n;
    accounted+=a.amount+withheld;withheldTotal+=withheld;
    if (withheld>0n) harvestAccounts.push(String(pubkey));
    if (!PublicKey.isOnCurve(a.owner.toBytes())) excluded.add(String(a.owner));
    holders.push({owner:String(a.owner),amountRaw:String(a.amount)});
  }
  if (accounted!==token.supply) throw Error('Holder scan does not reconcile to total supply; retry a fresh finalized snapshot.');
  return {mint:String(mint),slot:scan.context.slot,mintReadSlot:after.context.slot,commitment:'finalized',
    supplyRaw:String(token.supply),accountedSupplyRaw:String(accounted),withheldTotalRaw:String(withheldTotal),holders,harvestAccounts,
    excludedOwners:[...excluded].sort(),
    exclusionPolicy:'Collector, incinerator, explicitly listed owners, and program-owned wallets (including pool vaults) are excluded. Custodial/program positions do not receive direct payouts.'};
}
