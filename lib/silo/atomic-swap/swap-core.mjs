// SPDX-License-Identifier: AGPL-3.0-only
// Pure decision logic for the XMR -> SOL beta (user = Alice, maker = Bob).
// No I/O here: drivers (Silo UI, maker bot) observe the chains, call these functions,
// and perform exactly the returned action. Every rule that protects funds lives here.

export const MARGIN = 300;          // s: never reveal a scalar this close to a window edge
export const LOCK_MIN_LEAD = 3600;  // s: Alice locks XMR only if t0 is at least this far away
export const LOCK_WAIT = 1800;      // s: maker aborts if no XMR is seen this long after its SOL lock
export const CONFIRMATIONS = 10;
/** The maker's depth for one swap: an integer 1..CONFIRMATIONS, anything else (missing, garbage, higher) is CONFIRMATIONS. */
export const makerConfirmations = (n) => (Number.isSafeInteger(n) && n >= 1 && n <= CONFIRMATIONS ? n : CONFIRMATIONS);
export const CLAIM_FEE = 5000;          // lamports: one signature, no priority fee
export const MIN_GAS = 2 * CLAIM_FEE;    // the fee payer must hold this before the user funds XMR (H2)
export const ABORT_LEAD = 900;     // s: an online maker is expected not to let t0 arrive on an unready escrow
// Timelock bounds the user accepts (H3): the maker cannot impose a long lockup.
export const T0_MAX_LEAD = 3 * 3600;      // t0 at most 3 h after the user accepted the maker's lock
// t1 at most 26 h after acceptance (leave and return, 5 Nov 2026): room for the maker's 24 h claim window (T1=86400) plus clock
// slack. A longer t1 only widens the user's claim window; it costs the maker capital and does not shorten the user's safe window.
export const T1_MAX_LEAD = 26 * 3600;
export const CLAIM_WINDOW_MIN = 3600;     // at least 1 h between t0 and t1

/** Every escrow field the user agreed to, compared with the independently read account (H2). */
export function escrowMatches(t, p) {
  return !!p && p.claimPoint === t.A && p.refundPoint === t.B && p.claimer === t.claimer && p.lamports === t.lamports
    && p.refunder === t.refunder && p.t0 === t.t0 && p.t1 === t.t1;
}
/** Timelocks are acceptable only inside the bounds above, relative to when the user accepted them. */
export function timelocksAcceptable(t0, t1, acceptedAt) {
  return Number.isSafeInteger(t0) && Number.isSafeInteger(t1) && t0 >= acceptedAt + LOCK_MIN_LEAD
    && t0 <= acceptedAt + T0_MAX_LEAD && t1 <= acceptedAt + T1_MAX_LEAD && t1 - t0 >= CLAIM_WINDOW_MIN;
}

/**
 * Alice (the Silo user) decides her next step.
 * obs = { now, terms, pda, outcome, xmrLockTxid, xmrRecovered, quoteExpiresAt }
 *   terms   = what Alice agreed: { A, B, claimer, lamports, bobProofOk }
 *   pda     = null | { ready, t0, t1, lamports, claimPoint, refundPoint, claimer }
 *   outcome = null | { kind: 'claimed' | 'refunded', secret }  (read from chain history)
 */
export function aliceNext(o) {
  if (o.outcome?.kind === 'claimed') return { action: 'done', result: 'sol-received' };
  if (o.outcome?.kind === 'refunded') {
    if (o.xmrLockTxid && !o.xmrRecovered) return { action: 'recover-xmr', secret: o.outcome.secret };
    return { action: 'done', result: o.xmrLockTxid ? 'xmr-recovered' : 'cancelled' };
  }
  if (!o.pda) {
    if (o.xmrLockTxid) return { action: 'wait', reason: 'pda-missing-after-lock' }; // RPC lag; never re-lock
    if (o.now > o.quoteExpiresAt) return { action: 'done', result: 'quote-expired' };
    return { action: 'wait', reason: 'maker-lock' };
  }
  const p = o.pda;
  if (!o.xmrLockTxid) {
    const t = o.terms;
    const ok = t.bobProofOk && escrowMatches(t, p) && timelocksAcceptable(p.t0, p.t1, t.acceptedAt);
    if (!ok) return { action: 'done', result: 'bad-terms' };            // never lock XMR
    if (o.now > p.t0 - LOCK_MIN_LEAD) return { action: 'done', result: 'too-late-to-lock' };
    // The claim must be payable before any XMR moves (H2). Only the fee payer's own key can spend its
    // balance, so a balance verified now cannot shrink before the claim.
    if (!(o.feePayerLamports >= MIN_GAS)) return { action: 'wait', reason: 'fee-payer-not-funded' };
    return { action: 'lock-xmr' };
  }
  // XMR is locked. Claim only against the escrow she agreed to (it is immutable, so a mismatch means a
  // wrong reading), and only while the window is safely open.
  if (!escrowMatches(o.terms, p)) return { action: 'wait', reason: 'escrow-does-not-match' };
  if (!(o.feePayerLamports >= CLAIM_FEE)) return { action: 'wait', reason: 'fee-payer-underfunded' };   // never build an unpayable claim (H2)
  if (o.now < p.t1 - MARGIN && (p.ready || o.now >= p.t0)) return { action: 'claim' };
  if (o.now >= p.t1 - MARGIN) return { action: 'wait', reason: 'claim-window-closed-await-maker-refund' };
  return { action: 'wait', reason: 'xmr-confirming' };
}

/**
 * Maker (Bob) decides the next step for one swap.
 * obs = { now, lockedAt, pda, outcome, xmr, xmrSwept, expectedAtomic, requiredConfirmations? }
 *   requiredConfirmations: the maker's own depth for this swap (1..CONFIRMATIONS, else CONFIRMATIONS). Only the maker
 *   bears a shallower depth: a reorg that drops the user's payment after ready is designed to be the maker's loss, not the user's.
 *   xmr = null | { atomic, confirmations }  (view-only scan of the joint address, pool included)
 */
export function makerNext(o) {
  if (o.outcome?.kind === 'claimed') return o.xmrSwept ? { action: 'done', result: 'completed' } : { action: 'sweep-xmr', secret: o.outcome.secret };
  if (o.outcome?.kind === 'refunded') return { action: 'done', result: 'refunded' };
  if (!o.pda) return { action: 'wait', reason: 'pda-missing' };
  const p = o.pda;
  if (o.now >= p.t1) return { action: 'refund' };                      // Alice vanished
  if (p.ready) return { action: 'wait', reason: 'await-claim' };
  const need = makerConfirmations(o.requiredConfirmations);
  const enough = o.xmr && BigInt(o.xmr.atomic) >= BigInt(o.expectedAtomic) && o.xmr.confirmations >= need;
  if (enough && o.now < p.t0 - MARGIN) return { action: 'set-ready' };
  // Deadline abort: after t0 the user may claim without ready, so an online maker that has not seen a
  // usable payment by now refunds (the user then recovers her XMR with the revealed b).
  if (o.now >= p.t0 - ABORT_LEAD && o.now < p.t0 - MARGIN) return { action: 'refund' };
  // Abort only if nothing at all arrived (pool included) and the early refund is safely open.
  if (!o.xmr && o.now > o.lockedAt + LOCK_WAIT && o.now < p.t0 - MARGIN) return { action: 'refund' };
  // Underpaid lock: abort early too; Alice recovers her XMR with the revealed b.
  if (o.xmr && o.xmr.confirmations >= need && BigInt(o.xmr.atomic) < BigInt(o.expectedAtomic) && o.now < p.t0 - MARGIN) return { action: 'refund' };
  return { action: 'wait', reason: o.xmr ? 'xmr-confirming' : 'await-xmr' };
}
