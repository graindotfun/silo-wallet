import './browser-buffer.mjs';
import {Buffer} from 'buffer';
import {PublicKey} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,unpackMint,ExtensionType,getExtensionTypes,getAccountTypeOfMintType,getAccountLen} from '@solana/spl-token';
import * as sdk from '@raydium-io/raydium-sdk-v2';
import {QUOTES} from './quote-assets.mjs';
import {inspectRewardMint} from './rewards-snapshot.mjs';
import {baseTokenProgram} from './transfer-tax.mjs';
import {CPMM_CONFIG} from './launch-instructions.mjs';

/** Reads only a caller-pinned Grainpad rewards platform, never an arbitrary mint route. */
export async function readRewardMarket(connection,{mint,platformId,collector}) {
  const quote=QUOTES.wXMR,quoteMint=new PublicKey(quote.mint);
  const poolId=sdk.getPdaLaunchpadPoolId(sdk.LAUNCHPAD_PROGRAM,mint,quoteMint).publicKey;
  const [account,mintAccount,quoteAccount]=await connection.getMultipleAccountsInfo([poolId,mint,quoteMint],'finalized');
  if(!account?.owner.equals(sdk.LAUNCHPAD_PROGRAM))throw Error('Verified rewards launch pool unavailable.');
  const pool=sdk.LaunchpadPool.decode(account.data);
  if(!pool.mintA.equals(mint)||!pool.mintB.equals(quoteMint)||!pool.platformId.equals(platformId)||String(pool.configId)!==quote.config||pool.mintProgramFlag!==1||pool.mintDecimalsA!==6||pool.mintDecimalsB!==12)throw Error('Rewards pool identity mismatch.');
  const {token,fee}=inspectRewardMint(mint,mintAccount,collector);
  if(!quoteAccount?.owner.equals(TOKEN_PROGRAM_ID)||unpackMint(quoteMint,quoteAccount).decimals!==12)throw Error('wXMR quote configuration changed.');
  const [ca,pa]=await connection.getMultipleAccountsInfo([pool.configId,platformId],'finalized');
  if(!ca?.owner.equals(sdk.LAUNCHPAD_PROGRAM)||!pa?.owner.equals(sdk.LAUNCHPAD_PROGRAM))throw Error('Invalid rewards market configuration.');
  const config=sdk.LaunchpadConfig.decode(ca.data),platform=sdk.PlatformConfig.decode(pa.data);
  if(!config.mintB.equals(quoteMint)||config.curveType!==0||String(platform.cpConfigId)!==CPMM_CONFIG||!platform.transferFeeExtensionAuth.equals(collector))throw Error('Rewards configuration changed.');
  const epoch=(await connection.getEpochInfo('finalized')).epoch;
  const baseAccountSize=getAccountLen([...new Set([ExtensionType.ImmutableOwner,...getExtensionTypes(token.tlvData).map(getAccountTypeOfMintType).filter(t=>t!==ExtensionType.Uninitialized)])]);
  const common={pool,poolId,platform,config,quote,transferFeeConfig:fee,epoch,baseAccountSize};
  if(pool.status===0)return {...common,route:'curve',cpData:undefined};
  if(pool.status===1)return {...common,route:'graduating',cpData:undefined};
  if(pool.status!==2)throw Error('Unsupported rewards market state.');
  const pair=[mint,quoteMint].sort((a,b)=>Buffer.compare(a.toBuffer(),b.toBuffer()));
  const id=sdk.getCpmmPdaPoolId(sdk.CREATE_CPMM_POOL_PROGRAM,platform.cpConfigId,...pair).publicKey;
  const cp=await connection.getAccountInfo(id,'finalized');
  if(!cp?.owner.equals(sdk.CREATE_CPMM_POOL_PROGRAM))throw Error('Graduated rewards pool is not ready.');
  const raydium=await sdk.Raydium.load({connection,owner:collector,disableFeatureCheck:true,disableLoadToken:true});
  const cpData=await raydium.cpmm.getRpcPoolInfo(String(id),true);
  if(!cpData.configId.equals(platform.cpConfigId)||!cpData.mintA.equals(pair[0])||!cpData.mintB.equals(pair[1]))throw Error('Graduated rewards pool mismatch.');
  const baseIsA=cpData.mintA.equals(mint);
  if(!(baseIsA?cpData.mintProgramA:cpData.mintProgramB).equals(baseTokenProgram(pool))||!(baseIsA?cpData.mintProgramB:cpData.mintProgramA).equals(TOKEN_PROGRAM_ID))throw Error('Graduated rewards token programs mismatch.');
  return {...common,route:'cpmm',poolId:id,cpData};
}
