import {REWARDS_SPLIT_V2,FUTURE_REWARDS_SPLIT} from './rewards-split-policy.mjs';
import {FINALIZED_OFFICIAL_INVENTORY} from './finalized-official-inventory-identity.mjs';
import {mintInventoryReadinessErrors} from './mint-inventory-readiness.mjs';
/** Owner-approved public launches before GRAIN, 5 October 2026.
 * Source policy only: requests and environment flags cannot select this scope.
 * Holder/platform shares may be paid; the GRAIN share stays a source liability.
 */
export const PUBLIC_PRE_GRAIN_POLICY=Object.freeze({
 id:'grainpad-public-pregrain-v1',ownerApproved:true,
 decision:'docs/OWNER_LAUNCH_DECISIONS.md#public-launches-before-grain--5-october-2026',
 operatorMode:'public-pregrain',holdersBps:7000,grainBurnBps:1500,grainpadBps:1500,
 burnPhase:'reserved-until-official-grain',
});
export function isPublicPregrainMode(mode){return PUBLIC_PRE_GRAIN_POLICY.ownerApproved===true&&mode===PUBLIC_PRE_GRAIN_POLICY.operatorMode;}
/** Prepared successor phase. A missing source-pinned official identity keeps it
 * closed; publication JSON or an environment flag cannot choose the target. */
export const PUBLIC_LIVE_REWARDS_POLICY=Object.freeze({id:'grainpad-public-live-v1',ownerApproved:true,operatorMode:'public-live',officialMint:FINALIZED_OFFICIAL_INVENTORY.mint,holdersBps:7000,grainBurnBps:1500,grainpadBps:1500,burnPhase:'official-grain'});
export function isPublicLiveRewardsMode(mode){return PUBLIC_LIVE_REWARDS_POLICY.ownerApproved===true&&mode===PUBLIC_LIVE_REWARDS_POLICY.operatorMode;}
export function isPublicRewardsMode(mode){return isPublicPregrainMode(mode)||isPublicLiveRewardsMode(mode);}
export function assertPublicLiveRewardsDeployment(deployment,rewardsMint){
 const p=deployment.revenueSplitVersion===REWARDS_SPLIT_V2?{...PUBLIC_LIVE_REWARDS_POLICY,...FUTURE_REWARDS_SPLIT}:PUBLIC_LIVE_REWARDS_POLICY;
 if(!p.ownerApproved||deployment.officialGrainMint!==p.officialMint||rewardsMint!==deployment.officialGrainMint||deployment.holdersBps!==p.holdersBps||deployment.grainBurnBps!==p.grainBurnBps||deployment.grainpadBps!==p.grainpadBps)throw Error('Public live rewards require the reviewed source-pinned official GRAIN target, its matching rewardsMint and the approved 70/15/15 legacy or versioned 50/15/35 future split.');
}
export function assertPublicPregrainDeployment(deployment){
 const p=PUBLIC_PRE_GRAIN_POLICY;
 if(!p.ownerApproved||deployment.officialGrainMint!==null||deployment.holdersBps!==p.holdersBps||deployment.grainBurnBps!==p.grainBurnBps||deployment.grainpadBps!==p.grainpadBps)throw Error('Public pre-GRAIN rewards require the approved 70/15/15 split and no burn target.');
}
export function isPublicPregrainEvidence(evidence){
 const p=PUBLIC_PRE_GRAIN_POLICY;
 return p.ownerApproved===true&&evidence?.schemaVersion===5&&evidence.scope===p.id&&evidence.ownerDecision===p.decision;
}
export function pregrainReserveEvidenceError(item){
 const b=item?.burnPhase;
 if(item?.checks?.grainBuybackBurnFinalized===true)return 'Pre-GRAIN evidence must not claim a finalized GRAIN burn.';
 if(b?.mode!==PUBLIC_PRE_GRAIN_POLICY.burnPhase||b.officialGrainMint!==null||b.reserveBps!==1500||b.reserveIsolationVerified!==true||b.sourceAccountingVerified!==true)return 'Verify source-attributed 15% reserves, isolation from payouts/operating costs and the absent GRAIN burn target.';
 return null;
}

/** Owner-approved first-burn activation after the exact official launch finalized.
 * This scope reports an unperformed burn, never a receipt. All funds and existing
 * attempts remain attributed to their original sources. */
export const PUBLIC_POST_GRAIN_BOOTSTRAP_POLICY=Object.freeze({
 id:'grainpad-public-postgrain-bootstrap-v1',ownerApproved:true,
 decision:'docs/OWNER_LAUNCH_DECISIONS.md#finalized-grain-burn-activation--6-october-2026',
 operatorMode:'public-live',officialMint:FINALIZED_OFFICIAL_INVENTORY.mint,
 holdersBps:7000,grainBurnBps:1500,grainpadBps:1500,
 burnPhase:'official-grain-first-burn-pending',firstBurnStatus:'unperformed',
});
export function isPublicPostgrainBootstrapEvidence(evidence){
 const p=PUBLIC_POST_GRAIN_BOOTSTRAP_POLICY;
 return p.ownerApproved===true&&evidence?.schemaVersion===6&&evidence.scope===p.id&&evidence.ownerDecision===p.decision;
}
export function postgrainBootstrapEvidenceError(item,{grainInventory,officialInventoryProof,now=Date.now()}={}){
 const p=PUBLIC_POST_GRAIN_BOOTSTRAP_POLICY,b=item?.burnPhase;
 if(item?.checks?.grainBuybackBurnFinalized!==false||item?.officialBurn!=null||b?.firstBurnStatus!==p.firstBurnStatus||b?.firstBurnSignature!==null||b?.signature!=null||b?.receipt!=null||b?.finalizedTransaction!=null)return 'First GRAIN burn is unperformed; bootstrap evidence must not fabricate a burn signature or finalized proof.';
 if(b.mode!==p.burnPhase||b.officialGrainMint!==p.officialMint||b.reserveBps!==p.grainBurnBps||b.reserveIsolationVerified!==true||b.sourceAccountingVerified!==true)return 'Verify the exact finalized GRAIN target and preserve each source-attributed 15% reserve and its isolation.';
 if(grainInventory?.officialPhase!=='finalized-published'||grainInventory.officialMint!==p.officialMint||mintInventoryReadinessErrors(grainInventory,now,{officialInventoryProof}).length)return 'First-burn activation requires fresh primary verified exact official launch and CA proof plus the unchanged public inventory safeguards.';
 return null;
}
