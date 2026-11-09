import {QUOTES} from './quote-assets.mjs';
import {officialBurnEvidenceError} from './official-launch-readiness.mjs';
import {isDirectReleaseEvidence,realProgramProofError} from './release-scope.mjs';
import {isPublicPregrainEvidence,pregrainReserveEvidenceError,isPublicPostgrainBootstrapEvidence,postgrainBootstrapEvidenceError} from './public-rewards-phase.mjs';

// Flipping the generic issuance switch cannot waive the required rewards system.
export const REWARDS_OPERATIONAL = true;
export function assertHolderRewardsOperational(){
  if(!REWARDS_OPERATIONAL)throw Error('Holder rewards and tax-funded GRAIN burns must be operational before token creation.');
}

/** Owner requirement, 29 Sep 2026: holder distribution is required before launch. */
export const REWARDS_POLICY = Object.freeze({
  version: 'wxmr-holders-v1',
  required: true,
  payoutMint: QUOTES.wXMR.mint,
  payoutDecimals: 12,
  quoteAsset: 'wXMR',
  // The program supports whole basis points. The launch slider moves by 0.1%.
  transferFeeBps: Object.freeze(Array.from({length:201},(_,i)=>100+i)),
  minimumTaxBps: 100,
  maximumTaxBps: 300,
  sliderStepBps: 10,
  baseTokenPayouts: false,
  creatorFeeRedirect: false,
  grainBuybackBurnRequired: true,
  revenueSplit: null,
});

// Creator-selectable launch rates: 1.0%-3.0% in 0.1% steps, default 1.0%. On-chain rules accept any whole basis
// point in range, so existing mints are still read with transferFeeBps; every Grainpad launch path uses these.
export const LAUNCH_TAX_BPS = Object.freeze(REWARDS_POLICY.transferFeeBps.filter(bps => bps % REWARDS_POLICY.sliderStepBps === 0));
export const DEFAULT_LAUNCH_TAX_BPS = 100;
export function isLaunchTaxBps(value) { return Number.isInteger(value) && LAUNCH_TAX_BPS.includes(value); }
export const REWARDS_RELEASE_CHECKS = Object.freeze([
  'policyApproved', 'grainpadPlatformAttributionVerified', 'grainpadCollectorControlVerified', 'taxedLaunchVerified', 'curveBuySellVerified',
  'graduatedBuySellVerified', 'withheldCollectionVerified',
  'wxmrConversionVerified', 'completeHolderSnapshotVerified',
  'proRataPayoutFinalized', 'duplicatePayoutRejected',
  'restartRecoveryVerified', 'schedulerVerified', 'signerConfigured',
  'publicReceiptsVerified', 'solOperatingBudgetFunded',
  'revenueSplitApproved', 'grainBuybackBurnFinalized', 'burnBudgetIsolated',
]);

export function assertRewardsRelease(evidence, options) {
  // Only the explicitly approved schema-4 release substitutes a separately labelled
  // real-program graduation rehearsal. Every other financial check stays required.
  const direct=isDirectReleaseEvidence(options?.releaseEvidence);
  const pregrain=isPublicPregrainEvidence(options?.releaseEvidence);
  const bootstrap=isPublicPostgrainBootstrapEvidence(options?.releaseEvidence);
  const missing = REWARDS_RELEASE_CHECKS.filter(k => !(direct&&k==='graduatedBuySellVerified')&&!((pregrain||bootstrap)&&k==='grainBuybackBurnFinalized')&&evidence?.checks?.[k] !== true);
  if(direct){const error=realProgramProofError(evidence?.graduatedProgramProof);if(error)missing.push(error);}
  const burnEvidence=pregrain?pregrainReserveEvidenceError(evidence):bootstrap?postgrainBootstrapEvidenceError(evidence,options):officialBurnEvidenceError(evidence, options);
  if(burnEvidence)missing.push(burnEvidence);
  if (evidence?.payoutMint !== REWARDS_POLICY.payoutMint) missing.push('wXMR-only payout');
  if (evidence?.network !== 'mainnet-beta') missing.push('mainnet proof');
  if (!evidence?.firstPayoutSignature) missing.push('first finalized payout receipt');
  if (missing.length) throw Error(`Holder rewards are not ready: ${missing.join(', ')}.`);
}
