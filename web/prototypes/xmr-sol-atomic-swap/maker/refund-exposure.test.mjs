// AG-R2-H1 (Astra, refund path): the maker's refund carries its scalar b. These tests drive maker/maker-send.mjs (and makerStep with
// it) through REAL web3.js 1.99.0 Connections whose fetch is replaced by a fake chain, so every JSON-RPC payload asserted on is exactly
// what web3.js puts on the wire. Two Connections stand for the two independent RPC endpoints. No network, no WebSocket (the sender
// never subscribes: outcomes are settled from finalized evidence on later passes).
import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, renameSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Keypair, Connection, VersionedTransaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import bs58 from 'bs58';
import * as sol from '../client/sol.mjs';
import { makerStep, usableFromTransfers } from './maker-core.mjs';
import { createSender, earlyRefundGate, lateRefundGate, earlyRebroadcastBlock, ATTEMPT_EXPIRY_MARGIN } from './maker-send.mjs';
import { EARLY_SEND_MIN_LEAD, EARLY_LANDING_MARGIN, LATE_REFUND_MARGIN, ABORT_LEAD } from '../client/swap-core.mjs';

const T0 = 1_900_000_000, T1 = T0 + 7200;
const BH = Keypair.generate().publicKey.toBase58();
const CONF_SLOT = 5000, FIN_SLOT = 4968;

/** A fake cluster: confirmed and finalized views, one escrow, signature statuses, every request kept in order with its endpoint. */
function makeChain(over = {}) {
  return {
    confTime: T0 - ABORT_LEAD, finTime: T0 - ABORT_LEAD - 13, height: 9000, finHeight: 8968, lifetime: 150,
    escrow: { ready: false }, statuses: new Map(), calls: [], sends: [], hook: null, sendFails: false,
    accountLag: 0, ...over,
  };
}
function escrowData(maker, s, ready) {
  const b = Buffer.alloc(8 + 186);
  Buffer.from(sha256(new TextEncoder().encode('account:Swap'))).subarray(0, 8).copy(b, 0);
  maker.publicKey.toBuffer().copy(b, 8); Keypair.generate().publicKey.toBuffer().copy(b, 40);
  Buffer.from(s.A, 'hex').copy(b, 72); Buffer.from(s.B, 'hex').copy(b, 104);
  b.writeBigUInt64LE(1_000_000n, 136); b.writeBigInt64LE(BigInt(s.t0), 144); b.writeBigInt64LE(BigInt(s.t1), 152);
  b[160] = ready ? 1 : 0; Buffer.from(s.swapId, 'hex').copy(b, 161);
  return b.toString('base64');
}
function conn(chain, name, maker, s) {
  const answer = (method, params) => {
    const commitment = params?.find?.((p) => p && typeof p === 'object' && p.commitment)?.commitment;
    const P = (k) => (chain.per?.[name] && k in chain.per[name] ? chain.per[name][k] : chain[k]);   // per-endpoint view
    const fin = commitment === 'finalized';
    switch (method) {
      case 'getLatestBlockhash': return { context: { slot: CONF_SLOT }, value: { blockhash: bs58.encode(sha256(new TextEncoder().encode(`bh-${chain.height}`))), lastValidBlockHeight: chain.height + chain.lifetime } };
      case 'getSlot': return fin ? FIN_SLOT : CONF_SLOT;
      case 'getBlock': return { blockhash: BH, previousBlockhash: BH, parentSlot: params[0] - 1, blockTime: params[0] === FIN_SLOT ? chain.finTime : chain.confTime, blockHeight: params[0] === FIN_SLOT ? chain.finHeight : chain.height };
      case 'getBlockTime': return params[0] === FIN_SLOT ? chain.finTime : chain.confTime;
      case 'getBlockHeight': return P('height');
      case 'isBlockhashValid': return { context: { slot: CONF_SLOT }, value: P('bhValid') ?? true };
      case 'getAccountInfo': {
        if (P('accountError')) return undefined;
        const slot = (fin ? FIN_SLOT : CONF_SLOT) - P('accountLag'), escrow = P('escrow');
        const v = escrow ? { data: [escrowData(maker, s, escrow.ready), 'base64'], executable: false, lamports: 1_002_000, owner: sol.PROGRAM_ID.toBase58(), rentEpoch: 0, space: 194 } : null;
        return { context: { slot }, value: v };
      }
      case 'getSignatureStatuses': return { context: { slot: CONF_SLOT }, value: params[0].map((sig) => P('statuses').get(sig) ?? null) };
      case 'simulateTransaction': return { context: { slot: CONF_SLOT }, value: { err: null, logs: [], accounts: null, unitsConsumed: 900, returnData: null } };
      case 'sendTransaction': return bs58.encode(VersionedTransaction.deserialize(Buffer.from(params[0], 'base64')).signatures[0]);
      default: return undefined;
    }
  };
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body), reqs = Array.isArray(body) ? body : [body], outs = [];
    for (const r of reqs) {
      chain.calls.push({ endpoint: name, method: r.method, params: r.params });
      if (chain.hook) await chain.hook(r.method, name);
      if (r.method === 'sendTransaction') {
        chain.sends.push({ endpoint: name, tx: r.params[0], cfg: r.params[1], onDisk: chain.readDisk?.() });
        if (chain.sendFails) throw new TypeError('fetch failed (response lost)');   // delivered, answer lost
      }
      const result = answer(r.method, r.params);
      outs.push(result === undefined ? { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: `unexpected ${r.method}` } } : { jsonrpc: '2.0', id: r.id, result });
    }
    return new Response(JSON.stringify(Array.isArray(body) ? outs : outs[0]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return new Connection(`http://127.0.0.1:9/${name}`, { commitment: 'confirmed', fetch, disableRetryOnRateLimit: true });
}

/** A swap record, a durable store in a temp dir, a maker key, two endpoints and a sender with a controllable local clock. */
function setup(chainOver = {}, recOver = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'refund-exposure-')), maker = Keypair.generate(), b = randomBytes(32);
  const s = { swapId: randomBytes(32).toString('hex'), A: randomBytes(32).toString('hex'), B: randomBytes(32).toString('hex'), b: b.toString('hex'), t0: T0, t1: T1, lockedAt: T0 - 7200, xmrAtomic: '100', solLocked: true, ...recOver };
  const file = join(dir, `${s.swapId}.json`);
  const store = (x) => { writeFileSync(`${file}.tmp`, JSON.stringify(x)); renameSync(`${file}.tmp`, file); };
  const chain = makeChain(chainOver); chain.readDisk = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
  const clock = { ms: chain.confTime * 1000 };
  const logs = [];
  const conns = [conn(chain, 'primary', maker, s), conn(chain, 'secondary', maker, s)];
  const mk = () => createSender({ conns, payer: maker, store, log: (e) => logs.push(e), clock: () => clock.ms });
  return { dir, maker, b, s, file, store, chain, clock, logs, conns, sender: mk(), newSender: mk, reload: () => JSON.parse(readFileSync(file, 'utf8')), done: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---- payload inspection ----
function strings(x, out = []) { if (typeof x === 'string') out.push(x); else if (Array.isArray(x)) x.forEach((y) => strings(y, out)); else if (x && typeof x === 'object') Object.values(x).forEach((y) => strings(y, out)); return out; }
function carries(params, secret) {
  const h = secret.toString('hex');
  for (const str of strings(params)) {
    if (str.toLowerCase().includes(h)) return true;
    try { if (Buffer.from(str, 'base64').includes(secret)) return true; } catch {}
    try { if (Buffer.from(bs58.decode(str)).includes(secret)) return true; } catch {}
  }
  return false;
}
const withSecret = (t) => t.chain.calls.filter((c) => carries(c.params, t.b));
const validSigs = (b64, key) => { const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64')); const m = tx.message.serialize(); return tx.signatures.filter((g) => { try { return ed25519.verify(g, m, key.publicKey.toBytes()); } catch { return false; } }).map((g) => bs58.encode(g)); };
const finalized = (err = null) => ({ slot: FIN_SLOT, confirmations: null, err, confirmationStatus: 'finalized' });
const noSim = (t) => assert.deepEqual(t.chain.calls.filter((c) => /^simulateTransaction$|^getFeeForMessage$/.test(c.method)), [], 'no simulation and no fee query');

// ---- late (t1) path ----
test('late refund: b leaves only after a FINALIZED block time >= t1 + 60 s; a confirmed time or a local clock past t1 cannot release it', async () => {
  const t = setup({ confTime: T1 + 3600, finTime: T1 + LATE_REFUND_MARGIN - 1 });
  t.clock.ms = (T1 + 86400) * 1000;   // local clock a day ahead
  assert.equal((await t.sender.sendRefund(t.s, 'late')).refused, 'claim-window-not-provably-closed');
  assert.deepEqual(withSecret(t), [], 'b in no payload'); assert.equal(t.chain.sends.length, 0); assert.equal(t.s.secretExposure, undefined);
  t.chain.finTime = T1 + LATE_REFUND_MARGIN; t.clock.ms = (T1 - 86400) * 1000;   // and a local clock a day behind does not hold it either
  const r = await t.sender.sendRefund(t.s, 'late');
  assert.equal(r.sent, true);
  assert.deepEqual(t.chain.sends.map((x) => x.endpoint), ['primary', 'secondary'], 'the same bytes to both endpoints, once each');
  assert.equal(t.chain.sends[0].tx, t.chain.sends[1].tx, 'one variant only');
  const att = t.reload().refundAttempts; assert.equal(att.length, 1);
  assert.deepEqual(validSigs(t.chain.sends[0].tx, t.maker), [att[0].sig], 'the broadcast signature is the persisted one');
  assert.equal(att[0].raw, t.chain.sends[0].tx, 'the persisted bytes are the sent bytes');
  for (const x of t.chain.sends) { assert.equal(x.cfg.skipPreflight, true); assert.equal(x.onDisk?.refundAttempts?.[0]?.sig, att[0].sig, 'on disk before this send'); assert.ok(x.onDisk.secretExposure, 'exposure marked before the send'); }
  assert.deepEqual(withSecret(t).map((c) => c.method), ['sendTransaction', 'sendTransaction'], 'b appears in the two sends and nowhere else');
  noSim(t);
  assert.equal(t.chain.calls.filter((c) => c.method === 'getLatestBlockhash').length, 2, 'one blockhash per decision (the refused one and the sent one)');
  t.done();
});

test('late refund: an escrow gone or a stale context at finalized refuses, and nothing carries b', async () => {
  for (const over of [{ escrow: null }, { accountLag: 5 }]) {
    const t = setup({ confTime: T1 + 3600, finTime: T1 + 3600, ...over });
    const r = await t.sender.sendRefund(t.s, 'late');
    assert.match(r.refused, over.escrow === null ? /escrow-not-open-at-finalized/ : /stale-account-context/);
    assert.deepEqual(withSecret(t), []); t.done();
  }
});

// ---- early (pre-t0) path ----
test('early refund: sent only while the blockhash expires before t0 - margin; b in no payload when refused', async () => {
  const ok = setup();
  assert.equal((await ok.sender.sendRefund(ok.s, 'early')).sent, true);
  const g = ok.reload().refundAttempts[0].gate; assert.ok(g.lead >= g.need && g.need >= EARLY_SEND_MIN_LEAD && g.remainingBlocks === 150);
  noSim(ok); ok.done();
  for (const [over, why] of [[{ confTime: T0 - EARLY_SEND_MIN_LEAD + 1 }, 'blockhash-may-outlive-t0'], [{ lifetime: 300 }, 'blockhash-lifetime-unbounded'], [{ lifetime: 151, confTime: T0 - 560 }, 'blockhash-may-outlive-t0'], [{ escrow: { ready: true } }, 'escrow-ready'], [{ escrow: null }, 'escrow-not-open']]) {
    const t = setup(over); t.clock.ms = Math.min(t.clock.ms, (T0 - ABORT_LEAD) * 1000);
    assert.equal((await t.sender.sendRefund(t.s, 'early')).refused, why, JSON.stringify(over));
    assert.deepEqual(withSecret(t), [], 'b in no payload'); assert.equal(t.chain.sends.length, 0); t.done();
  }
});

test('early refund: a skewed local clock cannot release b; the later of chain time and local clock decides', async () => {
  // Chain already inside the last 600 s, local clock two hours behind: refused (a node or a clock behind cannot shorten the lead).
  const behind = setup({ confTime: T0 - 500 }); behind.clock.ms = (T0 - 7200) * 1000;
  assert.equal((await behind.sender.sendRefund(behind.s, 'early')).refused, 'blockhash-may-outlive-t0'); assert.deepEqual(withSecret(behind), []); behind.done();
  // A node lagging behind real time (chain time old), local clock correct and inside the window: refused too.
  const lagging = setup({ confTime: T0 - 3600 }); lagging.clock.ms = (T0 - 400) * 1000;
  assert.equal((await lagging.sender.sendRefund(lagging.s, 'early')).refused, 'blockhash-may-outlive-t0'); assert.deepEqual(withSecret(lagging), []); lagging.done();
});

test('early refund: the window is checked AFTER every await (delayed reads that cross the window refuse; nothing signed leaves)', async () => {
  // Local clock moves past t0 - 600 while the account read is in flight.
  const t = setup(); t.chain.hook = async (m) => { if (m === 'getAccountInfo') { await new Promise((r) => setTimeout(r, 20)); t.clock.ms = (T0 - EARLY_SEND_MIN_LEAD + 5) * 1000; } };
  assert.equal((await t.sender.sendRefund(t.s, 'early')).refused, 'blockhash-may-outlive-t0'); assert.deepEqual(withSecret(t), []); assert.equal(t.chain.sends.length, 0);
  t.done();
  // The chain moves while the blockhash answer is delayed: the chain time read after it is used.
  const u = setup(); u.chain.hook = async (m) => { if (m === 'getLatestBlockhash') { await new Promise((r) => setTimeout(r, 20)); u.chain.confTime = T0 - EARLY_SEND_MIN_LEAD + 1; } };
  assert.equal((await u.sender.sendRefund(u.s, 'early')).refused, 'blockhash-may-outlive-t0'); assert.deepEqual(withSecret(u), []);
  u.done();
});

test('makerStep + sender: a full mined XMR lock is never aborted early; an unpaid swap is refunded before t0; b in no payload otherwise', async () => {
  const pass = (t, xmr) => makerStep(t.s, { readSwap: async () => ({ ready: false, t0: T0, t1: T1, lamports: 1 }), readRevealed: async () => null, chainNow: async () => t.chain.confTime,
    scanXmr: async () => xmr, resolve: (x) => t.sender.resolve(x), sendReady: (x) => t.sender.sendReady(x), sendRefund: (x, k) => t.sender.sendRefund(x, k), sweep: async () => null, store: t.store, log: () => {} });
  // A full payment at the set-ready depth (10) is never aborted (here b may already be exposed, so no ready either): b stays out.
  const paid = setup(); paid.s.secretExposure = { at: 'x' }; paid.s.refundAttempts = [{ n: 1, action: 'refund', kind: 'early', state: 'expired' }];
  assert.equal((await pass(paid, { atomic: '100', confirmations: 10 })).action, 'wait');
  assert.deepEqual(withSecret(paid), []); assert.equal(paid.chain.sends.length, 0); paid.done();
  // Nothing, dust, or a full payment shallower than the set-ready depth (1 confirmation, reorgable): aborted.
  for (const xmr of [null, { atomic: '1', confirmations: 3 }, { atomic: '100', confirmations: 1 }, { atomic: '100', confirmations: 9 }]) {
    const t = setup();
    assert.deepEqual(await pass(t, xmr), { action: 'refund', kind: 'early' });
    assert.equal(t.chain.sends.length, 2); assert.equal(t.reload().refundAttempts[0].kind, 'early'); t.done();
  }
});

// ---- ambiguous outcomes, restarts, failures ----
test('lost response: the attempt stays open across passes and restarts; no second variant until finalized expiry; then exactly one new variant', async () => {
  const t = setup({ confTime: T1 + 3600, finTime: T1 + 3600, sendFails: true });
  const r = await t.sender.sendRefund(t.s, 'late'); assert.equal(r.sent, true);
  const att = t.reload().refundAttempts[0]; assert.equal(att.state, 'send-error');
  t.chain.sendFails = false;
  for (let i = 0; i < 3; i++) {
    const again = t.newSender();   // a restart: the record read back from disk
    const rec = t.reload();
    assert.equal((await again.resolve(rec)).open, 1);
    assert.equal((await again.sendRefund(rec, 'late')).refused, 'attempt-open');
    t.chain.finHeight += 20;   // not yet past lastValidBlockHeight + margin
  }
  assert.equal(t.chain.sends.length, 4, 'the first pair, then ONE rebroadcast of the same bytes after the send error (F3)');
  assert.ok(t.chain.sends.every((x) => x.tx === t.chain.sends[0].tx), 'same bytes, same signature: no new variant');
  assert.equal(t.reload().refundAttempts.length, 1); assert.equal(t.reload().refundAttempts[0].rebroadcasts, 1);
  t.chain.finHeight = att.lastValidBlockHeight + ATTEMPT_EXPIRY_MARGIN + 1; t.chain.height = t.chain.finHeight + 32;
  const rec = t.reload(); const s2 = t.newSender();
  assert.equal((await s2.resolve(rec)).open, 0); assert.equal(rec.refundAttempts[0].state, 'expired');
  assert.equal((await s2.sendRefund(rec, 'late')).sent, true);
  assert.equal(t.chain.sends.length, 6); assert.equal(t.reload().refundAttempts.length, 2);
  assert.notEqual(t.chain.sends[4].tx, t.chain.sends[0].tx); assert.equal(t.chain.sends[4].tx, t.chain.sends[5].tx);
  t.done();
});

test('lost response that landed: settled from the finalized status, refundSig set, nothing re-sent', async () => {
  const t = setup({ confTime: T1 + 3600, finTime: T1 + 3600, sendFails: true });
  await t.sender.sendRefund(t.s, 'late'); const sig = t.s.refundAttempts[0].sig;
  t.chain.statuses.set(sig, { slot: CONF_SLOT, confirmations: 3, err: null, confirmationStatus: 'confirmed' });
  assert.equal((await t.sender.resolve(t.s)).open, 1, 'confirmed is not final');
  t.chain.statuses.set(sig, finalized());
  assert.equal((await t.sender.resolve(t.s)).open, 0); assert.equal(t.s.refundSig, sig); assert.equal(t.s.refundAttempts[0].state, 'landed');
  assert.ok(t.chain.sends.every((x) => x.tx === t.chain.sends[0].tx), 'only rebroadcasts of the same bytes'); assert.equal(t.s.refundAttempts.length, 1); t.done();
});

test('rejected execution: a finalized failure keeps the exposure mark; a later variant needs the settled failure first', async () => {
  const t = setup({ confTime: T1 + 3600, finTime: T1 + 3600 });
  await t.sender.sendRefund(t.s, 'late'); const sig = t.s.refundAttempts[0].sig;
  assert.equal((await t.sender.sendRefund(t.s, 'late')).refused, 'attempt-open');
  t.chain.statuses.set(sig, finalized({ InstructionError: [1, { Custom: 6003 }] }));
  await t.sender.resolve(t.s); assert.equal(t.s.refundAttempts[0].state, 'failed'); assert.ok(t.s.secretExposure);
  assert.equal((await t.sender.sendReady(t.s)).refused, 'secret-may-be-exposed', 'never set ready once b may have left');
  assert.equal((await t.sender.sendRefund(t.s, 'late')).sent, true); assert.equal(t.s.refundAttempts.length, 2);
  t.done();
});

test('crash after the store, before the send: the restarted maker finds the persisted attempt and creates nothing new until it is settled', async () => {
  const t = setup({ confTime: T1 + 3600, finTime: T1 + 3600 });
  let crashed = null; t.chain.hook = async (m) => { if (m === 'sendTransaction' && !crashed) crashed = t.chain.readDisk(); };
  await t.sender.sendRefund(t.s, 'late');
  assert.equal(crashed.refundAttempts[0].state, 'persisted', 'the durable record existed before the first byte left');
  const s2 = t.newSender(); const before = t.chain.sends.length;
  assert.equal((await s2.resolve(crashed)).open, 1); assert.equal((await s2.sendRefund(crashed, 'late')).refused, 'attempt-open');
  assert.equal(t.chain.sends.length, before); t.done();
});

test('early attempt not proven landed by t0 - 120 s: ambiguous, no early retry, no ready; the t1 path then refunds', async () => {
  const t = setup();
  await t.sender.sendRefund(t.s, 'early');
  t.chain.confTime = T0 - EARLY_LANDING_MARGIN; t.clock.ms = t.chain.confTime * 1000;
  await t.sender.resolve(t.s); assert.equal(t.s.earlyAbort, 'ambiguous');
  t.chain.finHeight = t.s.refundAttempts[0].lastValidBlockHeight + ATTEMPT_EXPIRY_MARGIN + 1; t.chain.height = t.chain.finHeight + 32;
  await t.sender.resolve(t.s); assert.equal(t.s.refundAttempts[0].state, 'expired');
  assert.equal(earlyRefundGate({ record: t.s }).why, 'early-abort-ambiguous');
  assert.equal((await t.sender.sendRefund(t.s, 'early')).refused, 'early-abort-ambiguous');
  assert.equal((await t.sender.sendReady(t.s)).refused, 'secret-may-be-exposed');
  t.chain.confTime = T1 + 3600; t.chain.finTime = T1 + LATE_REFUND_MARGIN;
  assert.equal((await t.sender.sendRefund(t.s, 'late')).sent, true); t.done();
});

// ---- set-ready ----
test('set-ready: unsigned simulation only, attempt on disk before the send, both endpoints, no second variant while open', async () => {
  const t = setup({ confTime: T0 - 3000 });
  assert.equal((await t.sender.sendReady(t.s)).sent, true);
  const sim = t.chain.calls.filter((c) => c.method === 'simulateTransaction');
  assert.equal(sim.length, 1); assert.deepEqual(validSigs(sim[0].params[0], t.maker), [], 'no valid signature in the simulation');
  assert.equal(sim[0].params[1].sigVerify, false); assert.equal(sim[0].params[1].replaceRecentBlockhash, false);
  const att = t.reload().readyAttempts[0];
  assert.deepEqual(t.chain.sends.map((x) => [x.endpoint, x.onDisk?.readyAttempts?.[0]?.sig]), [['primary', att.sig], ['secondary', att.sig]]);
  assert.deepEqual(validSigs(t.chain.sends[0].tx, t.maker), [att.sig]);
  assert.equal((await t.sender.sendReady(t.s)).refused, 'attempt-open');
  assert.equal((await t.sender.sendRefund(t.s, 'early')).refused, 'attempt-open', 'no refund while a ready attempt may still land');
  assert.deepEqual(withSecret(t), []); t.done();
});

test('a ready attempt settled as expired: the early refund needs an account read at least as new as that settlement', async () => {
  const t = setup();
  t.s.readyAttempts = [{ n: 1, action: 'set-ready', sig: 'x', state: 'expired', resolvedSlot: CONF_SLOT + 10 }];
  assert.equal((await t.sender.sendRefund(t.s, 'early')).refused, 'stale-account-context'); assert.deepEqual(withSecret(t), []); t.done();
});

test('gates are pure: late needs finalized time, early needs a bounded blockhash, a landed ready and agreeing endpoints', () => {
  const rec = { t0: T0, t1: T1, B: 'bb' }, acc = { ready: false, t0: T0, t1: T1, refundPoint: 'bb' };
  const reads = [{ account: acc, slot: 10, minSlot: 10 }, { account: acc, slot: 12, minSlot: 0 }];
  const early = (over = {}) => earlyRefundGate({ record: rec, reads, tipTime: T0 - 900, localNow: T0 - 900, remainingBlocks: 150, ...over });
  assert.equal(lateRefundGate({ record: rec, account: acc, accountSlot: 10, finalized: { slot: 10, blockTime: null } }).why, 'finalized-time-unobserved');
  assert.equal(lateRefundGate({ record: rec, account: acc, accountSlot: 10, finalized: { slot: 10, blockTime: T1 + 60 } }).ok, true);
  assert.equal(early().ok, true);
  assert.equal(early({ remainingBlocks: undefined }).why, 'blockhash-lifetime-unbounded');
  assert.equal(early({ reads: [reads[0], { account: { ...acc, t0: T0 + 1 }, slot: 12, minSlot: 0 }] }).why, 'escrow-mismatch');
  // Astra 699-H2: a landed ready always forbids the early refund, whatever any endpoint's account says.
  assert.equal(early({ record: { ...rec, readyAttempts: [{ state: 'landed', resolvedSlot: 1 }] } }).why, 'ready-landed');
  assert.equal(early({ record: { ...rec, readySig: 'x' } }).why, 'ready-landed');
  assert.equal(early({ record: { ...rec, endpointDisagreement: { sig: 'x' } } }).why, 'endpoints-disagree');
  assert.equal(early({ reads: [reads[0], { error: 'down', minSlot: 0 }] }).why, 'escrow-unread-on-an-endpoint');
  assert.equal(early({ reads: [reads[0], { account: { ...acc, ready: true }, slot: 12, minSlot: 0 }] }).why, 'escrow-ready');
  assert.equal(early({ reads: [] }).why, 'escrow-unread');
  // Fable F1: the secondary must confirm the blockhash and agree on height.
  assert.equal(early({ crossCheck: { blockhashValid: false, heightPrimary: 9000, heightSecondary: 9000 } }).why, 'blockhash-not-valid-on-secondary');
  assert.equal(early({ crossCheck: { blockhashValid: true, heightPrimary: 9000, heightSecondary: 9009 } }).why, 'endpoint-heights-disagree');
  assert.equal(early({ crossCheck: { error: 'x' } }).why, 'secondary-unreadable');
  assert.equal(early({ crossCheck: { blockhashValid: true, heightPrimary: 9000, heightSecondary: 9008 } }).ok, true);
});

// ---- Astra 699-H2: endpoint skew around set-ready ----
test('699-H2 regression: a ready finalized on the secondary (newer) with an old primary saying not-ready refuses the early refund; the real tx slot is stored', async () => {
  const t = setup({ confTime: T0 - 3000 });
  await t.sender.sendReady(t.s); const sig = t.s.readyAttempts[0].sig;
  t.chain.confTime = T0 - ABORT_LEAD; t.clock.ms = t.chain.confTime * 1000;
  t.chain.per = { primary: { statuses: new Map() }, secondary: { statuses: new Map([[sig, { slot: CONF_SLOT + 100, confirmations: null, err: null, confirmationStatus: 'finalized' }]]) } };
  assert.equal((await t.sender.resolve(t.s)).open, 0);
  assert.equal(t.s.readyAttempts[0].state, 'landed'); assert.equal(t.s.readyAttempts[0].resolvedSlot, CONF_SLOT + 100, 'the slot of the transaction, not of the finalized sample');
  assert.equal(t.s.readySig, sig);
  // Both endpoints now answer an old "not ready" (the escrow view lags): still refused.
  t.chain.escrow = { ready: false };
  assert.equal((await t.sender.sendRefund(t.s, 'early')).refused, 'ready-landed');
  assert.deepEqual(withSecret(t), []); t.done();
});

test('699-H2: the settled ready slot bounds the account reads (a lagging primary is stale even before the ready-landed rule)', async () => {
  const t = setup();
  t.s.readyAttempts = [{ n: 1, action: 'set-ready', sig: 'x', state: 'failed', resolvedSlot: CONF_SLOT + 100 }];
  assert.equal((await t.sender.sendRefund(t.s, 'early')).refused, 'stale-account-context'); assert.deepEqual(withSecret(t), []); t.done();
});

test('699-H2: one endpoint says the ready failed, the other that it landed: counted as landed, disagreement recorded, no early refund', async () => {
  const t = setup({ confTime: T0 - 3000 });
  await t.sender.sendReady(t.s); const sig = t.s.readyAttempts[0].sig;
  t.chain.confTime = T0 - ABORT_LEAD; t.clock.ms = t.chain.confTime * 1000;
  t.chain.per = { primary: { statuses: new Map([[sig, finalized({ InstructionError: [1, { Custom: 6002 }] })]]) }, secondary: { statuses: new Map([[sig, { ...finalized(), slot: CONF_SLOT - 2 }]]) } };
  await t.sender.resolve(t.s);
  assert.equal(t.s.readyAttempts[0].state, 'landed'); assert.ok(t.s.endpointDisagreement);
  assert.ok(t.logs.some((e) => e.event === 'alarm-endpoints-disagree'));
  delete t.s.readySig; t.s.readyAttempts[0].state = 'failed';   // even if the record were read as failed, the disagreement alone refuses
  assert.equal((await t.sender.sendRefund(t.s, 'early')).refused, 'endpoints-disagree'); assert.deepEqual(withSecret(t), []); t.done();
});

test('699-H2: the escrow must be open and not ready on EVERY endpoint; an unreadable endpoint refuses', async () => {
  const ready = setup(); ready.chain.per = { secondary: { escrow: { ready: true } } };
  assert.equal((await ready.sender.sendRefund(ready.s, 'early')).refused, 'escrow-ready'); assert.deepEqual(withSecret(ready), []); ready.done();
  const down = setup(); down.chain.per = { secondary: { accountError: true } };
  assert.equal((await down.sender.sendRefund(down.s, 'early')).refused, 'escrow-unread-on-an-endpoint'); assert.deepEqual(withSecret(down), []); down.done();
});

test('Astra 699 b: chain time is re-sampled after the account reads (the chain crossing the window during them refuses)', async () => {
  const t = setup(); t.chain.hook = async (m) => { if (m === 'getAccountInfo') t.chain.confTime = T0 - EARLY_SEND_MIN_LEAD + 1; };
  assert.equal((await t.sender.sendRefund(t.s, 'early')).refused, 'blockhash-may-outlive-t0'); assert.deepEqual(withSecret(t), []); t.done();
});

// ---- Fable F1, F3, F4 ----
test('F1: a blockhash the secondary does not know, or disagreeing heights, refuse the early refund; the higher height is used', async () => {
  const stale = setup(); stale.chain.per = { secondary: { bhValid: false } };
  assert.equal((await stale.sender.sendRefund(stale.s, 'early')).refused, 'blockhash-not-valid-on-secondary'); assert.deepEqual(withSecret(stale), []); stale.done();
  const apart = setup(); apart.chain.per = { secondary: { height: apart.chain.height + 20 } };
  assert.equal((await apart.sender.sendRefund(apart.s, 'early')).refused, 'endpoint-heights-disagree'); assert.deepEqual(withSecret(apart), []); apart.done();
  const near = setup(); near.chain.per = { secondary: { height: near.chain.height + 5 } };
  assert.equal((await near.sender.sendRefund(near.s, 'early')).sent, true);
  assert.equal(near.reload().refundAttempts[0].gate.remainingBlocks, 145, 'remaining blocks from the higher of the two heights'); near.done();
});

test('F3: after a send error the SAME bytes are sent again while the blockhash may be valid; never after its last valid height', async () => {
  const t = setup({ confTime: T1 + 3600, finTime: T1 + 3600, sendFails: true });
  await t.sender.sendRefund(t.s, 'late'); const att = t.s.refundAttempts[0];
  t.chain.sendFails = false; await t.sender.resolve(t.s);
  assert.equal(t.chain.sends.length, 4); assert.equal(att.state, 'sent'); assert.equal(att.rebroadcasts, 1);
  for (const x of t.chain.sends) assert.deepEqual(validSigs(x.tx, t.maker), [att.sig]);
  const late = setup({ confTime: T1 + 3600, finTime: T1 + 3600, sendFails: true });
  await late.sender.sendRefund(late.s, 'late'); late.chain.finHeight = late.s.refundAttempts[0].lastValidBlockHeight + 1;
  await late.sender.resolve(late.s); assert.equal(late.chain.sends.length, 2, 'past its last valid height: no rebroadcast');
  t.done(); late.done();
});

test('Astra 4b9ed669: an EARLY refund is rebroadcast only while its timing still holds; never after the ambiguity cut or t0 (stalled finalized height)', async () => {
  const run = async (confTime) => {
    const t = setup({ sendFails: true });
    await t.sender.sendRefund(t.s, 'early'); assert.equal(t.s.refundAttempts[0].state, 'send-error');
    t.chain.sendFails = false; t.chain.confTime = confTime; t.clock.ms = confTime * 1000;   // finalized height stalls (unchanged)
    await t.sender.resolve(t.s);
    return t;
  };
  const ok = await run(T0 - ABORT_LEAD + 30);
  assert.equal(ok.chain.sends.length, 4, 'timing still holds: same bytes again'); assert.ok(ok.chain.sends.every((x) => x.tx === ok.chain.sends[0].tx)); ok.done();
  for (const [confTime, why] of [[T0 - EARLY_SEND_MIN_LEAD + 100, 'early-timing-no-longer-holds'], [T0 - EARLY_LANDING_MARGIN, 'early-abort-ambiguous'], [T0 + 30, 'early-abort-ambiguous']]) {
    const t = await run(confTime);
    assert.equal(t.chain.sends.length, 2, `no rebroadcast at t0 ${confTime - T0}`);
    assert.ok(t.logs.some((e) => e.event === 'rebroadcast-withheld' && e.why === why), why);
    assert.equal(t.s.refundAttempts.length, 1); t.done();
  }
  // Pure: after t0 and unobserved inputs block too.
  const rec = { t0: T0 }, att = { lastValidBlockHeight: 9150 };
  assert.equal(earlyRebroadcastBlock(rec, att, T0, 9000), 'after-t0');
  assert.equal(earlyRebroadcastBlock(rec, att, null, 9000), 'chain-time-unobserved');
  assert.equal(earlyRebroadcastBlock(rec, att, T0 - 900, null), 'height-unobserved');
  assert.equal(earlyRebroadcastBlock(rec, { lastValidBlockHeight: 9500 }, T0 - 900, 9000), 'blockhash-lifetime-unbounded');
  assert.equal(earlyRebroadcastBlock(rec, att, T0 - 900, 9000), null);
});

test('F4: a local clock far ahead of chain time is journaled as an alarm (it refuses early refunds)', async () => {
  const t = setup(); t.clock.ms = (t.chain.confTime + 3600) * 1000;
  assert.equal((await t.sender.sendRefund(t.s, 'early')).refused, 'blockhash-may-outlive-t0');
  assert.ok(t.logs.some((e) => e.event === 'alarm-local-clock-ahead' && e.aheadS === 3600)); t.done();
});

// ---- Astra 699-M1: adapter -> decision -> sender ----
test('699-M1: a full payment at the set-ready depth is not hidden by pool dust; mixed outputs count only at depth; underpayment aborts', async () => {
  const pass = (t, transfers) => makerStep(t.s, { readSwap: async () => ({ ready: false, t0: T0, t1: T1, lamports: 1 }), readRevealed: async () => null, chainNow: async () => t.chain.confTime,
    scanXmr: async () => usableFromTransfers(transfers), resolve: (x) => t.sender.resolve(x), sendReady: (x) => t.sender.sendReady(x), sendRefund: (x, k) => t.sender.sendRefund(x, k), sweep: async () => null, store: t.store, log: () => {} });
  const out = (amount, confirmations) => ({ amount, confirmations, unlock_time: 0 });
  for (const [name, transfers, expect] of [
    ['full 100 at 40 plus dust 1 in the pool', { in: [out(100, 40)], pool: [out(1, 0)] }, 'wait'],
    ['full 100 at 40 plus dust 1 at 2', { in: [out(100, 40), out(1, 2)] }, 'wait'],
    ['60 at 40 plus 40 at 12 (all at depth: ready, never an abort)', { in: [out(60, 40), out(40, 12)] }, 'set-ready'],
    ['60 at 40 plus 40 at 2 (only 60 at depth)', { in: [out(60, 40), out(40, 2)] }, 'refund'],
    ['100 at 40 but time-locked', { in: [{ ...out(100, 40), unlock_time: 99999999 }] }, 'refund'],
    ['underpaid 99 at 40', { in: [out(99, 40)] }, 'refund'],
  ]) {
    const t = setup(); t.s.secretExposure = null;
    const a = await pass(t, transfers);
    assert.equal(a.action === 'refund' ? 'refund' : a.action === 'set-ready' ? 'set-ready' : 'wait', expect, name);
    if (expect !== 'refund') assert.deepEqual(withSecret(t), [], `${name}: b in no payload`); else assert.equal(t.chain.sends.length, 2, name);
    t.done();
  }
});

test('source: the maker never sends ready or refund through sol.send, and no maker file prices or simulates a refund', () => {
  const strip = (f) => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const maker = strip('./maker.mjs'), send = strip('./maker-send.mjs');
  assert.doesNotMatch(maker, /sol\.send\(/);
  assert.match(maker, /sendRefund: \(x, kind\) => sender\.sendRefund\(x, kind\)/);
  for (const f of ['./maker.mjs', './maker-send.mjs', './maker-chain.mjs', './maker-core.mjs']) assert.doesNotMatch(strip(f), /getFeeForMessage/, f);
  // Each secret-bearing method is cut out on its own (the next method starts with "async "): the refund (b) and the strict claim (a).
  const method = (name) => { const i = send.indexOf(`async ${name}(`); assert.ok(i > 0, name); const j = send.indexOf('\n    async ', i + 1); return send.slice(i, j > 0 ? j : undefined); };
  assert.doesNotMatch(method('sendRefund'), /simulate/i, 'the refund path never simulates');
  assert.doesNotMatch(method('sendClaim'), /simulate|getFeeForMessage/i, 'the strict claim path (a) never simulates and is never priced');
  assert.match(method('sendCommit'), /simulateTransaction\(new VersionedTransaction\(message\), \{ sigVerify: false, replaceRecentBlockhash: false/, 'the commit (no secret) is simulated unsigned only');
  assert.doesNotMatch(send, /durableNonce|nonceInfo|NonceAccount/, 'recent blockhash only (R10)');
});

test('makerStep: while an attempt is unsettled nothing is decided or scanned for that swap (no second variant, even with the sender bypassed)', async () => {
  const t = setup({ confTime: T1 + 3600, finTime: T1 + 3600, sendFails: true });
  await t.sender.sendRefund(t.s, 'late');
  let scanned = 0, sent = 0;
  const a = await makerStep(t.s, { readSwap: async () => ({ ready: false, t0: T0, t1: T1, lamports: 1 }), readRevealed: async () => null, chainNow: async () => t.chain.confTime,
    scanXmr: async () => { scanned++; return null; }, resolve: (x) => t.sender.resolve(x), sendReady: async () => { sent++; return { sig: 'R' }; }, sendRefund: async () => { sent++; return { sig: 'F' }; }, sweep: async () => null, store: t.store, log: () => {} });
  assert.deepEqual(a, { action: 'wait', reason: 'attempt-unsettled' }); assert.equal(scanned, 0); assert.equal(sent, 0);
  t.done();
});
