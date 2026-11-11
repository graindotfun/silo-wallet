// User side (Bob, the refunder) of SOL -> XMR, browser-safe. Silo drives this module: it holds the per-swap secrets
// (b, the shared view key v), checks the maker's registration, builds the three transactions the user's wallet signs
// (lock, set_ready, refund: atomic-swap/refunder-tx.mjs, checked again inside the keyring), and derives the Monero keys
// that sweep the XMR once the maker's claim reveals a. Decisions come from reverse-core.mjs (rules U1-U5).
import { Buffer } from 'buffer';
import { randomScalar, pub, addPoints, addScalars, moneroAddress, fromLE, toLE, hex, unhex, proveShare, verifyShare } from './keys.mjs';
import { matchRevealed } from './sol.mjs';
import { MARGIN } from './swap-core.mjs';
import { userNext, REV_T0_LEAD, REV_CLAIM_WINDOW, REV_LEAD_SLACK } from './reverse-core.mjs';
import { buildSiloAtomicRefunderTx, atomicSwapPda, decodeStrictSwap, SILO_ATOMIC_PROGRAM_ID, SILO_ATOMIC_MAX_LOCK_LAMPORTS } from './refunder-tx.mjs';

export const REVERSE_RECORD_KIND = 'silo-atomic-sol-xmr-v1';
const net = (r) => (r.network === 'mainnet' ? 'mainnet' : 'stagenet');

/** Step 1: fresh secrets for one swap. Persist the returned record BEFORE registering with the maker. */
export function newReverseRecord({ owner, quote, network }) {
  if (quote?.direction !== 'sol-xmr') throw new Error('not-a-sol-xmr-quote');
  const b = randomScalar(), v = randomScalar(), swapId = unhex(quote.swapId);
  return { kind: REVERSE_RECORD_KIND, network, createdAt: Date.now(), quote, owner, swapId: quote.swapId,
    b: hex(toLE(b)), B: hex(pub(b)), v: hex(toLE(v)), V: hex(pub(v)), proofB: proveShare(b, swapId, 1), status: 'quoted' };
}
/** What Silo sends to the maker (never b). The private view key is shared by design: both sides watch the joint address. */
export const reverseRegisterRequest = (r) => ({ quoteId: r.quote.quoteId, refunder: r.owner, B: r.B, proofB: r.proofB, v: r.v });

/** Step 2: accept the maker's registration only if it is self-consistent. `now` = the user's own clock (seconds). */
export function acceptMakerRegistration(r, m, now = Math.floor(Date.now() / 1000)) {
  const q = r.quote;
  if (!verifyShare(unhex(q.A), q.proofA, unhex(r.swapId), 0)) throw new Error('maker-share-proof-invalid');
  if (m.swapId !== r.swapId || m.claimer !== q.claimer || m.claimPoint !== q.A) throw new Error('terms-mismatch');
  if (m.claimer === r.owner) throw new Error('maker-is-this-wallet');
  if (m.lamports !== q.lamports || m.xmrAtomic !== q.xmrAtomic) throw new Error('terms-mismatch');
  if (!(Number.isSafeInteger(m.lamports) && m.lamports > 0 && m.lamports <= SILO_ATOMIC_MAX_LOCK_LAMPORTS)) throw new Error('amount-outside-limits');
  // Timelocks as agreed (U5): t0 about REV_T0_LEAD (3 h) ahead and the maker's claim window exactly REV_CLAIM_WINDOW (2 h), so t1 = t0 + 2 h.
  // Strict mode lets the user refund any time before ready; after ready from t1 on, or one REV_COMMIT_WINDOW (1 h) after the maker's commit if it committed (v2: up to REV_MAX_HOLD_AFTER_T0 = 3 h after t0).
  if (!(Number.isSafeInteger(m.t0) && Number.isSafeInteger(m.t1) && Math.abs(m.t0 - (now + REV_T0_LEAD)) <= REV_LEAD_SLACK && m.t1 - m.t0 === REV_CLAIM_WINDOW)) throw new Error('timelocks-outside-bounds');
  const joint = moneroAddress(addPoints(unhex(q.A), unhex(r.B)), unhex(r.V), net(r));
  if (joint !== m.jointAddress) throw new Error('joint-address-mismatch');
  const pda = atomicSwapPda(r.owner, unhex(r.swapId)).toBase58();
  if (m.pda !== pda) throw new Error('pda-mismatch');
  return { ...r, A: q.A, claimer: q.claimer, jointAddress: joint, pda, t0: m.t0, t1: m.t1, acceptedAt: now, status: 'registered' };
}

const lockFields = (r) => ({ owner: r.owner, swapId: unhex(r.swapId), claimer: r.claimer, claimPoint: unhex(r.A), refundPoint: unhex(r.B), lamports: r.quote.lamports, t0: r.t0, t1: r.t1 });
/** The record the keyring compares a signing request against (native-keyring signReviewedAtomic). */
export function signingExpectation(kind, r) {
  if (kind === 'lock') return { kind, swapId: r.swapId, claimer: r.claimer, claimPoint: r.A, refundPoint: r.B, lamports: r.quote.lamports, t0: r.t0, t1: r.t1 };
  if (kind === 'ready') return { kind, swapId: r.swapId };
  if (kind === 'refund') return { kind, swapId: r.swapId, secret: r.b };
  throw new Error('unknown-step');
}
/** Unsigned base64 transaction for one step. */
export function buildStepTx(kind, r, blockhash) {
  const f = kind === 'lock' ? lockFields(r) : kind === 'ready' ? { owner: r.owner, swapId: unhex(r.swapId) } : { owner: r.owner, swapId: unhex(r.swapId), secret: unhex(r.b) };
  return Buffer.from(buildSiloAtomicRefunderTx(kind, f, blockhash).serialize()).toString('base64');
}

/**
 * The ONLY chain view used for decisions: an independent public RPC, never the Silo server (same rules as XMR -> SOL's
 * readChainIndependent, H1/H7). The escrow is a strict one; its outcome is read from the paged history, bound to this escrow
 * and to the expected point (a claim reveals a, a refund b). Returns { now, pda, outcome, blockhash, historyCursor }.
 */
export async function readReverseChain(r, rpcCall, { maxPages = 20 } = {}) {
  let historyCursor = r.historyCursor ?? null;
  const slot = await rpcCall('getSlot', [{ commitment: 'confirmed' }]);
  const now = await rpcCall('getBlockTime', [slot]);
  if (!Number.isSafeInteger(now)) throw new Error('chain-time-unavailable');
  const acc = (await rpcCall('getAccountInfo', [r.pda, { encoding: 'base64', commitment: 'confirmed' }]))?.value ?? null;
  let pda = null, outcome = null, snapshot;
  if (acc && acc.owner === SILO_ATOMIC_PROGRAM_ID) { try { pda = decodeStrictSwap(Buffer.from(acc.data[0], 'base64')); } catch { pda = null; } }
  // Astra 691-H1: b (the refund secret) may leave the device only on COHERENT FINALIZED evidence: one finalized account read, and the block time of THAT SAME slot (never the
  // time of another, newer slot read separately). The response context slot X says which state was read; T = getBlockTime(X) says when that state was current. A skipped slot
  // has no block time: step down to an earlier slot (an earlier time only delays a refund). Read whenever a ready may exist: the escrow shows ready, or this record sent or may have sent a ready.
  const readyMayExist = Boolean(pda?.ready) || r.branch === 'ready' || Boolean(r.readyAttemptAt) || Boolean(r.readyAttempts?.length);
  if (pda && readyMayExist) {
    try {
      const fin = await rpcCall('getAccountInfo', [r.pda, { encoding: 'base64', commitment: 'finalized' }]);
      const X = fin?.context?.slot; let time = null, at = null;
      if (Number.isSafeInteger(X) && fin && Object.prototype.hasOwnProperty.call(fin, 'value')) {
        for (let k = 0; k < 8 && time === null; k++) { try { const t = await rpcCall('getBlockTime', [X - k]); if (Number.isSafeInteger(t)) { time = t; at = X - k; } } catch { /* skipped slot: try an earlier one */ } }
        if (time !== null) {
          const v = fin.value;
          snapshot = { slot: X, timeSlot: at, time, pda: v && v.owner === SILO_ATOMIC_PROGRAM_ID ? decodeStrictSwap(Buffer.from(v.data[0], 'base64')) : null };
        }
      }
    } catch { snapshot = undefined; }
  }
  if (!pda) {
    let before = historyCursor ?? undefined;
    outer: for (let page = 0; page < maxPages; page++) {
      const rows = (await rpcCall('getSignaturesForAddress', [r.pda, { limit: 1000, before, commitment: 'confirmed' }])) ?? [];
      for (const row of rows) {
        if (row.err) continue;
        const tx = await rpcCall('getTransaction', [row.signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
        if (!tx?.transaction?.message || tx.meta?.err) continue;
        const c = matchRevealed(tx.transaction.message, { pda: r.pda, which: 'claim_strict', expectedPoint: r.A });
        if (c) { outcome = { kind: 'claimed', secret: hex(c), sig: row.signature }; break outer; }
        const f = matchRevealed(tx.transaction.message, { pda: r.pda, which: 'refund_strict', expectedPoint: r.B });
        if (f) { outcome = { kind: 'refunded', secret: hex(f), sig: row.signature }; break outer; }
      }
      if (rows.length < 1000) { historyCursor = null; break; }
      before = rows[rows.length - 1].signature;
      historyCursor = before;
    }
    if (outcome) historyCursor = null;
  }
  const blockhash = (await rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }]))?.value?.blockhash;
  if (typeof blockhash !== 'string') throw new Error('chain-read-incomplete');
  return { now, pda, snapshot, readyMayExist, outcome, blockhash, historyCursor };
}

/** Observations -> next action (reverse-core.userNext). xmr = the user's own view-only scan of the joint address. */
export function nextReverseAction(r, chain, xmr) {
  const decideAt = (now, pda) => decide(pda, now);
  const decide = (pda, now = chain.now) => userNext({ now, pda, outcome: chain.outcome, solLockAttempted: !!r.lockAttemptAt, lockedAt: r.lockedAt ?? r.acceptedAt,
    xmr, xmrSwept: !!r.xmrSweptTxids, quoteExpiresAt: r.quote.expiresAt,
    terms: { A: r.A, B: r.B, claimer: r.claimer, refunder: r.owner, lamports: r.quote.lamports, t0: r.t0, t1: r.t1, xmrAtomic: r.quote.xmrAtomic,
      makerProofOk: !!r.quote.proofA && verifyShare(unhex(r.quote.A), r.quote.proofA, unhex(r.swapId), 0) } });
  const first = decide(chain.pda);
  // Astra 691-H1: EVERY refund (not only one decided from a ready escrow) that a ready may still affect is decided again on the coherent finalized snapshot: its own time, its own
  // account. A stale "not ready" or "no commit" read, or a clock newer than the account, can therefore never release b. Without any ready ever sent by this record, nobody else can
  // set ready (only this wallet signs it), so the confirmed view is enough, as before.
  if (first.action === 'refund' && chain.readyMayExist) {
    const sn = chain.snapshot;
    if (!sn || !sn.pda) return { action: 'wait', reason: 'await-finalized-escrow' };
    const p = sn.pda;
    // not ready at the snapshot: a ready could still land until t0; only after t0 + MARGIN on the snapshot's own time is "not ready" permanent
    if (!p.ready) return sn.time >= p.t0 + MARGIN ? { action: 'refund' } : { action: 'wait', reason: 'await-finalized-ready-resolution' };
    return decideAt(sn.time, p);
  }
  return first;
}

/** After the maker's claim reveals a: the full key of the joint address, to sweep into the user's own Silo XMR wallet. */
export function sweepKeys(r, revealedA) {
  const a = fromLE(unhex(revealedA));
  if (hex(pub(a)) !== r.A) throw new Error('revealed-scalar-does-not-open-A');
  const spend = addScalars(a, fromLE(unhex(r.b)));
  const address = moneroAddress(pub(spend), unhex(r.V), net(r));
  if (address !== r.jointAddress) throw new Error('joint-key-mismatch');
  return { primaryAddress: address, privateSpendKey: hex(toLE(spend)), privateViewKey: r.v, restoreHeight: Math.max(0, (r.restoreHeight ?? 0) - 20) };
}
/** View-only keys for the user's own scan of the joint address (U2). */
export const watchKeys = (r) => ({ primaryAddress: r.jointAddress, privateViewKey: r.v, restoreHeight: Math.max(0, (r.restoreHeight ?? 0) - 20) });
