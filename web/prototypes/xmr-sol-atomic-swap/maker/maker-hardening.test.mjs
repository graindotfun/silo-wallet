// Review fixes of 10 Nov 2026 (maker side): F-12 / SEC-P-05 paid vs unpaid limits, F-13 / SEC-P-06 token on every route,
// SEC-P-07 second price source, SEC-P-09 bounded priority fee. No network except loopback; no real keys.
import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process'; import { fileURLToPath } from 'node:url';
import { Keypair, PublicKey, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { isCommitted, tally, limitInputs, unpaidCaps, requesterOf } from './maker-limits.mjs';
import { capsAdmission } from './maker-reverse.mjs';
import { makerStep } from './maker-core.mjs';
import { createPriceCheck, coingeckoPrice, krakenPrice, gapBps } from './price-feeds.mjs';
import { pickPriorityFee, priorityFeeConfig, createFeeSource, computeBudgetIxs, HARD_CAP_MICROLAMPORTS } from './priority-fee.mjs';
import { createSender, SEND_COMPUTE_UNITS } from './maker-send.mjs';

const now = new Date('2026-11-10T12:00:00.000Z');
const today = '2026-11-10T09:00:00.000Z', yesterday = '2026-11-09T09:00:00.000Z';
const X = 50_000_000_000n;   // 0.05 XMR
const rec = (o = {}) => ({ swapId: Math.random().toString(16).slice(2), xmrAtomic: X.toString(), createdAt: today, claimer: Keypair.generate().publicKey.toBase58(), ...o });
const caps = { minAtomic: 1_000_000_000n, maxPerSwapAtomic: X, maxPerDayAtomic: 300_000_000_000n, maxOpen: 3, reserveAtomic: 0n, ...unpaidCaps({}) };
const admit = (swaps, requester, xmr = X) => { const l = limitInputs(swaps, requester, { now }); return capsAdmission({ xmrAtomic: xmr, openCount: swaps.filter((s) => !s.done).length, lockedTodayAtomic: l.lockedTodayAtomic, unpaid: l.unpaid, caps }); };

// ---- F-12 ----
test('F-12: six unpaid requests leave the paid daily allowance unchanged', () => {
  const unpaid = Array.from({ length: 6 }, () => rec({ done: 'refunded' }));   // asked, never paid, aborted
  const t = tally(unpaid, { now });
  assert.equal(t.paidTodayAtomic, 0n);
  assert.equal(t.reservedAtomic, 0n, 'finished unpaid swaps reserve nothing');
  assert.equal(t.unpaidToday, 6);
  // the paid allowance is still the full 0.3: six paid-size swaps (6 x 0.05) fit, a seventh does not
  const paid = Array.from({ length: 5 }, () => rec({ committedAt: today, done: 'completed' }));
  assert.equal(admit([...unpaid.slice(0, 2), ...paid], Keypair.generate().publicKey.toBase58()), true, 'six unpaid + five paid: the sixth paid slot is free');
  const six = Array.from({ length: 6 }, () => rec({ committedAt: today, done: 'completed' }));
  assert.throws(() => admit(six, 'new'), /daily-limit-reached/);
});
test('F-12: the unpaid counter refuses the next request with its own error code, per day', () => {
  const caps48 = unpaidCaps({}); assert.equal(caps48.maxUnpaidPerDay, 48);
  const day = Array.from({ length: 48 }, () => rec({ done: 'refunded' }));
  assert.throws(() => admit(day, 'x'), (e) => e.message === 'unpaid-limit-reached');
  assert.equal(admit(day.slice(0, 47), 'x'), true);
  // yesterday's unpaid requests do not count today
  assert.equal(admit(day.map((s) => ({ ...s, createdAt: yesterday })), 'x'), true);
});
test('F-12: concurrent unpaid requests and one per address are bounded; the open cap still counts everything', () => {
  const a = rec(), b = rec();
  assert.throws(() => admit([a, b], 'c'), (e) => e.message === 'unpaid-busy-try-later');   // 2 unpaid open: a third unpaid is refused (a slot stays free for a paying user)
  assert.throws(() => admit([a], a.claimer), (e) => e.message === 'address-has-open-swap');
  assert.equal(admit([a], 'someone-else'), true);
  const paidOpen = [rec({ committedAt: today }), rec({ committedAt: today }), rec({ committedAt: today })];
  assert.throws(() => admit(paidOpen, 'z'), (e) => e.message === 'busy-try-later', 'three paid swaps open: the float cap still holds');
});
test('F-12: a paid swap counts toward the daily volume; open unpaid swaps are reserved so the 0.3 ceiling stays true', () => {
  const paid = rec({ committedAt: today, done: 'completed' });
  const open = [rec(), rec()];
  const t = tally([paid, ...open], { now });
  assert.equal(t.paidTodayAtomic, X); assert.equal(t.reservedAtomic, 2n * X);
  assert.equal(limitInputs([paid, ...open], null, { now }).lockedTodayAtomic, 3n * X);
  // a swap paid yesterday-created but paid today counts today; one created today but only recognised by later fields still counts
  assert.equal(tally([rec({ createdAt: yesterday, committedAt: today })], { now }).paidTodayAtomic, X);
  assert.equal(tally([rec({ readySig: 'sig' })], { now }).paidTodayAtomic, X);
  assert.equal(tally([rec({ createdAt: yesterday, readySig: 'sig', done: 'completed' })], { now }).paidTodayAtomic, 0n);
  assert.equal(tally([rec({ createdAt: yesterday, readySig: 'sig' })], { now }).paidTodayAtomic, X, 'legacy open record without a timestamp: counted today, conservatively');
});
test('F-12: committed means value in: SOL -> XMR counts once the user locked SOL, not at registration', () => {
  assert.equal(isCommitted(rec({ direction: 'sol-xmr', refunder: 'u' })), false);
  assert.equal(isCommitted(rec({ direction: 'sol-xmr', refunder: 'u', seenPda: true })), true);
  assert.equal(isCommitted(rec({ direction: 'sol-xmr', refunder: 'u', xmrSendTxid: 'tx' })), true);
  assert.equal(requesterOf({ direction: 'sol-xmr', refunder: 'u', claimer: 'maker' }), 'u');
  assert.equal(isCommitted(rec()), false); assert.equal(isCommitted(rec({ committedAt: today })), true);
  assert.equal(isCommitted(rec({ sweepTxids: ['t'] })), true);
  const reg = [rec({ direction: 'sol-xmr', refunder: 'u1' }), rec({ direction: 'sol-xmr', refunder: 'u2', seenPda: true })];
  const t = tally(reg, { now }); assert.equal(t.paidTodayAtomic, X); assert.equal(t.unpaidOpen.length, 1);
});
test('F-12: makerStep marks committedAt once the full amount is mined, not for a pool-only or short payment', async () => {
  const mk = (xmr) => {
    const s = { swapId: 'ab', xmrAtomic: X.toString(), confirmations: 10, lockedAt: 0, t0: 0 };
    const deps = { readSwap: async () => ({ t0: 10_000, t1: 20_000, ready: false }), chainNow: async () => 100, scanXmr: async () => xmr, store: () => { s.stored = true; }, log: () => {}, readRevealed: async () => null };
    return { s, deps };
  };
  for (const [xmr, expect] of [[{ atomic: X.toString(), confirmations: 0 }, false], [{ atomic: (X - 1n).toString(), confirmations: 3 }, false], [{ atomic: X.toString(), confirmations: 1 }, true]]) {
    const { s, deps } = mk(xmr); await makerStep(s, deps);
    assert.equal(!!s.committedAt, expect, JSON.stringify(xmr)); if (expect) assert.equal(s.stored, true, 'stored even on a waiting pass');
  }
});

// ---- SEC-P-07 ----
const cg = (xmr, sol, age = 10, t = 1_000_000) => async () => ({ ok: true, json: async () => ({ monero: { usd: xmr, last_updated_at: t - age }, solana: { usd: sol, last_updated_at: t - age } }) });
const kr = (xmr, sol) => async () => ({ ok: true, json: async () => ({ error: [], result: { XXMRZUSD: { c: [String(xmr), '1'] }, SOLUSD: { c: [String(sol), '1'] } } }) });
const checker = (a, b, bandBps) => createPriceCheck({ bandBps, fetchers: [() => coingeckoPrice({ fetcher: a, nowS: () => 1_000_000 }), () => krakenPrice({ fetcher: b })] });
test('SEC-P-07: two agreeing sources quote', async () => {
  const p = await checker(cg(300, 150), kr(302, 150.5))();
  assert.equal(p.solPerXmr, 2); assert.equal(p.check.source, 'kraken'); assert.ok(p.check.gapBps < 100);
});
test('SEC-P-07: a 20 percent outlier refuses with prices-disagree', async () => {
  await assert.rejects(checker(cg(300, 150), kr(360, 150))(), (e) => e.message === 'prices-disagree' && e.gapBps > 1500);
  await assert.rejects(checker(cg(360, 150), kr(300, 150))(), /prices-disagree/);
  assert.ok(gapBps({ xmrUsd: 300, solUsd: 150 }, { xmrUsd: 300, solUsd: 150 }) === 0);
});
test('SEC-P-07: one source down, malformed or stale refuses', async () => {
  const down = async () => { throw new Error('ECONNRESET'); };
  await assert.rejects(checker(cg(300, 150), down)(), /price-unavailable/);
  await assert.rejects(checker(down, kr(300, 150))(), /price-unavailable/);
  await assert.rejects(checker(cg(300, 150), async () => ({ ok: false, json: async () => ({}) }))(), /price-unavailable/);
  await assert.rejects(checker(cg(300, 150), async () => ({ ok: true, json: async () => ({ error: ['EGeneral:Internal error'], result: {} }) }))(), /price-unavailable/);
  await assert.rejects(checker(cg(0, 150), kr(300, 150))(), /price-unavailable/);
  await assert.rejects(checker(cg(300, 150, 900), kr(300, 150))(), /price-stale/);   // CoinGecko's own timestamp is 15 minutes old
  await assert.rejects(checker(async () => ({ ok: true, json: async () => ({ monero: { usd: 300 }, solana: { usd: 150 } }) }), kr(300, 150))(), /price-stale/, 'no timestamp cannot show freshness');
});
test('SEC-P-07: the band is configurable', async () => {
  await assert.rejects(checker(cg(300, 150), kr(306, 150), 100)(), /prices-disagree/);   // 2 percent vs a 1 percent band
  assert.ok((await checker(cg(300, 150), kr(306, 150), 300)()).solPerXmr);
});

// ---- SEC-P-09 ----
test('SEC-P-09: the fee is clamped between the floor and a ceiling a spike cannot exceed, and config cannot raise the hard cap', () => {
  const c = priorityFeeConfig({});
  assert.deepEqual([c.floor, c.ceiling, c.percentile], [5_000, 200_000, 75]);
  assert.equal(pickPriorityFee([], c), 5_000, 'no data: the floor');
  assert.equal(pickPriorityFee([{ prioritizationFee: 0 }, { prioritizationFee: 0 }], c), 5_000);
  assert.equal(pickPriorityFee(Array.from({ length: 20 }, (_, i) => ({ prioritizationFee: 50_000 + i })), c) >= 50_000, true);
  assert.equal(pickPriorityFee([{ prioritizationFee: 900_000_000 }], c), 200_000, 'a spike stops at the ceiling');
  assert.equal(pickPriorityFee(['x', null, NaN, -5, undefined], c), 5_000, 'garbage gives the floor');
  const wild = priorityFeeConfig({ PRIORITY_FEE_CEILING_MICROLAMPORTS: '99999999999', PRIORITY_FEE_FLOOR_MICROLAMPORTS: '99999999999' });
  assert.equal(wild.ceiling, HARD_CAP_MICROLAMPORTS); assert.ok(wild.floor <= wild.ceiling);
  assert.equal(priorityFeeConfig({ PRIORITY_FEE: 'off' }).enabled, false);
});
test('SEC-P-09: the fee source never throws and asks for the escrow account only', async () => {
  const seen = []; const cfg = priorityFeeConfig({});
  const ok = createFeeSource(cfg, { getRecentPrioritizationFees: async (a) => { seen.push(a); return [{ slot: 1, prioritizationFee: 20_000 }]; } });
  const pda = Keypair.generate().publicKey;
  assert.equal(await ok(pda), 20_000 > 5_000 ? 20_000 : 5_000); assert.deepEqual(seen, [{ lockedWritableAccounts: [pda] }]);
  assert.equal(await createFeeSource(cfg, { getRecentPrioritizationFees: async () => { throw new Error('rpc down'); } })(pda), 5_000);
  assert.equal(await createFeeSource({ ...cfg, enabled: false }, {})(pda), 0);
});
test('SEC-P-09: the transaction carries limit then price, price omitted at zero, never above the hard cap', () => {
  const [a, b] = computeBudgetIxs(SEND_COMPUTE_UNITS, 7_000);
  assert.ok(a.programId.equals(ComputeBudgetProgram.programId) && b.programId.equals(ComputeBudgetProgram.programId));
  assert.equal(a.data[0], 2); assert.equal(b.data[0], 3);   // SetComputeUnitLimit, SetComputeUnitPrice
  assert.equal(Number(b.data.readBigUInt64LE(1)), 7_000);
  assert.equal(computeBudgetIxs(SEND_COMPUTE_UNITS, 0).length, 1);
  assert.equal(Number(computeBudgetIxs(SEND_COMPUTE_UNITS, 9e12)[1].data.readBigUInt64LE(1)), HARD_CAP_MICROLAMPORTS);
});
test('SEC-P-09: the sender signs set-ready with the priced budget, the fee read before the blockhash and from the escrow address', async () => {
  const maker = Keypair.generate(); const order = []; const swapId = 'ab'.repeat(32);
  const conn = { getLatestBlockhash: async () => { order.push('blockhash'); return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 500 }; },
    simulateTransaction: async () => ({ value: { err: null } }), sendRawTransaction: async () => 'sig' };
  const rec2 = { swapId, readyAttempts: [] };
  const sender = createSender({ conns: [conn], payer: maker, store: () => {}, log: () => {}, feeFor: async (pda) => { order.push('fee'); assert.ok(pda instanceof PublicKey); return 12_345; } });
  const r = await sender.sendReady(rec2);
  assert.deepEqual(order.slice(0, 2), ['fee', 'blockhash']);
  const tx = VersionedTransaction.deserialize(Buffer.from(rec2.readyAttempts[0].raw, 'base64'));
  const ixs = tx.message.compiledInstructions; const keys = tx.message.staticAccountKeys;
  const budget = ixs.filter((i) => keys[i.programIdIndex].equals(ComputeBudgetProgram.programId));
  assert.equal(budget.length, 2); assert.equal(Number(Buffer.from(budget[1].data).readBigUInt64LE(1)), 12_345);
  assert.ok(r.sig || r.sent !== undefined);
});

// ---- F-13 / SEC-P-06: the real maker process ----
test('F-13: GET /v1/swap/<id> needs the token; authenticated works; health stays open and unchanged', async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'hard-')); mkdirSync(join(state, 'swaps'));
  writeFileSync(join(state, 'maker-sol.json'), JSON.stringify([...Keypair.generate().secretKey]));   // throwaway test key in a temp dir
  writeFileSync(join(state, 'wallet-password'), 'test-only');
  const id = 'cd'.repeat(32);
  writeFileSync(join(state, 'swaps', `${id}.json`), JSON.stringify({ swapId: id, jointAddress: 'JOINT', lockSig: 'L', xmrSendTxid: 'TXID', done: 'completed', createdAt: today, xmrAtomic: '1' }));
  const token = 't'.repeat(48), port = 39000 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./maker.mjs', import.meta.url))], {
    env: { PATH: process.env.PATH, MAKER_STATE: state, MAKER_PORT: String(port), MAKER_API_TOKEN: token, XMR_NETWORK: 'stagenet', SOL_RPC: 'http://127.0.0.1:9', MAKER_WALLET_RPC: 'http://127.0.0.1:9/json_rpc', XMR_DAEMON: 'http://127.0.0.1:9/json_rpc', LOOP_MS: '3600000' }, stdio: 'ignore' });
  t.after(() => { child.kill(); rmSync(state, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { await fetch(`${url}/v1/health`); break; } catch { await new Promise((r) => setTimeout(r, 50)); } }
  const none = await fetch(`${url}/v1/swap/${id}`); assert.equal(none.status, 401); assert.deepEqual(await none.json(), { error: 'unauthorized' });
  assert.equal((await fetch(`${url}/v1/swap/${id}`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(`${url}/v1/swap/zz`)).status, 401);
  const ok = await fetch(`${url}/v1/swap/${id}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(ok.status, 200); assert.equal((await ok.json()).xmrSendTxid, 'TXID');
  assert.equal((await fetch(`${url}/v1/quote`, { method: 'POST', body: '{}' })).status, 401);
  const h = await fetch(`${url}/v1/health`); assert.equal(h.status, 200);
  assert.deepEqual(Object.keys(await h.json()).sort(), ['accepting', 'limits', 'maker', 'ok', 'solXmr']);   // exactly what it exposed before
});

// ---- Retention (privacy) ----
import { reduceIfDue, pruneFinished, isFinished, RETENTION_MS } from './maker-retention.mjs';
import { recordProblem } from './quiesce-check.mjs';
const DAY = 24 * 3600 * 1000, T = Date.parse('2026-11-30T00:00:00.000Z');
const fin = (o = {}) => ({ swapId: 'ab'.repeat(32), done: 'completed', finalEvidence: { finalizedSlot: 5 }, finishedAt: '2026-11-10T00:00:00.000Z', createdAt: '2026-11-09T10:11:12.000Z', xmrAtomic: '50000000000', lamports: 7, claimer: 'CLAIMER', jointAddress: 'J', ...o });
test('retention: an old finished record is reduced to outcome and amounts', () => {
  const r = reduceIfDue(fin(), { nowMs: T });
  assert.deepEqual(r, { swapId: 'ab'.repeat(32), direction: 'xmr-sol', done: 'completed', finishedAt: '2026-11-10T00:00:00.000Z', createdAt: '2026-11-09T00:00:00.000Z', xmrAtomic: '50000000000', reduced: true, lamports: 7 });
  assert.equal(recordProblem(r, r.swapId), null, 'the quiesce check still accepts it');
  const user = Keypair.generate().publicKey.toBase58();
  const rev = reduceIfDue(fin({ direction: 'sol-xmr', refunder: user, done: 'completed', jointAddress: 'JOINT' }), { nowMs: T, pda: Keypair.generate().publicKey.toBase58() });
  assert.equal(recordProblem(rev, rev.swapId), null); assert.equal(rev.refunder, user, 'the refunder stays: the quiescence collector needs it'); assert.equal(JSON.stringify(rev).includes('JOINT'), false);
  assert.equal(reduceIfDue(fin(), { nowMs: Date.parse('2026-11-23T00:00:00.000Z') }), null, 'younger than 14 days: kept');
  assert.equal(reduceIfDue(r, { nowMs: T }), null, 'already reduced');
  const legacy = fin({ finishedAt: undefined }); assert.ok(reduceIfDue(legacy, { nowMs: T, fallbackFinishedMs: T - RETENTION_MS - 1 }));
});
test('retention: open and at-risk records are kept', () => {
  for (const o of [{ done: undefined }, { finalEvidence: undefined }, { b: 'ff'.repeat(32) }, { a: 'ff'.repeat(32) },
    { refundAttempts: [{ state: 'sent', sig: 'x' }] }, { claimAttempts: [{ state: 'persisted' }] }, { provisionalResult: { result: 'completed' }, done: undefined }])
    assert.equal(reduceIfDue(fin(o), { nowMs: T }), null, JSON.stringify(Object.keys(o)));
  assert.equal(isFinished(fin({ refundAttempts: [{ state: 'landed' }] })), true, 'settled attempts do not block');
});
test('retention: a bad clock never touches anything', () => {
  assert.equal(reduceIfDue(fin(), { nowMs: Date.parse('1970-01-02T00:00:00Z') }), null, 'clock before the floor');
  assert.equal(reduceIfDue(fin({ finishedAt: '2027-01-01T00:00:00.000Z' }), { nowMs: T }), null, 'finish time in the future');
  assert.equal(reduceIfDue(fin(), { nowMs: NaN }), null);
  assert.equal(reduceIfDue(fin({ finishedAt: 'garbage' }), { nowMs: T }), null);
  const files = { a: fin({ done: undefined, finalEvidence: undefined }), b: fin({ swapId: 'cd'.repeat(32) }) }; const written = [];
  pruneFinished({ ids: () => ['a', 'b'], load: (i) => files[i], write: (r) => written.push(r.swapId), mtimeMs: () => 0, nowMs: () => 0, log: () => {} });
  assert.deepEqual(written, [], 'clock at zero: nothing pruned, open record kept');
  pruneFinished({ ids: () => ['a', 'b'], load: (i) => files[i], write: (r) => written.push(r.swapId), mtimeMs: () => 0, nowMs: () => T, log: () => {} });
  assert.deepEqual(written, ['cd'.repeat(32)], 'right clock: only the finished one');
  const logs = []; assert.equal(pruneFinished({ ids: () => ['x'], load: () => { throw new Error('bad json'); }, write: () => {}, mtimeMs: () => 0, nowMs: () => T, log: (e) => logs.push(e.event) }), 0); assert.deepEqual(logs, ['retention-error']);
});

// ---- 709-M1: commitments across midnight ----
import { makerReverseStep } from './maker-reverse.mjs';
test('M1: yesterday\'s request funded today counts today; 0.25 + 0.05 funded today leaves no room (0.30 limit), also after a restart', async () => {
  const paid = Array.from({ length: 5 }, () => rec({ committedAt: today, done: 'completed' }));   // 0.25 today
  const stale = rec({ direction: 'sol-xmr', refunder: 'U', createdAt: yesterday });              // asked yesterday, unpaid
  assert.throws(() => admit([...paid, stale], 'new'), /daily-limit-reached/, 'reserved while unpaid: 0.25 + 0.05 + 0.05 > 0.30');
  // the user locks SOL today: the real reverse step stamps the first commitment
  const s = JSON.parse(JSON.stringify(stale));
  await makerReverseStep(s, new Proxy({ readSwapFinalized: async () => ({ t0: 1, t1: 2 }) }, { get: (t, k) => t[k] ?? (() => { throw new Error('stop'); }) })).catch(() => {});
  assert.equal(s.seenPda, true); assert.match(s.committedAt, /^\d{4}-\d\d-\d\dT/);
  s.committedAt = today;   // the stamp is "now"; pin it to the test's today
  const afterRestart = JSON.parse(JSON.stringify(s));   // persisted and read back by a new process
  assert.equal(tally([...paid, afterRestart], { now }).paidTodayAtomic, 6n * X, 'committed today although created yesterday');
  assert.throws(() => admit([...paid, afterRestart], 'new'), /daily-limit-reached/);
  assert.equal(admit([...paid.slice(0, 4), afterRestart], 'new'), true, 'room for exactly one more when only 0.25 is booked');
  // a swap funded yesterday does not count today
  assert.equal(tally([{ ...afterRestart, committedAt: yesterday, done: 'completed' }], { now }).paidTodayAtomic, 0n);
});

// ---- 709-M3: price validation fails closed ----
import { priceSettings, validBand, validMaxAge } from './price-feeds.mjs';
test('709-M3: malformed or unbounded price settings refuse to quote, they never accept anything', async () => {
  for (const bad of [NaN, Infinity, -1, 0, 5, 1e9, '300']) {
    await assert.rejects(createPriceCheck({ bandBps: bad, fetchers: [async () => ({ xmrUsd: 1, solUsd: 1 }), async () => ({ xmrUsd: 100, solUsd: 1 })] })(), /price-config-invalid/, `band ${bad}`);
  }
  for (const bad of [NaN, Infinity, 0, -5, 1e9, 5]) await assert.rejects(coingeckoPrice({ fetcher: cg(300, 150), nowS: () => 1_000_000, maxAgeS: bad }), /price-config-invalid/, `age ${bad}`);
  assert.deepEqual([validBand(300), validBand(Infinity), validMaxAge(300), validMaxAge(NaN)], [true, false, true, false]);
  assert.deepEqual(priceSettings({}), { bandBps: 300, maxAgeS: 300 });
  const env = priceSettings({ PRICE_BAND_BPS: 'Infinity', PRICE_MAX_AGE_S: 'abc' }); assert.equal(validBand(env.bandBps), false); assert.equal(validMaxAge(env.maxAgeS), false);
  assert.equal(validBand(priceSettings({ PRICE_BAND_BPS: '' }).bandBps), false, 'an empty setting is invalid, not zero-means-default');
});
test('709-M3: a CoinGecko timestamp from the future is stale, small clock skew is tolerated', async () => {
  const at = (skew) => coingeckoPrice({ fetcher: cg(300, 150, -skew), nowS: () => 1_000_000 });
  await assert.rejects(at(3600), /price-stale/); await assert.rejects(at(61), /price-stale/);
  assert.ok((await at(30)).xmrUsd === 300, '30 s ahead is within skew'); assert.ok((await at(0)).xmrUsd === 300);
});
