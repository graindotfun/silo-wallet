// Open maker endpoint, 11 Nov 2026: the two lanes (token / public), their isolation, the public lane's bounds, and the small handoff fixes
// (path-free status error, refund timing in quotes, readySeenAt, build hash, health). Loopback only; throwaway keys in temp directories;
// the price source is never reached (PRICE_BAND_BPS is set invalid on purpose, which refuses before any request leaves the process).
import test from 'node:test'; import assert from 'node:assert/strict';
import net from 'node:net'; import { spawn } from 'node:child_process'; import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'; import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { Keypair } from '@solana/web3.js';
import { parseLaneConfig, laneHealth, laneOf, laneRecords, laneCaps, laneAdmission, tokenHoldback, publicReserved, createBucket, createSourceLimiter, pruneQuotes, countLane, createQuoteStore, publicRoute, publicSwapView, publicOutcome, PUBLIC_OUTCOME, corsHeaders, BUILD_HASH } from './maker-lanes.mjs';
import { capsAdmission } from './maker-reverse.mjs';
import { limitInputs, unpaidCaps } from './maker-limits.mjs';
import { makerReverseStep } from './maker-reverse.mjs';
import { reduceIfDue } from './maker-retention.mjs';
import { reverseTimelocks } from '../client/reverse-core.mjs';

const XMR = (x) => BigInt(Math.round(x * 1e12));
const TOTAL = { min: XMR(0.001), perSwap: XMR(0.05), perDay: XMR(0.3), open: 3 };
const ON = { MAKER_PUBLIC_LANE: 'true' };
const now = new Date('2026-11-11T12:00:00.000Z'), today = '2026-11-11T09:00:00.000Z';
let n = 0;
const rec = (o = {}) => ({ swapId: (++n).toString(16).padStart(64, '0'), xmrAtomic: XMR(0.01).toString(), createdAt: today, claimer: Keypair.generate().publicKey.toBase58(), lamports: 1, solLocked: true, ...o });
const paid = (o = {}) => rec({ committedAt: today, done: 'completed', ...o });
const isOpenCounted = (s) => !s.done;
const baseCaps = { minAtomic: TOTAL.min, maxPerSwapAtomic: TOTAL.perSwap, maxPerDayAtomic: TOTAL.perDay, maxOpen: TOTAL.open, reserveAtomic: 0n, ...unpaidCaps({}) };
const PUB = parseLaneConfig(ON, TOTAL);
const admit = (lane, records, x = 0.01, pub = PUB, requester = null) => laneAdmission({ lane, xmrAtomic: XMR(x), requester, records, isOpenCounted, base: baseCaps, pub, now });

// ---------- configuration ----------
test('config: off by default and for "false"; any other value for the flag stops the start', () => {
  assert.deepEqual(parseLaneConfig({}, TOTAL), { enabled: false }); assert.deepEqual(parseLaneConfig({ MAKER_PUBLIC_LANE: 'false' }, TOTAL), { enabled: false });
  assert.deepEqual(parseLaneConfig({ MAKER_PUBLIC_LANE: '', MAKER_PUBLIC_MAX_OPEN: '-4' }, TOTAL), { enabled: false }, 'nothing else is read while off');
  for (const v of ['1', 'yes', 'TRUE', 'on']) assert.throws(() => parseLaneConfig({ MAKER_PUBLIC_LANE: v }, TOTAL), /MAKER_PUBLIC_LANE/);
});
test('config: defaults are small and sit inside the totals (1 open, 0.01 per swap, 0.03 per day)', () => {
  assert.equal(PUB.enabled, true); assert.equal(PUB.maxOpen, 1); assert.equal(PUB.maxPerSwap, XMR(0.01)); assert.equal(PUB.maxPerDay, XMR(0.03)); assert.equal(PUB.floatXmr, XMR(0.01));
  assert.equal(PUB.cors, null); assert.equal(PUB.perSource, 0); assert.equal(PUB.sourceHeader, '');
  assert.ok(PUB.maxPerSwap <= TOTAL.perSwap && PUB.maxPerDay < TOTAL.perDay && PUB.maxOpen < TOTAL.open);
});
test('config: nonsense is refused (negative, NaN, empty number, exponent, zero, above the totals, no token lane left)', () => {
  const bad = (env, re) => assert.throws(() => parseLaneConfig({ ...ON, ...env }, TOTAL), re, JSON.stringify(env));
  bad({ MAKER_PUBLIC_MAX_OPEN: '-1' }, /MAKER_PUBLIC_MAX_OPEN/); bad({ MAKER_PUBLIC_MAX_OPEN: 'NaN' }, /MAKER_PUBLIC_MAX_OPEN/); bad({ MAKER_PUBLIC_MAX_OPEN: '0' }, /MAKER_PUBLIC_MAX_OPEN/);
  bad({ MAKER_PUBLIC_MAX_OPEN: '3' }, /MAKER_PUBLIC_MAX_OPEN/);   // equal to the total would leave the token lane nothing
  bad({ MAKER_PUBLIC_MAX_XMR_PER_SWAP: '-0.01' }, /PER_SWAP/); bad({ MAKER_PUBLIC_MAX_XMR_PER_SWAP: 'NaN' }, /PER_SWAP/); bad({ MAKER_PUBLIC_MAX_XMR_PER_SWAP: '1e-2' }, /PER_SWAP/); bad({ MAKER_PUBLIC_MAX_XMR_PER_SWAP: '0' }, /PER_SWAP/);
  bad({ MAKER_PUBLIC_MAX_XMR_PER_SWAP: '0.06' }, /above MAX_XMR_PER_SWAP/); bad({ MAKER_PUBLIC_MAX_XMR_PER_SWAP: '0.0001' }, /below MIN/);
  bad({ MAKER_PUBLIC_MAX_XMR_PER_DAY: '0.3' }, /below MAX_XMR_PER_DAY/); bad({ MAKER_PUBLIC_MAX_XMR_PER_DAY: '0.4' }, /below MAX_XMR_PER_DAY/); bad({ MAKER_PUBLIC_MAX_XMR_PER_DAY: '0.005' }, /below the per swap/);
  bad({ MAKER_PUBLIC_MAX_FLOAT_XMR: '0.001' }, /FLOAT/); bad({ MAKER_PUBLIC_MAX_FLOAT_XMR: '-1' }, /FLOAT/);
  bad({ MAKER_PUBLIC_RATE_QUOTE_PER_MIN: '0' }, /RATE_QUOTE/); bad({ MAKER_PUBLIC_RATE_SWAP_BURST: '9999' }, /RATE_SWAP/); bad({ MAKER_PUBLIC_MAX_BODY: '99999' }, /MAX_BODY/); bad({ MAKER_PUBLIC_MAX_CONCURRENT: '0' }, /CONCURRENT/);
  bad({ MAKER_PUBLIC_RATE_PER_SOURCE_PER_MIN: '5' }, /needs MAKER_PUBLIC_SOURCE_HEADER/); bad({ MAKER_PUBLIC_SOURCE_HEADER: 'bad header!' }, /header name/);
  bad({ MAKER_PUBLIC_CORS_ORIGIN: 'not a url' }, /CORS/); bad({ MAKER_PUBLIC_CORS_ORIGIN: 'https://a.example/path' }, /CORS/); bad({ MAKER_PUBLIC_CORS_ORIGIN: 'ftp://a.example' }, /CORS/);
  assert.throws(() => parseLaneConfig(ON, { ...TOTAL, open: 1 }), /at least 2/);
  assert.equal(parseLaneConfig({ ...ON, MAKER_PUBLIC_CORS_ORIGIN: 'https://wallet.example' }, TOTAL).cors, 'https://wallet.example');
  assert.equal(parseLaneConfig({ ...ON, MAKER_PUBLIC_SOURCE_HEADER: 'X-Real-Ip', MAKER_PUBLIC_RATE_PER_SOURCE_PER_MIN: '6' }, TOTAL).sourceHeader, 'x-real-ip');
  assert.equal(parseLaneConfig({ ...ON, MAKER_PUBLIC_SOURCE_HEADER: 'x-real-ip' }, TOTAL).sourceHeader, '', 'a header alone does nothing: the per source limit is off unless it has a value');
  assert.ok(BUILD_HASH.test(`sha256:${'a'.repeat(64)}`) && !BUILD_HASH.test('sha256:abc') && !BUILD_HASH.test(`SHA256:${'a'.repeat(64)}`));
});
test('health: lane report lists the public caps and what the token lane keeps', () => {
  const h = laneHealth(PUB, { open: 3, perDay: XMR(0.3) });
  assert.deepEqual(h, { enabled: true, maxOpenSwaps: 1, maxXmrPerSwap: '0.010000000000', maxXmrPerDay: '0.030000000000', maxFloatXmr: '0.010000000000', tokenLaneOpenSwaps: 2, tokenLaneXmrPerDay: '0.270000000000' });
});

// ---------- lane off is today's behaviour ----------
test('lane off: admission equals the old capsAdmission over the whole record set, success and failure alike', () => {
  const off = { enabled: false };
  const sets = [[], [rec()], [rec(), rec(), rec()], [paid(), paid(), paid(), paid(), paid(), paid()], [rec({ lane: 'public' }), rec({ lane: 'public' }), rec()], Array.from({ length: 48 }, () => rec({ done: 'refunded' })), [paid({ xmrAtomic: XMR(0.05).toString() }), paid({ xmrAtomic: XMR(0.05).toString() }), paid({ xmrAtomic: XMR(0.05).toString() }), paid({ xmrAtomic: XMR(0.05).toString() }), paid({ xmrAtomic: XMR(0.05).toString() })]];
  const old = (records, x, requester) => { const l = limitInputs(records, requester, { now, isOpenCounted }); return capsAdmission({ xmrAtomic: XMR(x), openCount: records.filter(isOpenCounted).length, lockedTodayAtomic: l.lockedTodayAtomic, unpaid: l.unpaid, caps: baseCaps }); };
  const run = (f) => { try { return { ok: f() }; } catch (e) { return { err: e.message }; } };
  for (const records of sets) for (const x of [0.001, 0.01, 0.05, 0.06]) for (const lane of ['token', 'public']) assert.deepEqual(run(() => admit(lane, records, x, off)), run(() => old(records, x)), `${records.length} records, ${x}, ${lane}`);
  assert.equal(laneCaps('token', baseCaps, off), baseCaps); assert.equal(tokenHoldback([rec({ lane: 'public' })], off, isOpenCounted), 0n); assert.equal(laneRecords([1, 2], 'token', false).length, 2);
  assert.deepEqual(corsHeaders(off), {});
});

// ---------- isolation ----------
test('isolation, open slots: a full public lane does not refuse a token swap, and a full token lane does not refuse a public one', () => {
  const publicFull = [rec({ lane: 'public' })];
  assert.throws(() => admit('public', publicFull), /busy-try-later/);
  assert.equal(admit('token', publicFull), true); assert.equal(admit('token', [...publicFull, rec({ lane: 'token' })]), true, 'the token lane keeps its two slots');
  assert.throws(() => admit('token', [...publicFull, rec({ lane: 'token' }), rec({ lane: 'token' })]), /busy-try-later/, 'its share is the total minus the public slot, never more');
  const tokenFull = [rec({ lane: 'token' }), rec(), rec({ lane: 'token' })];   // a record with no lane is a token record (written before the lanes existed)
  assert.throws(() => admit('token', tokenFull), /busy-try-later/);
  assert.equal(admit('public', tokenFull), true);
  assert.ok(2 + 1 <= TOTAL.open, 'both shares together never exceed the maker total');
});
test('isolation, daily amount: public volume never uses the token amount and the reverse', () => {
  const publicDay = [paid({ lane: 'public' }), paid({ lane: 'public' }), paid({ lane: 'public' })];   // 0.03 = the public daily amount
  assert.throws(() => admit('public', publicDay), /daily-limit-reached/); assert.equal(admit('token', publicDay), true);
  const big = XMR(0.05).toString(), tokenDay = [...Array.from({ length: 5 }, () => paid({ xmrAtomic: big })), paid({ xmrAtomic: XMR(0.02).toString() })];   // 0.27 = the token daily amount
  assert.throws(() => admit('token', tokenDay), /daily-limit-reached/); assert.equal(admit('public', tokenDay), true);
});
test('isolation, unpaid counters: public unpaid requests never use the token lane unpaid counters', () => {
  const publicUnpaid = Array.from({ length: 30 }, () => rec({ lane: 'public', done: 'refunded' }));   // 24 a day is the public limit
  assert.throws(() => admit('public', publicUnpaid), /unpaid-limit-reached/); assert.equal(admit('token', publicUnpaid), true);
  const mine = Keypair.generate().publicKey.toBase58();
  assert.throws(() => admit('public', [rec({ lane: 'public', claimer: mine })], 0.01, { ...PUB, maxOpen: 2 }, mine), /address-has-open-swap/);
  assert.equal(admit('token', [rec({ lane: 'public', claimer: mine })], 0.01, PUB, mine), true, 'the same address in the other lane is a different count');
});
test('isolation, float: the public lane is bounded by its float, the token lane cannot use the unused part, both directions in XMR terms', () => {
  const pub2 = parseLaneConfig({ ...ON, MAKER_PUBLIC_MAX_OPEN: '2', MAKER_PUBLIC_MAX_XMR_PER_SWAP: '0.02', MAKER_PUBLIC_MAX_XMR_PER_DAY: '0.1', MAKER_PUBLIC_MAX_FLOAT_XMR: '0.03' }, TOTAL);
  const one = [rec({ lane: 'public', xmrAtomic: XMR(0.02).toString() })];
  assert.equal(publicReserved(one, isOpenCounted), XMR(0.02));
  assert.equal(admit('public', one, 0.01, pub2), true); assert.throws(() => admit('public', one, 0.011, pub2), /busy-try-later/, '0.02 + 0.011 is above the 0.03 float');
  assert.equal(admit('token', one, 0.05, pub2), true, 'a full public float does not refuse the token lane');
  assert.equal(tokenHoldback([], pub2, isOpenCounted), XMR(0.03), 'unused public float is held back from the token lane');
  assert.equal(tokenHoldback(one, pub2, isOpenCounted), XMR(0.01), 'the part in use is already counted as open, so only the rest is held');
  assert.equal(tokenHoldback([rec({ lane: 'public', xmrAtomic: XMR(0.02).toString() }), rec({ lane: 'public', xmrAtomic: XMR(0.02).toString() })], pub2, isOpenCounted), 0n);
  assert.equal(tokenHoldback([rec({ lane: 'token', xmrAtomic: XMR(0.05).toString() })], pub2, isOpenCounted), XMR(0.03), 'token swaps never reduce the public float');
  assert.equal(publicReserved([rec({ lane: 'public', done: 'refunded' })], isOpenCounted), 0n, 'a finished swap frees its float');
});
test('a stalled public registration frees its slot when the swap record is done (the protocol deadline), not before and not later', () => {
  const stalled = rec({ lane: 'public' });
  assert.throws(() => admit('public', [stalled]), /busy-try-later/);
  assert.equal(admit('public', [{ ...stalled, done: 'not-locked' }]), true, 'SOL to XMR: closed as not-locked after quote expiry plus LOCK_WAIT');
  assert.equal(admit('public', [{ ...stalled, done: 'refunded' }]), true, 'XMR to SOL: the maker refunds its own lock when no XMR comes');
});
test('the lane of a record: public only when marked, everything else (including old records) is token', () => {
  assert.equal(laneOf({ lane: 'public' }), 'public'); assert.equal(laneOf({}), 'token'); assert.equal(laneOf({ lane: 'token' }), 'token'); assert.equal(laneOf({ lane: 'admin' }), 'token'); assert.equal(laneOf(null), 'token');
  assert.equal(reduceIfDue({ swapId: 's', direction: 'xmr-sol', lane: 'public', done: 'completed', finishedAt: '2026-10-20T00:00:00.000Z', finalEvidence: { finalizedSlot: 1 }, xmrAtomic: '5', createdAt: today }, { nowMs: Date.parse('2026-11-11T00:00:00Z') }).lane, 'public', 'the lane survives the 14 day reduction');
  assert.equal('lane' in reduceIfDue({ swapId: 's', done: 'completed', finishedAt: '2026-10-20T00:00:00.000Z', finalEvidence: { finalizedSlot: 1 }, xmrAtomic: '5', createdAt: today }, { nowMs: Date.parse('2026-11-11T00:00:00Z') }), false, 'a token record is reduced exactly as before');
});

// ---------- bounds ----------
test('rate limit: a bucket allows its burst, refuses with a wait time, and refills with the clock', () => {
  let t = 0; const b = createBucket({ perMin: 6, burst: 2, now: () => t });
  assert.equal(b.take().ok, true); assert.equal(b.take().ok, true); const no = b.take(); assert.equal(no.ok, false); assert.ok(no.retryAfterS >= 1 && no.retryAfterS <= 10);
  t += 10_000; assert.equal(b.take().ok, true); assert.equal(b.take().ok, false); t += 3_600_000; assert.equal(b.take().ok, true); assert.equal(b.take().ok, true); assert.equal(b.take().ok, false, 'never above the burst');
});
test('per source limit: separate buckets per hashed source, the last entry of the header is used, memory is bounded, a missing header shares one bucket', () => {
  let t = 0; const l = createSourceLimiter({ header: 'x-real-ip', perMin: 1, now: () => t, max: 3 });
  assert.equal(l.take({ 'x-real-ip': '203.0.113.1' }).ok, true); assert.equal(l.take({ 'x-real-ip': '203.0.113.1' }).ok, false); assert.equal(l.take({ 'x-real-ip': '203.0.113.2' }).ok, true);
  assert.equal(l.take({ 'x-real-ip': 'spoofed, 203.0.113.1' }).ok, false, 'a client-added leading entry changes nothing: the proxy-added last one counts');
  for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']) l.take({ 'x-real-ip': ip }); assert.ok(l.size() <= 3);
  assert.equal(l.take({}).ok, true); assert.equal(l.take({}).ok, false);
});
test('quote pruning: expired quotes (and the secrets in them) are dropped, live ones kept; the public count is per lane', () => {
  const m = new Map([['a', { expiresAt: 100, a: 'secret', lane: 'public' }], ['b', { expiresAt: 200, lane: 'public' }], ['c', { expiresAt: 300 }], ['d', { expiresAt: 99, lane: 'token' }]]);
  assert.equal(countLane(m, 'public'), 2); assert.equal(pruneQuotes(m, 150), 2); assert.deepEqual([...m.keys()], ['b', 'c']); assert.equal(countLane(m, 'public'), 1); assert.equal(countLane(m, 'token'), 1); assert.equal(pruneQuotes(m, 150), 0);
});
test('routes and status view: the public lane serves four POST routes and one GET; the view has no Monero address, no tx id, no user address', () => {
  assert.deepEqual(['/v1/quote', '/v1/swap', '/v1/rev/quote', '/v1/rev/swap'].map((u) => publicRoute('POST', u)), ['quote', 'swap', 'quote', 'swap']);
  assert.equal(publicRoute('GET', `/v1/swap/${'a'.repeat(64)}`), 'status'); for (const u of ['/v1/status', '/v1/health', `/v1/swap/${'a'.repeat(63)}`, `/v1/swap/${'A'.repeat(64)}`, `/v1/swap/${'a'.repeat(64)}?x=1`, '/v1/swap/../x']) assert.equal(publicRoute('GET', u), null, u);
  assert.equal(publicRoute('POST', '/v1/status'), null); assert.equal(publicRoute('GET', '/v1/quote'), null); assert.equal(publicRoute('DELETE', '/v1/swap'), null);
  const v = publicSwapView({ swapId: 's', direction: 'sol-xmr', jointAddress: 'J', xmrSendTxid: 'T', refunder: 'R', claimer: 'C', v: 'VIEW', b: 'B', a: 'A', lockSig: 'l', readySig: 'r', claimSig: 'c', done: 'completed' });
  assert.deepEqual(v, { swapId: 's', direction: 'sol-xmr', lockSig: 'l', readySig: 'r', refundSig: null, claimSig: 'c', state: 'finished' }); assert.doesNotMatch(JSON.stringify(v), /"J"|"T"|"R"|"C"|VIEW/);
});
test('cors: only when configured, never the Authorization header', () => {
  assert.deepEqual(corsHeaders(PUB), {}); const c = parseLaneConfig({ ...ON, MAKER_PUBLIC_CORS_ORIGIN: 'https://w.example' }, TOTAL);
  assert.deepEqual(corsHeaders(c), { 'access-control-allow-origin': 'https://w.example', vary: 'Origin' });
  const pre = corsHeaders(c, true); assert.equal(pre['access-control-allow-headers'], 'content-type'); assert.doesNotMatch(JSON.stringify(pre), /authorization/i);
  assert.equal(corsHeaders(parseLaneConfig({ ...ON, MAKER_PUBLIC_CORS_ORIGIN: '*' }, TOTAL))['access-control-allow-origin'], '*');
});

// ---------- readySeenAt ----------
test('readySeenAt: set once at the earliest read with ready true, never moved, never set earlier', async () => {
  const { t0, t1 } = reverseTimelocks(1_800_000_000);
  const pda = (ready) => ({ ready, claimCommittedAt: 0, t0, t1, lamports: 7, claimPoint: 'aa', refundPoint: 'bb', claimer: 'maker', refunder: 'user' });
  const stored = []; let swap = pda(false), clock = 1_800_000_060;
  const d = { readSwapFinalized: async () => swap, chainNow: async () => clock, scanXmr: async () => null, readRevealed: async () => null, store: (s) => stored.push(JSON.parse(JSON.stringify(s))), log: () => {}, sendAllowed: () => false, proveFinal: async () => ({ final: false }) };
  const s = { swapId: 'ab', A: 'aa', B: 'bb', claimer: 'maker', refunder: 'user', lamports: 7, t0, t1, xmrAtomic: '50000000000', userProofOk: true, quoteExpiresAt: 1_800_000_120 };
  await makerReverseStep(s, d); assert.equal(s.readySeenAt, undefined, 'locked but not ready: nothing recorded'); assert.equal(s.seenPda, true);
  swap = pda(true); await makerReverseStep(s, d); const first = s.readySeenAt; assert.match(first, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/); assert.equal(stored.at(-1).readySeenAt, first, 'stored in the same pass');
  await new Promise((r) => setTimeout(r, 15)); await makerReverseStep(s, d); assert.equal(s.readySeenAt, first, 'the second read does not move it');
});

// ---------- the real maker process ----------
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function startMaker(t, env = {}, seed = () => {}) {
  const state = mkdtempSync(join(tmpdir(), 'maker-lanes-')); mkdirSync(join(state, 'swaps'));
  writeFileSync(join(state, 'maker-sol.json'), JSON.stringify([...Keypair.generate().secretKey])); writeFileSync(join(state, 'wallet-password'), 'test-only');   // throwaway test key
  seed(state);
  const token = 't'.repeat(48), port = await freePort();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./maker.mjs', import.meta.url))], { env: { PATH: process.env.PATH, MAKER_STATE: state, MAKER_PORT: String(port), MAKER_API_TOKEN: token, XMR_NETWORK: 'stagenet', SOL_RPC: 'http://127.0.0.1:9', MAKER_WALLET_RPC: 'http://127.0.0.1:9/json_rpc', XMR_DAEMON: 'http://127.0.0.1:9/json_rpc', LOOP_MS: '3600000', PRICE_BAND_BPS: '', ...env }, stdio: 'ignore' });
  t.after(() => { child.kill(); rmSync(state, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) { try { await fetch(`${url}/v1/health`); break; } catch { await sleep(50); } }
  const call = async (method, path, { body, auth = false, headers = {} } = {}) => { const r = await fetch(`${url}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(auth ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {} return { status: r.status, json, text, headers: r.headers }; };
  return { url, state, token, port, call, child };
}
const writeRec = (state, s) => writeFileSync(join(state, 'swaps', `${s.swapId}.json`), JSON.stringify(s));
const ROUTES = [['POST', '/v1/quote', { xmr: 0.01 }], ['POST', '/v1/swap', { quoteId: 'x' }], ['POST', '/v1/rev/quote', { xmr: 0.01 }], ['POST', '/v1/rev/swap', { quoteId: 'x' }]];

test('process, lane off: no token means 401 on every POST, status, lookups and unknown paths; health has today\'s keys; options and cors do nothing', async (t) => {
  const m = await startMaker(t);
  for (const [method, path, body] of ROUTES) assert.deepEqual([(await m.call(method, path, { body })).status, (await m.call(method, path, { body })).json], [401, { error: 'unauthorized' }], path);
  for (const p of ['/v1/status', `/v1/swap/${'a'.repeat(64)}`, '/v1/does-not-exist']) assert.equal((await m.call('GET', p)).status, 401, p);
  assert.equal((await m.call('OPTIONS', '/v1/quote')).status, 401);
  assert.equal((await m.call('POST', '/v1/quote', { body: { xmr: 0.01 }, headers: { authorization: 'Bearer wrong' } })).status, 401);
  const h = await m.call('GET', '/v1/health'); assert.equal(h.status, 200); assert.deepEqual(Object.keys(h.json), ['ok', 'accepting', 'maker', 'limits', 'solXmr']); assert.equal(h.headers.get('access-control-allow-origin'), null);
  const q = await m.call('POST', '/v1/quote', { auth: true, body: { xmr: 5 } }); assert.deepEqual([q.status, q.json], [400, { error: 'amount-outside-limits' }], 'the token lane works as before');
  assert.equal((await m.call('GET', '/v1/status', { auth: true })).status, 200);
});
test('process, lane off: a public-looking env value changes nothing, and a record marked public counts in the one pool', async (t) => {
  const m = await startMaker(t, { MAKER_PUBLIC_MAX_OPEN: '1', MAKER_PUBLIC_CORS_ORIGIN: '*' }, (s) => { for (const lane of ['public', 'token', undefined]) writeRec(s, rec({ lane })); });
  assert.equal((await m.call('POST', '/v1/quote', { body: { xmr: 0.01 } })).status, 401);
  const q = await m.call('POST', '/v1/quote', { auth: true, body: { xmr: 0.01 } }); assert.deepEqual(q.json, { error: 'busy-try-later' }, 'three open records fill the one pool of three');
});
test('process, lane on: public routes work without a token, status stays token only, a wrong token is still 401, unknown paths are 404', async (t) => {
  const m = await startMaker(t, ON);
  const q = await m.call('POST', '/v1/quote', { body: { xmr: 5 } }); assert.deepEqual([q.status, q.json], [400, { error: 'amount-outside-limits' }], 'the public lane is served');
  const q2 = await m.call('POST', '/v1/quote', { body: { xmr: 0.01 } }); assert.deepEqual(q2.json, { error: 'price-config-invalid' }, 'a public quote passes the capacity gates and stops at the price check (no price source is reached)');
  for (const [method, path, body] of ROUTES) assert.notEqual((await m.call(method, path, { body })).status, 401, path);
  assert.equal((await m.call('GET', '/v1/status')).status, 401); assert.equal((await m.call('GET', '/v1/status', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await m.call('POST', '/v1/quote', { body: { xmr: 0.01 }, headers: { authorization: 'Bearer wrong' } })).status, 401, 'a stale token does not fall through to the public lane');
  assert.equal((await m.call('GET', '/v1/does-not-exist')).status, 404); assert.equal((await m.call('POST', '/v1/nothing', { body: {} })).status, 404);
  const s = await m.call('GET', '/v1/status', { auth: true }); assert.equal(s.status, 200); assert.equal(s.json.network, 'stagenet');
  assert.equal((await m.call('POST', '/v1/quote', { auth: true, body: { xmr: 5 } })).status, 400, 'the token lane still answers');
});
test('process, lane on: health reports the lane and its caps; build hash only from the environment and only when well formed', async (t) => {
  const hash = `sha256:${'ab'.repeat(32)}`, m = await startMaker(t, { ...ON, MAKER_BUILD_HASH: hash });
  const h = (await m.call('GET', '/v1/health')).json; assert.equal(h.buildHash, hash); assert.equal(h.publicLane.enabled, true); assert.equal(h.publicLane.maxOpenSwaps, 1); assert.equal(h.publicLane.maxXmrPerSwap, '0.010000000000'); assert.equal(h.publicLane.tokenLaneOpenSwaps, 2);
  assert.equal(h.limits.maxOpenSwaps, 3, 'limits stays the maker total');
  const none = (await (await startMaker(t, ON)).call('GET', '/v1/health')).json; assert.equal('buildHash' in none, false);
  const off = (await (await startMaker(t, { MAKER_BUILD_HASH: hash })).call('GET', '/v1/health')).json; assert.equal(off.buildHash, hash); assert.equal('publicLane' in off, false);
});
test('process: nonsense configuration stops the start with a short message (lane values and build hash)', async () => {
  const run = (env) => new Promise((res) => {
    const state = mkdtempSync(join(tmpdir(), 'maker-lanes-')); mkdirSync(join(state, 'swaps')); writeFileSync(join(state, 'maker-sol.json'), JSON.stringify([...Keypair.generate().secretKey])); writeFileSync(join(state, 'wallet-password'), 'x');
    const c = spawn(process.execPath, [fileURLToPath(new URL('./maker.mjs', import.meta.url))], { env: { PATH: process.env.PATH, MAKER_STATE: state, MAKER_PORT: '1', XMR_NETWORK: 'stagenet', ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; c.stderr.on('data', (d) => { err += d; }); c.on('close', (code) => { rmSync(state, { recursive: true, force: true }); res({ code, err }); });
  });
  for (const [env, re] of [[{ ...ON, MAKER_PUBLIC_MAX_XMR_PER_SWAP: '0.5' }, /above MAX_XMR_PER_SWAP/], [{ ...ON, MAKER_PUBLIC_MAX_OPEN: '-1' }, /MAKER_PUBLIC_MAX_OPEN/], [{ ...ON, MAKER_PUBLIC_MAX_XMR_PER_DAY: 'NaN' }, /PER_DAY/], [{ MAKER_BUILD_HASH: 'sha256:short' }, /MAKER_BUILD_HASH/]]) {
    const r = await run(env); assert.notEqual(r.code, 0, JSON.stringify(env)); assert.match(r.err, re);
  }
});
test('process, isolation: a full public lane refuses only public quotes, a full token lane refuses only token quotes (open slots and daily amount)', async (t) => {
  const open = (s) => writeRec(s, rec({ lane: 'public' }));
  const a = await startMaker(t, ON, open);
  assert.deepEqual((await a.call('POST', '/v1/quote', { body: { xmr: 0.01 } })).json, { error: 'busy-try-later' }, 'public full');
  assert.deepEqual((await a.call('POST', '/v1/quote', { auth: true, body: { xmr: 0.01 } })).json, { error: 'price-config-invalid' }, 'token lane still passes the gates');
  const b = await startMaker(t, ON, (s) => { writeRec(s, rec({ lane: 'token' })); writeRec(s, rec()); });
  assert.deepEqual((await b.call('POST', '/v1/quote', { auth: true, body: { xmr: 0.01 } })).json, { error: 'busy-try-later' }, 'token full: its share is 2 of 3');
  assert.deepEqual((await b.call('POST', '/v1/quote', { body: { xmr: 0.01 } })).json, { error: 'price-config-invalid' }, 'public lane still passes the gates');
  const big = XMR(0.05).toString();
  const c = await startMaker(t, ON, (s) => { for (let i = 0; i < 5; i++) writeRec(s, paid({ xmrAtomic: big })); writeRec(s, paid({ xmrAtomic: XMR(0.02).toString() })); });
  assert.deepEqual((await c.call('POST', '/v1/quote', { auth: true, body: { xmr: 0.01 } })).json, { error: 'daily-limit-reached' }, 'token daily amount used');
  assert.deepEqual((await c.call('POST', '/v1/quote', { body: { xmr: 0.01 } })).json, { error: 'price-config-invalid' });
  const d = await startMaker(t, ON, (s) => { for (let i = 0; i < 3; i++) writeRec(s, paid({ lane: 'public' })); });
  assert.deepEqual((await d.call('POST', '/v1/quote', { body: { xmr: 0.01 } })).json, { error: 'daily-limit-reached' }, 'public daily amount used');
  assert.deepEqual((await d.call('POST', '/v1/quote', { auth: true, body: { xmr: 0.01 } })).json, { error: 'price-config-invalid' });
  assert.deepEqual((await d.call('POST', '/v1/quote', { body: { xmr: 0.05 } })).json, { error: 'amount-outside-limits' }, 'the public per swap maximum is its own (0.01)');
});
test('process: a quote from one lane cannot be used in the other; the lane in a request body is ignored', async (t) => {
  const m = await startMaker(t, ON);
  assert.deepEqual((await m.call('POST', '/v1/swap', { body: { quoteId: 'z'.repeat(32), lane: 'token' } })).json, { error: 'quote-expired' });
  assert.deepEqual((await m.call('POST', '/v1/quote', { body: { xmr: 0.05, lane: 'token' } })).json, { error: 'amount-outside-limits' }, 'claiming lane token in the body does not raise the public maximum');
});
test('process: the status lookup never shows the state path; the public lane sees only public swaps, reduced; the token lane sees the full lookup', async (t) => {
  const pubId = 'a'.repeat(64), tokId = 'b'.repeat(64), unk = 'c'.repeat(64);
  const m = await startMaker(t, ON, (s) => { writeRec(s, { swapId: pubId, lane: 'public', direction: 'sol-xmr', jointAddress: 'JOINTADDR', xmrSendTxid: 'TXID', lockSig: 'L', done: null, createdAt: today, xmrAtomic: '1' }); writeRec(s, { swapId: tokId, jointAddress: 'JOINTADDR2', createdAt: today, xmrAtomic: '1' }); });
  for (const auth of [false, true]) { const r = await m.call('GET', `/v1/swap/${unk}`, { auth }); assert.deepEqual([r.status, r.json], [404, { error: 'not-found' }]); assert.ok(!r.text.includes(m.state) && !r.text.includes('ENOENT') && !r.text.includes('/'), `no path: ${r.text}`); }
  const pub = await m.call('GET', `/v1/swap/${pubId}`); assert.equal(pub.status, 200); assert.equal(pub.json.swapId, pubId); assert.ok(!('xmrSent' in pub.json) && !pub.text.includes('xmrSent'), 'Sol M3: the public route does not say whether the maker sent XMR'); assert.deepEqual(Object.keys(pub.json).sort(), ['claimSig', 'direction', 'lockSig', 'readySig', 'refundSig', 'state', 'swapId']); assert.ok(!('jointAddress' in pub.json) && !('xmrSendTxid' in pub.json)); assert.ok(!pub.text.includes('JOINTADDR') && !pub.text.includes('TXID'));
  assert.equal((await m.call('GET', `/v1/swap/${tokId}`)).status, 404, 'a token lane swap is not visible on the public route');
  const full = await m.call('GET', `/v1/swap/${tokId}`, { auth: true }); assert.equal(full.json.jointAddress, 'JOINTADDR2');
  assert.equal((await m.call('GET', '/v1/swap/xyz')).status, 404);
  writeFileSync(join(m.state, 'swaps', `${'d'.repeat(64)}.json`), '{ not json');
  const bad = await m.call('GET', `/v1/swap/${'d'.repeat(64)}`, { auth: true }); assert.deepEqual(bad.json, { error: 'unreadable' }); assert.ok(!bad.text.includes(m.state));
});
test('process: public errors are short codes only; a body above the public limit is refused while the token lane keeps 8192', async (t) => {
  const m = await startMaker(t, ON);
  const junk = await m.call('POST', '/v1/quote', { body: '{ "xmr": ' }); assert.deepEqual(junk.json, { error: 'bad-request' });
  const none = await m.call('POST', '/v1/quote', { body: 'null' }); assert.equal(none.status, 400); assert.match(none.json.error, /^[a-z][a-z0-9-]{1,48}$/);
  const big = JSON.stringify({ xmr: 0.01, pad: 'x'.repeat(5000) });
  assert.deepEqual((await m.call('POST', '/v1/quote', { body: big })).json, { error: 'too-large' });
  assert.deepEqual((await m.call('POST', '/v1/quote', { auth: true, body: big })).json, { error: 'price-config-invalid' }, 'the token lane limit is unchanged');
  assert.deepEqual((await m.call('POST', '/v1/quote', { auth: true, body: JSON.stringify({ xmr: 0.01, pad: 'x'.repeat(9000) }) })).json, { error: 'too-large' });
});
test('process: the public routes have their own rate limits per route; the token lane is not limited by them', async (t) => {
  const m = await startMaker(t, { ...ON, MAKER_PUBLIC_RATE_QUOTE_PER_MIN: '1', MAKER_PUBLIC_RATE_QUOTE_BURST: '2' });
  const codes = []; for (let i = 0; i < 4; i++) codes.push((await m.call('POST', '/v1/quote', { body: { xmr: 5 } })).status);
  assert.deepEqual(codes, [400, 400, 429, 429]);
  const r = await m.call('POST', '/v1/rev/quote', { body: { xmr: 5 } }); assert.equal(r.status, 429, 'both quote routes share the quote bucket'); assert.deepEqual(r.json, { error: 'rate-limited' }); assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.equal((await m.call('POST', '/v1/swap', { body: { quoteId: 'x' } })).status, 400, 'the swap routes have their own bucket');
  for (let i = 0; i < 6; i++) assert.equal((await m.call('POST', '/v1/quote', { auth: true, body: { xmr: 5 } })).status, 400);
  assert.equal((await m.call('GET', '/v1/health')).status, 200);
});
test('process: the per source limit works only with a configured header; Tor style callers with no header share one bucket', async (t) => {
  const m = await startMaker(t, { ...ON, MAKER_PUBLIC_SOURCE_HEADER: 'x-test-source', MAKER_PUBLIC_RATE_PER_SOURCE_PER_MIN: '1', MAKER_PUBLIC_RATE_QUOTE_PER_MIN: '600', MAKER_PUBLIC_RATE_QUOTE_BURST: '600' });
  const from = (ip) => m.call('POST', '/v1/quote', { body: { xmr: 5 }, headers: { 'x-test-source': ip } }).then((r) => r.status);
  assert.deepEqual([await from('198.51.100.1'), await from('198.51.100.1'), await from('198.51.100.2')], [400, 429, 400]);
  const free = await startMaker(t, { ...ON, MAKER_PUBLIC_RATE_QUOTE_PER_MIN: '600', MAKER_PUBLIC_RATE_QUOTE_BURST: '600' });
  for (let i = 0; i < 6; i++) assert.equal((await free.call('POST', '/v1/quote', { body: { xmr: 5 }, headers: { 'x-test-source': '198.51.100.1' } })).status, 400, 'default off: the header is ignored');
});
test('process: concurrent public requests are bounded and a held connection frees its slot when it closes', async (t) => {
  const m = await startMaker(t, { ...ON, MAKER_PUBLIC_MAX_CONCURRENT: '2', MAKER_PUBLIC_RATE_QUOTE_PER_MIN: '6000', MAKER_PUBLIC_RATE_QUOTE_BURST: '600' });
  const hold = () => new Promise((res) => { const s = net.connect(m.port, '127.0.0.1', () => { s.write('POST /v1/quote HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 60\r\n\r\n{'); setTimeout(() => res(s), 150); }); });
  const a = await hold(), b = await hold();
  const third = await m.call('POST', '/v1/quote', { body: { xmr: 5 } }); assert.deepEqual([third.status, third.json], [503, { error: 'busy-try-later' }]);
  assert.equal((await m.call('POST', '/v1/quote', { auth: true, body: { xmr: 5 } })).status, 400, 'the token lane does not use the public slots');
  a.destroy(); await sleep(200); assert.equal((await m.call('POST', '/v1/quote', { body: { xmr: 5 } })).status, 400, 'a closed connection frees its slot');
  b.destroy();
});
test('process: cors headers only on public answers and only when configured; preflight is answered for public routes only', async (t) => {
  const m = await startMaker(t, { ...ON, MAKER_PUBLIC_CORS_ORIGIN: 'https://wallet.example' });
  const pub = await m.call('POST', '/v1/quote', { body: { xmr: 5 } }); assert.equal(pub.headers.get('access-control-allow-origin'), 'https://wallet.example');
  assert.equal((await m.call('POST', '/v1/quote', { auth: true, body: { xmr: 5 } })).headers.get('access-control-allow-origin'), null, 'the token lane answer has no cors');
  assert.equal((await m.call('GET', '/v1/health')).headers.get('access-control-allow-origin'), 'https://wallet.example');
  const pre = await m.call('OPTIONS', '/v1/quote'); assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS'); assert.doesNotMatch(pre.headers.get('access-control-allow-headers'), /authorization/i);
  assert.equal((await m.call('OPTIONS', '/v1/status')).status, 401, 'no preflight for operator routes');
  const plain = await startMaker(t, ON); assert.equal((await plain.call('POST', '/v1/quote', { body: { xmr: 5 } })).headers.get('access-control-allow-origin'), null); assert.equal((await plain.call('OPTIONS', '/v1/quote')).status, 404);
});
test('quote responses carry refund timing: the same delta the maker registers', () => {
  const src = readFileSync(new URL('./maker.mjs', import.meta.url), 'utf8'); const core = readFileSync(new URL('../client/reverse-core.mjs', import.meta.url), 'utf8');
  assert.match(src, /t0Delta: CFG\.t0Delta, t1Delta: CFG\.t1Delta/); assert.match(src, /t0Delta: REV_T0_LEAD, t1Delta: REV_T0_LEAD \+ REV_CLAIM_WINDOW/);
  assert.match(src, /t0: now \+ CFG\.t0Delta, t1: now \+ CFG\.t1Delta/, 'forward: the registered times use the same deltas'); assert.match(core, /const t0 = now \+ REV_T0_LEAD;[\s\S]*t1: t0 \+ REV_CLAIM_WINDOW/, 'reverse: reverseTimelocks uses the same two constants');
});

// ---------- Sol M2: one quote ceiling per lane, across both directions, reserved synchronously ----------
test('M2: many parallel quote requests (both directions) never pass the public ceiling, even with an await between the check and the insert', async () => {
  const fwd = new Map(), rev = new Map(), pub = { enabled: true, maxQuotes: 5 };
  const store = createQuoteStore({ maps: [fwd, rev], pub, now: () => 1000 });
  const wait = () => new Promise((r) => setTimeout(r, 5));
  const request = async (i) => {
    const slot = store.reserve('public');   // synchronous check and reservation, as in maker.mjs quote() and reverseQuote()
    try { await wait(); const map = i % 2 ? rev : fwd; slot.commit(map, `q${i}`, { lane: 'public', expiresAt: 2000 }); return 'ok'; }
    finally { slot.release(); }
  };
  const results = await Promise.allSettled(Array.from({ length: 60 }, (_, i) => request(i)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 5, 'exactly the ceiling');
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => /busy-try-later/.test(r.reason.message)));
  assert.equal(fwd.size + rev.size, 5, 'one ceiling across both directions'); assert.equal(store.held('public'), 0, 'nothing is left reserved');
});
test('M2: a failed or abandoned request gives its slot back; the token lane has no ceiling; expired quotes make room', async () => {
  const fwd = new Map(), rev = new Map(), store = createQuoteStore({ maps: [fwd, rev], pub: { enabled: true, maxQuotes: 2 }, now: () => 1000 });
  const a = store.reserve('public'), b = store.reserve('public');
  assert.throws(() => store.reserve('public'), /busy-try-later/);
  a.release(); a.release(); const c = store.reserve('public'); assert.equal(store.held('public'), 2, 'release is idempotent');
  b.release(); c.release();
  for (let i = 0; i < 50; i++) store.reserve('token');   // token lane: unchanged, no ceiling
  fwd.set('old', { lane: 'public', expiresAt: 999 }); rev.set('new', { lane: 'public', expiresAt: 5000 });
  const d = store.reserve('public'); assert.equal(fwd.has('old'), false, 'expired quotes are dropped before counting'); assert.throws(() => store.reserve('public'), /busy-try-later/); d.release();
});
test('M2/M1: in maker.mjs the reservation comes before any await in both quote paths, and public wallet reads use the bounded queue with the client signal', () => {
  const src = readFileSync(new URL('./maker.mjs', import.meta.url), 'utf8');
  for (const name of ['quote', 'reverseQuote']) {
    const body = src.slice(src.indexOf(`async function ${name}(`)); const end = body.indexOf('\n}\n'); const fn = body.slice(0, end);
    const reserve = fn.indexOf('quoteStore.reserve(lane)'), firstAwait = fn.indexOf('await ');
    assert.ok(reserve > 0 && firstAwait > reserve, `${name}: reserve before any await`);
    assert.match(fn, /slot\.commit\(/); assert.match(fn, /finally \{ slot\.release\(\); \}/);
  }
  assert.doesNotMatch(src, /quotes\.set\(|reverseQuotes\.set\(/, 'quotes enter the maps only through slot.commit');
  assert.match(src, /withWallet\.publicLane\(name, create, fn, \{ signal \}\)/); assert.match(src, /treasuryUnlocked\(lane, signal\)/);
  assert.match(src, /ac\.abort\(\)/, 'a closed connection aborts its queued work'); assert.equal((src.match(/\{ \.\.\.input, lane, signal \}/g) ?? []).length, 4, 'the server sets lane and signal after the body');
});
test('M1 config: the public wallet queue depth and deadline are validated; the defaults are small', () => {
  const on = { MAKER_PUBLIC_LANE: 'true' };
  const c = parseLaneConfig(on, TOTAL); assert.equal(c.walletQueueDepth, 4); assert.equal(c.walletDeadlineMs, 10000);
  assert.equal(parseLaneConfig({ ...on, MAKER_PUBLIC_WALLET_QUEUE_DEPTH: '2', MAKER_PUBLIC_WALLET_DEADLINE_MS: '3000' }, TOTAL).walletDeadlineMs, 3000);
  for (const [k, v] of [['MAKER_PUBLIC_WALLET_QUEUE_DEPTH', '0'], ['MAKER_PUBLIC_WALLET_QUEUE_DEPTH', '65'], ['MAKER_PUBLIC_WALLET_DEADLINE_MS', '100'], ['MAKER_PUBLIC_WALLET_DEADLINE_MS', '1e4']]) assert.throws(() => parseLaneConfig({ ...on, [k]: v }, TOTAL), /public-lane-config/, `${k}=${v}`);
});

// ---- Sol M3 (second round): every terminal outcome maps to a neutral on-chain state; the raw `done` never leaves the maker ----
import { REVERSE_FINAL } from './maker-core.mjs';
test('M3: every value `done` can take maps to open / finished / refunded / closed; the off-chain Monero classification is not readable', () => {
  const rec = (done, direction) => ({ swapId: 's', direction, jointAddress: 'J', xmrSendTxid: 'T', lockSig: 'l', readySig: 'r', refundSig: 'f', claimSig: 'c', done });
  const expected = { completed: 'finished', refunded: 'refunded', 'refunded-before-send': 'refunded', 'xmr-recovered': 'refunded', 'xmr-never-relayed': 'refunded', 'not-locked': 'closed' };
  for (const [done, state] of Object.entries(expected)) for (const dir of ['xmr-sol', 'sol-xmr']) {
    const v = publicSwapView(rec(done, dir)); assert.equal(v.state, state, `${dir} ${done}`); assert.ok(!('done' in v)); assert.ok(!JSON.stringify(v).includes(done) || state === done, `raw value ${done} is not echoed`);
  }
  for (const done of [null, undefined]) assert.equal(publicSwapView(rec(done, 'xmr-sol')).state, 'open');
  for (const done of REVERSE_FINAL) assert.ok(Object.hasOwn(PUBLIC_OUTCOME, done), `${done} is mapped on purpose`);
  assert.ok(Object.hasOwn(PUBLIC_OUTCOME, 'completed') && Object.hasOwn(PUBLIC_OUTCOME, 'refunded'));
  for (const odd of ['something-new', '__proto__', 'toString', 7, {}]) assert.equal(publicOutcome(odd), 'closed', 'an unknown value falls to closed and is not echoed');
  const states = new Set(Object.values(PUBLIC_OUTCOME)); assert.deepEqual([...states].sort(), ['closed', 'finished', 'refunded']);
  assert.equal(publicSwapView(rec('xmr-never-relayed', 'sol-xmr')).state, publicSwapView(rec('xmr-recovered', 'sol-xmr')).state, 'two Monero side outcomes look the same');
  assert.equal(publicSwapView(rec('refunded-before-send', 'sol-xmr')).state, publicSwapView(rec('xmr-recovered', 'sol-xmr')).state, 'sent and not sent look the same');
});
test('M3: the public lookup over HTTP shows the neutral state for every stored outcome', async (t) => {
  const outcomes = [[null, 'open'], ['completed', 'finished'], ['refunded', 'refunded'], ['refunded-before-send', 'refunded'], ['xmr-recovered', 'refunded'], ['xmr-never-relayed', 'refunded'], ['not-locked', 'closed']];
  const ids = outcomes.map((_, i) => String(i + 1).padStart(64, 'a'));
  const m = await startMaker(t, ON, (s) => { outcomes.forEach(([done], i) => writeRec(s, { swapId: ids[i], lane: 'public', direction: 'sol-xmr', jointAddress: 'JOINTADDR', xmrSendTxid: 'TXID', lockSig: 'L', done, createdAt: today, xmrAtomic: '1' })); });
  for (const [i, [done, state]] of outcomes.entries()) {
    const r = await m.call('GET', `/v1/swap/${ids[i]}`); assert.equal(r.status, 200); assert.equal(r.json.state, state);
    assert.ok(!('done' in r.json) && !('xmrSent' in r.json)); if (done) assert.ok(!r.text.includes(`"${done}"`) || done === state);
  }
});
test('Sol M1 config and wiring: the public admission queue depth and deadline are validated; both admissions pass the lane and signal to the shared FIFO', () => {
  const on = { MAKER_PUBLIC_LANE: 'true' };
  const c = parseLaneConfig(on, TOTAL); assert.equal(c.admissionQueueDepth, 4); assert.equal(c.admissionDeadlineMs, 10000);
  assert.equal(parseLaneConfig({ ...on, MAKER_PUBLIC_ADMISSION_QUEUE_DEPTH: '2', MAKER_PUBLIC_ADMISSION_DEADLINE_MS: '3000' }, TOTAL).admissionDeadlineMs, 3000);
  for (const [k, v] of [['MAKER_PUBLIC_ADMISSION_QUEUE_DEPTH', '0'], ['MAKER_PUBLIC_ADMISSION_QUEUE_DEPTH', '65'], ['MAKER_PUBLIC_ADMISSION_DEADLINE_MS', '100'], ['MAKER_PUBLIC_ADMISSION_DEADLINE_MS', '1e4']]) assert.throws(() => parseLaneConfig({ ...on, [k]: v }, TOTAL), new RegExp(k));
  const src = readFileSync(new URL('./maker.mjs', import.meta.url), 'utf8');
  assert.equal((src.match(/\}\), admitOpts\(input\)\);/g) ?? []).length, 2, 'forward and reverse registration both go through admitOpts');
  assert.match(src, /input\?\.lane === 'public' \? \{ public: true, signal: input\.signal \} : \{\}/, 'only the public lane is bounded and cancellable; the token lane passes nothing');
  assert.match(src, /createAdmissionSerial\(PUB\.enabled \? \{ publicMaxQueued: PUB\.admissionQueueDepth, publicDeadlineMs: PUB\.admissionDeadlineMs \} : \{\}\)/);
});
