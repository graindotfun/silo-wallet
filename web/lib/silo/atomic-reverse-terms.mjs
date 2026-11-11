// The folded conditions of "Swap SOL to XMR, no bridge" (the No bridge screen and Move to private show these same rows). Display only.
// Every row keeps the pre-claim and post-claim cases apart (Astra 748-M1): before the maker claims, the SOL can come back; once the maker has
// claimed, there is no SOL refund and recovery means collecting the XMR. Nothing here says the maker finishes, or Silo acts, while it is not running.
// This module is the one source for every served SOL to XMR recovery sentence (swap screen, Move to private, Home and Activity cards).
// Nothing here says Silo returns SOL unconditionally or at a fixed time: before the maker claims a refund is possible when eligible; after it, recovery means collecting the XMR.
/** The one required meaning, shown under "If it fails" and as the safety line. */
export const REVERSE_IF_FAILS = "Before the maker claims, your SOL can be refunded when eligible. After the maker claims, recovery means collecting your XMR, not refunding SOL. Keep this swap's recovery record.";
export const REVERSE_BACKUP = 'This needs this swap saved in Silo on this device, or in a wallet backup that contains it (an older backup may not). If both are lost, Silo cannot refund your SOL or collect your XMR.';
/** Silo's own attempt threshold (abort lead 900 s before t0) against the displayed "Confirm by" (t0 - 300 s): ten minutes apart. It is when an attempt MAY start, never a promised refund time. */
export const REVERSE_ATTEMPT = 'If no confirmation was sent and the payment does not allow confirming, Silo starts trying from about ten minutes before Confirm by, while Silo is open and unlocked; no promise on how long it takes to settle. A payment that does allow confirming still gets its confirmation.';
export const REVERSE_NEEDS = "A refund is made by this device: it needs this swap's record, Silo open and unlocked, a Solana signer and connection, and fees. A refund the swap rules already require does not depend on the Monero check succeeding; only the early 30 minute path needs a completed check that finds no XMR. The maker and the server never return SOL for a closed Silo.";
export const REVERSE_LATE = `If you are late and Silo has not sent your confirmation, your SOL is not taken, and no fixed return time is promised. ${REVERSE_ATTEMPT} ${REVERSE_NEEDS}`;
/** The one sentence about when a refund can happen, for the How it works block (swap screen). */
export const REVERSE_REFUND_TIMING = "When a refund can happen depends on how far the swap got. If no confirmation was sent, the rules may already allow it and Silo tries it while open and unlocked. If one may have been sent, it waits until the maker's claim window is over, about 5 hours after you started or more.";
/** Status words for the SOL to XMR phases (one source for every screen). */
export const REVERSE_SCAN_FAILED_DETAIL = `This device could not read the Monero network, so Silo cannot tell whether your XMR has arrived. A failed check proves nothing and does not alone start the early 30 minute refund. If the swap rules already require a refund, Silo does not need the check to try it. Your SOL stays locked in the swap program and only you can take it back. Silo keeps trying the check. ${REVERSE_ATTEMPT}`;
export const REVERSE_WAIT_DETAIL = 'Silo watches the shared Monero address itself. If no XMR is found, your SOL can be refunded when eligible, before the maker claims; the conditions below say when. Nothing is returned at a guaranteed time.';
export const reverseWaitNext = (target) => `At ${target} Monero confirmations Silo can confirm to the swap program. Only the maker's claim gives Silo the key to collect your XMR; if the maker does not claim, your SOL can be refunded.`;
export const REVERSE_REFUNDING_DETAIL = 'The swap rules now allow a refund, so Silo is trying to take your SOL back from the swap program. This is an attempt: it can be retried until it shows as refunded, and it does not turn back into a confirmation once the refund is saved. If the maker has already claimed, there is no SOL refund and recovery means collecting your XMR.';
export const REVERSE_REFUNDING_HEADLINE = 'Trying to return your SOL';
export const REVERSE_REFUNDING_KICKER = 'The swap did not finish';
export const REVERSE_SCAN_FAILED_HEADLINE = 'Silo cannot check Monero right now';
export const REVERSE_SCAN_FAILED_KICKER = 'Check failed';
export const REVERSE_SCAN_FAILED_NEXT = 'Nothing is confirmed to the maker until Silo has seen the XMR itself.';
export const REVERSE_SCAN_FAILED_ETA = 'How long this lasts depends on your connection and can take longer than you expect.';
export const REVERSE_REFUNDING_NEXT = 'Keep Silo open and unlocked until the refund shows as done.';
export const REVERSE_AFTER_CONFIRM = 'After your confirmation is on chain, the maker can claim the SOL while it is running. Once it has claimed, there is no SOL refund: your XMR waits at a shared address, the protocol sets no deadline for moving it, and Silo moves it into your wallet when you open it, using the saved record of this swap.';
/** The folded block under every pending card: late behaviour, what needs the saved record, and the backup. */
export const REVERSE_RECOVERY_TITLE = 'What if I am late or lose this record';
export const REVERSE_RECOVERY_NOTES = Object.freeze([REVERSE_IF_FAILS, REVERSE_LATE, REVERSE_BACKUP]);

/** @type {ReadonlyArray<readonly [string, string]>} */
export const REVERSE_TERMS = Object.freeze([
 ['You can close this page', `Stay on this screen until your SOL shows as locked. After that you can close the page or lock your phone. Silo cannot confirm your XMR while it is closed, because only your own wallet can release the SOL. So open and unlock Silo again, usually after about 40 minutes and before the time it shows, so it can check your XMR and confirm. ${REVERSE_LATE} ${REVERSE_BACKUP} ${REVERSE_AFTER_CONFIRM}`],
 ['The maker cannot take your SOL first', 'The swap program releases your SOL to the maker only after Silo has confirmed that your XMR arrived. Until then nobody else can move it.'],
 ['If the maker does not deliver', `Before Silo sends your confirmation, your SOL can be refunded when eligible: after a completed Monero check finds no XMR and the 30 minute lock wait has passed, if the XMR is below the quote, or when the confirmation deadline nears. A full payment with 10 confirmations is still confirmed while time remains. A failed or timed out Monero check proves nothing and does not alone start the 30 minute path; a refund the swap rules already require does not wait for it. ${REVERSE_ATTEMPT} If a confirmation may already have been sent, there is no early refund: it waits until the maker's claim window is over, and if the maker claims first there is no SOL refund.`],
 ['If the maker does not finish', 'After your confirmation is on chain, the maker, while it is running, can start its claim until the claim deadline, which is 5 hours after you started, and then has 1 hour to finish it. If it has not claimed, your SOL stays locked until both have run out: not before about 5 hours after you started, and a late maker start can push that past six hours. Then the refund still has to be confirmed on chain. Silo starts it while it is open, or when you open it again. Once the maker has claimed, there is no SOL refund: recovery means collecting your XMR.'],
 ['Beta', 'Small amounts only. Software not externally audited.'],
].map((row) => Object.freeze(row)));

// Phase, final and stage sentences (moved here from the status and return modules, Astra 759 round 2: one source).
/** SOL to XMR, one swap phase (atomic-reverse-driver phases). @param {{xmr?:string,confirmations?:number,target?:number,scanFailed?:boolean}} [c] */
export function reversePhaseCopy(phase, c = {}) {
  const xmr = c.xmr ?? '', target = Number.isSafeInteger(c.target) ? c.target : 10;
  const n = Math.max(0, Math.min(target, Number.isFinite(c.confirmations) ? c.confirmations : 0));
  switch (phase) {
    case 'locking': return {
      headline: 'Locking your SOL',
      detail: 'Your Silo Solana wallet signs one lock into the swap program. It can only go to the maker after your XMR has arrived.',
      nextAction: 'The maker sends your XMR to a shared Monero address.',
      eta: 'Usually a minute or two, but it can take longer.' };
    case 'awaiting-maker-xmr': return {
      headline: 'The maker is sending your XMR',
      detail: REVERSE_WAIT_DETAIL,
      nextAction: reverseWaitNext(target),
      eta: 'Usually the maker sends within minutes, but it can take longer.' };
    case 'xmr-check-failed':
    case 'xmr-confirming': return c.scanFailed || phase === 'xmr-check-failed' ? {
      headline: REVERSE_SCAN_FAILED_HEADLINE,
      detail: REVERSE_SCAN_FAILED_DETAIL,
      nextAction: REVERSE_SCAN_FAILED_NEXT,
      eta: REVERSE_SCAN_FAILED_ETA } : {
      headline: `${n} of ${target} confirmations`,
      detail: 'Your XMR is being confirmed by the Monero network. No action needed.',
      nextAction: reverseWaitNext(target),
      eta: 'Usually about 35 minutes in all, but it can take longer.' };
    case 'confirming': return {
      headline: 'Your XMR arrived',
      detail: `Silo saw ${xmr} XMR with ${target} confirmations and tells the swap program the maker may take the SOL.`,
      nextAction: 'The maker claims the SOL, which gives Silo the key to your XMR.',
      eta: 'Usually a minute or two, but it can take longer.' };
    case 'await-claim': return {
      headline: 'The maker is claiming the SOL',
      detail: 'When it does, Silo gets the key to the shared address and moves your XMR into your wallet. If the maker goes quiet, your SOL cannot come back before about 5 hours after you started, and a late maker commit can push that past six hours.',
      nextAction: 'Your XMR moves into your Silo Monero wallet.',
      eta: 'Usually the maker claims within minutes, but it can take hours.' };
    case 'sweeping': return {
      headline: 'Moving your XMR into your wallet',
      detail: 'One Monero transaction from the shared address to your own Silo Monero address.',
      nextAction: 'The XMR shows in your Monero wallet after Monero confirmations.',
      eta: 'Usually a few minutes, then Monero confirmations. It can take longer.' };
    case 'refunding': return {
      headline: REVERSE_REFUNDING_HEADLINE,
      detail: REVERSE_REFUNDING_DETAIL,
      nextAction: REVERSE_REFUNDING_NEXT,
      eta: 'Usually a few minutes once it starts, but it can take longer.' };
    default: return {
      headline: 'Setting up the swap',
      detail: 'Silo is checking the maker’s offer. Nothing has been locked.',
      nextAction: 'Your Silo Solana wallet locks the SOL.',
      eta: 'Usually a few seconds, but it can take longer.' };
  }
}

/** SOL to XMR, a finished swap. */
export function reverseFinalCopy(result) {
  if (result === 'xmr-received') return { headline: 'Received', detail: 'The XMR went to your Silo Monero wallet, less one Monero network fee. It shows there after Monero confirmations.', nextAction: 'Open your XMR to see it.', eta: null };
  if (result === 'sol-refunded') return { headline: 'SOL sent back', detail: 'The swap did not finish, so the SOL went back to your Silo Solana wallet.', nextAction: 'Open your SOL to see it.', eta: null };
  return { headline: 'Nothing was locked', detail: 'Your SOL is still in your Silo Solana wallet.', nextAction: 'You can get a new offer.', eta: null };
}


const RETURN_NEXT = Object.freeze({
  start: 'Stay on this screen until your SOL shows as locked.',
  confirm: 'Open and unlock Silo again before the time shown so it can check your XMR and confirm.',
  pending: 'Keep this page open, or reopen and unlock Silo, so it can attempt the confirmation again if needed.',
  collect: 'Open and unlock Silo so it can move your XMR into your wallet.',
  refund: 'Open and unlock Silo so it can try the refund once the swap rules allow, and keep it open and unlocked until the refund shows as done.',
});
const RETURN_ETA = Object.freeze({
  start: 'Usually a minute or two, but it can take longer.',
  confirm: 'Usually about 40 minutes after you start, but it can take longer. Come back before the time shown.',
  pending: null,
  collect: 'The maker can claim until about 5 hours after you started, so this can take hours.',
  refund: 'It can exceed six hours after you started.',
});

const PENDING_LATE_NEXT = 'Open and unlock Silo so it can check whether your confirmation landed. If it did not land and the maker has not claimed, your SOL can be refunded once the swap rules allow.';
const COLLECT_WAIT_NEXT = 'Open and unlock Silo after the maker claims so it can move your XMR into your wallet.';
const COLLECT_CLAIMED_ETA = 'Moving your XMR takes one Monero transaction, then Monero confirmations; this can take longer on a slow network.';
/** Next action and time hint for one leave-and-return stage. @param {{stage?:string,late?:boolean,claimed?:boolean}|null} plan */
export function reverseReturnWords(plan) {
  const stage = plan && RETURN_NEXT[plan.stage] ? plan.stage : 'refund', claimed = plan?.claimed === true;
  const nextAction = stage === 'pending' && plan?.late ? PENDING_LATE_NEXT : stage === 'collect' && claimed ? RETURN_NEXT.collect : stage === 'collect' ? COLLECT_WAIT_NEXT : RETURN_NEXT[stage];
  return { nextAction, eta: stage === 'collect' && claimed ? COLLECT_CLAIMED_ETA : RETURN_ETA[stage] };
}
const CONFIRM_HEAD = 'You can close this page once your SOL shows as locked.';
const COLLECT_CLAIMED = 'The maker has claimed the SOL, so there is no SOL refund now. Your XMR sits at a shared address and the protocol sets no deadline for moving it, but Silo can move it only with this swap\'s record (saved on this device or in a backup that contains it) and the key the maker revealed with its claim, plus a Solana node and a Monero node with usable history. Open and unlock Silo to move it.';
/** Title, visible line, extra notes for one stage. `time` is reverseConfirmTime's answer, `last` the "Latest possible" text, `plan.late` whether it has passed.
 * @param {{stage?:string,late?:boolean,claimed?:boolean}|null} plan @param {{kind:string|null,text:string|null,suggestedPassed?:boolean}} time @param {string|null} last */
export function reverseStageCopy(plan, time, last) {
  switch (plan?.stage) {
    case 'start': return { title: 'Starting your swap', line: 'Stay on this screen until your SOL shows as locked.', more: [] };
    case 'confirm': return { title: 'Your step: confirm your XMR',
      line: time.kind === 'comeBack' ? `${CONFIRM_HEAD} Open and unlock Silo again before ${time.text} to confirm your XMR.`
        : time.kind === 'latest' ? `${CONFIRM_HEAD} ${time.suggestedPassed ? 'The suggested time has passed: open and unlock Silo now' : 'Open and unlock Silo'} to confirm your XMR. Latest possible: ${time.text}.`
        : `${CONFIRM_HEAD} Open and unlock Silo now to confirm your XMR.`, more: REVERSE_RECOVERY_NOTES };
    case 'pending': return { title: 'Confirmation pending',
      line: plan.late
        ? 'Silo attempted your confirmation but has not seen it land, and the time to attempt it again has passed. Open and unlock Silo: if it did not land and the maker has not claimed, your SOL can be refunded once the swap rules allow, which can exceed six hours after you started.'
        : `Silo attempted your confirmation but has not seen it land yet. Keep this page open, or reopen and unlock Silo${last ? ` before ${last}` : ''}, so it can attempt it again if needed.`, more: REVERSE_RECOVERY_NOTES };
    case 'collect': return plan.claimed ? { title: 'Your XMR is ready to move', line: COLLECT_CLAIMED, more: [] } : {
      title: 'Waiting for the maker to claim',
      line: 'Your confirmation is on chain and you can close this page. While the maker is running it can claim the SOL, which gives Silo the key to your XMR; then open and unlock Silo to move it.',
      more: ['If the maker does not claim, your SOL cannot be refunded before about 5 hours after you started, and a late maker commit can push that past six hours.', ...REVERSE_RECOVERY_NOTES] };
    default: return { title: 'Take your SOL back',
      line: 'Open and unlock Silo and it tries the refund once the swap rules allow, if the maker has not claimed. Keep it open and unlocked until the refund shows as done. Your SOL is not taken meanwhile.',
      more: ['If no confirmation was sent, the rules may already allow the refund; Silo\'s own attempt still needs it open and unlocked, and settling can take a while. If one may have been attempted, the refund waits until the maker\'s claim window is over, which can exceed six hours after you started. If the maker claims first, there is no SOL refund: recovery means collecting your XMR.', REVERSE_ATTEMPT, REVERSE_BACKUP] };
  }
}
