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
