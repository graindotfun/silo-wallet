// Retention of finished swap records (privacy, lead request of 10 Nov 2026).
// A swap file holds per-swap data (the one-time view key until scrubbed, the user's Solana refund address, signatures), so keeping it forever links
// users to swaps. 14 days after a swap is FINISHED its file is reduced to { swapId, direction, done (the outcome), finishedAt, amounts, createdAt day }.
// Finished means: a terminal result proven at finalized commitment (done + finalEvidence), no send attempt still open, and the maker's secrets already
// scrubbed. Anything else (open, waiting for proof, an attempt unsettled, a secret still present) is at risk and is NEVER touched.
// The record is rewritten, not deleted, because the journal names every recorded swap and the quiesce check reads the directory.
import { OPEN_ATTEMPT_STATES, ATTEMPT_LISTS } from './maker-core.mjs';

export const RETENTION_MS = 14 * 24 * 3600 * 1000;
export const CLOCK_FLOOR_MS = Date.parse('2026-11-10T00:00:00.000Z');   // a clock earlier than this is wrong: delete nothing

export function isFinished(s) {
  if (!s || s.reduced || !s.done) return false;
  if (!Number.isInteger(s.finalEvidence?.finalizedSlot)) return false;
  if (ATTEMPT_LISTS.some((l) => (s[l] ?? []).some((a) => a && OPEN_ATTEMPT_STATES.has(a.state)))) return false;
  if ('a' in s || 'b' in s) return false;   // a secret that is still needed (or not yet scrubbed) means funds could still be at risk
  return true;
}

/** @returns the reduced record, or null when the record must be kept. finishedMs: s.finishedAt, else the caller's fallback (file mtime). */
export function reduceIfDue(s, { nowMs, fallbackFinishedMs = null, retentionMs = RETENTION_MS, pda = null }) {
  if (!isFinished(s)) return null;
  const finishedMs = s.finishedAt ? Date.parse(s.finishedAt) : fallbackFinishedMs;
  if (!Number.isFinite(finishedMs) || !Number.isFinite(nowMs)) return null;
  if (nowMs < CLOCK_FLOOR_MS || finishedMs > nowMs) return null;          // bad clock or a finish time in the future: keep
  if (nowMs - finishedMs < retentionMs) return null;
  const finishedAt = new Date(finishedMs).toISOString();
  const day = String(s.createdAt ?? finishedAt).slice(0, 10);
  const out = { swapId: s.swapId, direction: s.direction ?? 'xmr-sol', done: s.done, finishedAt, createdAt: `${day}T00:00:00.000Z`, xmrAtomic: s.xmrAtomic, reduced: true };
  if (s.lamports !== undefined) out.lamports = s.lamports;
  if (s.lane === 'public') out.lane = 'public';   // which lane it came from (open maker endpoint); no user data
  // 709-M2: the minimum verifiable escrow identity stays, so the upgrade check can still read the escrow's absence on chain: for a SOL -> XMR
  // swap the refunder (the quiescence collector derives the strict PDA from it) and the PDA itself; for XMR -> SOL the PDA (the refunder is the maker).
  // This keeps one address per reverse swap on disk: the unavoidable price of an upgrade check that proves nothing is still open.
  if (s.direction === 'sol-xmr') out.refunder = s.refunder;
  if (pda) out.pda = pda;
  return out;
}

/** deps = { ids(): string[], load(id), write(record), mtimeMs(id), nowMs(), log(e), pdaOf?(record) }. One bad file never stops the pass. */
export function pruneFinished(deps) {
  let reduced = 0;
  const nowMs = deps.nowMs();
  for (const id of deps.ids()) {
    try {
      const s = deps.load(id);
      const r = reduceIfDue(s, { nowMs, fallbackFinishedMs: s.finishedAt ? null : deps.mtimeMs(id), pda: deps.pdaOf ? deps.pdaOf(s) : null });
      if (r) { deps.write(r); reduced += 1; }
    } catch (e) { deps.log({ event: 'retention-error', swapId: id, error: String(e?.message ?? e).slice(0, 120) }); }
  }
  if (reduced) deps.log({ event: 'retention-reduced', count: reduced });
  return reduced;
}
