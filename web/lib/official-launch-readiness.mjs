/** Owner launch plan, 2026-10-05: atomic create + DEV buy + public wXMR admission.
 * Descriptions are not live readiness evidence. This module never signs or sends. */
import {OFFICIAL_LAUNCH_SIGNING_ENABLED} from './official-launch-policy.mjs';
export const OFFICIAL_LAUNCH_READINESS_ACKNOWLEDGED=true;
export const OFFICIAL_LAUNCH_BOUNDARY=Object.freeze({rehearsal:false,publicTradingOnInclusion:true,atomicWithPublicActivation:true});
export const OFFICIAL_LAUNCH_ATOMICITY=Object.freeze({
 atomicWithPublicActivation:true,ownerTransactionApprovals:2,
 launchTransactionAtomic:Object.freeze(['open public wXMR admission','initialize GRAIN against wXMR','create the creator GRAIN token account','buy the declared wXMR amount']),
 notInThatTransaction:Object.freeze(['application deployment and creation/rewards release gates','lookup-table extension','finalized registration and official contract publication','Monero provenance confirmation','holder payouts and the first official-token buy-and-burn']),
 unavoidableGap:'One Solana transaction creates GRAIN, buys the declared DEV amount and leaves public wXMR launches open. It needs two owner wallet approvals: creator and admin. The reviewed application, operator and release gates must already be ready before signing. Trading and on-chain admission begin on inclusion; the token page and official CA follow finalized registration. Monero confirmation and reward/burn cycles happen separately.',
});
export const OFFICIAL_PRELAUNCH_STAGING=Object.freeze([
 Object.freeze({id:'deploy',status:'live-check-required',waitClass:'installation',detail:'Verify that production equals reviewed main, migrations are applied, public creation and rewards release evidence passes, and official signing gates are enabled for this exact release.'}),
 Object.freeze({id:'operator',status:'live-check-required',waitClass:'installation',detail:'Require a fresh matching public-operator heartbeat, no unresolved financial operation and enough SOL. Every eligible public mint must be discovered. Before the official burn target is approved, its 15% allocation remains isolated; CA publication alone does not activate a burn target.'}),
 Object.freeze({id:'funding',status:'live-check-required',waitClass:'installation',detail:'Creator funding is the declared wXMR buy plus SOL for creation. The measured debit is 0.01234168 SOL; the enforced ceiling is 0.01734168 SOL. The admin separately funds the lookup extension and 0.0013462 SOL admission rent. Recheck balances and simulation; conversion fees are additional.'}),
 Object.freeze({id:'monitoring',status:'partially-verified',waitClass:'installation',detail:'Supervisor, heartbeats and local checks exist. External alert delivery and recurring off-host restore drills require separate evidence. Logs alone do not prove alert delivery.'}),
]);
export const OFFICIAL_POSTCREATION_ELIMINATED=Object.freeze([
 'A separate DEV-buy transaction: the declared buy is inside creation.',
 'A separate public-admission transaction: wXMR admission stays open inside the same atomic creation transaction.',
 'A deployment or second owner signature to publish the CA: finalized registration uses the existing idempotent publication path.',
]);
export const OFFICIAL_REMAINING_GAPS=Object.freeze([
 'The pool is tradeable on inclusion; finalized registration and verified CA publication follow. Open headers refresh every 15 seconds while visible and when focus returns.',
 'Protected-RPC unsigned curve SOL buy/sell checks and local real-program rehearsals cover the configured route. They do not establish graduated mainnet execution or physical-wallet acceptance.',
 'The first official-token burn follows verified target activation and sufficient earned reserve. Historical GRAINU or previous-GRAIN burns cannot prove a new-GRAIN burn.',
 'Public 70/15/15 distribution can run with the 15% isolated before GRAIN. Post-GRAIN activation must preserve arbitrary-source discovery and revenue-relative payout limits; the old single-mint full mode does not meet that requirement.',
]);
export const OFFICIAL_LAUNCH_CUTOVER=Object.freeze([
 Object.freeze({id:'C1',waitClass:'chain-confirmation',action:'Track the exact submitted signature to finalized success, then register that exact mint, creator and metadata hash. The scheduled indexer retries registration without another owner click.',after:'inclusion',latency:'Finality and one registration request; not a second deployment.',failure:'Pending, processed, confirmed or timeout preserves the reservation. A finalized error is replaceable only after the failed transaction is found, the mint is absent and finalized height exceeds reviewed expiry. Retry registration after success; never create a replacement token.'}),
 Object.freeze({id:'C2',waitClass:'runtime',action:'Publish the official contract address through the idempotent verified registration path. The token page and open headers read the same identity.',after:'finalized registration',latency:'The next index read; visible headers poll every 15 seconds and on focus, including after publication.',failure:'A different mint or failed verification is refused. Unavailable data is shown as unavailable, never as the old CA. Retry publication for the same finalized mint.'}),
 Object.freeze({id:'C3',waitClass:'runtime',action:'Public creators can launch wXMR rewards tokens through the released application. The launch transaction leaves reviewed wXMR admission open; SOL-paired issuance remains closed.',after:'atomic launch inclusion and ready application',latency:'No additional admission transaction or owner signature.',failure:'An atomic launch failure creates no GRAIN mint or DEV buy and preserves the pre-transaction admission state. Investigate the original signature and reservation before retrying.'}),
 Object.freeze({id:'C4',waitClass:'chain-confirmation',action:'Record each authorized finalized launch on Monero through its durable publication job. Confirm the receipt matches mint, creator and metadata.',after:'finalized registration',latency:'Monero construction, relay and confirmation are asynchronous and remain pending until verified.',failure:'Recover the existing nonce, stored transaction and relay claim. An uncertain result is not permission to construct or relay a second transaction.'}),
 Object.freeze({id:'C5',waitClass:'runtime',action:'Distribute holder and platform allocations from verified earned wXMR. Keep the GRAIN 15% reserved until the official target and public post-GRAIN operator mode are reviewed and active.',after:'funded source accrual and complete holder snapshot',latency:'The next eligible funded cycle; dust waits for a safe batch.',failure:'A reserve is not a burn. Recovery reuses the same operation; cancellation of old GRAINU is not a payment.'}),
 Object.freeze({id:'C6',waitClass:'chain-confirmation',action:'After verified target activation, execute the first official-token buy-and-burn only from isolated earned allocation within the approved SOL budget.',after:'funded reserve and readable official pool',latency:'A later eligible cycle and finalized transaction. An allocation below the conversion minimum waits.',failure:'Do not reuse historical burns as evidence for the new mint. Preserve reserves if target verification, liquidity or cost proof fails.'}),
]);
export const OFFICIAL_PRELAUNCH_CHECKS=Object.freeze([
 Object.freeze({id:'grainu-trading',status:'partial-evidence',detail:'Historical GRAINU unsigned curve checks and real-program local rehearsals apply to those paths, not a current physical-wallet or graduated-mainnet rehearsal.'}),
 Object.freeze({id:'grainu-rewards',status:'historical-records-preserved',detail:'The reward feed is the current transaction record. Owner-cancelled GRAINU obligations have zero active payable balance while earned, paid and cancelled history remain separate. This does not claim every queued payment has completed or that cancellation paid anyone.'}),
 Object.freeze({id:'grainu-burn-reserve',status:'retired',detail:'The owner cancelled old GRAINU reserve and obligations. Future public tokens create new isolated 15% GRAIN allocations; retired balances must not be resurrected as funding.'}),
 Object.freeze({id:'operator',status:'live-check-required',detail:'Require configurationReady, operationalReady and newSalesReady with a fresh heartbeat matching deployed financial settings. A running process or old report is insufficient.'}),
 Object.freeze({id:'funding',status:'live-check-required',detail:'Policy requires 0.035 SOL before a full 0.025 SOL round plus the 0.01 SOL floor. Account for unresolved cost reservations. Funding does not establish profitability. Code-level recovery support is separate from its installation and verified operation on the server.'}),
 Object.freeze({id:'monitoring',status:'partially-verified',detail:'Verify alert delivery, recovery and backup evidence for this release; do not infer them from local logs.'}),
 Object.freeze({id:'token-page',status:'awaiting-finalized-creation',detail:'The next mint stays in the owner browser until creation. CA publication and the official page require finalized creation and verification.'}),
 Object.freeze({id:'sol-wxmr',status:'curve-live-verified',detail:'Grainpad lookup GdrHQNhwy7veVC9evQ6YtSwrrjjkqKuHtaV4mfE1X7je is pinned. Protected-RPC unsigned curve SOL buy/sell checks passed; local real-program CPMM proofs must use current binaries. These are not full official-launch acceptance or a graduated-mainnet trade.'}),
]);
export function officialLaunchSigningGate({signingEnabled=OFFICIAL_LAUNCH_SIGNING_ENABLED,readinessAcknowledged=OFFICIAL_LAUNCH_READINESS_ACKNOWLEDGED}={}){
 if(!signingEnabled)return {allowed:false,reason:'Official GRAIN launch signing is locked. Nothing was signed or sent.'};
 if(readinessAcknowledged!==true)return {allowed:false,reason:'Official GRAIN creation is the public launch boundary. Signing stays locked until the owner readiness review is acknowledged. Nothing was signed or sent.'};
 return {allowed:true};
}
export function assertOfficialLaunchReadyToSign(){const gate=officialLaunchSigningGate();if(!gate.allowed)throw Error(gate.reason);}
export {officialBurnEvidenceError} from './official-burn-evidence.mjs';
