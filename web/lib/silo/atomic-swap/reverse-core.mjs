// Pure decision logic for SOL -> XMR (user = Bob, the refunder; maker = Alice, the claimer).
// Strict mode (owner decision P, 5 Nov 2026): the escrow uses the program's *_strict instructions, where the claim ALWAYS
// needs the user's ready. Protocol v2 (8 Nov 2026) makes the claim two-step. Windows (c = claim_committed_at, W = REV_COMMIT_WINDOW):
//   !ready                         -> refund only (any time)
//   ready, no commit, now < t1     -> nobody; the maker may COMMIT (secret-free). The user waits.
//   ready, no commit, now >= t1    -> refund only (a commit can no longer land)
//   ready, commit c                -> claim only on [c, c + W); refund from max(t1, c + W)
// set_ready only before t0. So the maker can never take the SOL without the user's confirmation (U5 closed), and the secret `a` is sent only
// when the deadline is a number read from the chain: the refund cannot open before c + W, so a resend inside W is always safe.
// No I/O: drivers observe both chains, call these functions, and perform exactly the returned action.
// Threat model: docs/research/xmr-sol-atomic-swap/SOL_TO_XMR_THREAT_MODEL.md (rules U1-U5, M1-M5).
import { MARGIN, LOCK_WAIT, CONFIRMATIONS, ABORT_LEAD, escrowMatches } from './swap-core.mjs';

// t0 = the last moment the user may confirm (set_ready). Strict mode keeps the SOL safe whatever t0 is, so it only bounds
// how long the maker's XMR can wait for a confirmation: 3 h covers slow Monero confirmations several times over.
export const REV_T0_LEAD = 3 * 3600;       // s: t0 after the user's SOL lock
export const REV_CLAIM_WINDOW = 2 * 3600;  // s: t1 - t0: after a ready, the maker claims before t1, else the user refunds
export const REV_LEAD_SLACK = 600;         // s: clock slack the maker allows on the user's chosen t0
export const REV_SEND_MIN_LEAD = 2 * 3600; // s: the maker sends XMR only if 10 confirmations + ready fit before t0
export const REV_COMMIT_WINDOW = 3600;     // s: = CLAIM_WINDOW_S in the program: the claim may land this long after the maker's commit, and the refund waits behind it
/** The latest the user's SOL can still be locked after a ready: the claim window (t1 - t0) plus the commit window. Shown to the user as "up to 3 hours". */
export const REV_MAX_HOLD_AFTER_T0 = REV_CLAIM_WINDOW + REV_COMMIT_WINDOW;

/** The timelocks the user puts in the lock, from the user's clock. */
export function reverseTimelocks(now) {
  if (!Number.isSafeInteger(now)) throw Error('bad clock');
  const t0 = now + REV_T0_LEAD;
  return { t0, t1: t0 + REV_CLAIM_WINDOW };
}
/** The maker accepts the user's timelocks only near the agreed shape (it must not be locked for longer). */
export function reverseTimelocksAcceptable(t0, t1, now) {
  return Number.isSafeInteger(t0) && Number.isSafeInteger(t1)
    && Math.abs(t0 - (now + REV_T0_LEAD)) <= REV_LEAD_SLACK + LOCK_WAIT // the escrow may be read up to LOCK_WAIT after the lock
    && t1 - t0 === REV_CLAIM_WINDOW;
}
const usable = (x, expected) => !!x && BigInt(x.atomic) >= BigInt(expected) && x.confirmations >= CONFIRMATIONS;

/**
 * The Silo user (Bob) decides the next step.
 * obs = { now, terms, pda, outcome, solLockAttempted, lockedAt, xmr, xmrSwept, quoteExpiresAt }
 *   terms   = what the user agreed and will lock: { A, B, claimer, refunder, lamports, t0, t1, xmrAtomic, makerProofOk }
 *   pda     = null | the escrow as read on Solana
 *   xmr     = null | { atomic, confirmations }: the user's OWN view-only scan of the joint address (U2), unlock_time 0
 *             outputs only, the pool included with 0 confirmations
 *   outcome = null | { kind: 'claimed' | 'refunded', secret }
 */
export function userNext(o) {
  if (o.outcome?.kind === 'claimed') return o.xmrSwept ? { action: 'done', result: 'xmr-received' } : { action: 'sweep-xmr', secret: o.outcome.secret }; // U4
  if (o.outcome?.kind === 'refunded') return { action: 'done', result: 'sol-refunded' };
  const t = o.terms;
  if (!o.pda) {
    if (o.solLockAttempted) return { action: 'wait', reason: 'pda-missing-after-lock' }; // RPC lag; never lock twice
    if (!t?.makerProofOk) return { action: 'done', result: 'bad-terms' };
    if (o.now > o.quoteExpiresAt) return { action: 'done', result: 'quote-expired' };
    return { action: 'lock-sol' };
  }
  const p = o.pda;
  // The escrow is immutable; a mismatch is a wrong reading, never a reason to act.
  if (!escrowMatches(t, p)) return { action: 'wait', reason: 'escrow-does-not-match' };
  if (p.ready) {
    // U3 (v2): refund only where the program allows it, plus MARGIN: never a commit seen (c > 0) and not run out, never before t1.
    // `pda` must come from a FINALIZED read for this decision (bob-flow.nextReverseAction enforces it): a commit that landed just before t1 must not be missed.
    const c = Number.isSafeInteger(p.claimCommittedAt) ? p.claimCommittedAt : 0;
    const opens = c > 0 ? Math.max(p.t1, c + REV_COMMIT_WINDOW) : p.t1;
    if (o.now >= opens + MARGIN) return { action: 'refund' };
    return { action: 'wait', reason: 'await-maker-claim' };
  }
  // Not ready: the refund is open at any time (strict mode), and nobody can claim.
  if (usable(o.xmr, t.xmrAtomic) && o.now < p.t0 - MARGIN) return { action: 'set-ready' }; // U2: only on our own scan
  if (o.now >= p.t0 - ABORT_LEAD) return { action: 'refund' };                     // U1: too late to confirm; take the SOL back
  if (!o.xmr && o.now > o.lockedAt + LOCK_WAIT) return { action: 'refund' };       // U1: the maker never sent
  if (o.xmr && o.xmr.confirmations >= CONFIRMATIONS && BigInt(o.xmr.atomic) < BigInt(t.xmrAtomic)) return { action: 'refund' }; // U1: underpaid
  return { action: 'wait', reason: o.xmr ? 'xmr-confirming' : 'await-maker-xmr' };
}

/**
 * The maker (Alice) decides the next step for one SOL -> XMR swap.
 * obs = { now, terms, pda, outcome, xmrSent, xmrOwn, xmrRecovered, finalized }
 *   terms   = its quote: { A, B, claimer (its key), refunder (the user), lamports, t0, t1, xmrAtomic, userProofOk }
 *   pda     = null | the escrow at finalized commitment
 *   xmrSent = null | txid of its own transfer to the joint address (recorded BEFORE broadcast, M2)
 *   xmrOwn  = null | { atomic, confirmations } of that transfer as seen at the joint address
 */
export function makerReverseNext(o) {
  if (o.outcome?.kind === 'claimed') return { action: 'done', result: 'completed' };
  if (o.outcome?.kind === 'refunded') {
    if (o.xmrSent && !o.xmrRecovered) return { action: 'recover-xmr', secret: o.outcome.secret }; // M4
    return { action: 'done', result: o.xmrSent ? 'xmr-recovered' : 'refunded-before-send' };
  }
  if (!o.pda) return { action: 'wait', reason: 'pda-missing' };
  const t = o.terms, p = o.pda;
  if (!o.xmrSent) {
    const ok = t.userProofOk && o.finalized && escrowMatches(t, p) && !p.ready;        // M1
    if (!ok) return { action: 'wait', reason: 'escrow-not-acceptable' };              // send nothing; the user refunds
    if (o.now >= p.t0 - REV_SEND_MIN_LEAD) return { action: 'wait', reason: 'too-late-to-send' };
    return { action: 'send-xmr' };
  }
  if (!escrowMatches(t, p)) return { action: 'wait', reason: 'escrow-does-not-match' };
  const confirmed = usable(o.xmrOwn, t.xmrAtomic);                                   // M3
  // Strict mode v2: step two (the secret) only after the finalized account shows the maker's commit, and only inside [c, c + W - MARGIN).
  // The deadline is the number on chain, not an estimate. A resend inside it is harmless: the refund cannot open before c + W.
  const c = Number.isSafeInteger(p.claimCommittedAt) ? p.claimCommittedAt : 0;
  if (p.ready && c > 0) {
    if (o.now < c + REV_COMMIT_WINDOW - MARGIN) return { action: 'claim' };
    return { action: 'wait', reason: 'claim-window-closed-await-refund' };           // never claim late; the user refunds, `b` is revealed, the maker recovers its XMR (M4)
  }
  // Step one (no secret): only after the user's ready, with its own XMR confirmed, and early enough that the commit can land before t1.
  if (o.now < p.t1 - MARGIN && confirmed && p.ready) return { action: 'commit-claim' };
  if (o.now >= p.t1 - MARGIN) return { action: 'wait', reason: 'claim-window-closed-await-refund' };
  return { action: 'wait', reason: p.ready ? 'xmr-confirming-own' : 'await-user-ready' };
}
