/** Holder-reward lookups in the GRAIN panel, bound to the wallet they were asked for. Each result, pending check and failure
 * carries its owner; the panel shows only those of the wallet connected now, so after a wallet switch an earlier or late
 * answer is never shown under another wallet. */
export const SILO_REWARDS_IDLE=Object.freeze({result:null,busy:null,failed:null});
export function siloRewardsStart(state,owner){return {...state,busy:owner,failed:state.failed===owner?null:state.failed};}
export function siloRewardsDone(state,owner,data){return {...state,result:{owner,data},busy:state.busy===owner?null:state.busy};}
export function siloRewardsFail(state,owner){return {...state,failed:owner,busy:state.busy===owner?null:state.busy};}
export function siloRewardsView(state,owner){
 if(!owner)return {rewards:null,busy:false,failed:false};
 return {rewards:state.result?.owner===owner?state.result.data:null,busy:state.busy===owner,failed:state.failed===owner};
}
