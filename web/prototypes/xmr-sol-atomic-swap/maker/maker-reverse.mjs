// SOL -> XMR maker plumbing (maker = Alice, the claimer). Every side effect is injected so the decision path,
// the send-once rule and restart behaviour are tested deterministically. Decisions: client/reverse-core.mjs.
import { makerReverseNext, REV_SEND_MIN_LEAD } from '../client/reverse-core.mjs';
import { LOCK_WAIT } from '../client/swap-core.mjs';
import { finishIfFinal } from './maker-core.mjs';
import { CLOCK_LAG_S, createAuthorizer } from '../client/secret-send.mjs';

/**
 * Where XMR received in an XMR -> SOL swap goes (owner decision, 5 Nov 2026): into the maker's own treasury as SOL -> XMR
 * inventory while that stays at or under the ceiling, otherwise to the owner's address. Without recycling (or without an owner
 * address) the old rule holds: the owner's address when set, else the treasury.
 */
export function sweepDestination({ recycle, treasuryAtomic, incomingAtomic, ceilingAtomic, ownerAddress, treasuryAddress }) {
  if (!recycle || !ownerAddress) return ownerAddress ? { kind: 'owner', address: ownerAddress } : { kind: 'treasury', address: treasuryAddress };
  return BigInt(treasuryAtomic) + BigInt(incomingAtomic) <= BigInt(ceilingAtomic) ? { kind: 'treasury', address: treasuryAddress } : { kind: 'owner', address: ownerAddress };
}

/** The XMR the maker may still commit: unlocked treasury balance minus open reverse swaps not yet sent, minus a fee reserve. */
export function freeInventory(unlockedAtomic, openReverse, reserveAtomic) {
  const committed = openReverse.filter((s) => !s.xmrSendTxid && !s.done).reduce((t, s) => t + BigInt(s.xmrAtomic), 0n);
  const free = BigInt(unlockedAtomic) - committed - BigInt(reserveAtomic);
  return free > 0n ? free : 0n;
}

/**
 * Astra r4 N1: capacity is enforced where it becomes a commitment, at registration, not only at quote time. The caller runs this
 * inside one serialized section (createSerial) and stores the swap file before leaving it, so the stored record is the durable
 * reservation the next admission counts. Counts are over ALL directions (one open-swap limit and one daily quota shared by both).
 * Inventory is the unlocked treasury minus every open SOL -> XMR swap not yet sent, minus the fee reserve.
 * @returns {true} or throws the same error codes the quote uses
 * capsAdmission is the part both directions share (per swap, open count, daily quota); the normal XMR -> SOL start uses it too, through the
 * SAME serialized section as the reverse registration (Astra r5), so mixed concurrent admissions are counted together.
 */
export function capsAdmission({ xmrAtomic, openCount, lockedTodayAtomic, caps }) {
  const x = BigInt(xmrAtomic);
  if (!(x >= BigInt(caps.minAtomic) && x <= BigInt(caps.maxPerSwapAtomic))) throw new Error('amount-outside-limits');
  if (openCount >= caps.maxOpen) throw new Error('busy-try-later');
  if (BigInt(lockedTodayAtomic) + x > BigInt(caps.maxPerDayAtomic)) throw new Error('daily-limit-reached');
  return true;
}
export function reverseAdmission({ xmrAtomic, openCount, lockedTodayAtomic, unlockedAtomic, openReverse, caps }) {
  capsAdmission({ xmrAtomic, openCount, lockedTodayAtomic, caps });
  if (freeInventory(unlockedAtomic, openReverse, caps.reserveAtomic) < BigInt(xmrAtomic)) throw new Error('inventory-low');
  return true;
}

/** How long a commit or claim just sent is left alone before the next pass may send it again. */
export const RESEND_PAUSE_MS = 60_000;

/** Runs jobs one at a time in call order; one failure never blocks the next. */
export function createSerial() {
  let tail = Promise.resolve();
  return (fn) => { const run = tail.then(fn, fn); tail = run.then(() => {}, () => {}); return run; };
}

/** Before a NEW transfer is built: the unlocked balance must still cover this swap and the fee reserve (the quote-time check can be stale). */
export function canSendNow({ unlockedAtomic, xmrAtomic, reserveAtomic }) {
  return BigInt(unlockedAtomic) >= BigInt(xmrAtomic) + BigInt(reserveAtomic);
}

/**
 * One maker pass for one SOL -> XMR swap. deps = { readSwapFinalized(), readRevealed(which, point, cursor, onCursor),
 * chainNow(), scanXmr(s), buildXmrTransfer(s) -> { txid, hex }, relayXmr(hex, { authorize, mark }) -> { sent }, sendCommit(s) -> { sig, pending? } | { refused },
 * sendClaim(s) -> { sig, pending? } | { refused }, resolve?(s) -> { open }, recoverXmr(s, secretHex) -> { status, txids? }, store(s), log(e), sendAllowed() }.
 * The Solana sends are maker-send.mjs (the ONE send discipline of both directions): every commit and claim attempt is stored before its
 * bytes leave, goes to every endpoint, is settled only from finalized evidence (resolve), and while one is open nothing new is decided or
 * sent for this swap. The claim gate (the deadline c + W read at finalized on every endpoint, the blockhash bound) lives in the sender.
 * The XMR transfer is built without relaying, recorded durably, and only then relayed (M2): a restart re-relays the
 * same signed transaction and never builds a second one.
 */
export async function makerReverseStep(s, deps) {
  const pda = await deps.readSwapFinalized();
  let outcome = null, cursorMoved = false;
  if (pda) { if (!s.seenPda) { s.seenPda = true; cursorMoved = true; } }
  else if (s.seenPda) {
    s.histCursor ??= {};
    const read = (which, point) => deps.readRevealed(which, point, s.histCursor[which] ?? null, (c) => { if ((s.histCursor[which] ?? null) !== c) { s.histCursor[which] = c; cursorMoved = true; } });
    const c = await read('claim', s.A);
    const r = c ? null : await read('refund', s.B);
    outcome = c ? { kind: 'claimed', secret: c.secretHex, sig: c.sig } : r ? { kind: 'refunded', secret: r.secretHex, sig: r.sig } : null;
  }
  const now = await deps.chainNow();
  if (!pda && !s.seenPda) {
    // The user never locked: the quote expired and nothing can arrive any more (the user's side never locks late).
    // 701-H1: "never locked" is a terminal result too: proven only when the strict escrow is absent at FINALIZED on every endpoint.
    if (now > s.quoteExpiresAt + LOCK_WAIT) {
      if (!(await finishIfFinal(s, 'not-locked', null, deps))) return { action: 'wait', reason: 'terminal-not-proven' };
      deps.store(s); deps.log({ event: 'state', swapId: s.swapId, done: s.done }); return { action: 'done', result: s.done };
    }
    if (cursorMoved) deps.store(s);
    return { action: 'wait', reason: 'await-user-lock' };
  }
  // A signed transfer recorded but not yet relayed (crash between the two): relay that same transaction again.
  // Astra r6/r7 and the design note: BUILT MEANS SENT. The XMR transfer is relayed only while the send window is open, judged on a clock read INSIDE relayXmr, right before
  // the bytes leave the wallet process (after the wallet queue has opened and refreshed the wallet); `mark` makes the attempt durable first. But the recorded transaction
  // identity (xmrSendTxid, xmrSendHex) is NEVER deleted, whatever happens (a lost reply, a crash, a clock failure, an expired window): anyone holding the hex or the wallet's
  // pending transaction could still put it on chain, so the maker keeps running the whole state machine with xmrSent set. A transfer we decide not to relay is only
  // flagged (xmrRelayAbandoned): we never relay it ourselves again, the scan still looks for it, and a refund still leads to recovery.
  // Astra r8: the XMR send window is authorized by ELAPSED time: the monotonic clock is read BEFORE the chain-time request goes out, the node's answer is
  // taken as of the request, and the whole request-to-reply time is added (the real time at the reply is at most that), plus the clock-lag allowance. A delayed
  // reply can only make the estimate later. One authorizer per relay attempt, called right before the bytes leave the wallet process.
  const monoNow = deps.mono ?? (() => performance.now());
  const windowState = async () => {
    const authorize = createAuthorizer({ now: deps.chainNow, mono: monoNow, notAfter: s.t0 - REV_SEND_MIN_LEAD });
    try { await authorize('xmr-relay'); return 'open'; } catch (e) { return String(e?.message).startsWith('clock-unavailable') ? 'clock' : 'closed'; }
  };
  const guardedRelay = async (retry) => {
    let refused = null;
    const res = await deps.relayXmr(s.xmrSendHex, {
      authorize: async () => { const w = await windowState(); if (w !== 'open') { refused = w; return false; } return true; },
      mark: () => { s.xmrRelayAttemptAt = Date.now(); deps.store(s); },
    });
    if (res?.sent === false) {
      if (refused === 'clock') { deps.log({ event: 'xmr-relay-held', swapId: s.swapId, txid: s.xmrSendTxid, why: 'clock-unavailable' }); return { action: 'wait', reason: 'clock-unavailable' }; }
      s.xmrRelayAbandoned = s.xmrRelayAttemptAt ? 'window-closed-after-attempt' : 'window-closed-never-attempted'; deps.store(s);
      deps.log({ event: 'xmr-relay-abandoned', swapId: s.swapId, txid: s.xmrSendTxid, why: s.xmrRelayAbandoned });
      return { action: 'wait', reason: 'relay-abandoned' };
    }
    s.xmrRelayed = true; deps.store(s); deps.log({ event: 'xmr-relayed', swapId: s.swapId, txid: s.xmrSendTxid, retry });
    return null;
  };
  // Retry of a recorded, not yet confirmed relay. Only while the swap is undecided (no claim or refund yet); a held or refused retry never ends the pass:
  // the scan below and, after a refund, the recovery path still run.
  if (pda && !outcome && s.xmrSendTxid && !s.xmrRelayed && s.xmrSendHex && !s.xmrRelayAbandoned) { const r = await guardedRelay(true); if (r?.reason === 'relay-abandoned') return r; }
  // Unified send discipline (AG-R2-H1 for both directions): a commit or claim attempt not yet settled from finalized evidence blocks every
  // new Solana decision for this swap. Recovery after a refund (no escrow any more) is never blocked by it.
  // Settled on every pass, also when the escrow looks absent (701-H1); only an escrow that is present makes an open attempt block decisions.
  if (deps.resolve) {
    const r = await deps.resolve(s);
    if (r.open && pda) { if (cursorMoved) deps.store(s); return { action: 'wait', reason: 'attempt-unsettled' }; }
  }
  // After the maker's commit the scan is no longer needed (the commit already required its confirmed XMR) and the claim does not depend on it.
  const xmrOwn = s.xmrSendTxid && pda && now < pda.t1 && !pda.claimCommittedAt ? await deps.scanXmr(s) : null;
  // The scan sees the recorded transaction (pool or chain): an unresolved relay is now known to have gone out.
  if (xmrOwn && s.xmrSendTxid && !s.xmrRelayed) { s.xmrRelayed = true; deps.store(s); deps.log({ event: 'xmr-relay-observed', swapId: s.swapId, txid: s.xmrSendTxid }); }
  const terms = { A: s.A, B: s.B, claimer: s.claimer, refunder: s.refunder, lamports: s.lamports, t0: s.t0, t1: s.t1, xmrAtomic: s.xmrAtomic, userProofOk: s.userProofOk === true };
  const obs = { terms, pda, outcome, xmrSent: s.xmrSendTxid ?? null, xmrOwn, xmrRecovered: !!s.recoverTxids, finalized: !!pda };
  const a = makerReverseNext({ now, ...obs });
  if (a.action === 'wait') { if (cursorMoved) deps.store(s); return a; }
  // The decision window and the relay window must agree: with the clock-lag allowance included, a transfer that could not be relayed is not even built.
  if (a.action === 'send-xmr' && now + CLOCK_LAG_S >= (pda?.t0 ?? s.t0) - REV_SEND_MIN_LEAD) { if (cursorMoved) deps.store(s); return { action: 'wait', reason: 'too-late-to-send' }; }
  if (a.action === 'send-xmr' && deps.canSend && !(await deps.canSend(s))) { if (cursorMoved) deps.store(s); deps.log({ event: 'send-held-inventory', swapId: s.swapId }); return { action: 'wait', reason: 'inventory-low' }; }
  if (a.action === 'send-xmr' && deps.sendAllowed && !deps.sendAllowed()) { if (cursorMoved) deps.store(s); deps.log({ event: 'send-held', swapId: s.swapId }); return { action: 'wait', reason: 'send-held' }; }
  // Astra r5 (High): `now` was read before the scan, which can be slow. An action that sends XMR or reveals the secret `a` (the claim) is
  // authorized again with the time read NOW, immediately before the side effect; if the margin is gone, or the time cannot be read, nothing is sent.
  // v2 throttles: a commit or claim sent a moment ago is given time to be seen by the FINALIZED read before it is sent again (a repeat is harmless on chain, only a fee).
  const wall = deps.wallNow ? deps.wallNow() : Date.now();
  if (a.action === 'commit-claim' && s.commitSentAt && wall - s.commitSentAt < RESEND_PAUSE_MS) { if (cursorMoved) deps.store(s); return { action: 'wait', reason: 'commit-pending-finality' }; }
  if (a.action === 'claim' && s.claimSentAt && wall - s.claimSentAt < RESEND_PAUSE_MS) { if (cursorMoved) deps.store(s); return { action: 'wait', reason: 'claim-pending-finality' }; }
  // A claim attempt that stayed open into the end of its window: no further claim, ever (a may be out; only the user's refund and recovery remain).
  if ((a.action === 'claim' || a.action === 'commit-claim') && s.claimAbort === 'ambiguous') { if (cursorMoved) deps.store(s); return { action: 'wait', reason: 'claim-ambiguous-await-refund' }; }
  if (a.action === 'send-xmr' || a.action === 'claim' || a.action === 'commit-claim') {
    let fresh = null;
    try { fresh = await deps.chainNow(); } catch { /* fail closed below */ }
    const again = Number.isFinite(fresh) ? makerReverseNext({ now: fresh, ...obs }) : null;
    if (again?.action !== a.action) { if (cursorMoved) deps.store(s); deps.log({ event: 'stale-authorization', swapId: s.swapId, action: a.action, now, fresh, reason: again?.reason ?? 'time-unavailable' }); return { action: 'wait', reason: 'stale-authorization' }; }
  }
  deps.log({ event: 'action', swapId: s.swapId, action: a.action, xmrOwn, ready: pda?.ready ?? null });
  if (a.action === 'send-xmr') {
    const tx = await deps.buildXmrTransfer(s);
    s.xmrSendTxid = tx.txid; s.xmrSendHex = tx.hex; s.xmrRelayed = false; deps.store(s); // durable BEFORE broadcast (M2)
    const held = await guardedRelay(false); if (held) return held;
  }
  // Step one of the claim (v2): secret-free, signed by the maker. The secret leaves only after the FINALIZED account shows this commit (next pass).
  if (a.action === 'commit-claim') {
    s.commitSentAt = wall; deps.store(s);
    const r = await deps.sendCommit(s);
    if (r?.refused) { deps.store(s); return { action: 'wait', reason: `commit-refused: ${r.refused}` }; }
    if (r?.sig && !r.pending) s.commitSig = r.sig;
  }
  // Step two reveals `a`: only through the sender's strict claim path (never simulated, never priced, recorded before broadcast, both endpoints),
  // against the deadline c + W read at finalized on every endpoint, never an estimate. A new variant only after the previous attempt is settled
  // (expired) and only while the blockhash provably expires before c + W: the refund cannot open before c + W.
  if (a.action === 'claim') {
    const prevClaimSentAt = s.claimSentAt;
    s.claimSentAt = wall; deps.store(s);
    const r = await deps.sendClaim(s);
    if (r?.refused) {
      // A refusal the sender marks `unsent` (nothing signed, nothing broadcast: it stopped at its gate) must not start the 60 s pause, so the next pass really calls the
      // sender again. Any other refusal, a pending attempt, an ambiguous result or a thrown error keeps the stamp exactly as before.
      if (r.unsent === true) { if (prevClaimSentAt === undefined) delete s.claimSentAt; else s.claimSentAt = prevClaimSentAt; }
      deps.store(s); return { action: 'wait', reason: `claim-refused: ${r.refused}` };
    }
    if (r?.sig && !r.pending) s.claimSig = r.sig;
  }
  if (a.action === 'recover-xmr') {
    // recoverXmr -> { status: 'recovered', txids } | { status: 'pending' } | { status: 'absent' }; a throw is "unknown" and propagates (nothing is counted).
    const res = await deps.recoverXmr(s, a.secret);
    if (res?.status === 'recovered') { s.recoverTxids = res.txids; s.recoverState = 'recovered'; }
    else if (res?.status === 'pending') { s.recoverState = 'pending'; }
    else if (res?.status === 'absent') {
      // Only a real "absent" scan counts, at least 100 s apart. And only a transfer that provably never left our hands (no relay attempt, never observed on chain) may END this way;
      // a transfer that was attempted or seen stays open (state absent-after-attempt) and is never counted out: an operator resolves it from the kept txid and hex.
      const nowMs = Date.now(); if (!s.recoverLastEmptyAt || nowMs - s.recoverLastEmptyAt >= 100_000) { s.recoverEmptyScans = (s.recoverEmptyScans ?? 0) + 1; s.recoverLastEmptyAt = nowMs; }
      const neverLeft = !s.xmrRelayAttemptAt && !s.xmrRelayed && Boolean(s.xmrRelayAbandoned);
      if (neverLeft && s.recoverEmptyScans >= 3) {
        s.recoverState = 'never-relayed';
        if (await finishIfFinal(s, 'xmr-never-relayed', outcome, deps)) deps.log({ event: 'recover-empty-terminal', swapId: s.swapId, txid: s.xmrSendTxid });
        else { deps.store(s); return { action: 'wait', reason: 'terminal-not-proven' }; }
      }
      else if (!neverLeft && s.recoverEmptyScans >= 3 && s.recoverState !== 'absent-after-attempt') { s.recoverState = 'absent-after-attempt'; deps.log({ event: 'recover-absent-after-attempt', swapId: s.swapId, txid: s.xmrSendTxid }); }
    } else throw new Error('recover-xmr: unrecognized result'); // never guess
  }
  if (a.action === 'done' && !(await finishIfFinal(s, a.result, outcome, deps))) return { action: 'wait', reason: 'terminal-not-proven' };
  deps.store(s);
  deps.log({ event: 'state', swapId: s.swapId, xmrSendTxid: s.xmrSendTxid, claimSig: s.claimSig, recoverTxids: s.recoverTxids, done: s.done });
  return a;
}

/**
 * Where the XMR stands at the joint address after a refund revealed b (Astra r8). Four distinct answers, never merged:
 *   recovered: unlocked funds exist (the caller sweeps them);   pending: funds exist but are locked/unconfirmed, or an incoming transfer is listed (wait, never count);
 *   absent: the wallet's balance is zero AND no incoming transfer is listed (the only answer that may count toward an end).
 * A thrown error (RPC down, scan failure, timeout) is "unknown": it must reach the caller as an exception, which never increments anything.
 */
export function classifyJointBalance(bal, transfers) {
  const unlocked = BigInt(bal?.unlocked_balance ?? 0), total = BigInt(bal?.balance ?? 0);
  if (unlocked > 0n) return { status: 'sweepable', unlocked: unlocked.toString() };
  const listed = (transfers?.in?.length ?? 0) + (transfers?.pool?.length ?? 0);
  if (total > 0n || listed > 0) return { status: 'pending', balance: total.toString(), listed };
  return { status: 'absent' };
}

/** wallet-rpc `transfer` request for the maker's one XMR send: built but not relayed, asking for the metadata that `relay_tx` takes
 * (`tx_metadata`; `tx_blob` is the raw transaction and relay_tx rejects it with "Failed to parse tx metadata"). */
export const xmrTransferRequest = (address, xmrAtomic) => ({ destinations: [{ amount: Number(xmrAtomic), address }], priority: 0, do_not_relay: true, get_tx_metadata: true });
/** The { txid, hex } the step records before it relays; hex is the relay_tx metadata. */
export function xmrTransferResult(r) {
  if (typeof r?.tx_hash !== 'string' || typeof r?.tx_metadata !== 'string' || !r.tx_metadata) throw new Error('wallet-rpc transfer returned no relayable metadata');
  return { txid: r.tx_hash, hex: r.tx_metadata };
}
