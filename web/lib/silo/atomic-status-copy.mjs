// Plain-language status for the no-bridge swaps (XMR to SOL and SOL to XMR). Pure and display-only: phase in, words out. The driver, the
// swap core and the return plan (atomic-reverse-return.mjs) decide what happens; nothing here moves money, holds a key or changes a rule.
// Wording keeps every true statement the panels already carried. Times are "usually" with "can take longer" unless a protocol deadline
// is shown by the panel itself from the swap record.
import { reverseReturnCopy } from './atomic-reverse-return.mjs';
import { REVERSE_RECOVERY_TITLE, reversePhaseCopy, reverseFinalCopy, reverseReturnWords } from './atomic-reverse-terms.mjs';
/** @typedef {{headline:string,detail:string,nextAction:string,eta:string|null}} PlainStatus */

export const ATOMIC_FORWARD_PHASES = Object.freeze(['waiting-maker', 'checking-lock', 'awaiting-xmr', 'confirming', 'claiming', 'awaiting-refund', 'recovering', 'stopped']);
export const ATOMIC_FORWARD_RESULTS = Object.freeze(['sol-received', 'xmr-recovered', 'cancelled', 'quote-expired', 'bad-terms', 'too-late-to-lock', 'maker-answer-rejected', 'other']);
export const ATOMIC_REVERSE_PHASES = Object.freeze(['setup', 'locking', 'awaiting-maker-xmr', 'xmr-confirming', 'xmr-check-failed', 'confirming', 'await-claim', 'sweeping', 'refunding']);
export const ATOMIC_REVERSE_RESULTS = Object.freeze(['xmr-received', 'sol-refunded', 'nothing-locked']);

/** XMR to SOL, one swap phase (atomic-driver phases). @param {{xmr?:string,target?:number,confirmations?:number}} [c] */
export function atomicForwardStatus(phase, c = {}) {
  const xmr = c.xmr ?? '', target = Number.isSafeInteger(c.target) ? c.target : 10;
  const n = Math.max(0, Math.min(target, Number.isFinite(c.confirmations) ? c.confirmations : 0));
  switch (phase) {
    case 'checking-lock': return {
      headline: 'Checking the SOL lock on Solana',
      detail: 'The maker’s lock was found. Silo checks it on an independent Solana node before you send anything.',
      nextAction: 'You send the XMR once the check passes.',
      eta: 'Usually a few seconds, but it can take longer if the Solana node is slow.' };
    case 'awaiting-xmr': return {
      headline: `Send exactly ${xmr} XMR`,
      detail: 'The payment is ready in your Monero wallet, with its network fee. Nothing is sent until you confirm there.',
      nextAction: `${target} Monero confirmations, then Silo claims your SOL. Once the XMR is sent you can close Silo.`,
      eta: null };
    case 'confirming': return {
      headline: `${n} of ${target} confirmations`,
      detail: 'Your XMR payment is being confirmed by the Monero network. No action needed.',
      nextAction: `At ${target} confirmations Silo claims your SOL: right away while it is open, otherwise the next time you open and unlock it, before the claim deadline.`,
      eta: `Usually about ${target * 2 + 15} minutes in all, but it can take longer.` };
    case 'claiming': return {
      headline: 'Claiming your SOL',
      detail: 'The claim was sent to Solana. While Silo is open and unlocked it checks that the claim landed and retries.',
      nextAction: 'The SOL shows at your Silo Solana address.',
      eta: 'Usually a minute or two, but it can take longer.' };
    case 'awaiting-refund': return {
      headline: 'Waiting for the maker’s refund',
      detail: 'The SOL can no longer be claimed. Your XMR comes back only if the maker returns the SOL lock and reveals its key part; expiry alone does not return it. Once the maker has, open and unlock Silo and it returns the XMR.',
      nextAction: 'Silo returns your XMR to your Monero wallet once the maker has refunded.',
      eta: 'This depends on the maker and can take hours.' };
    case 'recovering': return {
      headline: 'Returning your XMR',
      detail: 'The maker refunded the SOL lock, so your XMR can come back. Silo does this while it is open with your Monero wallet unlocked; if you close or lock it, it continues only after you open and unlock it again.',
      nextAction: 'The XMR shows in your Monero wallet after Monero confirmations.',
      eta: 'Usually a few minutes, then Monero confirmations. It can take longer.' };
    case 'stopped': return {
      headline: 'The maker cancelled this offer',
      detail: 'Do not send more XMR. While Silo is open and unlocked it watches for a late payment, then closes this swap.',
      nextAction: 'If you did send XMR, it comes back only if the maker returns the SOL lock.',
      eta: null };
    default: return {
      headline: 'Waiting for the maker to lock the SOL',
      detail: 'No action needed. Nothing has left your wallet.',
      nextAction: 'You send the XMR once the lock is checked.',
      eta: 'Usually a few minutes, but it can take longer.' };
  }
}

/** XMR to SOL, a finished swap. */
export function atomicForwardFinal(result) {
  switch (result) {
    case 'sol-received': return { headline: 'Received', detail: 'Done. Your SOL arrived at your Silo Solana address.', nextAction: 'Activity shows what arrived.', eta: null };
    case 'xmr-recovered': return { headline: 'XMR sent back', detail: 'The claim deadline passed and the maker refunded the SOL lock. No SOL arrived for this swap.', nextAction: 'Your XMR shows in your Monero wallet after Monero confirmations, less one Monero network fee.', eta: null };
    case 'cancelled': return { headline: 'Nothing was sent', detail: 'Cancelled before any XMR was sent. Nothing was spent.', nextAction: 'You can get a new offer.', eta: null };
    case 'quote-expired': return { headline: 'Nothing was sent', detail: 'This offer expired before any XMR was sent. Nothing was spent.', nextAction: 'You can get a new offer.', eta: null };
    case 'bad-terms': return { headline: 'Nothing was sent', detail: 'The on-chain lock did not match your offer, so no XMR was sent. Nothing was spent.', nextAction: 'You can get a new offer.', eta: null };
    case 'too-late-to-lock': return { headline: 'Nothing was sent', detail: 'It was too late to lock XMR safely, so none was sent. Nothing was spent.', nextAction: 'You can get a new offer.', eta: null };
    case 'maker-answer-rejected': return { headline: 'Nothing was sent', detail: 'The offer did not check out, so no XMR was sent. Nothing was spent.', nextAction: 'You can get a new offer.', eta: null };
    default: return { headline: 'This swap is finished', detail: 'This swap is finished. Check your wallets to see where the money is.', nextAction: 'Activity lists what arrived.', eta: null };
  }
}

/** Home and Activity card for an XMR to SOL swap in progress. Times arrive already formatted ("14:05 today"), or null. */
export function atomicForwardCardStatus(phase, c = {}) {
  const { xmr = '', sol = '', sendByText = null, claimByText = null, claimOpen = false } = c;
  const refund = phase === 'awaiting-refund' || phase === 'recovering';
  if (phase === 'awaiting-xmr') return {
    headline: 'Your step: send the XMR',
    detail: `Confirm ${xmr} XMR in your Monero wallet${sendByText ? ` by ${sendByText}` : ''}.`,
    nextAction: 'Open Silo to confirm the payment in your Monero wallet.', eta: null };
  if (refund) return {
    headline: 'Your XMR is coming back',
    detail: 'The claim deadline passed. Your XMR comes back only if the maker returns the SOL lock. Open and unlock Silo to continue.',
    nextAction: 'Open and unlock Silo so it can return the XMR once the maker has refunded.',
    eta: 'This depends on the maker and can take hours.' };
  if (phase === 'stopped') return { ...atomicForwardStatus('stopped'), eta: null };
  if (phase === 'waiting-maker' || phase === 'checking-lock') return {
    headline: 'Starting your swap',
    detail: 'The maker is locking the SOL. Nothing has left your wallet.',
    nextAction: 'No action needed yet. You send the XMR once the lock is checked.',
    eta: 'Usually a few minutes, but it can take longer.' };
  return {
    headline: `${sol} SOL on its way`,
    detail: claimOpen && claimByText
      ? `Silo collects it while it is open and unlocked. If you close or lock Silo, open and unlock it again before ${claimByText} so it can try the claim.`
      : 'Silo is checking this swap.',
    nextAction: claimByText ? `Keep Silo open, or open and unlock it before ${claimByText}.` : 'Open Silo to see where it stands.',
    eta: 'Usually about 35 minutes in all, but it can take longer.' };
}

/** SOL to XMR, one swap phase (atomic-reverse-driver phases). The sentences live in atomic-reverse-terms.mjs. @param {{xmr?:string,confirmations?:number,target?:number,scanFailed?:boolean}} [c] */
export function atomicReverseStatus(phase, c = {}) { return reversePhaseCopy(phase, c); }

/** SOL to XMR, a finished swap. */
export function atomicReverseFinal(result) { return reverseFinalCopy(result); }

/** A swap in progress while its direction is switched off in this build (Astra 748-M2). The card stays, read-only. SOL to XMR keeps running in
 * recovery mode (refunds, claims, sweeps) while Silo is open and unlocked; XMR to SOL waits until swaps are switched back on. */
export const ATOMIC_PAUSED_COPY = Object.freeze({
  'sol-xmr': 'Swaps are switched off in this build. This swap is saved on this device, and Silo keeps finishing or refunding it while Silo is open and unlocked.',
  'xmr-sol': 'Swaps are switched off in this build. This swap is saved on this device and continues when swaps are switched back on.',
});
/** Leave-and-return stage (start, confirm, pending, collect, refund) for the swap screen and the Home and Activity card. The sentences come from reverseReturnCopy, unchanged. */
export function atomicReverseReturnStatus(plan, options = {}) {
  const copy = reverseReturnCopy(plan, options), words = reverseReturnWords(plan);
  return { headline: copy.title, detail: copy.line, nextAction: words.nextAction, eta: words.eta, facts: copy.facts, more: copy.more, moreTitle: REVERSE_RECOVERY_TITLE };
}
