/** Owner-approved Silo economics. Values describe policy, never live settlement. */
export const SILO_REVENUE_POLICY = Object.freeze({
 version: 3, transferFeeBps: 0,
 // The fee Silo itself adds on top of a provider's own quote (basis points of swap volume), charged to the user.
 // changenow:0 -- owner-approved 28 Oct 2026: no additional Silo fee on ChangeNOW conversions. See
 // partnerCommissionBpsByProvider below for the separate, unrelated revenue ChangeNOW itself pays Silo.
 // jupiter:100 -- owner decision 4 Nov 2026 (chat): 1% total referral fee on Solana swaps, from the first live swap;
 // Jupiter keeps 20% of it, so Silo retains 0.8%. The 50bps text below is the superseded 29 Oct decision:
 // jupiter:50 -- owner-approved 29 Oct 2026, replacing an earlier, unapproved 70bps proposal and the
 // no-collection-build (zero-fee) alternative: 50bps (0.5%) is the TOTAL referral fee charged to the user, no
 // additional Silo fee beyond it. Jupiter's own published referral-fee split applies to this total (not an
 // extra charge): see siloJupiterReferralSplit below -- verify this is the split actually in effect before
 // relying on it for revenue accounting. Jupiter's own executionMode gate (jupiter-execution-service.mjs's
 // configured()) still separately requires SILO_SWAP_FEE_COLLECTION_ENABLED==='true', a real referral account,
 // and an independent swap execution review before this number can ever be charged to a user -- none of those
 // are satisfied in any deployed Worker yet, so approving the number itself is not activation.
 swapFeesByProvider: Object.freeze({jupiter: 100, trocador: 100, changenow: 0}),
 // Revenue a provider pays SILO from its OWN margin, in basis points of swap volume -- never a charge added to the
 // user's quoted amount (conversion-service.mjs passes ChangeNOW's own toAmount straight through with no markup).
 // A provider absent here does not pay Silo this way. Confirmed in ChangeNOW's own account correspondence (19 Oct 2026;
 // [redacted for publication: the correspondent's name and the quoted text]). Owner-approved, 28 Oct 2026, for the beta.
 partnerCommissionBpsByProvider: Object.freeze({changenow: 40}),
 buybackAllocationBps: 3000, cardRevenueEnabled: false,
});
/** Legacy planning range retained for existing historical scenarios. Live provider policy uses the explicit getter below. */
export function siloSwapFeeBps(value = 40) {
 if (!Number.isInteger(value) || value < 30 || value > 50) throw Error('Silo swap fee must be between 30 and 50 basis points.');
 return value;
}
/** No caller-provided override or generic default for a live provider. This policy is not activation. */
export function siloProviderSwapFeeBps(provider) {
 if (!Object.hasOwn(SILO_REVENUE_POLICY.swapFeesByProvider, provider)) throw Error('Swap provider fee policy is not approved.');
 return SILO_REVENUE_POLICY.swapFeesByProvider[provider];
}
/** The commission basis points a provider pays Silo from its own margin (never a user-facing charge), or null if
 * this provider has no such arrangement registered. Keep this distinct from siloProviderSwapFeeBps everywhere it
 * is surfaced: one is what the user pays, the other is revenue Silo receives that never touches the user's quote. */
export function siloPartnerCommissionBps(provider) {
 return Object.hasOwn(SILO_REVENUE_POLICY.partnerCommissionBpsByProvider, provider)
   ? SILO_REVENUE_POLICY.partnerCommissionBpsByProvider[provider] : null;
}
/** Whether `bps` is some owner-approved adapter's fee, independent of which adapter processes a given intent
 * (an intent's own `provider` field identifies the underlying exchange a cross-chain platform routed through,
 * not the Silo adapter -- that match is `assertCrosschainAvailable`'s job, via `config.provider`). */
export function siloApprovedSwapFeeBps(bps) {
 return Object.values(SILO_REVENUE_POLICY.swapFeesByProvider).includes(bps);
}
export function siloRevenueStatus() {
 return Object.freeze({policy: SILO_REVENUE_POLICY, collectionEnabled: false,
  buybackExecutionEnabled: false, status: 'awaiting-provider-integration',
  revenueBase: 'verified-collected-fees-minus-provider-and-execution-costs-and-refunds',
  reason: 'Provider settlement verification, collection accounts and a reviewed GRAIN purchase-and-burn route are required.'});
}
