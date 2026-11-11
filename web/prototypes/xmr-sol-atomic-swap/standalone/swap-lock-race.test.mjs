// Race tests with REAL child processes for the swap file lock and the funding intent (stale takeover must never create two owners).
// Run: node --test prototypes/xmr-sol-atomic-swap/standalone/swap-lock-race.test.mjs     (SWAP_RACE_ITERATIONS=50 by default)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lib from './swap-lib.mjs';
import { makeWorldFactory } from './swap-test-world.mjs';

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'swap-lock-race.child.mjs');
const ITER = Number(process.env.SWAP_RACE_ITERATIONS ?? 50);
const tmp = mkdtempSync(join(tmpdir(), 'silo-swap-race-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const deadPid = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString());
const fresh = () => {
  const p = join(tmp, `r${n++}.json`);
  lib.createSwapFile(p, { passphrase: 'correct horse battery staple', kdf: { N: 1024, r: 8, p: 1 }, minKdfN: 1024 }).create({ network: 'devnet' });
  return p;
};
const run = (args, env = {}) => new Promise((resolve) => { const c = spawn(process.execPath, [CHILD, ...args], { stdio: 'ignore', env: { ...process.env, ...env } }); c.on('exit', (code, sig) => resolve({ code, sig })); });
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
const startIn = (ms = 700) => String(Date.now() + ms);
const stale = (p, i) => writeFileSync(`${p}.lock`, i % 2 ? String(deadPid) : JSON.stringify({ v: 2, pid: deadPid, start: 'x', token: 'old' }), { mode: 0o600 });

test(`(a) three processes race for a stale lock: exactly one owner at any time, nobody is locked out for good (${ITER} iterations)`, async () => {
  for (let i = 0; i < ITER; i++) {
    const p = fresh(), log = `${p}.log`; stale(p, i); const at = startIn();
    const res = await Promise.all([1, 2, 3].map(() => run(['lock', p, log, at, '30'])));
    assert.deepEqual(res.map((r) => r.code), [0, 0, 0], `iteration ${i}: every contender eventually got its turn`);
    const l = lines(log);
    assert.equal(l.length, 6, `iteration ${i}: ${l.join('|')}`);
    for (let k = 0; k < 6; k += 2) { const [e, x] = [l[k].split(' '), l[k + 1].split(' ')]; assert.ok(e[0] === 'enter' && x[0] === 'exit' && e[1] === x[1], `iteration ${i}: two owners at once: ${l.join('|')}`); }
    assert.deepEqual(readdirSync(tmp).filter((f) => f.startsWith(`r${n - 1}.json.lock`)), [], 'no lock entry is left behind');
  }
});

test(`(a2) three processes race while a live holder keeps the lock and a dead one is on disk: the live holder is never displaced (${ITER} iterations)`, async () => {
  for (let i = 0; i < ITER; i++) {
    const p = fresh(), log = `${p}.log`; stale(p, i); const at = startIn(400);
    const holder = run(['lock', p, log, at, '400']);
    const others = await Promise.all([1, 2].map(() => run(['lock', p, log, String(Number(at) + 20), '30'])));
    assert.equal((await holder).code, 0); assert.deepEqual(others.map((r) => r.code), [0, 0]);
    const l = lines(log); assert.equal(l.length, 6, l.join('|'));
    for (let k = 0; k < 6; k += 2) assert.ok(l[k].startsWith('enter') && l[k + 1].startsWith('exit') && l[k].split(' ')[1] === l[k + 1].split(' ')[1], `iteration ${i}: ${l.join('|')}`);
  }
});

test(`(b) two wallets, two processes, the same unfunded swap: exactly one payment is built, the other is refused (${ITER} iterations)`, async () => {
  for (let i = 0; i < ITER; i++) {
    const p = fresh(), log = `${p}.log`, at = startIn();
    await Promise.all([run(['claim', p, log, at, 'wallet-A']), run(['claim', p, log, at, 'wallet-B'])]);
    const l = lines(log); const built = l.filter((x) => x.startsWith('build'));
    assert.equal(built.length, 1, `iteration ${i}: ${l.join('|')}`);
    assert.equal(l.filter((x) => x.startsWith('refused') && x.endsWith('funding-wallet-mismatch')).length, 1, `iteration ${i}: ${l.join('|')}`);
  }
});

test(`(b2) the same wallet twice is not a second payment: the second sees the reservation and resumes it (${ITER} iterations)`, async () => {
  for (let i = 0; i < ITER; i++) {
    const p = fresh(), log = `${p}.log`, at = startIn();
    await Promise.all([run(['claim', p, log, at, 'wallet-A']), run(['claim', p, log, at, 'wallet-A'])]);
    const l = lines(log); assert.equal(l.filter((x) => x.startsWith('build')).length, 1, l.join('|')); assert.equal(l.filter((x) => x.startsWith('same')).length, 1, l.join('|'));
  }
});

test(`(c) the owner dies between the lock and the intent, then two wallets race the stale takeover: still exactly one payment (${ITER} iterations)`, async () => {
  for (let i = 0; i < ITER; i++) {
    const p = fresh(), log = `${p}.log`;
    const crashed = await run(['crash-after-lock', p, log, String(Date.now())]);
    assert.equal(crashed.sig, 'SIGKILL'); assert.ok(readdirSync(tmp).some((f) => f.startsWith(`r${n - 1}.json.lock.h.`)), 'the dead owner left its lock entry');
    const at = startIn();
    await Promise.all([run(['fund', p, log, at, 'wallet-A']), run(['fund', p, log, at, 'wallet-B'])]);
    const l = lines(log); assert.equal(l.filter((x) => x.startsWith('build')).length, 1, `iteration ${i}: ${l.join('|')}`);
    assert.equal(l.filter((x) => x.startsWith('refused') && x.endsWith('funding-wallet-mismatch')).length, 1, `iteration ${i}: ${l.join('|')}`);
  }
});

test(`(c2) the owner dies after the intent is on disk: the other wallet cannot take over; the original wallet, holding the swap lock, takes the dead run's reservation over and builds exactly once (${ITER} iterations)`, async () => {
  for (let i = 0; i < ITER; i++) {
    const p = fresh(), log = `${p}.log`;
    await run(['crash-after-claim', p, log, String(Date.now()), 'wallet-A']);
    const at = startIn();
    await Promise.all([run(['fund', p, log, at, 'wallet-B']), run(['fund', p, log, at, 'wallet-A'])]);
    const l = lines(log); assert.deepEqual(l.filter((x) => x.startsWith('build')), ['build wallet-A'], `iteration ${i}: only the original wallet builds, once: ${l.join('|')}`);
    assert.ok(l.includes('refused wallet-B funding-wallet-mismatch'), l.join('|'));
  }
});

test(`(a3) a live holder whose lock entry gives EIO on the first read is never displaced: the contender backs off, strictly one owner at a time (${ITER} iterations)`, async () => {
  for (let i = 0; i < ITER; i++) {
    const p = fresh(), log = `${p}.log`, at = startIn(400);
    const holder = run(['lock', p, log, at, '400']);
    const other = run(['lock', p, log, String(Number(at) + 100), '30'], { SWAP_TEST_EIO: '1' });
    assert.equal((await holder).code, 0); assert.equal((await other).code, 0);
    const l = lines(log); assert.equal(l.length, 4, l.join('|'));
    for (let k = 0; k < 4; k += 2) assert.ok(l[k].startsWith('enter') && l[k + 1].startsWith('exit') && l[k].split(' ')[1] === l[k + 1].split(' ')[1], `iteration ${i}: two owners at once: ${l.join('|')}`);
  }
});

// ---- the REAL payment caller (createForwardSession.resume -> driver -> prepareLock -> claimIntent -> wallet RPC), two processes, the same funding wallet ----------------------------
const PASS = 'correct horse battery staple', KDF = { N: 1024, r: 8, p: 1 }, REC = { recordPassphrase: PASS, recordKdf: KDF, recordMinKdfN: 1024 };
let ids = 0;
const world = makeWorldFactory({ tmp, nextId: () => `p${ids++}`, REC });
/** A swap registered with the fake maker and not paid. Returns the record path and the preset file that lets another process rebuild the same chain state. */
async function unfundedSwap() {
  const w = world(); const rec = join(tmp, `u${n++}.json`);
  await w.session({ recordPath: rec, confirmPayment: async () => false }).start({ xmr: '0.05', confirm: async () => true, until: 'paid', pollMs: 1000, maxTicks: 2 });
  const { b, ...escrow } = w.W.escrow;
  const preset = `${rec}.preset`; writeFileSync(preset, JSON.stringify({ maker: w.maker, user: w.user, swapId: w.swapId, escrow, feePayer: w.W.feePayer, feeBalance: w.W.feeBalance, clock: w.now() }));
  return { rec, preset, w };
}
const pay = (rec, preset, log, at, delay, env) => run(['pay', rec, log, at, preset, String(delay)], env);

test(`(d) real caller: a live holder, a competing entry that gives EIO on the first read, the same funding wallet: exactly one owner, exactly one transfer, one relay (${ITER} iterations)`, async () => {
  let kept = 0;
  for (let i = 0; i < ITER; i++) {
    const { rec, preset } = await unfundedSwap(); const log = `${rec}.log`, at = startIn(900);
    const holder = pay(rec, preset, log, at, 600);          // whichever process gets the swap first holds it for the whole (slow) confirmation
    const second = pay(rec, preset, log, String(Number(at) + 150), 600, { SWAP_TEST_EIO: '1' });
    await Promise.all([holder, second]);
    const l = lines(log);
    const count = (k) => l.filter((x) => x.startsWith(k)).length;
    assert.equal(count('confirm'), 1, `iteration ${i}: exactly one owner reached the payment: ${l.join('|')}`);
    assert.equal(count('transfer'), 1, `iteration ${i}: exactly one transfer: ${l.join('|')}`); assert.equal(count('relay'), 1, `iteration ${i}: one relay: ${l.join('|')}`);
    assert.equal(count('done') + count('refused'), 2, l.join('|')); if (l.some((x) => /^refused \d+ swap-file-busy$/.test(x))) kept++;
    const f = lib.createSwapFile(rec, { passphrase: PASS, kdf: KDF, minKdfN: 1024 }).load().record; assert.equal(f.fundingIntent.txid.length, 64); assert.equal(f.xmrLockTxid, f.fundingIntent.txid);
  }
  assert.ok(kept >= ITER * 0.8, `the busy path was really exercised (${kept} of ${ITER} iterations kept the second run out)`);
});

test(`(d2) real caller, no EIO: two runs of the same wallet start together; whichever owns the swap pays, the other either waits out or finds the payment already recorded: one transfer (${ITER} iterations)`, async () => {
  for (let i = 0; i < ITER; i++) {
    const { rec, preset } = await unfundedSwap(); const log = `${rec}.log`, at = startIn(900);
    await Promise.all([pay(rec, preset, log, at, 200), pay(rec, preset, log, at, 200)]);
    const l = lines(log); assert.equal(l.filter((x) => x.startsWith('transfer')).length, 1, `iteration ${i}: ${l.join('|')}`); assert.equal(l.filter((x) => x.startsWith('relay')).length, 1, l.join('|'));
  }
});
