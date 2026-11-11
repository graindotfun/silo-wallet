// Astra 709-H1: one unreadable swap record must not stop recovery of the others, nor the next pass.
import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process'; import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';
import { scanSwaps, recoveryPass, reasonOf } from './maker-records.mjs';

const id = (n) => String(n).padStart(2, '0').repeat(32);
const good = (n, o = {}) => ({ swapId: id(n), createdAt: '2026-11-10T00:00:00.000Z', xmrAtomic: '1', ...o });
const fsOf = (files) => ({ list: () => Object.keys(files).map((k) => `${k}.json`), load: (i) => { const v = files[i]; if (v instanceof Error) throw v; return typeof v === 'string' ? JSON.parse(v) : v; } });

test('H1: a corrupt COMPLETED record next to a refundable swap: the swap is still recovered, accounting is incomplete, no secret in the report', async () => {
  const files = { [id(1)]: '{"swapId": "SECRETVIEWKEY' , [id(2)]: good(2, { done: 'completed' }), [id(3)]: good(3) };
  const handled = [], logs = []; let seen;
  await recoveryPass({ scan: () => scanSwaps(fsOf(files)), onScan: (r) => { seen = r; }, handle: async (s) => { handled.push(s.swapId); }, log: (e) => logs.push(e) });
  assert.deepEqual(handled, [id(3)], 'the open readable swap is stepped, the finished one is not');
  assert.equal(seen.complete, false); assert.deepEqual(seen.bad, [{ id: id(1), why: 'unparseable' }]);
  assert.equal(JSON.stringify(seen).includes('SECRETVIEWKEY'), false, 'no file content in the report');
});
test('H1: a refund that proceeds while another file is corrupt, and one failing swap does not stop the next', async () => {
  const files = { [id(1)]: 'not json', [id(2)]: good(2), [id(3)]: good(3) };
  const handled = [], logs = [];
  await recoveryPass({ scan: () => scanSwaps(fsOf(files)), onScan: () => {}, log: (e) => logs.push(e), handle: async (s) => { handled.push(s.swapId); if (s.swapId === id(2)) throw new Error('rpc down'); return 'refund-sent'; } });
  assert.deepEqual(handled, [id(2), id(3)]); assert.equal(logs.length, 1); assert.equal(logs[0].swapId, id(2));
});
test('H1: a transient directory-read failure is reported, nothing throws, and the next scan recovers', async () => {
  let fail = true; const files = { [id(1)]: good(1) };
  const scan = () => scanSwaps({ list: () => { if (fail) throw Object.assign(new Error('EIO: i/o error, scandir /state/swaps'), { code: 'EIO' }); return Object.keys(files).map((k) => `${k}.json`); }, load: fsOf(files).load });
  const handled = []; let seen;
  await recoveryPass({ scan, onScan: (r) => { seen = r; }, handle: async (s) => { handled.push(s.swapId); }, log: () => {} });
  assert.deepEqual([seen.complete, seen.dirError, handled], [false, 'EIO', []]);
  fail = false;
  await recoveryPass({ scan, onScan: (r) => { seen = r; }, handle: async (s) => { handled.push(s.swapId); }, log: () => {} });
  assert.deepEqual([seen.complete, handled], [true, [id(1)]]);
});
test('H1: malformed shape and unreadable files are told apart, with short reason classes only', () => {
  const r = scanSwaps(fsOf({ [id(1)]: '[]', [id(2)]: Object.assign(new Error('EACCES: permission denied, open /secret/path'), { code: 'EACCES' }), [id(3)]: { ...good(3), swapId: id(4) }, [id(5)]: good(5) }));
  assert.deepEqual(r.bad.map((b) => b.why), ['malformed', 'EACCES', 'malformed']); assert.equal(r.records.length, 1);
  assert.equal(reasonOf(new Error('x')), 'unreadable'); assert.equal(reasonOf(Object.assign(new Error('x'), { code: 'weird path /etc' })), 'unreadable');
});

// ---- the real maker process: admission stays closed, the timer keeps running, status reports it ----
test('H1: real maker with a corrupt record: admission refused, status and health report it, the loop keeps ticking', async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'rec-')); mkdirSync(join(state, 'swaps'));
  writeFileSync(join(state, 'maker-sol.json'), JSON.stringify([...Keypair.generate().secretKey])); writeFileSync(join(state, 'wallet-password'), 'test-only');
  writeFileSync(join(state, 'swaps', `${id(1)}.json`), '{"swapId":"truncated');
  const token = 't'.repeat(48), port = 40000 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./maker.mjs', import.meta.url))], { env: { PATH: process.env.PATH, MAKER_STATE: state, MAKER_PORT: String(port), MAKER_API_TOKEN: token, XMR_NETWORK: 'stagenet', SOL_RPC: 'http://127.0.0.1:9', MAKER_WALLET_RPC: 'http://127.0.0.1:9/json_rpc', XMR_DAEMON: 'http://127.0.0.1:9/json_rpc', LOOP_MS: '300' }, stdio: 'ignore' });
  t.after(() => { child.kill(); rmSync(state, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${port}`, auth = { authorization: `Bearer ${token}` };
  for (let i = 0; i < 100; i++) { try { await fetch(`${url}/v1/health`); break; } catch { await new Promise((r) => setTimeout(r, 50)); } }
  await new Promise((r) => setTimeout(r, 1200));   // several passes
  const st = await (await fetch(`${url}/v1/status`, { headers: auth })).json();
  assert.equal(st.accounting.complete, false); assert.deepEqual(st.accounting.unreadable, [{ id: id(1).slice(0, 16), why: 'unparseable' }]);
  assert.equal((await (await fetch(`${url}/v1/health`)).json()).accepting, false);
  const q = await fetch(`${url}/v1/quote`, { method: 'POST', headers: auth, body: JSON.stringify({ xmr: 0.01 }) }); assert.match((await q.json()).error, /maker-paused|maker-accounting-incomplete/);
  const j = readFileSync(join(state, 'journal.jsonl'), 'utf8'); assert.equal(j.includes('truncated'), false, 'no file content in the journal'); assert.match(j, /records-unreadable/);
  const ticks = (j.match(/"event":"admission-/g) ?? []).length; assert.ok(ticks >= 1);
  rmSync(join(state, 'swaps', `${id(1)}.json`)); await new Promise((r) => setTimeout(r, 900));
  assert.equal((await (await fetch(`${url}/v1/health`)).json()).accepting, true, 'readable again: admission reopens by itself');
  assert.match(readFileSync(join(state, 'journal.jsonl'), 'utf8'), /records-readable-again/);
  assert.equal((await fetch(`${url}/v1/quote`, { method: 'POST', body: '{bad' })).status, 401, 'unauthenticated malformed body gets 401');
});
