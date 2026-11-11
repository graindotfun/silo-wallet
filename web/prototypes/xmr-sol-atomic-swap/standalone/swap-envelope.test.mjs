// Tests for the encrypted recovery file, its locking, the logging boundary and the shared timing constants (findings 771-H1, 771-M1, 771-M3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, chmodSync, statSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import * as lib from './swap-lib.mjs';
import * as env from './swap-envelope.mjs';
import { scrub, createLogger, describeError } from './swap-log.mjs';
import * as shared from '../../../lib/silo/atomic-swap/swap-core.mjs';
import * as sharedRev from '../../../lib/silo/atomic-swap/reverse-core.mjs';
import * as protoCore from '../client/swap-core.mjs';
import * as protoRev from '../client/reverse-core.mjs';
import { REVERSE_ATTEMPT } from '../../../lib/silo/atomic-reverse-terms.mjs';

const PASS = 'correct horse battery staple', KDF = { N: 1024, r: 8, p: 1 };
const opts = (extra = {}) => ({ passphrase: PASS, kdf: KDF, minKdfN: 1024, ...extra });
const tmp = mkdtempSync(join(tmpdir(), 'silo-swap-env-test-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(tmp, `rec${n++}.json`);
const SECRETS = { b: 'ab'.repeat(32), v: 'cd'.repeat(32), feePayerSecret: 'ef'.repeat(64), jointAddress: `5${'Q'.repeat(94)}`, makerUrl: 'https://maker.example/secret-path' };

test('M1: the record never appears in plain text on disk; the clear header shows only format, cipher, key derivation parameters, direction and network', () => {
  const p = fresh(); const f = lib.createSwapFile(p, opts());
  f.create({ network: 'devnet', direction: 'xmr-sol', makerUrl: SECRETS.makerUrl, xmrAddress: SECRETS.jointAddress });
  f.saveRecord({ swapId: '12'.repeat(32), ...SECRETS, claimTx: 'AAAA'.repeat(40) });
  const raw = readFileSync(p, 'utf8');
  for (const v of Object.values(SECRETS)) assert.equal(raw.includes(v), false, `plain text found: ${v.slice(0, 10)}`);
  assert.equal(raw.includes('swapId'), false); assert.equal(raw.includes('claimTx'), false);
  const h = JSON.parse(raw);
  assert.deepEqual(Object.keys(h).sort(), ['cipher', 'ciphertext', 'direction', 'format', 'iv', 'kdf', 'network', 'tag']);
  assert.equal(h.format, env.ENVELOPE_FORMAT); assert.equal(h.cipher, 'aes-256-gcm'); assert.equal(h.kdf.name, 'scrypt');
  assert.equal(f.load().record.b, SECRETS.b);
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(tmp).filter((x) => x.startsWith(`rec${n - 1}.json.`)), [], 'no temp file left behind');
});

test('M1: every write uses a fresh nonce', () => {
  const p = fresh(); const f = lib.createSwapFile(p, opts()); f.create({ network: 'devnet' });
  const a = JSON.parse(readFileSync(p, 'utf8')).iv; f.saveRecord({ x: 1 }); const b = JSON.parse(readFileSync(p, 'utf8')).iv; f.saveRecord({ x: 1 }); const c = JSON.parse(readFileSync(p, 'utf8')).iv;
  assert.equal(new Set([a, b, c]).size, 3);
});

test('M1: a wrong passphrase fails closed, and so does a missing one; nothing is returned', () => {
  const p = fresh(); const f = lib.createSwapFile(p, opts()); f.create({ network: 'devnet' }); f.saveRecord({ secret: 'top' });
  assert.throws(() => lib.createSwapFile(p, opts({ passphrase: 'this is not the passphrase' })).load(), (e) => e.code === 'record-decrypt-failed');
  assert.throws(() => lib.createSwapFile(p, opts({ passphrase: null })).load(), (e) => e.code === 'passphrase-missing');
});

test('M1: a changed byte anywhere is detected (ciphertext, tag, nonce, and every authenticated header field)', () => {
  const p = fresh(); const f = lib.createSwapFile(p, opts()); f.create({ network: 'devnet' }); f.saveRecord({ secret: 'top' });
  const good = JSON.parse(readFileSync(p, 'utf8'));
  const flip = (hex) => (hex[0] === '0' ? '1' : '0') + hex.slice(1);
  const variants = {
    ciphertext: { ...good, ciphertext: Buffer.from(good.ciphertext, 'base64').map((x, i) => (i === 3 ? x ^ 1 : x)).toString('base64') },
    tag: { ...good, tag: flip(good.tag) }, iv: { ...good, iv: flip(good.iv) },
    network: { ...good, network: 'mainnet' }, direction: { ...good, direction: 'xmr-sol' }, salt: { ...good, kdf: { ...good.kdf, salt: flip(good.kdf.salt) } },
    truncated: { ...good, ciphertext: good.ciphertext.slice(0, -8) },
  };
  for (const [name, v] of Object.entries(variants)) {
    const q = fresh(); writeFileSync(q, JSON.stringify(v), { mode: 0o600 });
    assert.throws(() => lib.createSwapFile(q, opts()).load(), (e) => /^(record-decrypt-failed|envelope-)/.test(e.code), name);
  }
});

test('M1: no plain text fallback: a plain JSON swap file (the format of earlier versions) and garbage are refused, never read', () => {
  const p = fresh(); writeFileSync(p, JSON.stringify({ format: lib.RECORD_FORMAT, network: 'devnet', record: { b: SECRETS.b } }), { mode: 0o600 });
  assert.throws(() => lib.createSwapFile(p, opts()).load(), (e) => e.code === 'envelope-format');
  const q = fresh(); writeFileSync(q, 'not json at all', { mode: 0o600 });
  assert.throws(() => lib.createSwapFile(q, opts()).load(), (e) => e.code === 'envelope-malformed');
});

test('M1: a weak or missing passphrase cannot create a file; a key derivation weaker than the floor, or larger than the ceiling, is refused when read', () => {
  const p = fresh();
  assert.throws(() => lib.createSwapFile(p, opts({ passphrase: 'short' })).create({ network: 'devnet' }), (e) => e.code === 'passphrase-weak');
  assert.equal(existsSync(p), false, 'the file does not remain after the refusal');
  assert.throws(() => lib.createSwapFile(p, opts({ passphrase: null })).create({ network: 'devnet' }), (e) => e.code === 'passphrase-missing' || e.code === 'passphrase-weak');
  const q = fresh(); lib.createSwapFile(q, opts()).create({ network: 'devnet' });
  assert.throws(() => lib.createSwapFile(q, { passphrase: PASS }).load(), (e) => e.code === 'envelope-kdf-weak', 'default floor refuses a cheap file');
  const h = JSON.parse(readFileSync(q, 'utf8')); h.kdf.N = 1 << 20; const r = fresh(); writeFileSync(r, JSON.stringify(h), { mode: 0o600 });
  assert.throws(() => lib.createSwapFile(r, opts()).load(), (e) => e.code === 'envelope-kdf-unsupported');
});

test('M1: the temporary file is never created through a symlink; an unsafe temp file is refused and the link target is untouched', () => {
  const p = fresh(); const f = lib.createSwapFile(p, opts()); f.create({ network: 'devnet' });
  const victim = fresh(); writeFileSync(victim, 'victim content', { mode: 0o600 });
  symlinkSync(victim, `${p}.tmp`);
  assert.throws(() => f.saveRecord({ x: 1 }), (e) => e.code === 'record-file-unsafe');
  assert.equal(readFileSync(victim, 'utf8'), 'victim content');
  rmSync(`${p}.tmp`);
  writeFileSync(`${p}.tmp`, 'loose', { mode: 0o644 }); chmodSync(`${p}.tmp`, 0o644);
  assert.throws(() => f.saveRecord({ x: 1 }), (e) => e.code === 'record-file-unsafe', 'a pre-existing temp file with a loose mode is refused');
  rmSync(`${p}.tmp`);
  writeFileSync(`${p}.tmp`, 'stale', { mode: 0o600 });
  f.saveRecord({ x: 2 });                                 // a stale temp file of ours (a crash) is replaced
  assert.equal(f.load().record.x, 2);
});

test('M1: a record file that is a symlink, or readable by others, is refused when read', () => {
  const p = fresh(); lib.createSwapFile(p, opts()).create({ network: 'devnet' });
  const link = fresh(); symlinkSync(p, link);
  assert.throws(() => lib.createSwapFile(link, opts()).load(), (e) => e.code === 'record-file-unsafe');
  chmodSync(p, 0o644);
  assert.throws(() => lib.createSwapFile(p, opts()).load(), (e) => e.code === 'record-file-unsafe');
});

test('M1: create refuses an existing file and does not follow a symlink at the record path', () => {
  const p = fresh(); lib.createSwapFile(p, opts()).create({ network: 'devnet' });
  assert.throws(() => lib.createSwapFile(p, opts()).create({ network: 'devnet' }), (e) => e.code === 'swap-file-exists');
  const victim = fresh(); writeFileSync(victim, 'victim', { mode: 0o600 }); const link = fresh(); symlinkSync(victim, link);
  assert.throws(() => lib.createSwapFile(link, opts()).create({ network: 'devnet' }), (e) => e.code === 'swap-file-exists');
  assert.equal(readFileSync(victim, 'utf8'), 'victim');
});

const entryOf = (p) => { const d = dirname(p), pre = `${basename(p)}.lock.h.`; const n = readdirSync(d).filter((x) => x.startsWith(pre)); return n.length === 1 ? join(d, n[0]) : null; };
// ---- H1: locking -----------------------------------------------------------------------------------------------------------------------
test('H1: a second acquire in the SAME process fails closed (two sessions, or the same one twice), and the lock is released for the next user', () => {
  const p = fresh(); lib.createSwapFile(p, opts()).create({ network: 'devnet' });
  const a = lib.createSwapFile(p, opts()), b = lib.createSwapFile(p, opts());
  a.lock();
  assert.throws(() => b.lock(), (e) => e.code === 'swap-file-busy');
  assert.throws(() => a.lock(), (e) => e.code === 'swap-file-busy', 'no reentry for the holder either');
  a.unlock();
  b.lock(); b.unlock();
  assert.equal(existsSync(`${p}.lock`), false);
});

test('H1: the lock file names its owner by pid and start time, and a lock of a live process is never taken over', () => {
  const p = fresh(); lib.createSwapFile(p, opts()).create({ network: 'devnet' });
  const a = lib.createSwapFile(p, opts()); a.lock();
  const entry = entryOf(p); assert.ok(entry, 'one entry per holder');
  const owner = JSON.parse(readFileSync(entry, 'utf8'));
  assert.equal(owner.pid, process.pid); assert.ok(owner.token); assert.ok(owner.start === null || typeof owner.start === 'string');
  a.unlock();
  // a lock written by a live other process (the parent) is respected, in both formats
  for (const content of [String(process.ppid), JSON.stringify({ v: 2, pid: process.ppid, start: lib.processStartId(process.ppid), token: 'x' })]) {
    writeFileSync(`${p}.lock`, content, { mode: 0o600 });
    assert.throws(() => lib.createSwapFile(p, opts()).lock(), (e) => e.code === 'swap-file-busy');
    rmSync(`${p}.lock`);
  }
});

test('H1: a lock whose owner is gone (dead pid, or a reused pid with another start time) is replaced; an unreadable lock fails closed', () => {
  const p = fresh(); lib.createSwapFile(p, opts()).create({ network: 'devnet' });
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString();
  writeFileSync(`${p}.lock`, JSON.stringify({ v: 2, pid: Number(dead), start: 'whatever', token: 'x' }), { mode: 0o600 });
  const a = lib.createSwapFile(p, opts()); a.lock(); a.unlock();
  const sid = lib.processStartId(process.ppid);
  if (sid) {
    writeFileSync(`${p}.lock`, JSON.stringify({ v: 2, pid: process.ppid, start: `${sid}-different`, token: 'x' }), { mode: 0o600 });
    const b = lib.createSwapFile(p, opts()); b.lock(); b.unlock();
  }
  writeFileSync(`${p}.lock`, '{not json', { mode: 0o600 });
  assert.throws(() => lib.createSwapFile(p, opts()).lock(), (e) => e.code === 'swap-file-busy');
  rmSync(`${p}.lock`);
});

test('H1: only a confirmed vanished entry counts as gone; a symlink, a directory, an unreadable file or garbled content in a competing entry slot refuses the lock (fail closed)', () => {
  const p = fresh(); lib.createSwapFile(p, opts()).create({ network: 'devnet' });
  const slot = `${p}.lock.h.zzzz`;
  const attempts = [
    ['a symbolic link', () => symlinkSync('/etc/hosts', slot), () => rmSync(slot)],
    ['a directory', () => mkdirSync(slot), () => rmSync(slot, { recursive: true })],
    ['a file nobody can read', () => { writeFileSync(slot, JSON.stringify({ v: 3, pid: process.ppid, token: 'q', at: Date.now() }), { mode: 0o000 }); }, () => { chmodSync(slot, 0o600); rmSync(slot); }],
    ['garbled content', () => writeFileSync(slot, '\u0000\u0001 not a lock', { mode: 0o600 }), () => rmSync(slot)],
  ];
  for (const [what, make, clean] of attempts) {
    if (what === 'a file nobody can read' && process.getuid?.() === 0) continue;       // root reads everything
    make();
    const a = lib.createSwapFile(p, opts());
    assert.throws(() => a.lock(), (e) => e.code === 'swap-file-busy', what);
    assert.equal(readdirSync(dirname(p)).filter((x) => x.startsWith(`${basename(p)}.lock.h.`) && x !== 'zzzz' && !x.endsWith('zzzz')).length, 0, `${what}: the refused contender left no entry of its own`);
    clean();
    a.lock(); a.unlock();                                                              // once the slot is clean, the lock is free again
  }
  // a competing entry that vanishes (a confirmed ENOENT) is the only "gone": a dead owner's entry is replaced
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString();
  writeFileSync(slot, JSON.stringify({ v: 3, pid: Number(dead), start: 'x', token: 'q', at: 1 }), { mode: 0o600 });
  const b = lib.createSwapFile(p, opts()); b.lock(); assert.equal(existsSync(slot), false, 'the dead entry was removed'); b.unlock();
});

test('H1: unlock never removes a lock it does not own', () => {
  const p = fresh(); lib.createSwapFile(p, opts()).create({ network: 'devnet' });
  const a = lib.createSwapFile(p, opts()); a.lock();
  const entry = entryOf(p);
  writeFileSync(entry, JSON.stringify({ v: 3, pid: process.ppid, start: null, token: 'someone-else' }), { mode: 0o600 });
  a.unlock();
  assert.equal(existsSync(entry), true);
  rmSync(entry);
  lib.createSwapFile(p, opts()).lock();                    // the registry was cleared by unlock
});

// ---- M3: the logging boundary --------------------------------------------------------------------------------------------------------------
test('M3: scrub removes known secrets, credential URLs, bearer tokens and long hex or base58 strings; show keeps public identifiers but not secrets', () => {
  const secrets = ['https://rpc.example/v2/KEY-abcdef123456?api-key=SUPERSECRET', 'hunter2-hunter2'];
  const msg = `failed https://user:pw123@node.example:8899/x?token=abc for https://rpc.example/v2/KEY-abcdef123456?api-key=SUPERSECRET; Bearer abcdefghijkl; pass hunter2-hunter2; ${'ab'.repeat(40)}; ${'5'.repeat(44)}`;
  const strict = scrub(msg, secrets);
  for (const bad of ['pw123', 'SUPERSECRET', 'KEY-abcdef123456', 'abcdefghijkl', 'hunter2', 'ab'.repeat(40), '5'.repeat(44), 'token=abc']) assert.equal(strict.includes(bad), false, bad);
  const addr = `Maker Solana address: ${'7'.repeat(44)} at http://127.0.0.1:8899 via https://user:pw123@h.example/`;
  const shown = scrub(addr, secrets, { strict: false });
  assert.ok(shown.includes('7'.repeat(44)), 'a public address stays in show mode'); assert.equal(shown.includes('pw123'), false);
});

test('M3: an error that is not one of this tool\'s refusals is printed as a fixed public code, never by its message', () => {
  const e = new Error('request to https://user:pw@rpc.example/KEY123?api-key=SECRET failed: fetch failed');
  assert.equal(describeError(e, []), 'network-unreachable');
  assert.equal(describeError(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'network-timeout');
  assert.equal(describeError(new Error('some odd thing with SECRET')), 'unexpected-error');
  const out = []; const log = createLogger({ sink: (s) => out.push(s), secrets: () => ['LATER-SECRET'] });
  log.line('a LATER-SECRET b'); log.show('c LATER-SECRET d'); log.error(e);
  assert.equal(out.join('|').includes('LATER-SECRET'), false); assert.equal(out.join('|').includes('KEY123'), false);
});

test('M3: a redirect from the Solana RPC or the wallet RPC is refused by name', async () => {
  const redirecting = async () => ({ ok: false, status: 302, type: 'basic', headers: { get: () => 'https://elsewhere.example' }, json: async () => ({}), text: async () => '' });
  await assert.rejects(lib.createSolanaRpc({ url: 'http://127.0.0.1:8899', fetcher: redirecting })('getSlot'), (e) => e.code === 'redirect-refused');
  await assert.rejects(lib.noRedirect(redirecting)('http://127.0.0.1:1', {}), (e) => e.code === 'redirect-refused');
  let seen; await lib.noRedirect(async (u, i) => { seen = i; return { status: 200, type: 'basic' }; })('http://127.0.0.1:1', {});
  assert.equal(seen.redirect, 'manual');
});

// ---- constants shared with the supplied flows ------------------------------------------------------------------------------------------------
test('the timing constants this client enforces (the prototype modules) equal the ones the supplied flows use (lib/silo/atomic-swap)', () => {
  for (const k of ['MARGIN', 'LOCK_MIN_LEAD', 'LOCK_WAIT', 'CONFIRMATIONS', 'CLAIM_FEE', 'MIN_GAS', 'ABORT_LEAD', 'EARLY_SEND_MIN_LEAD', 'EARLY_LANDING_MARGIN', 'LATE_REFUND_MARGIN', 'T0_MAX_LEAD', 'T1_MAX_LEAD', 'CLAIM_WINDOW_MIN']) {
    assert.equal(protoCore[k], shared[k], `swap-core ${k}`);
  }
  for (const k of ['REV_T0_LEAD', 'REV_CLAIM_WINDOW', 'REV_LEAD_SLACK', 'REV_SEND_MIN_LEAD', 'REV_COMMIT_WINDOW', 'REV_MAX_HOLD_AFTER_T0']) assert.equal(protoRev[k], sharedRev[k], `reverse-core ${k}`);
});

test('M2: the timing words in the terms match the shared rule (abort threshold t0-900, confirm by t0-300, ten minutes apart) and say allowed is not done', () => {
  assert.equal(shared.ABORT_LEAD, 900); assert.equal(shared.MARGIN, 300);
  assert.match(REVERSE_ATTEMPT, /ten minutes before Confirm by/);
  const lines = lib.describeTerms({ sol: '0.3', xmr: '0.05', solPerXmr: null, spreadBps: null, claimer: '7'.repeat(44), expiresAt: 1_900_000_100 }, { network: 'devnet', now: 1_900_000_000 }).join('\n');
  assert.match(lines, /10 minutes before the confirm-by time/); assert.match(lines, /full amount with 10 confirmations still gets your confirmation until/);
  assert.match(lines, /a failed check does not count/); assert.match(lines, /"Allowed" is not "done"/);
  assert.doesNotMatch(lines, /at the latest about 15 minutes before/);
});

test('M2: the chain clock does not keep an old offset after later failures: it expires, and a failed first read stays unsynced', async () => {
  let t = 1_000_000, ok = true;
  const clock = lib.createChainClock({ rpc: async (m) => { if (!ok) throw new Error('rpc down https://k:s@h/'); return m === 'getSlot' ? 5 : 2000; }, localNow: () => t });
  ok = false; await assert.rejects(clock.sync()); assert.equal(clock.synced, false); assert.throws(() => clock.now(), (e) => e.code === 'clock-unsynced');
  ok = true; await clock.sync(); assert.equal(clock.now(), 2_000_000 + 0 + (t - t));
  ok = false; t += 60_000; await assert.rejects(clock.sync()); assert.equal(clock.synced, true, 'a recent good read is still usable');
  assert.equal(clock.now(), 2_000_000 + 60_000);
  t += 61_000; await assert.rejects(clock.sync()); assert.equal(clock.synced, false, 'older than the maximum age: dropped'); assert.throws(() => clock.now(), (e) => e.code === 'clock-unsynced');
  ok = true; await clock.sync(); assert.equal(clock.synced, true);
});
