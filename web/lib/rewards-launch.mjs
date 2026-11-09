/** Candidate instructions only. No wallet, keys, network, signing or submission. */
import {Buffer} from 'buffer';
import {PublicKey} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID} from '@solana/spl-token';
import * as sdk from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import {QUOTES} from './quote-assets.mjs';
import {REWARDS_POLICY,isLaunchTaxBps} from './rewards-policy.mjs';
import {CPMM_CONFIG} from './launch-instructions.mjs';
import {decodeAllowConfig} from './launch-rules.mjs';
import {POLICY} from './platform-policy.mjs';

const b = x => new BN(String(x));
const supply = '1000000000000000';
export function rewardsRuleConstraints() {
  return [[0,0,0],[1,0,1],[2,0,0],[3,0,supply],[4,0,'793100000000000'],
    [5,0,QUOTES.wXMR.floor],[6,0,0],[7,0,0],[8,0,0],
    [9,0,1],[10,0,1],[11,1,REWARDS_POLICY.minimumTaxBps],[11,2,REWARDS_POLICY.maximumTaxBps],[12,0,supply],[16,1,206900]]
    .map(([field,op,value]) => ({field,op,value:b(value)}));
}

export function rewardsAddresses(platform) {
  const config = new PublicKey(QUOTES.wXMR.config);
  return {config,
    allow: sdk.getPdaPlatformAllowConfig(sdk.LAUNCHPAD_PROGRAM,platform,config).publicKey,
    rule: sdk.getPdaPlatformCurveRule(sdk.LAUNCHPAD_PROGRAM,platform,config).publicKey};
}

/** Unsigned proposal. A distinct admin derives a distinct platform; an existing admin cannot create it again. */
export function buildRewardsPlatformProposal({admin,collector,platformFeeRate,creatorFeeRate=2500}) {
  if (!PublicKey.isOnCurve(admin.toBytes()) || !PublicKey.isOnCurve(collector.toBytes())) throw Error('Explicit administrator and collector wallets are required.');
  if (!Number.isInteger(platformFeeRate) || platformFeeRate < 0 || platformFeeRate > 10000) throw Error('An explicit reviewed platform fee (0–1%) is required.');
  if (!Number.isInteger(creatorFeeRate) || creatorFeeRate < 0 || creatorFeeRate > 10000) throw Error('Invalid creator fee.');
  const platform = sdk.getPdaPlatformId(sdk.LAUNCHPAD_PROGRAM,admin).publicKey;
  const a = rewardsAddresses(platform);
  const create = sdk.createPlatformConfig(sdk.LAUNCHPAD_PROGRAM,admin,admin,admin,admin,platform,
    new PublicKey(CPMM_CONFIG),collector,{platformScale:b(1000000),creatorScale:b(0),burnScale:b(0)},
    b(platformFeeRate),b(creatorFeeRate),'Grainpad rewards','https://grainpad.fun','',b(0));
  const rules = [sdk.createPlatformAllowConfigIns(sdk.LAUNCHPAD_PROGRAM,admin,platform,a.config,a.allow),
    sdk.createPlatformCurveRuleIns(sdk.LAUNCHPAD_PROGRAM,admin,platform,a.config,a.rule),
    sdk.updatePlatformCurveRuleIns(sdk.LAUNCHPAD_PROGRAM,admin,platform,a.config,a.rule,0,rewardsRuleConstraints())];
  const restrictions = ['updateRestrictGlobalConfig','updateRestrictCurveParam'].map(type => sdk.updatePlatformConfig(sdk.LAUNCHPAD_PROGRAM,admin,platform,{type,value:b(1)}));
  return {platform,collector,create,restrictions,rules,
    activationNotice:'Requires separate reviewed platform setup. Existing untaxed launch rules are incompatible.'};
}

export function buildRewardsLaunch({owner,payer=owner,mint,platform,name,symbol,uri,taxBps,quoteMint=QUOTES.wXMR.mint}) {
  if (!isLaunchTaxBps(taxBps)) throw Error('Choose a transfer tax from 1.0% to 3.0% in 0.1% steps.');
  if (String(quoteMint) !== QUOTES.wXMR.mint) throw Error('Rewards launches must use wXMR.');
  if (!name || Buffer.byteLength(name)>32 || !symbol || Buffer.byteLength(symbol)>10 || !/^(https:\/\/|ipfs:\/\/)/.test(uri) || Buffer.byteLength(uri)>200) throw Error('Invalid token metadata.');
  const a = rewardsAddresses(platform), quote = new PublicKey(quoteMint);
  const pool = sdk.getPdaLaunchpadPoolId(sdk.LAUNCHPAD_PROGRAM,mint,quote).publicKey;
  const instruction = sdk.initializeWithToken2022(sdk.LAUNCHPAD_PROGRAM,payer,owner,a.config,platform,
    sdk.getPdaLaunchpadAuth(sdk.LAUNCHPAD_PROGRAM).publicKey,pool,mint,quote,
    sdk.getPdaLaunchpadVaultId(sdk.LAUNCHPAD_PROGRAM,pool,mint).publicKey,
    sdk.getPdaLaunchpadVaultId(sdk.LAUNCHPAD_PROGRAM,pool,quote).publicKey,TOKEN_PROGRAM_ID,
    6,name,symbol,uri,{type:'ConstantCurve',totalSellA:b('793100000000000'),migrateType:'cpmm',supply:b(supply),totalFundRaisingB:b(QUOTES.wXMR.floor)},
    b(0),b(0),b(0),sdk.CpmmCreatorFeeOn.OnlyTokenB,
    {transferFeeBasePoints:taxBps,maxinumFee:b(supply)},a.allow,a.rule);
  return {instruction,instructions:[instruction],pool,quoteMint:String(quote),taxBps};
}

/** Preserve existing fees/LP destinations while preparing a separately reviewed tax-policy change.
 * Execute closure first, configure while closed, and activate only after the operator is ready.
 * No transaction is signed, sent or implicitly authorized by this builder.
 */
export function buildRewardsReconfiguration({admin,collector,platformAccount,wxmrAllowAccount,wxmrRuleAccount,solAllowAccount}) {
  if(!PublicKey.isOnCurve(admin.toBytes())||!PublicKey.isOnCurve(collector.toBytes()))throw Error('Explicit admin and collector wallets required.');
  if(!platformAccount?.owner.equals(sdk.LAUNCHPAD_PROGRAM))throw Error('Existing LaunchLab platform account required.');
  const platform=sdk.getPdaPlatformId(sdk.LAUNCHPAD_PROGRAM,admin).publicKey,p=sdk.PlatformConfig.decode(platformAccount.data),a=rewardsAddresses(platform);
  if(p.restrictGlobalConfig!==1||p.restrictCurveParam!==1)throw Error('Existing platform must already enforce restricted configurations and curves.');
  const solConfig=new PublicKey(QUOTES.SOL.config),solAllow=sdk.getPdaPlatformAllowConfig(sdk.LAUNCHPAD_PROGRAM,platform,solConfig).publicKey;
  const closeInstructions=[];
  for(const [account,config,address] of [[solAllowAccount,solConfig,solAllow],[wxmrAllowAccount,a.config,a.allow]]){
    if(!account)continue;
    if(!account.owner.equals(sdk.LAUNCHPAD_PROGRAM))throw Error('Unexpected allowlist owner.');
    const decoded=decodeAllowConfig(account.data);
    if(!decoded.platformId.equals(platform)||!decoded.configId.equals(config))throw Error('Allowlist identity mismatch.');
    closeInstructions.push(sdk.closePlatformAllowConfigIns(sdk.LAUNCHPAD_PROGRAM,admin,platform,config,address));
  }
  // `configure` also sets the approved Grainpad curve fee (0.75%); the creator fee must already be the approved 0.25%.
  if(p.creatorFeeRate.toString()!==String(POLICY.creatorRate))throw Error('Existing creator fee differs from the approved launch economics.');
  const decodeText=value=>Buffer.from(value).toString('utf8').replace(/\0+$/,'');
  const configurationInstructions=[sdk.updatePlatformConfig(sdk.LAUNCHPAD_PROGRAM,admin,platform,{type:'updateAll',value:{
    platformClaimFeeWallet:p.platformClaimFeeWallet,platformLockNftWallet:p.platformLockNftWallet,platformVestingWallet:p.platformVestingWallet,
    cpConfigId:p.cpConfigId,migrateCpLockNftScale:{platformScale:p.platformScale,creatorScale:p.creatorScale,burnScale:p.burnScale},feeRate:new BN(POLICY.platformRate),
    creatorFeeRate:p.creatorFeeRate,name:decodeText(p.name),web:decodeText(p.web),img:decodeText(p.img),transferFeeExtensionAuth:collector,platformVestingScale:p.platformVestingScale}})];
  if(wxmrRuleAccount){
    if(!wxmrRuleAccount.owner.equals(sdk.LAUNCHPAD_PROGRAM))throw Error('Unexpected rewards rule owner.');
    const rule=sdk.PlatformCurveRule.decode(wxmrRuleAccount.data);
    if(!rule.platformId.equals(platform)||!rule.configId.equals(a.config))throw Error('Rule identity mismatch.');
    for(const group of rule.groups)configurationInstructions.push(sdk.removePlatformCurveRuleIns(sdk.LAUNCHPAD_PROGRAM,admin,platform,a.config,a.rule,group.groupId));
  }else configurationInstructions.push(sdk.createPlatformCurveRuleIns(sdk.LAUNCHPAD_PROGRAM,admin,platform,a.config,a.rule));
  configurationInstructions.push(sdk.updatePlatformCurveRuleIns(sdk.LAUNCHPAD_PROGRAM,admin,platform,a.config,a.rule,0,rewardsRuleConstraints()));
  return {platform,collector,closeInstructions,configurationInstructions,
    activationInstructions:[sdk.createPlatformAllowConfigIns(sdk.LAUNCHPAD_PROGRAM,admin,platform,a.config,a.allow)],
    notice:'Review and finalize closure before configuration. Activation is a separate owner decision after rewards readiness. Existing SPL mints are not upgraded.'};
}
