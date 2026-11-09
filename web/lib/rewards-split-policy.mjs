import {nativeMarketHeld} from './rewards-first-smart-round.mjs';
/** Source-pinned future split. Never migrates or edits an existing source/credit. */
export const REWARDS_SPLIT_V2='wxmr-holders-v2-50-15-35';
export const FUTURE_REWARDS_SPLIT=Object.freeze({holdersBps:5000,grainBurnBps:1500,grainpadBps:3500});
export const PUBLISHED_REWARDS_SPLIT=Object.freeze({...FUTURE_REWARDS_SPLIT,version:REWARDS_SPLIT_V2,executionScope:'payments-only',historicalEntitlements:'original-frozen-split'});
/** The connected smart producer remains behind the source hold.
 * Restarting a healthy payer can never implicitly authorize another market sale. */
export function paymentsOnlyExecution(config){
 if(config?.executionScope==='smart-market'){if(nativeMarketHeld(config.marketExecution?.collector)||config.marketExecution?.state!=='live')throw Error('Smart market requires reviewed source GO and a live isolated controller.');return false;}
 if(config?.executionScope!=null&&config.executionScope!=='payments-only')throw Error('Market execution stays held; only payments-only is source-approved.');
 return true;
}
export function approvedRevenueSplit(split){
 return !!split&&split.grainBurnBps===1500&&((split.holdersBps===7000&&split.grainpadBps===1500)||(split.holdersBps===5000&&split.grainpadBps===3500));
}
export function approvedWorkflowSplit(policy){
 return !!policy&&policy.burnBps===1500&&((policy.revenueSplitVersion==null&&policy.holdersBps===7000&&policy.platformBps===1500)||(policy.revenueSplitVersion===REWARDS_SPLIT_V2&&policy.holdersBps===5000&&policy.platformBps===3500));
}
export function frozenSplitMatchesPolicy(split,policy){
 return approvedWorkflowSplit(policy)&&approvedRevenueSplit(split)&&split.holdersBps===policy.holdersBps&&split.grainBurnBps===policy.burnBps&&split.grainpadBps===policy.platformBps;
}
export function splitDeploymentForConfig(config,deployment){
 if(config?.revenueSplitVersion==null)return deployment;
 if(config.revenueSplitVersion!==REWARDS_SPLIT_V2)throw Error('Unknown future rewards split version.');
 return {...deployment,...FUTURE_REWARDS_SPLIT,revenueSplitVersion:REWARDS_SPLIT_V2};
}
