// Deterministic maker tests (Astra round 2): H4 wallet response -> scan -> decision, H5 queue failure and recovery,
// refund while the Monero wallet RPC is down, and H7 resumable history for the maker.
import test from 'node:test'; import assert from 'node:assert/strict';
import { usableFromTransfers, createWalletQueue, makerStep, createStartGate } from './maker-core.mjs';
import { makerNext, MARGIN, LATE_REFUND_MARGIN } from '../client/swap-core.mjs';

const XMR = '50000000000';                       // 0.05 XMR expected
const NOW = 1_800_000_000;
const pdaOpen = { ready: false, t0: NOW + 3600, t1: NOW + 10800, lamports: 1 };
const decide = (transfers, over = {}) => makerNext({ now: NOW, lockedAt: NOW - 600, pda: pdaOpen, outcome: null, xmr: usableFromTransfers(transfers), xmrSwept: false, expectedAtomic: XMR, ...over });
const out = (amount, confirmations, unlock_time = 0) => ({ amount, confirmations, unlock_time });

test('H4: a confirmed but future-locked output never counts toward ready', () => {
  const t = { in: [out(XMR, 50, 3_100_000)] };
  assert.deepEqual(usableFromTransfers(t), { atomic: '0', confirmations: 50, mined: [] }, 'a locked output is not in the mined list either (699-M1)');
  assert.notEqual(decide(t).action, 'set-ready');
});
test('H4: mixed outputs: only unlock_time 0 counts, so a locked top-up cannot complete an underpayment', () => {
  const t = { in: [out('30000000000', 40), out('20000000000', 40, NOW + 86400)] };
  assert.equal(usableFromTransfers(t).atomic, '30000000000');
  assert.notEqual(decide(t).action, 'set-ready');
  const full = { in: [out('30000000000', 40), out('20000000000', 40)] };
  assert.equal(decide(full).action, 'set-ready');
});
test('H4: a pending pool output holds ready back through the minimum confirmation count', () => {
  const t = { in: [out(XMR, 40)], pool: [out('1', 0)] };
  assert.equal(usableFromTransfers(t).confirmations, 0);
  assert.notEqual(decide(t).action, 'set-ready');
  assert.equal(usableFromTransfers({ in: [], pool: [] }), null);
});

function fakeWallet() {
  const calls = []; let down = false, failNextFn = false;
  const W = async (method, params) => { calls.push(method); if (down) throw new Error('ECONNREFUSED'); if (method === 'open_wallet' && params.filename === 'missing') throw new Error('no wallet'); return {}; };
  return { W, calls, set down(v) { down = v; }, set failNextFn(v) { failNextFn = v; } };
}
test('H5: a failed wallet job reaches only its own caller and the next job runs normally', async () => {
  const w = fakeWallet(); const withWallet = createWalletQueue(w.W, 'pw');
  const first = withWallet('a', async () => {}, async () => { throw new Error('boom'); });
  const second = withWallet('b', async () => {}, async () => 'ok');
  await assert.rejects(first, /boom/); assert.equal(await second, 'ok');
  assert.equal(w.calls.filter((c) => c === 'close_wallet').length >= 4, true, 'every job closes its wallet even after a failure');
});
test('H5: the wallet RPC going down fails queued jobs, and the queue recovers when it comes back', async () => {
  const w = fakeWallet(); const withWallet = createWalletQueue(w.W, 'pw');
  w.down = true;
  const jobs = [1, 2, 3].map((i) => withWallet('x' + i, async () => {}, async () => i));
  for (const j of jobs) await assert.rejects(j, /ECONNREFUSED/);
  w.down = false;
  assert.equal(await withWallet('y', async () => {}, async () => 'back'), 'back');
  let created = false; assert.equal(await withWallet('missing', async () => { created = true; }, async () => 'made'), 'made'); assert.equal(created, true);
});

// ---- Sol M1: the public wallet queue is bounded, has deadlines, is cancelled with its caller and never goes ahead of recovery ----
function gate() { let open; const p = new Promise((r) => { open = r; }); return { p, open }; }
function fakeTimers() { const t = []; return { setTimer: (f, ms) => { const h = { f, ms, off: false }; t.push(h); return h; }, clearTimer: (h) => { if (h) h.off = true; }, fire: (i) => { if (!t[i].off) t[i].f(); }, all: t }; }
test('M1: saturating the public lane never puts a public job ahead of a recovery job that arrives later', async () => {
  const w = fakeWallet(), order = []; const q = createWalletQueue(w.W, 'pw', { publicMaxDepth: 3 });
  const g = gate();
  const running = q.publicLane('p0', async () => {}, async () => { order.push('p0'); await g.p; });   // one public job is already running
  await new Promise((r) => setImmediate(r));
  const queued = [1, 2, 3].map((i) => q.publicLane('p' + i, async () => {}, async () => { order.push('p' + i); }));
  await assert.rejects(q.publicLane('over', async () => {}, async () => order.push('over')), /busy-try-later/);   // depth bound: the 4th waits for nothing
  const rec = q('rec', async () => {}, async () => { order.push('rec'); return 'recovered'; });
  g.open();
  assert.equal(await rec, 'recovered'); await running; await Promise.all(queued);
  assert.deepEqual(order, ['p0', 'rec', 'p1', 'p2', 'p3'], 'recovery runs right after the one running job, before every queued public job');
  assert.equal(order.includes('over'), false);
  assert.deepEqual(q.depth(), { recovery: 0, publicLane: 0 });
});
test('M1: a queued public job past its deadline is removed and never touches the wallet; recovery is unaffected', async () => {
  const w = fakeWallet(), tm = fakeTimers(); const q = createWalletQueue(w.W, 'pw', { setTimer: tm.setTimer, clearTimer: tm.clearTimer, publicDeadlineMs: 5000 });
  const g = gate(), ran = [];
  const hold = q('hold', async () => {}, async () => { await g.p; });
  const slow = q.publicLane('late', async () => {}, async () => { ran.push('late'); });
  assert.equal(tm.all[0].ms, 5000);
  tm.fire(0);
  await assert.rejects(slow, /busy-try-later/);
  assert.deepEqual(q.depth(), { recovery: 0, publicLane: 0 });
  g.open(); await hold;
  assert.deepEqual(ran, [], 'the expired job never ran');
  assert.equal(w.calls.filter((c) => c === 'open_wallet').length, 1, 'only the recovery job opened a wallet');
});
test('M1: a client that disconnects while queued cancels its wallet work; one already running releases the caller and finishes alone', async () => {
  const w = fakeWallet(); const q = createWalletQueue(w.W, 'pw');
  const g = gate(), ran = [];
  const hold = q('hold', async () => {}, async () => { await g.p; });
  const ac = new AbortController();
  const queued = q.publicLane('gone', async () => {}, async () => { ran.push('gone'); }, { signal: ac.signal });
  ac.abort();
  await assert.rejects(queued, /client-gone/);
  assert.deepEqual(q.depth().publicLane, 0);
  await assert.rejects(q.publicLane('pre', async () => {}, async () => {}, { signal: ac.signal }), /client-gone/);   // already aborted: never queued
  g.open(); await hold;
  assert.deepEqual(ran, []);
  // running job: the caller is released at once, the executor still closes the wallet and the next job runs
  const g2 = gate(), ac2 = new AbortController(); let finished = false;
  const run = q.publicLane('run', async () => {}, async () => { await g2.p; finished = true; return 'late'; }, { signal: ac2.signal });
  await new Promise((r) => setImmediate(r));
  ac2.abort(); await assert.rejects(run, /client-gone/); assert.equal(finished, false);
  const next = q('next', async () => {}, async () => 'ok');
  g2.open(); assert.equal(await next, 'ok'); assert.equal(finished, true);
});
test('M1: a failing public job reaches only its own caller and the recovery queue keeps working', async () => {
  const w = fakeWallet(); const q = createWalletQueue(w.W, 'pw');
  const bad = q.publicLane('x', async () => {}, async () => { throw new Error('boom'); });
  const rec = q('r', async () => {}, async () => 'fine');
  await assert.rejects(bad, /boom/); assert.equal(await rec, 'fine');
});

function deps(over = {}) {
  const log = [], stored = [], sent = [];
  return {
    log, stored, sent,
    d: {
      readSwap: async () => over.pda ?? null,
      readRevealed: over.readRevealed ?? (async () => null),
      chainNow: async () => over.now ?? NOW,
      scanXmr: over.scanXmr ?? (async () => { throw new Error('wallet rpc down'); }),
      sendReady: async () => { sent.push('ready'); return { sig: 'READY' }; },
      sendRefund: async () => { sent.push('refund'); return { sig: 'REFUND' }; },
      sweep: async () => { sent.push('sweep'); return ['sweep-tx']; },
      store: (s) => stored.push(structuredClone(s)),
      log: (e) => log.push(e),
    },
  };
}
const swap = () => ({ swapId: 'cd'.repeat(32), A: 'aa', B: 'bb', b: '00', lockedAt: NOW - 20000, xmrAtomic: XMR });
test('H5: at t1 the escrow is refunded while the Monero wallet RPC is down (the scan is never called)', async () => {
  let scanned = 0;
  const x = deps({ pda: { ...pdaOpen, t1: NOW - LATE_REFUND_MARGIN }, scanXmr: async () => { scanned++; throw new Error('wallet rpc down'); } });
  const s = swap(); const a = await makerStep(s, x.d);
  assert.equal(a.action, 'refund'); assert.deepEqual(x.sent, ['refund']); assert.equal(scanned, 0); assert.equal(x.stored.at(-1).refundSig, 'REFUND');
});
test('H5: before t1 a wallet RPC failure throws out of this pass only, sends nothing, and the next pass proceeds', async () => {
  const s = swap();
  const down = deps({ pda: pdaOpen });
  await assert.rejects(makerStep(s, down.d), /wallet rpc down/); assert.deepEqual(down.sent, []);
  const up = deps({ pda: pdaOpen, scanXmr: async () => usableFromTransfers({ in: [out(XMR, 12)] }) });
  assert.equal((await makerStep(s, up.d)).action, 'set-ready'); assert.deepEqual(up.sent, ['ready']);
  const late = deps({ pda: { ...pdaOpen, t0: NOW + MARGIN - 1 }, scanXmr: async () => usableFromTransfers({ in: [out(XMR, 12)] }) });
  assert.notEqual((await makerStep(swap(), late.d)).action, 'set-ready', 'never sets ready inside the margin before t0');
});
test('H7: the maker saves its history cursor while the closing transaction is not yet found, and resumes from it', async () => {
  const cursors = [];
  const readRevealed = async (which, point, cursor, onCursor) => { cursors.push([which, cursor]); if (which === 'claim') { onCursor(cursor ? 'C2' : 'C1'); return cursor === 'C1' ? { secretHex: '11', sig: 'CLAIM' } : null; } onCursor(null); return null; };
  const s = swap();
  const first = deps({ readRevealed }); const a1 = await makerStep(s, first.d);
  assert.equal(a1.action, 'wait'); assert.equal(first.stored.at(-1).histCursor.claim, 'C1');
  const reloaded = structuredClone(first.stored.at(-1));
  const second = deps({ readRevealed }); const a2 = await makerStep(reloaded, second.d);
  assert.deepEqual(cursors.slice(-1)[0], ['claim', 'C1']); assert.equal(a2.action, 'sweep-xmr'); assert.deepEqual(second.sent, ['sweep']);
});

// ---- Astra round 4, N1: start-up checks never stop refunds ----
const OWNER = '8' + 'B'.repeat(94);
const LIMITS = { perSwap: 50_000_000_000n, perDay: 300_000_000_000n, open: 3 };
const gateWith = (over = {}) => {
  const calls = { n: 0 }; let answer = over.answer ?? (async () => ({ valid: true, nettype: 'mainnet', integrated: false }));
  const g = createStartGate({ network: 'mainnet', sweepTo: OWNER, token: 'x'.repeat(48), caps: LIMITS, limits: LIMITS, ...over, validate: async (a) => { calls.n++; return answer(a); } });
  return { g, calls, set answer(f) { answer = f; } };
};
test('N1: wallet-rpc down at start closes the gate (no new swaps, no sweeps); it opens once validation works, then is cached', async () => {
  const t = gateWith({ answer: async () => { throw new Error('ECONNREFUSED'); } });
  assert.deepEqual(await t.g.check(), { open: false, reasons: ['wallet-rpc-unavailable'] }); assert.equal(t.g.isOpen(), false);
  t.answer = async () => ({ valid: true, nettype: 'mainnet', integrated: false });
  assert.equal((await t.g.check()).open, true); await t.g.check(); assert.equal(t.calls.n, 2, 'a definitive answer is not re-asked');
});
test('N1: a wrong-network, integrated or invalid address, too-high caps or no token keep the gate closed', async () => {
  for (const answer of [async () => ({ valid: true, nettype: 'stagenet', integrated: false }), async () => ({ valid: true, nettype: 'mainnet', integrated: true }), async () => ({ valid: false })]) {
    const t = gateWith({ answer }); assert.equal((await t.g.check()).open, false); assert.equal((await t.g.check()).open, false);
  }
  for (const over of [{ token: '' }, { caps: { ...LIMITS, perSwap: LIMITS.perSwap + 1n } }, { caps: { ...LIMITS, open: 4 } }, { sweepTo: '4short' }, { sweepTo: null }]) {
    const t = gateWith(over); assert.equal((await t.g.check()).open, false, JSON.stringify(over, (k, v) => typeof v === 'bigint' ? String(v) : v)); assert.equal(t.calls.n, 0);
  }
});
test('N1 regression: with the gate closed by a start-up failure, an expired escrow is still refunded and a sweep is held until it opens', async () => {
  const t = gateWith({ answer: async () => { throw new Error('ECONNREFUSED'); } }); await t.g.check();
  const expired = deps({ pda: { ...pdaOpen, t1: NOW - LATE_REFUND_MARGIN } }); expired.d.sweepAllowed = t.g.isOpen;
  assert.equal((await makerStep(swap(), expired.d)).action, 'refund'); assert.deepEqual(expired.sent, ['refund']);
  const readRevealed = async (which) => (which === 'claim' ? { secretHex: '11', sig: 'CLAIM' } : null);
  const s = swap();
  const held = deps({ readRevealed }); held.d.sweepAllowed = t.g.isOpen;
  assert.equal((await makerStep(s, held.d)).reason, 'sweep-held'); assert.deepEqual(held.sent, []);
  t.answer = async () => ({ valid: true, nettype: 'mainnet', integrated: false }); await t.g.check();
  const later = deps({ readRevealed }); later.d.sweepAllowed = t.g.isOpen;
  assert.equal((await makerStep(s, later.d)).action, 'sweep-xmr'); assert.deepEqual(later.sent, ['sweep']);
});
test('N1: off mainnet with no sweep address the gate is open without any wallet call', async () => {
  const g = createStartGate({ network: 'stagenet', sweepTo: null, token: '', caps: LIMITS, limits: LIMITS, validate: async () => { throw new Error('not called'); } });
  assert.equal((await g.check()).open, true);
});

test('proposal 5 Nov: makerStep passes the swap record\'s own depth; an old record without one keeps 10', async () => {
  const scan = async () => usableFromTransfers({ in: [out(XMR, 4)] });
  const shallow = deps({ pda: pdaOpen, scanXmr: scan });
  assert.equal((await makerStep({ ...swap(), confirmations: 4 }, shallow.d)).action, 'set-ready');
  const old = deps({ pda: pdaOpen, scanXmr: scan });
  assert.notEqual((await makerStep(swap(), old.d)).action, 'set-ready');
});

// ---- Astra r4 N2: the SOL -> XMR claim counts only the maker's own recorded transaction ----
import { usableFromTransfersOf as ownOnlyRaw } from './maker-core.mjs';
test('N2: another confirmed transfer to the joint address never satisfies the amount or the depth; only the recorded txid counts', () => {
  const own = 'a'.repeat(64), other = 'b'.repeat(64);
  // Astra 699-M1 added the mined outputs list to the summary; N2 is about the amount and the depth of the OWN transaction only.
  const ownOnly = (x, id) => { const r = ownOnlyRaw(x, id); return r && { atomic: r.atomic, confirmations: r.confirmations }; };
  const t = { in: [{ txid: other, amount: 50_000_000_000, confirmations: 30, unlock_time: 0 }, { txid: own, amount: 1_000_000_000, confirmations: 2, unlock_time: 0 }], pool: [] };
  assert.deepEqual(ownOnly(t, own), { atomic: '1000000000', confirmations: 2 });          // not 51 XMR at 2 confirmations, not the other tx's depth
  assert.equal(ownOnly({ in: [{ txid: other, amount: 50_000_000_000, confirmations: 30, unlock_time: 0 }], pool: [] }, own), null); // own tx not seen
  assert.deepEqual(ownOnly({ in: [], pool: [{ txid: own, amount: 1_000_000_000, confirmations: 0 }] }, own), { atomic: '0', confirmations: 0 }); // own in the pool
  assert.equal(ownOnly(t, undefined), null); assert.equal(ownOnly(t, 'nothex'), null);
  assert.deepEqual(ownOnly({ in: [{ txid: own, amount: 1_000_000_000, confirmations: 20, unlock_time: 99 }], pool: [] }, own), { atomic: '0', confirmations: 20 }); // time-locked output never counts
});

// ---- Astra r6: the normal direction's early refund (reveals b) is decided again on a fresh clock and carries its own deadline ----
// Unified with AG-R2-H1 (PR 699): the deadline of an early refund is no longer a notAfter handed to a transport; the sender decides the exposure
// itself (earlyRefundGate: the blockhash must expire before t0 with margin, refund-exposure.test.mjs). makerStep hands it the KIND.
test('r6: an early refund (reveals b) is handed to the sender as kind early before t1, and as kind late after t1', async () => {
  const seen = [];
  const early = deps({ pda: pdaOpen, now: pdaOpen.t0 - 1000, scanXmr: async () => null }); early.d.sendRefund = async (x, kind) => { seen.push(kind); return { sig: 'R' }; };
  const s = swap(); s.lockedAt = pdaOpen.t0 - 1000 - 2000;
  assert.equal((await makerStep(s, early.d)).action, 'refund'); assert.deepEqual(seen, ['early']);
  const late = deps({ pda: { ...pdaOpen, t1: NOW - LATE_REFUND_MARGIN }, now: NOW }); late.d.sendRefund = async (x, kind) => { seen.push(kind); return { sig: 'R' }; };
  assert.equal((await makerStep(swap(), late.d)).action, 'refund'); assert.deepEqual(seen[1], 'late');
});
test('r6: a refund approved before a slow scan is NOT sent when the fresh time is inside the margin before t0', async () => {
  const clock = [pdaOpen.t0 - 700, pdaOpen.t0 - 100]; // decision time, then the time read right before the send
  const x = deps({ pda: pdaOpen, scanXmr: async () => null }); x.d.chainNow = async () => clock.shift() ?? pdaOpen.t0;
  const s = swap(); s.lockedAt = pdaOpen.t0 - 700 - 2000;
  const r = await makerStep(s, x.d); assert.equal(r.reason, 'stale-authorization'); assert.deepEqual(x.sent, []);
  const broken = deps({ pda: pdaOpen, scanXmr: async () => null }); let n = 0; broken.d.chainNow = async () => { if (n++ === 0) return pdaOpen.t0 - 700; throw new Error('rpc down'); };
  const s2 = swap(); s2.lockedAt = pdaOpen.t0 - 700 - 2000; assert.equal((await makerStep(s2, broken.d)).reason, 'stale-authorization'); assert.deepEqual(broken.sent, []);
});

// ---- Hygiene (8 Nov 2026): the XMR -> SOL maker wipes v and its refund secret b once the swap is final ----
import { scrubSecrets } from './maker-core.mjs';
test('hygiene: scrubSecrets removes v, a, b and stamps the time once; public fields stay', () => {
  // Astra 701-H1: only a terminal result proven at finalized (finalEvidence, written by finishIfFinal) may destroy material.
  const fe = { finalizedSlot: 7 };
  const s = { swapId: 'ab', A: 'aa', B: 'bb', V: 'vv', v: 'v'.repeat(64), b: 'b'.repeat(64), done: 'completed', finalEvidence: fe };
  assert.equal(scrubSecrets(s, 123), 2); assert.deepEqual(Object.keys(s).sort(), ['A', 'B', 'V', 'done', 'finalEvidence', 'secretsWipedAt', 'swapId']); assert.equal(s.secretsWipedAt, 123);
  assert.equal(scrubSecrets(s, 456), 0); assert.equal(s.secretsWipedAt, 123, 'second call changes nothing');
});

// ---- Sol M1 (second round): cancellation reaches the stage boundaries of a STARTED public job; the final close always runs ----
// A wallet whose chosen methods wait for a gate, so a test can abort the caller while one specific call is under way.
function stagedWallet(holdOn = []) {
  const calls = [], gates = Object.fromEntries(holdOn.map((m) => [m, gate()])), reached = Object.fromEntries(holdOn.map((m) => [m, gate()]));
  const W = async (method) => { calls.push(method); if (gates[method]) { reached[method].open(); await gates[method].p; } return {}; };
  return { W, calls, gates, reached };
}
test('Sol M1: abort while open_wallet is under way: no refresh, no job call, the cleanup close runs, recovery goes next', async () => {
  const w = stagedWallet(['open_wallet']); const q = createWalletQueue(w.W, 'pw'); const ac = new AbortController(); let jobRan = false;
  const pub = q.publicLane('p', async () => {}, async () => { jobRan = true; }, { signal: ac.signal });
  await w.reached.open_wallet.p; ac.abort(); await assert.rejects(pub, /client-gone/);
  const rec = q('r', async () => {}, async () => 'recovered');
  w.gates.open_wallet.open(); assert.equal(await rec, 'recovered');
  assert.equal(jobRan, false); assert.deepEqual(w.calls.slice(0, 3), ['close_wallet', 'open_wallet', 'close_wallet'], 'no refresh for the cancelled job; its close is the cleanup');
});
test('Sol M1: abort while refresh is under way: the job call (balance) is never made, the close still runs', async () => {
  const w = stagedWallet(['refresh']); const q = createWalletQueue(w.W, 'pw'); const ac = new AbortController(); let jobRan = false;
  const pub = q.publicLane('p', async () => {}, async () => { jobRan = true; await w.W('get_balance'); }, { signal: ac.signal });
  await w.reached.refresh.p; ac.abort(); await assert.rejects(pub, /client-gone/);
  const rec = q('r', async () => {}, async () => 'recovered');
  w.gates.refresh.open(); assert.equal(await rec, 'recovered');
  assert.equal(jobRan, false); assert.equal(w.calls.includes('get_balance'), false);
  assert.deepEqual(w.calls.slice(0, 4), ['close_wallet', 'open_wallet', 'refresh', 'close_wallet']);
});
test('Sol M1: abort while the job call is under way: it is never interrupted, and its close still runs', async () => {
  const w = stagedWallet(['get_balance']); const q = createWalletQueue(w.W, 'pw'); const ac = new AbortController(); let finished = false;
  const pub = q.publicLane('p', async () => {}, async () => { await w.W('get_balance'); finished = true; }, { signal: ac.signal });
  await w.reached.get_balance.p; ac.abort(); await assert.rejects(pub, /client-gone/);
  assert.equal(finished, false); w.gates.get_balance.open();
  await q('r', async () => {}, async () => 'x'); assert.equal(finished, true, 'the call in progress ran to its end');
  assert.deepEqual(w.calls.slice(0, 5), ['close_wallet', 'open_wallet', 'refresh', 'get_balance', 'close_wallet']);
});
test('Sol M1: the deadline cancels a started public job the same way (stops before refresh)', async () => {
  const w = stagedWallet(['open_wallet']), tm = fakeTimers(); const q = createWalletQueue(w.W, 'pw', { setTimer: tm.setTimer, clearTimer: tm.clearTimer, publicDeadlineMs: 5000 });
  let jobRan = false; const pub = q.publicLane('p', async () => {}, async () => { jobRan = true; });
  await w.reached.open_wallet.p; tm.fire(0); await assert.rejects(pub, /busy-try-later/);
  w.gates.open_wallet.open(); await q('r', async () => {}, async () => 'x');
  assert.equal(jobRan, false); assert.equal(w.calls.includes('refresh') && w.calls.indexOf('refresh') < w.calls.lastIndexOf('close_wallet', 3), false);
});
test('Sol M1: recovery scheduling stays ahead of a cancelled started job and of every waiting public job', async () => {
  const w = stagedWallet(['refresh']); const q = createWalletQueue(w.W, 'pw'); const order = []; const ac = new AbortController();
  const p0 = q.publicLane('p0', async () => {}, async () => { order.push('p0'); }, { signal: ac.signal });
  await w.reached.refresh.p;
  const p1 = q.publicLane('p1', async () => {}, async () => { order.push('p1'); }), r1 = q('r1', async () => {}, async () => { order.push('r1'); });
  ac.abort(); await assert.rejects(p0, /client-gone/);
  w.gates.refresh.open(); await Promise.all([r1, p1]);
  assert.deepEqual(order, ['r1', 'p1'], 'p0 never ran its job call; recovery went before the waiting public job');
});
test('Sol M1: a cancelled public job whose wallet is down still releases the executor', async () => {
  const w = fakeWallet(); const q = createWalletQueue(w.W, 'pw'); const ac = new AbortController(); ac.abort();
  await assert.rejects(q.publicLane('p', async () => {}, async () => 1, { signal: ac.signal }), /client-gone/);
  assert.equal(await q('r', async () => {}, async () => 'ok'), 'ok');
});

// ---- Sol M1 (third round residual): the cleanup try/finally covers the initial close and the open/create stage too ----
test('Sol M1 residual: cancellation during a FAILING initial close still attempts the final close', async () => {
  const calls = []; let closeCount = 0; const ac = new AbortController(); const g = gate();
  const W = async (m) => { calls.push(m); if (m === 'close_wallet') { closeCount++; if (closeCount === 1) { await g.p; throw new Error('close timed out'); } } return {}; };
  const q = createWalletQueue(W, 'pw'); let jobRan = false;
  const pub = q.publicLane('p', async () => {}, async () => { jobRan = true; }, { signal: ac.signal });
  await Promise.resolve(); ac.abort(); await assert.rejects(pub, /client-gone/);
  g.open(); assert.equal(await q('r', async () => {}, async () => 'ok'), 'ok');
  assert.equal(jobRan, false); assert.equal(calls.includes('open_wallet') && calls.indexOf('open_wallet') < 2, false, 'a cancelled job opens nothing');
  assert.deepEqual(calls.slice(0, 2), ['close_wallet', 'close_wallet'], 'the failed initial close is followed by an attempted final close');
});
test('Sol M1 residual: a throwing open fallback (public treasury read) still attempts the final close and releases the executor', async () => {
  const calls = []; const W = async (m) => { calls.push(m); if (m === 'open_wallet') throw new Error('no wallet'); return {}; };
  const q = createWalletQueue(W, 'pw');
  await assert.rejects(q.publicLane('treasury', () => { throw new Error('treasury wallet missing'); }, async () => 1), /treasury wallet missing/);
  assert.deepEqual(calls, ['close_wallet', 'open_wallet', 'close_wallet']);
  assert.equal(await q('r', async () => {}, async () => 'ok'), 'ok', 'the queue is not poisoned');
});
test('Sol M1 residual: an async create fallback that rejects also reaches the final close', async () => {
  const calls = []; const W = async (m) => { calls.push(m); if (m === 'open_wallet') throw new Error('no wallet'); return {}; };
  const q = createWalletQueue(W, 'pw');
  await assert.rejects(q('x', async () => { throw new Error('create failed'); }, async () => 1), /create failed/);
  assert.equal(calls.at(-1), 'close_wallet');
});

// ---- Sol M3 residual: the public response follows finalized SOLANA observations, not the progress of Monero work ----
import { publicSwapView } from './maker-lanes.mjs';
test('Sol M3 residual (forward): identical Solana history, sweep succeeding vs pending vs failing: the public response is identical at every pass', async () => {
  const claim = { secretHex: '11', sig: 'CLAIMSIG' };
  const run = async (sweepKind) => {
    const s = { ...swap(), direction: 'xmr-sol', lockSig: 'LK' }; const views = [];
    const x = deps({ readRevealed: async (which) => (which === 'claim' ? claim : null) });
    x.d.proveFinal = async (_s, o) => ({ final: true, evidence: { finalizedSlot: 9, outcomeSig: o?.sig ?? null } });
    x.d.sweep = async () => { if (sweepKind === 'fail') throw new Error('wallet rpc down'); return sweepKind === 'ok' ? ['sweep-tx'] : null; };
    for (let i = 0; i < 3; i++) { try { await makerStep(s, x.d); } catch {} views.push(JSON.stringify(publicSwapView(s))); }
    return { views, s };
  };
  const ok = await run('ok'), pending = await run('pending'), fail = await run('fail');
  assert.deepEqual(ok.views[0], pending.views[0]); assert.deepEqual(pending.views[0], fail.views[0]);
  assert.deepEqual(ok.views.at(-1), pending.views.at(-1)); assert.deepEqual(pending.views.at(-1), fail.views.at(-1));
  assert.deepEqual(JSON.parse(fail.views[0]), { swapId: 'cd'.repeat(32), direction: 'xmr-sol', lockSig: 'LK', readySig: null, refundSig: null, claimSig: 'CLAIMSIG', state: 'finished' }, 'the claim signature is the OBSERVED one, shown before and without the sweep');
  assert.equal(fail.s.sweepTxids, undefined); assert.ok(ok.s.sweepTxids, 'the Monero outcomes did differ underneath');
});
test('Sol M3 residual: a claim not yet proven at finalized is not shown at all (no public change until proven)', async () => {
  const s = { ...swap(), direction: 'xmr-sol' }; const before = JSON.stringify(publicSwapView(s));
  const x = deps({ readRevealed: async (which) => (which === 'claim' ? { secretHex: '11', sig: 'CLAIMSIG' } : null) });
  x.d.proveFinal = async () => ({ final: false, why: 'not-finalized' }); x.d.sweep = async () => ['t'];
  await makerStep(s, x.d); assert.equal(JSON.stringify(publicSwapView(s)), before); assert.equal(s.pubSol, undefined);
});
