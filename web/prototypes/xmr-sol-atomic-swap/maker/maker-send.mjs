// Maker-only send path for set-ready and refund (Astra AG-R2-H1). Kept out of client/sol.mjs, which the browser shares.
//
// The refund carries the maker's scalar b in its instruction data. Zero signatures stop an RPC from authorizing such bytes, but they do
// not hide them, so the refund is NEVER simulated (signed or unsigned) and never priced with getFeeForMessage: the fee is fixed (one
// signature, compute limit SEND_COMPUTE_UNITS, and a priority fee that is bounded by configuration and read from the escrow account only, see priority-fee.mjs). One message is compiled with one blockhash and signed once locally;
// the attempt (action, swap id, signature, blockhash, last valid block height, the exact transaction bytes, its state and the exposure
// mark) is written durably (tmp, fsync, rename, fsync dir: the caller's store) BEFORE the same raw bytes go to every configured RPC
// (two independent endpoints on mainnet) with skipPreflight. An outcome is only ever settled from finalized evidence; while one is open
// no other variant of any action is created for that swap, across restarts too.
//
// When b may leave (client/swap-core.mjs, the exposure rule):
// - early (before t0, escrow not ready): only while t0 - max(local clock, confirmed chain time) >= max(EARLY_SEND_MIN_LEAD,
//   remaining blocks of the blockhash x MAX_SECONDS_PER_BLOCK + EARLY_LANDING_MARGIN). The atomic guarantee is the blockhash: those bytes
//   cannot land after its last valid block height. That is a bound in block height, not time: in a network halt the bytes may land
//   after t0 once the cluster resumes (the refund fails, b is on chain); the loss is the principal exposure of that swap (fees and the
//   number of swaps separate; the cap is in XMR, not a fixed SOL amount). Every input is read AFTER the blockhash and after every other await, and the check
//   runs synchronously right before signing. An early attempt not proven landed by t0 - EARLY_LANDING_MARGIN makes the swap 'ambiguous':
//   no further early attempt, no set-ready, only the t1 path.
// - late (from t1): only when a FINALIZED block's time is >= t1 + LATE_REFUND_MARGIN and the escrow still exists in a finalized context
//   at least that new. The local clock plays no part.
// set-ready carries no scalar: it may be simulated unsigned (all-zero signatures, sigVerify false), but its attempt is recorded the same
// way before it is sent, and it is never sent once b may have left.
//
// SOL -> XMR (protocol v2, the maker is the claimer of a strict escrow): the SAME discipline, the same attempt records, the same two
// endpoints and the same finalized settlement. Which secret, which party, when:
// - the user's b is revealed only by the user's own refund_strict (never by the maker); the maker reads it from the chain and recovers its XMR.
// - the maker's a is revealed only by claim_strict, and only after the maker's secret-free claim_commit_strict is FINALIZED (c on chain).
//   The program accepts the claim on [c, c + W) and keeps the refund shut until max(t1, c + W). The claim is the early refund's mirror image:
//   bytes that land at or after c + W fail, and a failed claim has already shown a while the user's refund is about to open. So a claim is
//   signed only while (c + W) - max(local clock, confirmed chain time) >= max(CLAIM_SEND_MIN_LEAD, remaining blocks x MAX_SECONDS_PER_BLOCK +
//   CLAIM_LANDING_MARGIN), with every input read after the blockhash and the check synchronous right before signing. ready and c are read at
//   FINALIZED commitment on EVERY endpoint, at least as new as the commit attempt's landed slot, and must agree. A claim attempt not settled
//   by (c + W) - CLAIM_LANDING_MARGIN makes the swap 'ambiguous' (claimAbort): no further claim, no rebroadcast; the maker only watches for
//   the user's refund and recovers its XMR from b (the documented v2 liveness residual). The claim is never simulated and never priced.
// - the commit carries no secret: like set-ready it may be simulated unsigned, and gets the same write-ahead record and two endpoints.
// While ANY attempt of a swap is open (either direction), nothing new is decided or sent for that swap.
import { Transaction, VersionedTransaction, ComputeBudgetProgram, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import * as sol from '../client/sol.mjs';
import { EARLY_SEND_MIN_LEAD, EARLY_LANDING_MARGIN, LATE_REFUND_MARGIN } from '../client/swap-core.mjs';
import { REV_COMMIT_WINDOW } from '../client/reverse-core.mjs';
import { strictPda, claimStrictIx, commitClaimStrictIx, decodeStrict } from './strict-sol.mjs';
import { ATTEMPT_LISTS, OPEN_ATTEMPT_STATES } from './maker-core.mjs';
import { computeBudgetIxs } from './priority-fee.mjs';

export const SEND_COMPUTE_UNITS = 60_000;
export const MAX_BLOCKHASH_BLOCKS = 151;      // a fresh blockhash is valid for 150 more blocks; anything above is not a fresh blockhash
export const MAX_SECONDS_PER_BLOCK = 3;       // ASSUMPTION, not a guarantee: 150 blocks take at most 450 s (nominal about 60 s); a halt breaks it
export const HEIGHT_AGREEMENT = 8;            // blocks: the endpoints' confirmed heights may differ by at most this (tolerated skew), else no early refund
// F5 (9 Nov rehearsal): the two heights are read concurrently and each read's start and end are measured (local clock). The two samples were taken at
// instants at most `gap = max(end) - min(start)` apart, and the chain moves SLOTS_PER_SECOND blocks per second, so that much skew is TOLERATED (it is not verified agreement).
// The allowance widens ONLY this comparison. The remaining-lifetime math of the claim uses the LOWER of the two heights (never the higher), so skew can never shorten the safety margin.
// The tolerance is HEIGHT_AGREEMENT plus ceil(gap * SLOTS_PER_SECOND), the allowance capped at HEIGHT_SKEW_CAP so a very slow endpoint can never buy a wide gap.
export const SLOTS_PER_SECOND = 2.5;   // blocks per second (nominal 400 ms slots)
export const HEIGHT_SKEW_CAP = 12;     // blocks: hard cap on the latency allowance (about 4.8 s of chain)
export function heightTolerance(crossCheck) {
  const t = crossCheck?.timing;
  if (!t || ![t.primaryStart, t.primaryEnd, t.secondaryStart, t.secondaryEnd].every(Number.isFinite)) return HEIGHT_AGREEMENT;   // no measurement, no allowance
  if (t.primaryEnd < t.primaryStart || t.secondaryEnd < t.secondaryStart) return HEIGHT_AGREEMENT;                                    // a clock that went backwards proves nothing: no allowance
  const gapMs = Math.max(t.primaryEnd, t.secondaryEnd) - Math.min(t.primaryStart, t.secondaryStart);
  const allowance = Math.min(HEIGHT_SKEW_CAP, Math.max(0, Math.ceil((gapMs / 1000) * SLOTS_PER_SECOND)));
  return HEIGHT_AGREEMENT + allowance;
}
export const CLOCK_AHEAD_ALARM_S = 120;       // local clock this far ahead of chain time: journal alarm (it would silently refuse early refunds)
export const ATTEMPT_EXPIRY_MARGIN = 32;      // an attempt is expired once the finalized height exceeds its last valid height + this
// SOL -> XMR strict claim: the same numbers as the early refund (its mirror image, deadline c + W instead of t0).
export const CLAIM_SEND_MIN_LEAD = EARLY_SEND_MIN_LEAD;
export const CLAIM_LANDING_MARGIN = EARLY_LANDING_MARGIN;
const OPEN = OPEN_ATTEMPT_STATES;

const attempts = (s) => ATTEMPT_LISTS.flatMap((l) => s[l] ?? []);
/** Attempts whose outcome is not settled by finalized evidence. While any exists, no new variant of any action is created. */
export const openAttempts = (s) => attempts(s).filter((a) => OPEN.has(a.state));

function compile(ixs, payerKey, blockhash, microLamports = 0) {
  const tx = new Transaction().add(...computeBudgetIxs(SEND_COMPUTE_UNITS, microLamports), ...ixs);
  tx.feePayer = payerKey; tx.recentBlockhash = blockhash;
  return tx.compileMessage();
}
function signOnce(message, payer) {
  const v = new VersionedTransaction(message); v.sign([payer]);
  return { raw: Buffer.from(v.serialize()).toString('base64'), sig: bs58.encode(v.signatures[0]) };
}
function decodeEscrow(acc) {
  const v = acc?.value; if (!v || !v.owner?.equals?.(sol.PROGRAM_ID)) return null;
  try { return sol.decodeSwap(v.data); } catch { return null; }
}
function decodeStrictEscrow(acc) {
  const v = acc?.value; if (!v || !v.owner?.equals?.(sol.PROGRAM_ID)) return null;
  try { return decodeStrict(v.data); } catch { return null; }
}
const isReverse = (s) => s?.direction === 'sol-xmr';
const refuse = (why, facts = {}) => ({ ok: false, why, facts });

/** The record's escrow terms against a decoded account. */
function sameEscrow(record, a) { return a.refundPoint === record.B && a.t0 === record.t0 && a.t1 === record.t1; }

/**
 * Early exposure check, pure and synchronous. In: record; reads = one entry per RPC endpoint { account (decoded or null), slot,
 * minSlot, error? }; tipTime (confirmed chain time, the LAST value awaited); localNow (s, sampled synchronously here); remainingBlocks
 * (blockhash last valid height minus the confirmed height read after the blockhash: an overestimate, so conservative).
 * Fail closed (Astra 699-H2): a set-ready that landed (finalized success on ANY endpoint) always forbids the early refund; so does a
 * recorded disagreement between endpoints about an attempt; and every endpoint must answer with the escrow open, not ready, the same
 * terms, in a context at least as new as its minSlot. Any missing or disagreeing answer refuses.
 * The time bound: the blockhash bounds landing in block HEIGHT. Converting that to time with MAX_SECONDS_PER_BLOCK (3 s) is an
 * assumption, not a guarantee: this check converts blocks to seconds with an ASSUMED 3 s per block. In a network halt the bytes may
 * land after t0 (the loss is the principal exposure of this swap, runbook 3b).
 */
export function earlyRefundGate({ record, reads, tipTime, localNow, remainingBlocks, crossCheck }) {
  if (record.earlyAbort === 'ambiguous') return refuse('early-abort-ambiguous');
  if ((record.readyAttempts ?? []).some((a) => a.state === 'landed') || record.readySig) return refuse('ready-landed');
  if (record.endpointDisagreement) return refuse('endpoints-disagree');
  if (!Array.isArray(reads) || !reads.length) return refuse('escrow-unread');
  for (const r of reads) {
    if (!r || r.error) return refuse('escrow-unread-on-an-endpoint');
    if (!r.account) return refuse('escrow-not-open');
    if (!Number.isInteger(r.slot) || r.slot < r.minSlot) return refuse('stale-account-context');
    if (r.account.ready) return refuse('escrow-ready');
    if (!sameEscrow(record, r.account)) return refuse('escrow-mismatch');
  }
  // Fable F1: the blockhash and heights come from the primary; with a second endpoint it must confirm the blockhash is valid and its
  // height must be within the tolerated skew, so a stale or invented blockhash (bytes that never land while the primary holds b) is refused.
  if (crossCheck) {
    if (crossCheck.error) return refuse('secondary-unreadable');
    if (crossCheck.blockhashValid !== true) return refuse('blockhash-not-valid-on-secondary');
    if (!Number.isInteger(crossCheck.heightPrimary) || !Number.isInteger(crossCheck.heightSecondary) || Math.abs(crossCheck.heightPrimary - crossCheck.heightSecondary) > HEIGHT_AGREEMENT)
      return refuse('endpoint-heights-disagree', { heights: [crossCheck.heightPrimary, crossCheck.heightSecondary] });
  }
  if (!Number.isSafeInteger(tipTime)) return refuse('chain-time-unobserved');
  if (!Number.isInteger(remainingBlocks) || remainingBlocks < 1 || remainingBlocks > MAX_BLOCKHASH_BLOCKS) return refuse('blockhash-lifetime-unbounded', { remainingBlocks });
  const hi = Math.max(tipTime, Math.floor(localNow));   // the later of the two: a clock or node behind cannot shorten the lead
  const lead = record.t0 - hi, need = Math.max(EARLY_SEND_MIN_LEAD, remainingBlocks * MAX_SECONDS_PER_BLOCK + EARLY_LANDING_MARGIN);
  if (lead < need) return refuse('blockhash-may-outlive-t0', { lead, need });
  return { ok: true, why: 'blockhash-expires-before-t0', facts: { lead, need, tipTime, localNow: Math.floor(localNow), remainingBlocks } };
}

/** Late exposure check, pure and synchronous. finalized = { slot, height, blockTime } of a finalized block; account read at finalized. */
export function lateRefundGate({ record, account, accountSlot, finalized }) {
  if (!finalized || !Number.isSafeInteger(finalized.blockTime) || !Number.isInteger(finalized.slot)) return refuse('finalized-time-unobserved');
  if (!Number.isInteger(accountSlot) || accountSlot < finalized.slot) return refuse('stale-account-context');
  if (!account) return refuse('escrow-not-open-at-finalized');
  if (!sameEscrow(record, account)) return refuse('escrow-mismatch');
  if (finalized.blockTime < record.t1 + LATE_REFUND_MARGIN) return refuse('claim-window-not-provably-closed', { finalizedTime: finalized.blockTime, need: record.t1 + LATE_REFUND_MARGIN });
  return { ok: true, why: 'finalized-after-t1', facts: { finalizedSlot: finalized.slot, finalizedTime: finalized.blockTime } };
}

/** Why an open EARLY refund attempt may not be rebroadcast now (null = it may). hi = later of chain time and local clock (s). */
export function earlyRebroadcastBlock(s, att, hi, tipHeight) {
  if (s.earlyAbort === 'ambiguous') return 'early-abort-ambiguous';
  if (!Number.isSafeInteger(hi)) return 'chain-time-unobserved';
  if (hi >= s.t0) return 'after-t0';
  if (!Number.isInteger(tipHeight)) return 'height-unobserved';
  const remaining = att.lastValidBlockHeight - tipHeight;
  if (remaining > MAX_BLOCKHASH_BLOCKS) return 'blockhash-lifetime-unbounded';
  if (s.t0 - hi < Math.max(EARLY_SEND_MIN_LEAD, Math.max(0, remaining) * MAX_SECONDS_PER_BLOCK + EARLY_LANDING_MARGIN)) return 'early-timing-no-longer-holds';
  return null;
}
/** Why an open strict CLAIM attempt may not be rebroadcast now (null = it may): the same rule as the early refund, deadline c + W. */
export function claimRebroadcastBlock(s, att, hi, tipHeight) {
  if (s.claimAbort === 'ambiguous') return 'claim-ambiguous';
  if (!Number.isSafeInteger(att.deadline)) return 'claim-deadline-unknown';
  if (!Number.isSafeInteger(hi)) return 'chain-time-unobserved';
  if (hi >= att.deadline) return 'after-claim-window';
  if (!Number.isInteger(tipHeight)) return 'height-unobserved';
  const remaining = att.lastValidBlockHeight - tipHeight;
  if (remaining > MAX_BLOCKHASH_BLOCKS) return 'blockhash-lifetime-unbounded';
  if (att.deadline - hi < Math.max(CLAIM_SEND_MIN_LEAD, Math.max(0, remaining) * MAX_SECONDS_PER_BLOCK + CLAIM_LANDING_MARGIN)) return 'claim-timing-no-longer-holds';
  return null;
}

/**
 * Strict claim exposure check (SOL -> XMR, reveals a), pure and synchronous. Same shape as earlyRefundGate. reads = one entry per endpoint
 * { account (decoded StrictSwap or null), slot, minSlot, error? } at FINALIZED commitment; every endpoint must show the escrow open, ready, the
 * maker's commit (claimCommittedAt > 0), the record's terms, the SAME commit time, in a context at least as new as minSlot (the landed commit
 * attempt's slot). The deadline is c + W from that agreed finalized value, never an estimate.
 */
export function strictClaimGate({ record, reads, tipTime, localNow, remainingBlocks, crossCheck }) {
  if (!isReverse(record)) return refuse('not-a-reverse-swap');
  if (record.claimAbort === 'ambiguous') return refuse('claim-ambiguous');
  if (!Array.isArray(reads) || !reads.length) return refuse('escrow-unread');
  let c = null;
  for (const r of reads) {
    if (!r || r.error) return refuse('escrow-unread-on-an-endpoint');
    if (!r.account) return refuse('escrow-not-open');
    if (!Number.isInteger(r.slot) || r.slot < r.minSlot) return refuse('stale-account-context');
    const a = r.account;
    if (a.claimer !== record.claimer || a.refunder !== record.refunder || a.claimPoint !== record.A || a.refundPoint !== record.B || a.t0 !== record.t0 || a.t1 !== record.t1) return refuse('escrow-mismatch');
    if (!a.ready) return refuse('escrow-not-ready');
    if (!Number.isSafeInteger(a.claimCommittedAt) || a.claimCommittedAt <= 0) return refuse('commit-not-finalized');
    if (c !== null && a.claimCommittedAt !== c) return refuse('endpoints-disagree-on-commit');
    c = a.claimCommittedAt;
  }
  if (crossCheck) {
    if (crossCheck.error) return refuse('secondary-unreadable');
    if (crossCheck.blockhashValid !== true) return refuse('blockhash-not-valid-on-secondary');
    if (!Number.isInteger(crossCheck.heightPrimary) || !Number.isInteger(crossCheck.heightSecondary) || Math.abs(crossCheck.heightPrimary - crossCheck.heightSecondary) > heightTolerance(crossCheck))
      return refuse('endpoint-heights-disagree', { heights: [crossCheck.heightPrimary, crossCheck.heightSecondary], tolerance: heightTolerance(crossCheck) });
  }
  if (!Number.isSafeInteger(tipTime)) return refuse('chain-time-unobserved');
  if (!Number.isInteger(remainingBlocks) || remainingBlocks < 1 || remainingBlocks > MAX_BLOCKHASH_BLOCKS) return refuse('blockhash-lifetime-unbounded', { remainingBlocks });
  const deadline = c + REV_COMMIT_WINDOW;
  const hi = Math.max(tipTime, Math.floor(localNow));
  const lead = deadline - hi, need = Math.max(CLAIM_SEND_MIN_LEAD, remainingBlocks * MAX_SECONDS_PER_BLOCK + CLAIM_LANDING_MARGIN);
  if (lead < need) return refuse('blockhash-may-outlive-claim-window', { lead, need, deadline });
  return { ok: true, why: 'blockhash-expires-before-claim-window-ends', facts: { lead, need, deadline, committedAt: c, tipTime, localNow: Math.floor(localNow), remainingBlocks } };
}

/** A finalized block's slot, height and time from one block (the height and time are bound to that slot). */
export async function finalizedObservation(conn) {
  const slot = await conn.getSlot('finalized');
  const b = await conn.getBlock(slot, { commitment: 'finalized', transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 });
  if (!Number.isInteger(slot) || !b || !Number.isInteger(b.blockHeight)) throw new Error('finalized-unobservable');
  return { slot, height: b.blockHeight, blockTime: b.blockTime ?? null };
}

/**
 * conns = [primary, secondary?] web3.js Connections (reads use the primary; every broadcast goes to all). payer = maker keypair.
 * store(s) must be durable (fsync) before it returns. clock() = local ms, injected for tests; used only to make the early check stricter.
 */
export function createSender({ conns, payer, store, log, feeFor = async () => 0, clock = () => Date.now(), monotonic = () => (typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : clock()) }) {
  const primary = conns[0];
  const pdaOf = (s) => sol.swapPda(payer.publicKey, Buffer.from(s.swapId, 'hex'));

  async function broadcast(s, att) {
    const raw = Buffer.from(att.raw, 'base64');
    const r = await Promise.allSettled(conns.map((c) => c.sendRawTransaction(raw, { skipPreflight: true })));
    att.sends = r.map((x) => (x.status === 'fulfilled' ? { ok: true, sig: x.value } : { ok: false, error: String(x.reason?.message ?? x.reason).slice(0, 200) }));
    att.state = att.sends.some((x) => x.ok) ? 'sent' : 'send-error';   // a send error says nothing about landing: still open
    if (att.sends.some((x) => x.ok && x.sig !== att.sig)) log({ event: 'alarm-rpc-returned-other-signature', swapId: s.swapId, sig: att.sig });
    store(s);
    log({ event: 'attempt-sent', swapId: s.swapId, action: att.action, kind: att.kind ?? null, n: att.n, sig: att.sig, state: att.state, sends: att.sends.map((x) => x.ok) });
    return { sent: true, pending: true, sig: att.sig };
  }

  function persist(s, list, att) {
    (s[list] ??= []).push(att);
    // The exposure mark names the FIRST secret-bearing attempt (from then on the secret counts as public) and lists every variant since,
    // so a later variant (a new blockhash after an expired one) never hides behind the first mark (Astra 701 round 1).
    if (att.action === 'refund' || att.action === 'claim-strict') {
      s.secretExposure ??= { at: att.createdAt, sig: att.sig, kind: att.action === 'refund' ? att.kind : 'claim-strict' };
      (s.secretExposure.variants ??= []).push({ n: att.n, sig: att.sig, at: att.createdAt, lastValidBlockHeight: att.lastValidBlockHeight });
    }
    store(s);   // durable BEFORE any of these bytes leave the process
    log({ event: 'attempt-persisted', swapId: s.swapId, action: att.action, kind: att.kind ?? null, n: att.n, sig: att.sig, lastValidBlockHeight: att.lastValidBlockHeight });
  }

  const no = (why) => ({ final: false, why });
  return {
    /**
     * Astra 701-H1: proof that a terminal result is FINAL, for finishIfFinal (maker-core.mjs). Every endpoint must read the swap's escrow
     * address (normal PDA, or the strict PDA for SOL -> XMR) at FINALIZED commitment, in a context at least as new as this pass's finalized
     * observation, and find no program-owned account there; when an outcome is named (the claim or refund that ended it), its signature must
     * be finalized without error on at least one endpoint and failed on none. No send attempt of the swap may be open. Anything unreadable,
     * stale or contradictory is "not final": the record keeps its secrets, its attempt bytes and its place in the recovery loop.
     */
    async proveFinal(s, outcome) {
      if (openAttempts(s).length) return no('attempt-open');
      if (outcome && typeof outcome.sig !== 'string') return no('outcome-without-signature');
      const fin = await finalizedObservation(primary);
      let pda; try { pda = isReverse(s) ? strictPda(new PublicKey(s.refunder), Buffer.from(s.swapId, 'hex')) : pdaOf(s); } catch { return no('pda-underivable'); }
      for (const c of conns) {
        let acc; try { acc = await c.getAccountInfoAndContext(pda, { commitment: 'finalized', minContextSlot: fin.slot }); } catch { return no('escrow-unreadable-at-finalized'); }
        if (!Number.isInteger(acc?.context?.slot) || acc.context.slot < fin.slot) return no('stale-finalized-context');
        if (acc.value && acc.value.owner?.equals?.(sol.PROGRAM_ID)) return no('escrow-account-at-finalized');
      }
      let sigSlot = null;
      if (outcome) {
        const st = await Promise.all(conns.map((c) => c.getSignatureStatuses([outcome.sig], { searchTransactionHistory: true }).catch(() => null)));
        const seen = st.map((x) => (x && Array.isArray(x.value) ? x.value[0] ?? null : undefined));
        if (seen.some((x) => x === undefined)) return no('outcome-status-unreadable');
        if (seen.some((x) => x && x.err)) return no('outcome-failed-or-contradictory');
        const ok = seen.find((x) => x && x.confirmationStatus === 'finalized');
        if (!ok) return no('outcome-not-finalized');
        sigSlot = ok.slot;
      }
      return { final: true, evidence: { finalizedSlot: fin.slot, outcomeSig: outcome?.sig ?? null, outcomeSlot: sigSlot, at: new Date(clock()).toISOString() } };
    },

    /**
     * Settles open attempts from finalized evidence. Returns { open } = attempts still unsettled. With no open attempt it returns at
     * once (nothing to settle; the ambiguous mark below can only be set while an early attempt is still open).
     * Each settled attempt records the REAL slot of its transaction (Astra 699-H2), taken from the endpoint that reports it finalized.
     * A finalized success on any endpoint wins (a landed ready forbids every early refund); success on one endpoint and failure on
     * another is recorded as endpointDisagreement, which refuses every early refund for this swap (only the t1 path remains).
     */
    async resolve(s) {
      const open = openAttempts(s);
      if (!open.length) return { open: 0 };
      const fin = await finalizedObservation(primary);
      // Time for every early-refund decision in this pass, sampled once BEFORE any rebroadcast: the ambiguity cut is applied first.
      const earlyOpen = open.some((a) => a.action === 'refund' && a.kind === 'early');
      const claimOpen = open.filter((a) => a.action === 'claim-strict');
      let hi = null, tipHeight = null;
      if (earlyOpen || claimOpen.length) {
        const tip = await primary.getBlockTime(await primary.getSlot('confirmed')).catch(() => null);
        tipHeight = await primary.getBlockHeight('confirmed').catch(() => null);
        hi = Math.max(Number.isSafeInteger(tip) ? tip : 0, Math.floor(clock() / 1000));
        if (earlyOpen && s.earlyAbort !== 'ambiguous' && hi >= s.t0 - EARLY_LANDING_MARGIN) { s.earlyAbort = 'ambiguous'; log({ event: 'early-abort-ambiguous', swapId: s.swapId }); }
        // SOL -> XMR: a claim (a) still open this close to c + W may fail after showing a while the user's refund opens. Stop every further
        // claim and rebroadcast; only the refund-watch and XMR recovery remain (the v2 liveness residual, journaled as an alarm).
        if (claimOpen.some((a) => !Number.isSafeInteger(a.deadline) || hi >= a.deadline - CLAIM_LANDING_MARGIN) && s.claimAbort !== 'ambiguous') { s.claimAbort = 'ambiguous'; log({ event: 'alarm-claim-ambiguous', swapId: s.swapId }); }
      }
      for (const att of open) {
        // Fable F3: an attempt whose every send failed is sent again as the SAME bytes (same signature, no new variant) while the
        // finalized height has not passed its last valid height. The landing bound is unchanged (same blockhash).
        // Astra (4b9ed669): an EARLY refund is never re-sent after the ambiguity cut (t0 - EARLY_LANDING_MARGIN), after t0, or once the
        // early timing condition (the same lead as for the first send, from the later of chain time and local clock and the confirmed
        // height) no longer holds; the payment and escrow state are not re-read for the same bytes (b went out with the first send).
        // Late-refund and set-ready rebroadcasts stay allowed.
        if (att.state === 'send-error' && fin.height <= att.lastValidBlockHeight) {
          const why = att.action === 'refund' && att.kind === 'early' ? earlyRebroadcastBlock(s, att, hi, tipHeight)
            : att.action === 'claim-strict' ? claimRebroadcastBlock(s, att, hi, tipHeight) : null;
          if (why) log({ event: 'rebroadcast-withheld', swapId: s.swapId, n: att.n, sig: att.sig, why });
          else { att.rebroadcasts = (att.rebroadcasts ?? 0) + 1; await broadcast(s, att); }
        }
        const st = await Promise.all(conns.map((c) => c.getSignatureStatuses([att.sig], { searchTransactionHistory: true }).catch(() => null)));
        const seen = st.map((x) => (x && Array.isArray(x.value) ? x.value[0] ?? null : undefined));
        const fins = seen.filter((x) => x && x.confirmationStatus === 'finalized');
        const ok = fins.find((x) => !x.err), bad = fins.find((x) => x.err);
        const at = new Date(clock()).toISOString();
        if (ok && bad) { s.endpointDisagreement ??= { sig: att.sig, at }; log({ event: 'alarm-endpoints-disagree', swapId: s.swapId, sig: att.sig }); }
        if (ok) Object.assign(att, { state: 'landed', err: null, resolvedSlot: ok.slot, resolvedAt: at });
        else if (bad && seen.every((x) => x === null || (x?.confirmationStatus === 'finalized' && x.err))) Object.assign(att, { state: 'failed', err: bad.err, resolvedSlot: bad.slot, resolvedAt: at });
        else if (seen.every((x) => x === null) && st.every((x) => (x?.context?.slot ?? -1) >= fin.slot) && fin.height > att.lastValidBlockHeight + ATTEMPT_EXPIRY_MARGIN)
          Object.assign(att, { state: 'expired', resolvedSlot: fin.slot, resolvedAt: at });
        if (att.state === 'landed' && att.action === 'set-ready') s.readySig = att.sig;
        if (att.state === 'landed' && att.action === 'refund') s.refundSig = att.sig;
        if (att.state === 'landed' && att.action === 'commit-strict') s.commitSig = att.sig;
        if (att.state === 'landed' && att.action === 'claim-strict') s.claimSig = att.sig;
        if (!OPEN.has(att.state)) log({ event: 'attempt-resolved', swapId: s.swapId, action: att.action, kind: att.kind ?? null, n: att.n, sig: att.sig, state: att.state, slot: att.resolvedSlot });
      }
      // The ambiguity mark above (an early refund still open at t0 - EARLY_LANDING_MARGIN: no further early attempt, no set-ready,
      // no rebroadcast of it, only the t1 path) uses time while the send decision rests on the blockhash: consistent, because it only
      // ever stops things and never releases b. It does not undo anything either: b went out with the attempt and stays exposed
      // (secretExposure) whatever this mark says.
      store(s);
      return { open: openAttempts(s).length };
    },

    async sendReady(s) {
      if (isReverse(s)) return { refused: 'wrong-direction' };
      if (openAttempts(s).length) return { refused: 'attempt-open' };
      if (s.secretExposure || s.earlyAbort) return { refused: 'secret-may-be-exposed' };
      const fee = await feeFor(pdaOf(s));   // SEC-P-09: read before the blockhash; an escrow address only, no message
      const { blockhash, lastValidBlockHeight } = await primary.getLatestBlockhash('confirmed');
      const message = compile([sol.readyIx({ refunder: payer.publicKey, swapId: Buffer.from(s.swapId, 'hex') })], payer.publicKey, blockhash, fee);
      const sim = await primary.simulateTransaction(new VersionedTransaction(message), { sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' });
      if (sim.value.err) return { refused: `simulation-refused ${JSON.stringify(sim.value.err)}` };
      const { raw, sig } = signOnce(message, payer);
      const att = { n: (s.readyAttempts?.length ?? 0) + 1, action: 'set-ready', swapId: s.swapId, sig, blockhash, lastValidBlockHeight, raw, createdAt: new Date(clock()).toISOString(), state: 'persisted' };
      persist(s, 'readyAttempts', att);
      return broadcast(s, att);
    },

    async sendRefund(s, kind) {
      if (isReverse(s)) return { refused: 'wrong-direction' };   // the maker never refunds a strict escrow: only the user holds b
      if (kind !== 'early' && kind !== 'late') return { refused: 'unknown-refund-kind' };
      if (openAttempts(s).length) return { refused: 'attempt-open' };
      const pda = pdaOf(s);
      // The blockhash comes first: every observation below is newer than it. In the early path the chain time is the LAST awaited
      // read (re-sampled after the height and account reads, Astra 699 b) and the local clock is read synchronously in the gate.
      const fee = await feeFor(pda);   // SEC-P-09: before the blockhash, so everything after it stays as before
      const bh = await primary.getLatestBlockhashAndContext('confirmed');
      const { blockhash, lastValidBlockHeight } = bh.value;
      let gate;
      if (kind === 'late') {
        const finalized = await finalizedObservation(primary);
        const acc = await primary.getAccountInfoAndContext(pda, { commitment: 'finalized', minContextSlot: finalized.slot });
        gate = () => lateRefundGate({ record: s, account: decodeEscrow(acc), accountSlot: acc?.context?.slot, finalized });
      } else {
        // Every endpoint must show the escrow open and not ready, at least as new as any settled ready attempt (its real slot).
        const readySlot = Math.max(0, ...(s.readyAttempts ?? []).map((a) => a.resolvedSlot ?? 0));
        const height = await primary.getBlockHeight('confirmed');
        let crossCheck = null, maxHeight = height;
        if (conns[1]) {
          try {
            const v = await conns[1].isBlockhashValid(blockhash, { commitment: 'confirmed' });
            const h2 = await conns[1].getBlockHeight('confirmed');
            crossCheck = { blockhashValid: v?.value === true, heightPrimary: height, heightSecondary: h2 };
            maxHeight = Math.max(height, h2);   // the higher height: the real chain is at least there
          } catch (e) { crossCheck = { error: String(e?.message ?? e).slice(0, 120) }; }
        }
        const reads = await Promise.all(conns.map(async (c, i) => {
          const minSlot = i === 0 ? Math.max(bh.context.slot, readySlot) : readySlot;
          try { const acc = await c.getAccountInfoAndContext(pda, { commitment: 'confirmed', minContextSlot: minSlot }); return { account: decodeEscrow(acc), slot: acc?.context?.slot, minSlot }; }
          catch (e) { return { error: String(e?.message ?? e).slice(0, 120), minSlot }; }
        }));
        const tipTime = await primary.getBlockTime(await primary.getSlot('confirmed'));
        gate = () => {
          const localNow = clock() / 1000;
          // Fable F4: a local clock far ahead refuses every early refund (the gate takes the later time); say so loudly.
          if (Number.isSafeInteger(tipTime) && localNow - tipTime > CLOCK_AHEAD_ALARM_S) log({ event: 'alarm-local-clock-ahead', swapId: s.swapId, aheadS: Math.round(localNow - tipTime) });
          return earlyRefundGate({ record: s, reads, tipTime, localNow, remainingBlocks: lastValidBlockHeight - maxHeight, crossCheck });
        };
      }
      // From here to the store: synchronous only.
      const message = compile([sol.refundIx({ refunder: payer.publicKey, swapId: Buffer.from(s.swapId, 'hex'), secret: Buffer.from(s.b, 'hex') })], payer.publicKey, blockhash, fee);
      const g = gate();
      if (!g.ok) { log({ event: 'refund-refused', swapId: s.swapId, kind, why: g.why, ...g.facts }); return { refused: g.why }; }
      const { raw, sig } = signOnce(message, payer);
      const att = { n: (s.refundAttempts?.length ?? 0) + 1, action: 'refund', kind, swapId: s.swapId, sig, blockhash, lastValidBlockHeight, raw, createdAt: new Date(clock()).toISOString(), state: 'persisted', gate: g.facts };
      persist(s, 'refundAttempts', att);
      return broadcast(s, att);
    },

    /** SOL -> XMR step one: claim_commit_strict (no secret). Simulated unsigned like set-ready; recorded before broadcast; both endpoints. */
    async sendCommit(s) {
      if (!isReverse(s)) return { refused: 'wrong-direction' };
      if (openAttempts(s).length) return { refused: 'attempt-open' };
      if (s.claimAbort) return { refused: 'claim-ambiguous' };
      const refunder = new PublicKey(s.refunder), swapId = Buffer.from(s.swapId, 'hex');
      const fee = await feeFor(strictPda(refunder, swapId));
      const { blockhash, lastValidBlockHeight } = await primary.getLatestBlockhash('confirmed');
      const message = compile([commitClaimStrictIx({ refunder, swapId, claimer: payer.publicKey })], payer.publicKey, blockhash, fee);
      const sim = await primary.simulateTransaction(new VersionedTransaction(message), { sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' });
      if (sim.value.err) return { refused: `simulation-refused ${JSON.stringify(sim.value.err)}` };
      const { raw, sig } = signOnce(message, payer);
      const att = { n: (s.commitAttempts?.length ?? 0) + 1, action: 'commit-strict', swapId: s.swapId, sig, blockhash, lastValidBlockHeight, raw, createdAt: new Date(clock()).toISOString(), state: 'persisted' };
      persist(s, 'commitAttempts', att);
      return broadcast(s, att);
    },

    /**
     * SOL -> XMR step two: claim_strict(a). Never simulated, never priced (fixed fee). Every input is read after the blockhash; the strict
     * escrow is read at FINALIZED commitment on every endpoint (at least as new as the landed commit); chain time is the last awaited read;
     * strictClaimGate runs synchronously right before signing; the attempt (with its deadline c + W) is stored before the bytes leave.
     */
    async sendClaim(s) {
      if (!isReverse(s)) return { refused: 'wrong-direction' };
      if (openAttempts(s).length) return { refused: 'attempt-open' };
      if (s.claimAbort === 'ambiguous') return { refused: 'claim-ambiguous' };
      if (typeof s.a !== 'string' || !/^[0-9a-f]{64}$/.test(s.a)) return { refused: 'secret-missing' };
      const refunder = new PublicKey(s.refunder), swapId = Buffer.from(s.swapId, 'hex'), pda = strictPda(refunder, swapId);
      const fee = await feeFor(pda);   // SEC-P-09: before the blockhash
      const bh = await primary.getLatestBlockhashAndContext('confirmed');
      const { blockhash, lastValidBlockHeight } = bh.value;
      const commitSlot = Math.max(0, ...(s.commitAttempts ?? []).filter((a) => a.state === 'landed').map((a) => a.resolvedSlot ?? 0));
      // F5: both endpoints are read at the same time and every read is timed, so a slow secondary is judged by its measured latency (heightTolerance), not by read order.
      const timed = async (fn) => { const start = monotonic(); const value = await fn(); return { value, start, end: monotonic() }; };   // monotonic timing (performance.now): a wall-clock step cannot create an allowance
      const secondaryRead = conns[1] ? Promise.all([timed(() => conns[1].isBlockhashValid(blockhash, { commitment: 'confirmed' })), timed(() => conns[1].getBlockHeight('confirmed'))]).then((x) => ({ ok: x }), (e) => ({ error: e })) : null;
      const hp = await timed(() => primary.getBlockHeight('confirmed'));
      const height = hp.value;
      let crossCheck = null, lifetimeHeight = height;   // lifetimeHeight = the LOWER of the two heights: skew can only lengthen the remaining lifetime we assume
      if (secondaryRead) {
        const r = await secondaryRead;
        if (r.error) crossCheck = { error: String(r.error?.message ?? r.error).slice(0, 120) };
        else {
          const [v, h] = r.ok;
          crossCheck = { blockhashValid: v.value?.value === true, heightPrimary: height, heightSecondary: h.value,
            timing: { primaryStart: hp.start, primaryEnd: hp.end, secondaryStart: Math.min(v.start, h.start), secondaryEnd: h.end } };
          lifetimeHeight = Math.min(height, h.value);
        }
      }
      const reads = await Promise.all(conns.map(async (c) => {
        try { const acc = await c.getAccountInfoAndContext(pda, { commitment: 'finalized', minContextSlot: commitSlot }); return { account: decodeStrictEscrow(acc), slot: acc?.context?.slot, minSlot: commitSlot }; }
        catch (e) { return { error: String(e?.message ?? e).slice(0, 120), minSlot: commitSlot }; }
      }));
      const tipTime = await primary.getBlockTime(await primary.getSlot('confirmed'));
      // From here to the store: synchronous only.
      const message = compile([claimStrictIx({ refunder, swapId, claimer: payer.publicKey, secret: Buffer.from(s.a, 'hex') })], payer.publicKey, blockhash, fee);
      const localNow = clock() / 1000;
      if (Number.isSafeInteger(tipTime) && localNow - tipTime > CLOCK_AHEAD_ALARM_S) log({ event: 'alarm-local-clock-ahead', swapId: s.swapId, aheadS: Math.round(localNow - tipTime) });
      const g = strictClaimGate({ record: s, reads, tipTime, localNow, remainingBlocks: lastValidBlockHeight - lifetimeHeight, crossCheck });
      if (!g.ok) { log({ event: 'claim-refused', swapId: s.swapId, why: g.why, ...g.facts }); return { refused: g.why, unsent: true }; }   // unsent: nothing signed, nothing broadcast
      const { raw, sig } = signOnce(message, payer);
      const att = { n: (s.claimAttempts?.length ?? 0) + 1, action: 'claim-strict', swapId: s.swapId, sig, blockhash, lastValidBlockHeight, raw, deadline: g.facts.deadline, createdAt: new Date(clock()).toISOString(), state: 'persisted', gate: g.facts };
      persist(s, 'claimAttempts', att);
      return broadcast(s, att);
    },
  };
}
