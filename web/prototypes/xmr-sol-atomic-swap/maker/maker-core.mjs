// Maker decision plumbing with every side effect injected, so the wallet-response -> scan -> decision path
// and the queue/RPC failure paths are tested deterministically (Astra round 2, H4 and H5).
import { makerNext } from '../client/swap-core.mjs';

const XMR_ADDRESS = /^[48][1-9A-HJ-NP-Za-km-z]{94}$/;
/**
 * Hygiene (8 Nov 2026): once a swap has reached a final state, the secrets it needed are removed from the stored record: the swap view key `v`
 * (single-use, shared by the user), the maker's own spend share (`a` for SOL -> XMR, `b` for XMR -> SOL). Public keys, txids and signatures stay for the
 * audit trail. Only called where `done` is set: until then every one of these is still needed for a refund, a recovery or a sweep.
 */
/** Every Solana send attempt list a swap file can hold (maker-send.mjs): forward set-ready and refund, reverse commit and strict claim. */
export const ATTEMPT_LISTS = ['readyAttempts', 'refundAttempts', 'commitAttempts', 'claimAttempts'];
/** Attempt states whose outcome is not settled by finalized evidence. */
export const OPEN_ATTEMPT_STATES = new Set(['persisted', 'sent', 'send-error']);
/**
 * Astra 701-H1: secrets and attempt bytes are destroyed ONLY once the terminal result is proven at FINALIZED commitment (s.finalEvidence,
 * written by finishIfFinal) and no send attempt is still open. A provisional or contradictory result never reaches this point; if it does
 * anyway (a caller bug), nothing is removed. Returns the number of secrets removed (0 when refused).
 */
export function scrubSecrets(s, at = Date.now()) {
  if (!s?.done || !s.finalEvidence || !Number.isInteger(s.finalEvidence.finalizedSlot)) return 0;
  if (ATTEMPT_LISTS.some((l) => (s[l] ?? []).some((a) => a && OPEN_ATTEMPT_STATES.has(a.state)))) return 0;
  let n = 0;
  for (const k of ['v', 'a', 'b']) if (k in s) { delete s[k]; n++; }
  // The exact bytes of a refund (b) or a strict claim (a) attempt carry the secret too; once final there is nothing left to rebroadcast.
  // The identity of every attempt (signature, blockhash, last valid height, state) stays: the quiesce check settles open attempts from it.
  let raw = 0;
  for (const list of ATTEMPT_LISTS) for (const att of s[list] ?? []) if (att && 'raw' in att) { delete att.raw; raw++; }
  if (n || raw) s.secretsWipedAt ??= at;
  return n;
}
/**
 * Start-up checks that never stop refunds (Astra round 4, N1). A failed check closes the gate: no new quotes or
 * swaps and no XMR sweeps, while the loop keeps refunding expired escrows from Solana alone. Config problems keep
 * it closed until a fixed restart; a wallet-rpc outage is retried on every check. A definitive answer is cached.
 * caps and limits are in atomic units; validate(address) is monero-wallet-rpc validate_address.
 */
export function createStartGate({ network, sweepTo, token, caps, limits, validate, secondaryRpc }) {
  const fixed = [];
  if (network === 'mainnet') {
    // AG-R2-H1: every set-ready and refund goes to two independent RPC endpoints on mainnet; without the second, no new swaps.
    if (secondaryRpc === false) fixed.push('secondary-rpc-missing');
    if (!sweepTo || !XMR_ADDRESS.test(sweepTo)) fixed.push('sweep-address-missing-or-malformed');
    if (caps.perSwap > limits.perSwap || caps.perDay > limits.perDay || caps.open > limits.open) fixed.push('caps-above-approved');
    if (!token || token.length < 32) fixed.push('api-token-missing');
  }
  let verdict = fixed.length ? { open: false, reasons: fixed } : sweepTo ? null : { open: true, reasons: [] };
  let last = verdict ?? { open: false, reasons: ['sweep-address-not-yet-validated'] };
  return {
    isOpen: () => last.open,
    async check() {
      if (verdict) return (last = verdict);
      try {
        const v = await validate(sweepTo);
        verdict = v?.valid && v.nettype === network && !v.integrated ? { open: true, reasons: [] } : { open: false, reasons: ['sweep-address-invalid-for-' + network] };
        return (last = verdict);
      } catch { return (last = { open: false, reasons: ['wallet-rpc-unavailable'] }); }
    },
  };
}

/**
 * get_transfers answer -> what the maker may count. Only outputs spendable without an extra lock count
 * toward the amount (H4): a far-future unlock_time would buy liquid SOL with XMR the maker cannot sweep.
 * Confirmations are the minimum over everything seen (pool included), so a pending or locked output can
 * only delay ready, never trigger it.
 */
export function usableFromTransfers(t) {
  const all = [...(t?.in ?? []), ...(t?.pool ?? [])];
  if (!all.length) return null;
  const usable = (t.in ?? []).filter((i) => Number(i.unlock_time ?? 0) === 0);
  // Astra 699-M1: the mined, spendable outputs one by one, so the "never abort a full payment at the set-ready depth" exception can
  // measure that payment by itself; the minimum above (pool included) would let a dust output in the pool hide it.
  const mined = usable.filter((i) => (i.confirmations ?? 0) >= 1).map((i) => ({ atomic: BigInt(i.amount).toString(), confirmations: i.confirmations }));
  return { atomic: usable.reduce((x, i) => x + BigInt(i.amount), 0n).toString(), confirmations: Math.min(...all.map((i) => i.confirmations ?? 0)), mined };
}

/**
 * SOL -> XMR (Astra r4 N2): the claim rule is "my OWN confirmed XMR", so the scan counts only the transfer whose txid the maker
 * recorded before relaying it. Another confirmed transfer to the same address (anyone can send to it) never satisfies the amount
 * or the confirmation depth. Same shape as usableFromTransfers; null when the recorded transaction is not seen.
 */
export function usableFromTransfersOf(t, txid) {
  if (typeof txid !== 'string' || !/^[a-f0-9]{64}$/.test(txid)) return null;
  const own = (list) => (list ?? []).filter((i) => i.txid === txid);
  return usableFromTransfers({ in: own(t?.in), pool: own(t?.pool) });
}

/**
 * wallet-rpc holds one open wallet at a time, so access is serialized. One failure must not poison the
 * queue (H5): each job runs after the previous one settles, whatever its outcome, and its own error goes
 * only to its own caller.
 *
 * Two queues feed that ONE executor (open maker endpoint, Sol M1):
 * - the recovery queue (the function itself): the watch loop, sweeps, refunds, the token lane. First in, first out, unbounded as before,
 *   and always served BEFORE any public job that has not started;
 * - the public queue (withWallet.publicLane): bounded depth, a deadline per job, and cancellation when the caller goes away. A public job
 *   that has not started is removed on its deadline or on the caller's abort and never touches the wallet.
 * A public job that has started is a WHOLE job of up to six sequential wallet RPC calls: close_wallet, open_wallet (create on failure),
 * refresh, the job's own call(s) (for the treasury read: get_balance), close_wallet. A call that is under way is never interrupted. When the
 * caller aborts or the deadline passes, the caller is released at once and the job is told to stop at the next SAFE stage boundary: before
 * open_wallet, before refresh and before the job's own call it is skipped; a final close_wallet is ALWAYS ATTEMPTED on every exit path, including a failed initial close, a failed open and a throwing create fallback (cleanup, never skipped; a failed close is not proof that the wallet is closed). So a
 * recovery job that arrives behind a started public job waits for the call in progress plus the cleanup close, not for the whole job.
 * Each call has the wallet client's own timeout (120 s on the maker), so the worst case is bounded by the sum, listed in the runbook.
 * opts: { publicMaxDepth = 4, publicDeadlineMs = 10000, setTimer, clearTimer } (the timers are injectable for tests).
 */
export function createWalletQueue(W, password, opts = {}) {
  const { publicMaxDepth = 4, publicDeadlineMs = 10_000, setTimer = setTimeout, clearTimer = clearTimeout } = opts;
  const recovery = [], pending = [];
  let busy = false;
  // Stage boundaries where a cancelled public job may stop: nothing is changed by skipping them. Never inside a call, never the final close.
  const exec = async (j) => {
    const stop = () => { if (j.cancelled) throw new Error('client-gone'); };
    // Sol M1 residual: the cleanup try/finally starts BEFORE the initial close, so every exit path (a throwing cancellation after a failed
    // initial close, an open failure followed by a throwing create fallback, the public treasury fallback that throws at once) still ATTEMPTS
    // a final close. An attempt is all that can be promised: a close that itself fails or times out leaves the wallet state unknown.
    try {
      stop();
      try { await W('close_wallet'); } catch {}
      stop();
      try { await W('open_wallet', { filename: j.filename, password }); } catch { await j.create(); }
      stop();
      await W('refresh');
      stop();
      return await j.fn();
    } finally { await W('close_wallet').catch(() => {}); }
  };
  const pump = () => {
    if (busy) return;
    const job = recovery.shift() ?? pending.shift();
    if (!job) return;
    busy = true; job.started = true;
    exec(job).then(job.ok, job.fail).finally(() => { busy = false; pump(); });
  };
  const job = (filename, create, fn) => {
    let ok, fail;
    const promise = new Promise((res, rej) => { ok = res; fail = rej; });
    return { filename, create, fn, promise, ok, fail, started: false, cancelled: false };
  };
  const withWallet = (filename, create, fn) => { const j = job(filename, create, fn); recovery.push(j); pump(); return j.promise; };
  withWallet.publicLane = (filename, create, fn, { signal, deadlineMs = publicDeadlineMs } = {}) => {
    if (signal?.aborted) return Promise.reject(new Error('client-gone'));
    if (pending.length >= publicMaxDepth) return Promise.reject(new Error('busy-try-later'));
    const j = job(filename, create, fn);
    let done = false, timer = null, onAbort = null;
    const settle = (f, v) => { if (done) return; done = true; clearTimer(timer); signal?.removeEventListener('abort', onAbort); f(v); };
    const out = new Promise((res, rej) => {
      const drop = (why) => { j.cancelled = true; const i = pending.indexOf(j); if (i >= 0) pending.splice(i, 1); settle(rej, new Error(why)); };
      timer = setTimer(() => drop('busy-try-later'), deadlineMs);
      onAbort = () => drop('client-gone');
      signal?.addEventListener('abort', onAbort, { once: true });
      j.promise.then((v) => settle(res, v), (e) => settle(rej, e));
    });
    pending.push(j); pump();
    return out;
  };
  withWallet.depth = () => ({ recovery: recovery.length, publicLane: pending.length });
  return withWallet;
}

/**
 * Sol M3 residual: the PUBLIC view of a swap may only show what is independently recorded from finalized SOLANA observations, never anything
 * whose timing follows Monero work (the XMR sweep or recovery, a wallet scan). The moment a claim or a refund is observed in the escrow's
 * history, it is proven final at finalized commitment (deps.proveFinal, the same proof a terminal result needs) and recorded ONCE as
 * s.pubSol = { kind: 'claimed' | 'refunded', sig }. That happens before any sweep or recovery in the same pass, so the public answer for
 * identical Solana histories does not depend on whether the Monero side has finished, is pending or failed. Not proven: nothing is recorded,
 * the next pass tries again. Returns true when a new observation was recorded.
 */
export async function recordSolObservation(s, outcome, deps) {
  if (s.pubSol || !outcome || (outcome.kind !== 'claimed' && outcome.kind !== 'refunded')) return false;
  let proof;
  try { proof = deps.proveFinal ? await deps.proveFinal(s, outcome) : null; } catch { return false; }
  if (!proof?.final || !Number.isInteger(proof?.evidence?.finalizedSlot)) return false;
  s.pubSol = { kind: outcome.kind, sig: outcome.sig };
  deps.store(s);
  return true;
}

/**
 * Astra 701-H1: the ONE way a swap record (either direction) becomes terminal. The decision layer's "done" is provisional: the escrow read
 * and the claim/refund history are confirmed-commitment views and can flip. deps.proveFinal(s, outcome) must prove, at FINALIZED commitment
 * on every endpoint, that the escrow account is gone and (when an outcome is named) that its signature is finalized without error, and that
 * no send attempt of the swap is open. Until then the record keeps its secrets, its attempts and its place in the recovery loop
 * (s.provisionalResult notes what is pending). A missing or failing check is "not proven". Returns true when the record is now terminal.
 */
export async function finishIfFinal(s, result, outcome, deps) {
  let proof;
  try { proof = deps.proveFinal ? await deps.proveFinal(s, outcome ?? null) : { final: false, why: 'no-finality-check' }; }
  catch (e) { proof = { final: false, why: `finality-unreadable: ${String(e?.message ?? e).slice(0, 80)}` }; }
  if (!proof?.final || !Number.isInteger(proof?.evidence?.finalizedSlot)) {
    const why = proof?.why ?? 'not-proven';
    if (s.provisionalResult?.result !== result || s.provisionalResult?.why !== why) { s.provisionalResult = { result, why, sig: outcome?.sig ?? null, at: new Date().toISOString() }; deps.store(s); }
    deps.log({ event: 'terminal-not-proven', swapId: s.swapId, result, why });
    return false;
  }
  if (outcome && !s.pubSol) s.pubSol = { kind: outcome.kind, sig: outcome.sig };   // Sol M3 residual: same finalized proof, same record the public view reads
  s.done = result; s.finalEvidence = proof.evidence; s.finishedAt = new Date().toISOString(); delete s.provisionalResult;
  scrubSecrets(s);
  return true;
}

/**
 * One maker pass for one swap. deps = { readSwap(), readRevealed(which, point, cursor, onCursor), chainNow(),
 * scanXmr(s), sendReady(s), sendRefund(s, kind), sweep(s, secret), store(s), log(e), resolve?(s), proveFinal(s, outcome) }.
 * Astra 701-H1: the outcome read here (confirmed escrow read, confirmed history) is provisional; "done" goes through finishIfFinal.
 * Monero is consulted only for an escrow that is still open and not ready; an expired escrow is refunded
 * without depending on Monero at all (H5).
 * AG-R2-H1: while a set-ready or refund attempt of this swap is not settled by finalized evidence (deps.resolve), nothing new is
 * decided or sent for it. sendRefund/sendReady may refuse ({ refused }): nothing was signed or sent, the pass waits. A refund attempt
 * that went out is settled later, so refundSig/readySig are only set here when the sender reports a final answer (no `pending`).
 */
export async function makerStep(s, deps) {
  const pda = await deps.readSwap();
  let outcome = null, cursorMoved = false;
  if (!pda) {
    s.histCursor ??= {};
    const read = (which, point) => deps.readRevealed(which, point, s.histCursor[which] ?? null, (c) => { if ((s.histCursor[which] ?? null) !== c) { s.histCursor[which] = c; cursorMoved = true; } });
    const c = await read('claim', s.A);
    const r = c ? null : await read('refund', s.B);
    outcome = c ? { kind: 'claimed', secret: c.secretHex, sig: c.sig } : r ? { kind: 'refunded', sig: r.sig } : null;
    await recordSolObservation(s, outcome, deps);   // before any Monero work of this pass (Sol M3 residual)
  }
  // Attempts are settled on every pass, also when the escrow looks absent (701-H1: a confirmed absence must not skip settlement). With an
  // escrow present an open attempt blocks every new decision; without one, nothing can be sent anyway and finishIfFinal refuses while it is open.
  if (deps.resolve) {
    const r = await deps.resolve(s);
    if (r.open && pda) return { action: 'wait', reason: 'attempt-unsettled' };   // no second variant while one may still land
  }
  const now = await deps.chainNow();
  const xmr = pda && !pda.ready && now < pda.t1 ? await deps.scanXmr(s) : null;
  // F-12: the swap counts as PAID once the full amount is mined (one confirmation or more; a pool-only payment can still be double spent).
  // Recorded once and durably, only ever used for the daily-volume tally (maker-limits.mjs), never for a money decision.
  if (xmr && !s.committedAt && xmr.confirmations >= 1 && BigInt(xmr.atomic) >= BigInt(s.xmrAtomic)) { s.committedAt = new Date().toISOString(); cursorMoved = true; deps.log?.({ event: 'paid-seen', swapId: s.swapId }); }
  const obs = { lockedAt: s.lockedAt, pda, outcome, xmr, xmrSwept: !!s.sweepTxids, expectedAtomic: s.xmrAtomic, requiredConfirmations: s.confirmations, secretExposed: !!s.secretExposure, earlyAbort: s.earlyAbort };
  const a = makerNext({ now, ...obs });
  if (a.action === 'wait') { if (cursorMoved) deps.store(s); return a; }   // the history position survives a restart (H7)
  // A closed start gate holds the sweep (the revealed secret stays on chain); refunds and ready still run (N1).
  if (a.action === 'sweep-xmr' && deps.sweepAllowed && !deps.sweepAllowed()) { if (cursorMoved) deps.store(s); deps.log({ event: 'sweep-held', swapId: s.swapId }); return { action: 'wait', reason: 'sweep-held' }; }
  // Astra r6 (kept from PR 675): `now` was read before the scan, so set-ready and refund are decided AGAIN on a time read now, and both the action and
  // the refund kind must be the same; otherwise nothing is sent this pass. This is an extra fail-closed layer in front of the sender: the sender
  // (maker-send.mjs, AG-R2-H1) re-reads every input after the blockhash and decides the exposure itself, synchronously before signing.
  if (a.action === 'set-ready' || a.action === 'refund') {
    let fresh = null; try { fresh = await deps.chainNow(); } catch { /* fail closed below */ }
    const again = Number.isFinite(fresh) ? makerNext({ now: fresh, ...obs }) : null;
    if (again?.action !== a.action || (again?.kind ?? null) !== (a.kind ?? null)) { if (cursorMoved) deps.store(s); deps.log({ event: 'stale-authorization', swapId: s.swapId, action: a.action, now, fresh, reason: again?.reason ?? 'time-unavailable' }); return { action: 'wait', reason: 'stale-authorization' }; }
  }
  deps.log({ event: 'action', swapId: s.swapId, action: a.action, kind: a.kind ?? null, xmr, ready: pda?.ready ?? null });
  if (a.action === 'set-ready' || a.action === 'refund') {
    const r = a.action === 'set-ready' ? await deps.sendReady(s) : await deps.sendRefund(s, a.kind);
    if (r?.refused) { if (cursorMoved) deps.store(s); return { action: 'wait', reason: `${a.action}-refused: ${r.refused}` }; }
    if (r?.sig && !r.pending) s[a.action === 'set-ready' ? 'readySig' : 'refundSig'] = r.sig;
  }
  if (a.action === 'sweep-xmr') { const t = await deps.sweep(s, a.secret); if (t) { s.sweepTxids = t; s.claimSig = outcome.sig; } }
  if (a.action === 'done' && !(await finishIfFinal(s, a.result, outcome, deps))) return { action: 'wait', reason: 'terminal-not-proven' };
  deps.store(s);
  deps.log({ event: 'state', swapId: s.swapId, readySig: s.readySig, refundSig: s.refundSig, sweepTxids: s.sweepTxids, done: s.done });
  return a;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Admission gate (VBU-M1, spec docs MAKER_ADMISSION_GATE_SPEC.md). Separate from the start gate above: it closes NEW quotes and swaps
// only. Recovery (set-ready, refund, XMR sweep, the Worker's claim relay) never looks at it, so a closed admission holds no sweep.
// ---------------------------------------------------------------------------------------------------------------------------------

const UNWRITABLE = new Set(['EACCES', 'EPERM', 'EROFS']);
/**
 * Reads the operator's drain file on EVERY call (no cache, so a close takes effect at the next request, whatever the start gate has
 * cached for the life of the process). Fail closed (R5): only "does not exist" means open; any other answer, including a stat error
 * such as EACCES or ENOTDIR, means closed. With requireUnwritableDir (mainnet) the file's directory must also be one the maker
 * cannot write (R1: the maker can neither create nor remove the file); a writable or missing directory keeps admission closed.
 * fs = { statSync, accessSync, W_OK } (node:fs), injected for tests. onClosed() runs on every read that answers closed.
 */
export function createAdmission({ file, fs, requireUnwritableDir = false, onClosed = () => {} }) {
  const dir = file.slice(0, file.lastIndexOf('/')) || '/';
  function read() {
    try { fs.statSync(file); return { open: false, reason: 'drain-file-present' }; } catch (e) {
      if (e?.code !== 'ENOENT') return { open: false, reason: `drain-file-unreadable-${e?.code ?? 'unknown'}` };
    }
    if (requireUnwritableDir) {
      try { fs.accessSync(dir, fs.W_OK); return { open: false, reason: 'drain-dir-writable-by-maker' }; } catch (e) {
        if (!UNWRITABLE.has(e?.code)) return { open: false, reason: `drain-dir-unusable-${e?.code ?? 'unknown'}` };
      }
    }
    return { open: true, reason: null };
  }
  return {
    file,
    state() { const r = read(); if (!r.open) onClosed(r); return r; },
    isOpen() { return this.state().open; },
  };
}

/**
 * One admission at a time, in call order; one failure never blocks the next (same helper as PR 675). Counts admissions waiting in the
 * queue and the one running, so /v1/status can show work the swap files cannot show yet (R4).
 * Sol M1 (second round): public admissions share this FIFO but are BOUNDED and CANCELLABLE before they start. run(fn, { public: true, signal })
 * rejects at once with busy-try-later when publicMaxQueued public admissions already wait, removes the entry (and rejects with busy-try-later
 * on the deadline, client-gone on abort) while it waits, and never starts fn for a removed entry. Token admissions (no options) are unbounded
 * and uncancelled as before. Once fn has started nothing here interrupts it; admitSwap checks the signal at its own stage boundaries,
 * before the first persistent commitment only.
 * opts: { publicMaxQueued = 4, publicDeadlineMs = 10000, setTimer, clearTimer } (timers injectable for tests).
 */
export function createAdmissionSerial(opts = {}) {
  const { publicMaxQueued = 4, publicDeadlineMs = 10_000, setTimer = setTimeout, clearTimer = clearTimeout } = opts;
  const waiting = []; let busy = false, queued = 0, running = 0;
  const pump = () => {
    if (busy) return;
    const e = waiting.shift();
    if (!e) return;
    busy = true;
    Promise.resolve().then(async () => { queued -= 1; running += 1; try { return await e.fn(); } finally { running -= 1; } })
      .then(e.ok, e.fail).finally(() => { busy = false; pump(); });
  };
  return {
    run(fn, o = {}) {
      const isPublic = o.public === true;
      if (isPublic) {
        if (o.signal?.aborted) return Promise.reject(new Error('client-gone'));
        if (waiting.filter((w) => w.public).length >= publicMaxQueued) return Promise.reject(new Error('busy-try-later'));
      }
      let ok, fail;
      const promise = new Promise((res, rej) => { ok = res; fail = rej; });
      const e = { fn, ok, fail, public: isPublic };
      queued += 1; waiting.push(e);
      if (isPublic) {
        let timer = null, onAbort = null;
        const cleanup = () => { clearTimer(timer); o.signal?.removeEventListener('abort', onAbort); };
        const drop = (why) => { const i = waiting.indexOf(e); if (i < 0) return; waiting.splice(i, 1); queued -= 1; cleanup(); fail(new Error(why)); };
        timer = setTimer(() => drop('busy-try-later'), o.deadlineMs ?? publicDeadlineMs);
        onAbort = () => drop('client-gone');
        o.signal?.addEventListener('abort', onAbort, { once: true });
        promise.then(cleanup, cleanup);
      }
      pump();
      return promise;
    },
    counts: () => ({ queued, running, inflight: queued + running }),
  };
}

/**
 * The XMR -> SOL admission with every side effect injected. d = { isOpen() (start gate AND admission, read live), takeQuote(quoteId)
 * (returns and forgets the quote, throws quote-expired), checkLimits(q), prepare(q, input) -> { record, signed } (every await: proofs,
 * balance, keys, chain time, daemon height, blockhash, simulation, local signing), store(record), broadcast(signed, record) }.
 * Order: entry check, limits, prepare, then the LAST check (R4) with no await between it and store(), the first persistent commitment.
 * The record stored carries the secret AND the signed lock's signature and last valid block height, written BEFORE the broadcast, so
 * a lock whose send response is lost is never mistaken for "never locked" (Astra round 2: ambiguous lock).
 */
export async function admitSwap(input, d) {
  if (input.signal?.aborted) throw new Error('client-gone');   // M1: a gone client costs nothing before the quote is taken
  const q = d.takeQuote(input.quoteId);
  if (!d.isOpen()) throw new Error('maker-paused');
  d.checkLimits(q, input);
  const { record, signed } = await d.prepare(q, input);
  if (input.signal?.aborted) throw new Error('client-gone');   // M1: last cancellation point: nothing is stored or broadcast yet; after store() it never applies
  if (!d.isOpen()) throw new Error('maker-paused');      // R4: re-check after the last await, immediately before the commitment
  d.store(record);
  return d.broadcast(signed, record);
}


// ---- Lock records and their classification (spec revision 2: R9, R10, K0 to K4; Astra AG-H2, AG-M1) ----
// R9 write-ahead record: admitSwap stores the swap file only after the lock is signed, and that first store already holds lockSig,
// lockBlockhash and lockLastValidBlockHeight (fsync) BEFORE the broadcast; lockSig is never cleared. Because nothing is stored before
// signing, this maker has no "stored but unsigned" state: an admission that fails before signing leaves no file at all. K3
// (abortedBeforeSign) is still classified for completeness. R10: locks, ready and refund use a recent blockhash, never a durable nonce
// (client/sol.mjs send and maker-chain prepareSigned; a test checks it), so an unlanded lock stops being landable after its
// lastValidBlockHeight. A record that names a nonce (lockNonce) never gets K2 or K4.
//
// Evidence (maker-chain collectEvidence) is { expiry: { slot, height } (finalized tip slot and the height of the block at that slot),
// historyIndex: { ok } (the history services already cover the expiry slot), account: { slot, kind: none|escrow|non-escrow|unknown-type },
// history: [{ signature, err, slot, kind }] | null, sigStatus (null = not found, undefined = unread), sigStatusSlot, boundary }.
// Every negative answer counts only when its context slot is at or after the expiry observation's slot: an absence read from before
// the expiry observation (a lagging node, a stale cache, a history service behind the node) is rejected, never combined.
// Residual assumption, documented in the runbook: the RPC is honest. Context checks reject stale answers; they cannot beat an RPC that lies.
export const LOCK_FORMAT = 2;
export const K4_TIME_MARGIN_S = 120;      // H = first finalized block whose blockTime is >= maker-started + this
export const K4_HEIGHT_MARGIN = 300;      // the finalized block height must exceed H + this (a blockhash is valid for 150 blocks)
export const EXPIRY_MARGIN = 32;          // K2: the expiry block's height must exceed lockLastValidBlockHeight + this
export const NEVER_LANDED_RECHECK_S = 120; // maker: two coherent K2 observations at least this far apart, the second from a later context

/** What the record itself says about its lock: 'final', 'locked', 'pending' (write-ahead record, not settled), 'never-landed' or 'legacy'. */
export function lockStage(s) {
  if (s.done) return 'final';
  if (s.solLocked === true) return 'locked';
  const sig = typeof s.lockSig === 'string' && s.lockSig.length > 0;
  if (sig && Number.isInteger(s.lockLastValidBlockHeight)) return s.lockNeverLanded ? 'never-landed' : 'pending';
  if (sig) return 'locked';                            // old code wrote lockSig only after a confirmed send
  return 'legacy';                                     // no lockSig: NOT evidence that nothing was sent
}

const fresh = (slot, ev) => Number.isInteger(slot) && slot >= ev.expiry.slot;
/** History entries that cannot have created, changed or closed an escrow: failed transactions (other than the lock itself) and transactions
 * that do not include the program at all. Anything else in the history blocks every absence class. */
function absenceHistoryProblem(s, ev) {
  if (!Array.isArray(ev.history)) return 'pda-history-unreadable';
  if (!ev.historyIndex?.ok) return 'history-index-behind-expiry';
  for (const h of ev.history) {
    if (h.signature === s.lockSig) return 'lock-in-pda-history';
    if (h.err || h.kind === 'unrelated') continue;
    return 'pda-has-program-history';
  }
  return null;
}

/** Final states of a SOL -> XMR record (maker-reverse.mjs / reverse-core.mjs makerReverseNext). */
export const REVERSE_FINAL = new Set(['completed', 'xmr-recovered', 'refunded-before-send', 'not-locked', 'xmr-never-relayed']);

/**
 * Send attempts (maker-send.mjs, both directions) the record still holds as open are settled here from the check's OWN reads, never from the
 * record. Two different answers, never merged (Astra 701 round 1):
 * - landed or failed: a FINALIZED status (success or error) for the signature;
 * - cannot land now, and never executed as far as finalized history shows: the signature unknown to the status history (an answer from a
 *   context at or after the expiry observation), the expiry height above its last valid height + EXPIRY_MARGIN, the history services
 *   proven not to lag behind the expiry block (historyIndex.ok), and the escrow address's finalized history readable and NOT naming the
 *   signature. This is narrower than K2 for locks (which also needs an empty account and an absence-only history): an attempt carries no
 *   escrow creation, so "cannot land now" plus "not in the finalized history" is what the upgrade needs.
 * Anything else is ambiguous: the bytes may still land, or the indexes disagree. Returns null (no problem) or the reason.
 */
export function attemptsProblem(s, ev) {
  for (const list of ATTEMPT_LISTS) for (const att of s[list] ?? []) {
    if (!att || !OPEN_ATTEMPT_STATES.has(att.state)) continue;
    const tag = `${att.action ?? list} ${String(att.sig ?? '').slice(0, 8)}`;
    const e = ev.attempts?.[att.sig];
    if (!e || e.status === undefined) return `attempt-status-unread (${tag})`;
    if (!fresh(e.slot, ev)) return `stale-attempt-status-context (${tag})`;
    if (e.status && e.status.confirmationStatus === 'finalized') continue;
    if (e.status) return `attempt-not-finalized (${tag})`;
    if (!Number.isInteger(att.lastValidBlockHeight) || ev.expiry.height <= att.lastValidBlockHeight + EXPIRY_MARGIN) return `attempt-may-still-land (${tag})`;
    if (!ev.historyIndex?.ok) return `history-index-behind-expiry (${tag})`;
    if (!Array.isArray(ev.history)) return `pda-history-unreadable (${tag})`;
    if (ev.history.some((h) => h.signature === att.sig)) return `attempt-in-history-but-status-unknown (${tag})`;
  }
  return null;
}

/**
 * Quiesce classification of ONE swap file by positive evidence (spec section 4, item 3). Returns { k: 'K0'..'K4', why, txids?, nonEscrow? }
 * or { k: null, why } = NOT OK (ambiguous). The record itself is never changed (R11).
 * Both directions: a SOL -> XMR record (direction 'sol-xmr', the maker is the claimer of a strict escrow) passes only as K0: final, no escrow
 * at its strict PDA, every send attempt settled. An open SOL -> XMR swap always blocks (the maker's XMR, the user's SOL or a secret may be in
 * flight). In either direction an open record carrying an ambiguity mark (earlyAbort, claimAbort, endpointDisagreement) blocks, and so does
 * any send attempt that may still land.
 */
export function classifyRecord(s, ev) {
  if (!ev) return { k: null, why: 'no-evidence' };
  if (!ev.expiry || !Number.isInteger(ev.expiry.slot) || !Number.isInteger(ev.expiry.height)) return { k: null, why: 'expiry-unobserved' };
  const a = ev.account;
  if (!a) return { k: null, why: 'pda-unreadable' };
  if (a.kind === 'escrow') return { k: null, why: 'escrow-at-pda' };      // positive, whatever its age
  if (!fresh(a.slot, ev)) return { k: null, why: 'stale-account-context' };
  if (a.kind !== 'none' && a.kind !== 'non-escrow') return { k: null, why: 'unknown-account-at-pda' };
  // AG-M1: a plain lamport balance at a PDA whose escrow is proven closed or never created is reported, not blocking.
  const extra = a.kind === 'non-escrow' ? { nonEscrow: { owner: a.owner, lamports: a.lamports } } : {};
  if (!s.done && (s.earlyAbort || s.claimAbort || s.endpointDisagreement)) return { k: null, why: 'ambiguity-mark-on-open-swap' };
  const ap = attemptsProblem(s, ev); if (ap) return { k: null, why: ap };
  if (s.direction === 'sol-xmr') {
    if (!s.done) return { k: null, why: 'reverse-swap-open' };
    if (!REVERSE_FINAL.has(s.done)) return { k: null, why: `unknown final state ${String(s.done).slice(0, 20)}` };
    return { k: 'K0', why: `sol-xmr done ${s.done}, no escrow at the strict PDA, every send attempt settled`, ...extra };
  }
  if (s.direction !== undefined && s.direction !== 'xmr-sol') return { k: null, why: 'unknown direction' };
  if (s.done === 'completed' || s.done === 'refunded') return { k: 'K0', why: `done ${s.done}, no escrow at the PDA`, ...extra };
  if (s.done) return { k: null, why: `unknown final state ${String(s.done).slice(0, 20)}` };
  if (!Array.isArray(ev.history)) return { k: null, why: 'pda-history-unreadable' };
  const ok = ev.history.filter((h) => !h.err);
  const lock = ok.find((h) => h.kind === 'lock'), end = ok.find((h) => h.kind === 'claim' || h.kind === 'refund');
  if (lock && end) return { k: 'K1', why: `lock and ${end.kind} found in the PDA history`, txids: [lock.signature, end.signature], ...extra };
  // Absence classes: every negative answer from a context at or after the expiry observation.
  const nonce = s.lockNonce !== undefined, height = ev.expiry.height;
  if (typeof s.lockSig === 'string' && s.lockSig && Number.isInteger(s.lockLastValidBlockHeight)) {
    if (nonce) return { k: null, why: 'durable-nonce-lock-never-expires' };
    if (ev.sigStatus === undefined) return { k: null, why: 'lock-status-unread' };
    if (ev.sigStatus !== null) return { k: null, why: 'lock-signature-known-to-cluster' };
    if (!fresh(ev.sigStatusSlot, ev)) return { k: null, why: 'stale-status-context' };
    if (height <= s.lockLastValidBlockHeight + EXPIRY_MARGIN) return { k: null, why: 'lock-may-still-land' };
    const hp = absenceHistoryProblem(s, ev); if (hp) return { k: null, why: hp };
    return { k: 'K2', why: `lock ${s.lockSig.slice(0, 8)} unknown to the cluster and expired (height ${height} > ${s.lockLastValidBlockHeight} + ${EXPIRY_MARGIN})`, ...extra };
  }
  if (s.abortedBeforeSign && !s.lockSig) {
    const hp = absenceHistoryProblem(s, ev); if (hp) return { k: null, why: hp };
    return { k: 'K3', why: 'aborted before signing', ...extra };
  }
  if (!s.lockSig && !Number.isInteger(s.lockLastValidBlockHeight) && !nonce) {
    const b = ev.boundary ?? {};
    if (typeof b.started !== 'string' || typeof s.createdAt !== 'string' || !(s.createdAt < b.started)) return { k: null, why: 'no-process-boundary' };
    if (!Number.isInteger(b.H) || height <= b.H + K4_HEIGHT_MARGIN) return { k: null, why: 'process-boundary-not-yet-expired' };
    const hp = absenceHistoryProblem(s, ev); if (hp) return { k: null, why: hp };
    return { k: 'K4', why: `written before maker-started ${b.started}; finalized height ${height} > H ${b.H} + ${K4_HEIGHT_MARGIN}`, ...extra };
  }
  return { k: null, why: 'ambiguous' };
}

/**
 * Maker-side view of a write-ahead record whose outcome is not known yet: 'locked' (an identified escrow is at the PDA in any context, or the
 * lock signature is finalized without error), 'never-locked' (exactly the K2 evidence, all fresh) or 'pending'.
 */
export function lockOutcome(s, ev) {
  if (!ev) return { state: 'pending', why: 'no-evidence' };
  if (ev.account?.kind === 'escrow') return { state: 'locked', why: 'escrow-account-exists' };
  if (ev.sigStatus && ev.sigStatus.confirmationStatus === 'finalized' && !ev.sigStatus.err) return { state: 'locked', why: 'lock-tx-finalized' };
  const c = classifyRecord(s, ev);
  if (c.k === 'K2') return { state: 'never-locked', why: c.why };
  return { state: 'pending', why: c.why };
}

/**
 * Loop pass for a write-ahead record not yet settled (stage 'pending' or 'never-landed'). deps = { evidence(s) -> ev, store(s), log(e), now() }.
 * - 'locked' marks the record locked (also from 'never-landed': an alarm, since that means an earlier answer was wrong).
 * - 'never-locked' needs TWO coherent K2 observations: the second at least NEVER_LANDED_RECHECK_S later and with an expiry observation
 *   from a slot after the first one's absence reads. Only then is lockNeverLanded recorded. The record is never set done: it stays in the
 *   recovery loop (makerStep keeps running, and this function keeps watching for a late escrow); it only stops counting toward the open cap.
 * - anything else ('pending', an unreadable or stale answer) drops an unconfirmed first observation and changes nothing else.
 * Nothing is deleted: the file, the secret and lockSig stay (R11).
 */
export async function resolveLock(s, deps) {
  const nowMs = deps.now?.() ?? Date.now();
  let ev = null;
  try { ev = await deps.evidence(s); } catch (e) { deps.log({ event: 'lock-evidence-error', swapId: s.swapId, error: String(e?.message ?? e) }); }
  const c = lockOutcome(s, ev);
  const was = lockStage(s);
  if (c.state === 'locked') {
    s.solLocked = true; s.lockEvidence = { why: c.why, at: new Date(nowMs).toISOString() }; deps.store(s);
    deps.log({ event: was === 'never-landed' ? 'lock-landed-after-never-landed' : 'lock-landed-late', swapId: s.swapId, why: c.why });
    return c;
  }
  if (was === 'never-landed') return c;                 // settled already; only a landing changes it
  if (c.state === 'never-locked') {
    const obs = { expirySlot: ev.expiry.slot, height: ev.expiry.height, absenceSlot: Math.min(ev.account.slot, ev.sigStatusSlot), at: new Date(nowMs).toISOString() };
    const first = s.lockAbsenceSeen;
    if (first && obs.expirySlot > first.absenceSlot && nowMs - Date.parse(first.at) >= NEVER_LANDED_RECHECK_S * 1000) {
      s.lockNeverLanded = { why: c.why, observations: [first, obs] }; s.lockAbsenceSeen = null; deps.store(s);
      deps.log({ event: 'lock-never-landed', swapId: s.swapId, why: c.why });
      return { state: 'never-landed', why: c.why };
    }
    if (!first) { s.lockAbsenceSeen = obs; deps.store(s); }
    deps.log({ event: 'lock-absence-seen', swapId: s.swapId, why: c.why, confirm: !!first });
    return { state: 'pending', why: first ? 'awaiting-second-observation' : 'first-observation' };
  }
  if (s.lockAbsenceSeen) { s.lockAbsenceSeen = null; deps.store(s); }
  deps.log({ event: 'lock-pending', swapId: s.swapId, why: c.why });
  return c;
}
