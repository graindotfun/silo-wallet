/** Pure transaction instructions. No keys, RPC, signatures or submissions. */
import {PublicKey} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID} from '@solana/spl-token';
import BN from 'bn.js';
import * as s from '@raydium-io/raydium-sdk-v2';
import {FEE_POLICY} from './fee-policy.mjs';
import {quoteAsset} from './quote-assets.mjs';
import {launchRuleInstructions,ruleAddresses} from './launch-rules.mjs';
export const CPMM_CONFIG='CRRS5ieQmBrZjWhcj99JuGrT5tyuWDaGAXLXLFjbAtjQ';
const b=x=>new BN(String(x)),zero=b(0);
export function buildPlatformInstructions(owner,platform){return [s.createPlatformConfig(s.LAUNCHPAD_PROGRAM,owner,owner,owner,owner,platform,new PublicKey(CPMM_CONFIG),PublicKey.default,{platformScale:b(1000000),creatorScale:zero,burnScale:zero},b(FEE_POLICY.curve.platform),b(FEE_POLICY.curve.creator),'Grainpad','https://grainpad.fun','',zero),...launchRuleInstructions(owner,platform)];}
/** Restrictions are committed with creation; both allowlists remain absent until 1b. */
export function buildGuardedPlatformInstructions(owner,platform,step){
 const all=buildPlatformInstructions(owner,platform);
 if(step==='1a')return [all[0],...all.slice(-2)];
 if(step==='1b')return all.slice(1,-2);
 throw Error('Unknown platform setup step.');
}
export function buildLaunchInstruction({owner,mint,platform,symbol='SOL',name,tokenSymbol,uri}){
 const q=quoteAsset(symbol),quote=new PublicKey(q.mint),a=ruleAddresses(platform,symbol),pool=s.getPdaLaunchpadPoolId(s.LAUNCHPAD_PROGRAM,mint,quote).publicKey;
 const instruction=s.initializeV2(s.LAUNCHPAD_PROGRAM,owner,owner,a.config,platform,s.getPdaLaunchpadAuth(s.LAUNCHPAD_PROGRAM).publicKey,pool,mint,quote,s.getPdaLaunchpadVaultId(s.LAUNCHPAD_PROGRAM,pool,mint).publicKey,s.getPdaLaunchpadVaultId(s.LAUNCHPAD_PROGRAM,pool,quote).publicKey,s.getPdaMetadataKey(mint).publicKey,TOKEN_PROGRAM_ID,6,name,tokenSymbol,uri,{type:'ConstantCurve',totalSellA:b('793100000000000'),migrateType:'cpmm',supply:b('1000000000000000'),totalFundRaisingB:b(q.floor)},zero,zero,zero,s.CpmmCreatorFeeOn.OnlyTokenB,a.allow,a.rule);
 return {instruction,pool,quote:q};
}
