// Deterministic maker tests (Astra round 2): H4 wallet response -> scan -> decision, H5 queue failure and recovery,
// refund while the Monero wallet RPC is down, and H7 resumable history for the maker.
import test from 'node:test'; import assert from 'node:assert/strict';
import { usableFromTransfers, createWalletQueue, makerStep, createStartGate } from './maker-core.mjs';
import { makerNext, MARGIN } from '../client/swap-core.mjs';

const XMR = '50000000000';                       // 0.05 XMR expected
const NOW = 1_800_000_000;
const pdaOpen = { ready: false, t0: NOW + 3600, t1: NOW + 10800, lamports: 1 };
const decide = (transfers, over = {}) => makerNext({ now: NOW, lockedAt: NOW - 600, pda: pdaOpen, outcome: null, xmr: usableFromTransfers(transfers), xmrSwept: false, expectedAtomic: XMR, ...over });
const out = (amount, confirmations, unlock_time = 0) => ({ amount, confirmations, unlock_time });

test('H4: a confirmed but future-locked output never counts toward ready', () => {
  const t = { in: [out(XMR, 50, 3_100_000)] };
  assert.deepEqual(usableFromTransfers(t), { atomic: '0', confirmations: 50 });
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
  const x = deps({ pda: { ...pdaOpen, t1: NOW }, scanXmr: async () => { scanned++; throw new Error('wallet rpc down'); } });
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
  const expired = deps({ pda: { ...pdaOpen, t1: NOW } }); expired.d.sweepAllowed = t.g.isOpen;
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
