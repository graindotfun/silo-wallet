/** Owner-approved initial release scope, 3 October 2026.
 * Compatibility observations are disclosed, never converted into passing tests.
 * This source policy cannot be selected or overridden by an HTTP body or environment flag.
 */
import {isPublicPregrainEvidence,isPublicPostgrainBootstrapEvidence} from './public-rewards-phase.mjs';
export const DIRECT_RELEASE_SCOPE=Object.freeze({
 id:'grainpad-direct-v1',
 ownerApproved:true,
 decision:'docs/OWNER_LAUNCH_DECISIONS.md#initial-release-scope--3-october-2026',
});
export const DIRECT_RELEASE_OBSERVATIONS=Object.freeze([
 'iosPhantom','androidPhantom','iosSolflare','androidSolflare',
 'raydium','jupiter','dexscreener','geckoterminal','birdeye','axiom','photon','bullx',
 'mainnetGraduation','independentPublicMainnetLaunch','contractedCapacity',
 'completeProviderArchive','externalAlertDelivery',
]);
export function isDirectReleaseEvidence(evidence){
 return isPublicPregrainEvidence(evidence)||isPublicPostgrainBootstrapEvidence(evidence)||(DIRECT_RELEASE_SCOPE.ownerApproved===true&&evidence?.schemaVersion===4&&
  evidence.scope===DIRECT_RELEASE_SCOPE.id&&evidence.ownerDecision===DIRECT_RELEASE_SCOPE.decision);
}
export function realProgramProofError(proof){
 if(proof?.environment!=='local-real-program'||proof?.programExecuted!==true||
  !/^[a-f0-9]{64}$/.test(proof.reportSha256??'')||typeof proof.evidence!=='string'||!proof.evidence.trim()||
  !Number.isInteger(proof.passedCases)||proof.passedCases<1||proof.failedCases!==0||
  !Array.isArray(proof.programDigests)||!proof.programDigests.length||proof.programDigests.some(hash=>!/^[a-f0-9]{64}$/.test(hash)))
  return 'Attach the retained successful real-program rehearsal, report hash and captured program hashes; a mock or mainnet label cannot replace it.';
 return null;
}
export function releaseObservationErrors(observations){
 const states=new Set(['verified','owner-reported','not-tested','not-observed','unsupported']);
 return DIRECT_RELEASE_OBSERVATIONS.flatMap(name=>{
  const item=observations?.[name];
  if(!states.has(item?.status)||typeof item?.detail!=='string'||!item.detail.trim())return [`Disclose the actual ${name} observation, including when it is untested.`];
  if(item.status==='verified'&&(!['mainnet','physical-device','production'].includes(item.environment)||typeof item.evidence!=='string'||!item.evidence.trim()))return [`Verified ${name} needs its actual environment and evidence; local rehearsals do not prove production compatibility.`];
  return [];
 });
}
