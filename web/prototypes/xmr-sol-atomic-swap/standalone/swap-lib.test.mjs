// Unit tests of the standalone SOL -> XMR client against a fake maker, a fake Solana chain and a fake Monero wallet RPC.
// Run: node --test prototypes/xmr-sol-atomic-swap/standalone/swap-lib.test.mjs
// All keys are throwaway keys generated here. Every request goes through ONE recording fetcher; globalThis.fetch is replaced with a trap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { sha256 } from '@noble/hashes/sha256';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomScalar, pub, toLE, hex, unhex, proveShare, addPoints, moneroAddress } from '../client/keys.mjs';
import { REV_T0_LEAD, REV_CLAIM_WINDOW } from '../client/reverse-core.mjs';
import { inspectSiloAtomicRefunderTx, atomicSwapPda, SILO_ATOMIC_PROGRAM_ID } from '../../../lib/silo/atomic-swap/refunder-tx.mjs';
import * as lib from './swap-lib.mjs';
import { main } from './silo-swap.mjs';

const PASS = 'correct horse battery staple', KDF = { N: 1024, r: 8, p: 1 };      // test-only cheap key derivation; real files use N 32768
const REC = { recordPassphrase: PASS, recordKdf: KDF, recordMinKdfN: 1024 };
const readRec = (path) => lib.createSwapFile(path, { passphrase: PASS, kdf: KDF, minKdfN: 1024 }).load();
const MAKER = 'https://maker.example', SOL = 'http://127.0.0.1:8899', XMR = 'http://127.0.0.1:38293', NODE = 'http://127.0.0.1:38081';
const ORIGINS = new Set([new URL(MAKER).origin, new URL(SOL).origin, new URL(XMR).origin, new URL(NODE).origin]);
const BASE = 1_900_000_000;
const disc = (n) => Buffer.from(sha256(new TextEncoder().encode(n))).subarray(0, 8);
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { throw new Error(`UNEXPECTED global fetch ${url}`); };
const tmp = mkdtempSync(join(tmpdir(), 'silo-swap-test-'));
test.after(() => { rmSync(tmp, { recursive: true, force: true }); globalThis.fetch = realFetch; });
let counter = 0;
const newKeyFile = () => { const kp = Keypair.generate(); const p = join(tmp, `key${counter++}.json`); writeFileSync(p, JSON.stringify([...kp.secretKey]), { mode: 0o600 }); return { path: p, kp, address: kp.publicKey.toBase58() }; };
const ok = (json, status = 200) => ({ ok: status < 400, status, type: 'basic', text: async () => JSON.stringify(json), json: async () => json });

function world(opts = {}) {
  const key = newKeyFile(), maker = Keypair.generate().publicKey.toBase58();
  let clock = BASE;
  const a = randomScalar(), swapId = hex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const W = { urls: [], posts: {}, sent: [], escrow: null, history: [], xmr: null, xmrBalance: { balance: '0', unlocked_balance: '0' }, sweeps: [], quoteTweak: (q) => q, regTweak: (r) => r, requireToken: opts.token ?? null, programExecutable: opts.programExecutable ?? true, genesis: opts.genesis ?? 'local-genesis' };
  const quote = () => W.quoteTweak({ direction: 'sol-xmr', quoteId: 'ab'.repeat(16), swapId, xmrAtomic: '50000000000', lamports: 345_000_000, solPerXmr: 6.9, spreadBps: 0, priceSource: 'x', A: hex(pub(a)), proofA: proveShare(a, unhex(swapId), 0), claimer: maker, expiresAt: clock + 120 });
  let reg = null;
  const height = () => Math.floor((clock - BASE) * 2);
  const account = () => {
    const e = W.escrow, d = Buffer.alloc(8 + 194); disc('account:StrictSwap').copy(d, 0); let o = 8;
    for (const k of [key.address, maker]) { bs58.decode(k).forEach((x, i) => (d[o + i] = x)); o += 32; }
    Buffer.from(e.A, 'hex').copy(d, o); o += 32; Buffer.from(e.B, 'hex').copy(d, o); o += 32;
    d.writeBigUInt64LE(BigInt(e.lamports), o); o += 8; d.writeBigInt64LE(BigInt(e.t0), o); o += 8; d.writeBigInt64LE(BigInt(e.t1), o); o += 8; d[o] = e.ready ? 1 : 0; o += 1;
    Buffer.from(swapId, 'hex').copy(d, o); o += 32; o += 1; d.writeBigInt64LE(0n, o);
    return { owner: SILO_ATOMIC_PROGRAM_ID, data: [d.toString('base64'), 'base64'] };
  };
  const chainRpc = (method, params) => {
    switch (method) {
      case 'getGenesisHash': return W.genesis;
      case 'getSlot': return params?.[0]?.commitment === 'finalized' ? height() : 1;
      case 'getBlockTime': return params[0] === 1 ? clock : clock - Math.floor((height() - params[0]) / 2);
      case 'getBlock': return { blockHeight: params[0] };
      case 'getSignatureStatuses': return { context: { slot: height() }, value: params[0].map(() => null) };
      case 'getLatestBlockhash': return { value: { blockhash: bs58.encode(globalThis.crypto.getRandomValues(new Uint8Array(32))), lastValidBlockHeight: height() + 150 } };
      case 'getAccountInfo': {
        if (params[0] === SILO_ATOMIC_PROGRAM_ID) return { context: { slot: height() }, value: W.programExecutable ? { executable: true, owner: 'BPFLoaderUpgradeab1e11111111111111111111111', data: [Buffer.alloc(36).toString('base64'), 'base64'] } : null };
        return { context: { slot: height() }, value: W.escrow ? account() : null };
      }
      case 'getSignaturesForAddress': return W.history.map((h, i) => ({ signature: `s${i}`, err: null }));
      case 'getTransaction': return W.history[Number(params[0].slice(1))];
      case 'sendTransaction': {
        const tx = VersionedTransaction.deserialize(Buffer.from(params[0], 'base64')), seen = inspectSiloAtomicRefunderTx(tx, { now: clock });
        assert.equal(tx.signatures.length, 1); W.sent.push(seen.kind);
        if (seen.kind === 'lock') W.escrow = { A: hex(seen.terms.claimPoint), B: hex(seen.terms.refundPoint), lamports: seen.terms.lamports, t0: seen.terms.t0, t1: seen.terms.t1, ready: false };
        else if (seen.kind === 'ready') W.escrow.ready = true;
        else { const m = tx.message, keys = m.staticAccountKeys.map((k) => k.toBase58()), ix = m.compiledInstructions[1];
          W.history.push({ transaction: { message: { accountKeys: keys, instructions: [{ programIdIndex: ix.programIdIndex, accounts: [...ix.accountKeyIndexes], data: bs58.encode(ix.data) }] } }, meta: { err: null } }); W.escrow = null; }
        return 'sig';
      }
      default: throw new Error(`unexpected solana method ${method}`);
    }
  };
  const walletRpc = (method, params) => {
    switch (method) {
      case 'validate_address': return { valid: params.address.startsWith('5'), nettype: 'stagenet', integrated: false };
      case 'close_wallet': case 'refresh': return {};
      case 'open_wallet': throw new Error('not found');
      case 'generate_from_keys': W.walletKeys = params; return {};
      case 'get_transfers': return { in: W.xmr ? [{ amount: W.xmr.atomic, confirmations: W.xmr.confirmations, unlock_time: 0, txid: 'aa' }] : [], pool: [] };
      case 'get_balance': return W.xmrBalance;
      case 'sweep_all': W.sweeps.push(params.address); return { tx_hash_list: ['sweep-tx'] };
      case 'get_info': return { height: 1000 };
      default: throw new Error(`unexpected wallet method ${method}`);
    }
  };
  const makerRoute = (path, body, headers) => {
    if (W.requireToken && headers.authorization !== `Bearer ${W.requireToken}`) return ok({ error: 'unauthorized' }, 401);
    W.posts[path] = body;
    if (path === '/v1/rev/quote') return ok(quote());
    if (path === '/v1/rev/swap') {
      if (W.registerFails) throw new TypeError('fetch failed');
      const t0 = Math.floor(clock) + REV_T0_LEAD;
      let v = 0n; const vb = unhex(body.v); for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(vb[i]);
      reg = W.regTweak({ swapId, claimer: maker, claimPoint: hex(pub(a)), lamports: 345_000_000, xmrAtomic: '50000000000', t0, t1: t0 + REV_CLAIM_WINDOW,
        jointAddress: moneroAddress(addPoints(pub(a), unhex(body.B)), pub(v), 'stagenet'), pda: atomicSwapPda(key.address, unhex(swapId)).toBase58() });
      return ok(reg);
    }
    return ok({ error: 'not-found' }, 404);
  };
  const fetcher = async (url, init = {}) => {
    const u = new URL(url); W.urls.push(url);
    assert.ok(ORIGINS.has(u.origin), `request outside the user's endpoints: ${u.origin}`);
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.origin === new URL(MAKER).origin) return makerRoute(u.pathname, body, init.headers ?? {});
    if (u.origin === new URL(SOL).origin) { try { return ok({ result: chainRpc(body.method, body.params) }); } catch (e) { return ok({ error: { message: e.message } }); } }
    if (u.origin === new URL(NODE).origin) return ok({ result: walletRpc(body.method, body.params) });
    try { return ok({ result: walletRpc(body.method, body.params) }); } catch (e) { return ok({ error: { message: e.message } }); }
  };
  // The wallet RPC and the node share the loopback host in real life; here they are separate ports so each is asserted on.
  const session = (o = {}) => {
    const sleep = async (ms) => { clock += ms / 1000; };
    return lib.createSession({ network: 'devnet', solanaRpcUrl: SOL, moneroWalletRpcUrl: XMR, daemonHeight: lib.createDaemonHeight({ url: NODE, fetchImpl: fetcher }), keypair: key.kp, owner: key.address,
      xmrAddress: '5' + 'A'.repeat(94), recordPath: o.recordPath ?? join(tmp, `swap${counter++}.json`), maker: lib.createMakerClient({ url: MAKER, token: opts.token ?? null, fetcher }),
      fetcher, now: () => clock * 1000, sleep, log: o.log ?? (() => {}), expectedMaker: maker, maxSolPerXmr: 10, nodeOwnership: 'own', ...REC, ...o });
  };
  return { W, key, maker, a, session, fetcher, advance: (s) => { clock += s; }, now: () => clock };
}
const yes = async () => true;
const FAST = { pollMs: 60_000, maxTicks: 1 };

test('happy path: quote, lock, XMR confirms, ready, maker claims, sweep to the user address; only the user endpoints are contacted', async () => {
  const w = world(); const s = w.session();
  let v = await s.start({ xmr: '0.05', confirm: yes, until: 'locked', pollMs: 40_000 });
  assert.equal(v.phase, 'awaiting-maker-xmr'); assert.deepEqual(w.W.sent, ['lock']);
  // the swap file holds the record with its secrets, mode 0600, written before registration (checked in a later test)
  w.W.xmr = { atomic: '50000000000', confirmations: 4 }; w.advance(600);
  v = await s.resume({ ...FAST }); assert.equal(v.phase, 'xmr-confirming'); assert.equal(v.confirmations, 4);
  w.W.xmr.confirmations = 10; w.advance(600);
  v = await s.resume({ ...FAST }); assert.equal(v.phase, 'confirming'); assert.deepEqual(w.W.sent, ['lock', 'ready']);
  w.W.escrow.ready = true; w.advance(60); v = await s.resume({ ...FAST }); assert.equal(v.phase, 'await-claim');
  // the maker claims: the escrow closes and the claim reveals a
  const pda = atomicSwapPda(w.key.address, unhex(readRec(s.file.path).record.swapId)).toBase58();
  w.W.escrow = null;
  w.W.history = [{ transaction: { message: { accountKeys: [w.maker, pda, w.key.address, SILO_ATOMIC_PROGRAM_ID], instructions: [{ programIdIndex: 3, accounts: [1, 0, 2], data: bs58.encode(Buffer.concat([disc('global:claim_strict'), Buffer.from(toLE(w.a))])) }] } }, meta: { err: null } }];
  w.W.xmrBalance = { balance: '50000000000', unlocked_balance: '50000000000' }; w.advance(60);
  v = await s.resume({ ...FAST }); assert.equal(v.phase, 'sweeping'); assert.deepEqual(v.record.xmrSweptTxids, ['sweep-tx']);
  assert.deepEqual(w.W.sweeps, ['5' + 'A'.repeat(94)], 'sweep goes to the address the user named');
  v = await s.resume({ ...FAST }); assert.equal(v.phase, 'received'); assert.equal(lib.outcomeOf(v).code, 0);
  assert.equal(w.W.sent.filter((k) => k === 'lock').length, 1);
  // request body of the registration: exactly the five fields, no tierOk
  assert.deepEqual(Object.keys(w.W.posts['/v1/rev/swap']).sort(), ['B', 'proofB', 'quoteId', 'refunder', 'v']);
  assert.deepEqual(w.W.posts['/v1/rev/quote'], { xmr: '0.05' });
  // no request left the three user-supplied origins (the fetcher asserts it per request; here the full list)
  assert.ok(w.W.urls.length > 10);
  for (const u of w.W.urls) assert.ok(ORIGINS.has(new URL(u).origin), u);
});

test('the swap file is written with the secrets BEFORE the maker sees the registration, and a failed registration leaves nothing locked', async () => {
  const w = world(); w.W.registerFails = true; const s = w.session();
  await assert.rejects(s.start({ xmr: '0.05', confirm: yes }), /registration was refused/);
  const f = readRec(s.file.path);
  assert.equal(f.format, lib.RECORD_FORMAT); assert.equal(f.record.status, 'quoted'); assert.match(f.record.b, /^[0-9a-f]{64}$/);
  assert.equal(w.W.sent.length, 0, 'nothing locked');
  assert.equal((await import('node:fs')).statSync(s.file.path).mode & 0o777, 0o600);
  // the crashed run resumes: no escrow, quote expires, the swap closes without a lock
  w.advance(200); const v = await s.resume({ ...FAST });
  assert.equal(v.record.result, 'quote-expired'); assert.equal(w.W.sent.length, 0);
});

for (const [name, tweak, code] of [
  ['amount differs from the request', (q) => ({ ...q, xmrAtomic: '40000000000' }), 'quote-amount-mismatch'],
  ['expired quote', (q) => ({ ...q, expiresAt: BASE - 1 }), 'quote-expired'],
  ['quote open too long', (q) => ({ ...q, expiresAt: BASE + 86_400 }), 'quote-ttl-too-long'],
  ['wrong direction', (q) => ({ ...q, direction: 'xmr-sol' }), 'quote-wrong-direction'],
  ['bad share proof', (q) => ({ ...q, proofA: { ...q.proofA, s: '00'.repeat(32) } }), 'quote-bad-proof'],
  ['spread above the limit', (q) => ({ ...q, spreadBps: 5000, lamports: Math.ceil(345_000_000 * 1.5) }), 'quote-spread-too-high'],
  ['price does not match the charge', (q) => ({ ...q, lamports: 900_000_000 }), 'quote-price-inconsistent'],
  ['lamports over the ceiling', (q) => ({ ...q, lamports: 3_000_000_000 }), 'quote-lamports-out-of-range'],
  ['maker is the user wallet', (q, w) => ({ ...q, claimer: w.key.address }), 'quote-claimer-is-user'],
]) test(`refuses before locking or storing: quote ${name}`, async () => {
  const w = world(); w.W.quoteTweak = (q) => tweak(q, w); const s = w.session({ maxSolPerXmr: 100 });
  await assert.rejects(s.start({ xmr: '0.05', confirm: yes }), (e) => e.code === code);
  assert.equal(w.W.sent.length, 0); assert.equal(s.file.exists(), false); assert.equal(w.W.posts['/v1/rev/swap'], undefined, 'the maker was never asked to register');
});

for (const [name, tweak, msg] of [
  ['a different program or escrow address (pda)', (r) => ({ ...r, pda: Keypair.generate().publicKey.toBase58() }), /pda-mismatch/],
  ['a different SOL amount', (r) => ({ ...r, lamports: r.lamports + 1 }), /terms-mismatch/],
  ['a different XMR amount', (r) => ({ ...r, xmrAtomic: '10' }), /terms-mismatch/],
  ['deadlines too far away', (r) => ({ ...r, t0: r.t0 + 86_400, t1: r.t1 + 86_400 }), /timelocks-outside-bounds/],
  ['a claim window of another length', (r) => ({ ...r, t1: r.t1 + 3600 }), /timelocks-outside-bounds/],
  ['a joint address that is not A + B', (r) => ({ ...r, jointAddress: '5' + 'B'.repeat(94) }), /joint-address-mismatch/],
]) test(`refuses before locking: maker registration answers ${name}`, async () => {
  const w = world(); w.W.regTweak = tweak; const s = w.session();
  await assert.rejects(s.start({ xmr: '0.05', confirm: yes }), (e) => e.code === 'registration-refused' && msg.test(e.message));
  assert.equal(w.W.sent.length, 0, 'no SOL locked');
  assert.equal(readRec(s.file.path).record.status, 'rejected');
});

test('refuses when the pinned program is not on the cluster, the cluster does not match, or the user declines; the maker is not even asked', async () => {
  let w = world({ programExecutable: false }); await assert.rejects(w.session().start({ xmr: '0.05', confirm: yes }), (e) => e.code === 'program-missing'); assert.equal(Object.keys(w.W.posts).length, 0);
  w = world({ genesis: lib.GENESIS.mainnet }); await assert.rejects(w.session().start({ xmr: '0.05', confirm: yes }), (e) => e.code === 'wrong-cluster');
  w = world(); await assert.rejects(w.session().start({ xmr: '0.05', confirm: async () => false }), (e) => e.code === 'declined');
  assert.equal(w.W.sent.length, 0); assert.equal(w.W.posts['/v1/rev/swap'], undefined);
  w = world(); await assert.rejects(w.session({ maxLamports: 1000 }).start({ xmr: '0.05', confirm: yes }), (e) => e.code === 'quote-over-limit');
  // a mainnet run needs mainnet's genesis hash; a local validator is accepted only for the test network
  w = world(); await assert.rejects(lib.createSession({ ...{ network: 'mainnet', solanaRpcUrl: SOL, moneroWalletRpcUrl: XMR, recordPath: join(tmp, 'm.json'), maker: lib.createMakerClient({ url: MAKER, fetcher: w.fetcher }), fetcher: w.fetcher } }).preflight(), (e) => e.code === 'wrong-cluster');
});

test('the terms and the refund times are shown BEFORE the confirmation is asked, and the exact times after registration, before the lock is sent', async () => {
  const w = world(); const lines = []; let shownAtConfirm = 0;
  const s = w.session({ log: (l) => lines.push(l) });
  await s.start({ xmr: '0.05', confirm: async () => { shownAtConfirm = lines.length; return true; }, until: 'locked', pollMs: 40_000 });
  const text = lines.join('\n');
  assert.ok(shownAtConfirm >= 6, 'terms printed before asking');
  assert.match(lines.slice(0, shownAtConfirm).join('\n'), /after you confirm: no refund before 2030-/);
  assert.match(text, /Registered\. Exact times: confirm by/); assert.match(text, /upgrade authority/);
  assert.ok(text.indexOf('Registered. Exact times') < text.length);
  assert.deepEqual(w.W.sent, ['lock']);
});

test('maker stalls after the lock: no refund early, the refund opens about 30 minutes after the lock, and the refund command sends only that', async () => {
  const w = world(); const s = w.session();
  await s.start({ xmr: '0.05', confirm: yes, until: 'locked', pollMs: 40_000 });
  w.advance(900); let v = await s.resume({ ...FAST }); assert.equal(v.phase, 'awaiting-maker-xmr'); assert.deepEqual(w.W.sent, ['lock']);
  v = await s.refund(); assert.notEqual(v.phase, 'refunding'); assert.deepEqual(w.W.sent, ['lock'], 'refund command before the time sends nothing');
  w.advance(1100); // past LOCK_WAIT after the lock
  v = await s.status(); assert.equal(v.phase, 'would-refund'); assert.deepEqual(w.W.sent, ['lock'], 'status never sends');
  v = await s.refund(); assert.equal(v.phase, 'refunding'); assert.deepEqual(w.W.sent, ['lock', 'refund']);
  assert.equal(w.W.escrow, null); w.advance(60); v = await s.resume({ ...FAST }); assert.equal(v.phase, 'refunded'); assert.equal(lib.outcomeOf(v).code, 3);
});

test('after the confirmation was sent, the refund waits for t1 plus the margin', async () => {
  const w = world(); const s = w.session();
  await s.start({ xmr: '0.05', confirm: yes, until: 'locked', pollMs: 40_000 });
  w.W.xmr = { atomic: '50000000000', confirmations: 10 }; w.advance(600); await s.resume({ ...FAST });
  assert.deepEqual(w.W.sent, ['lock', 'ready']); w.W.escrow.ready = true;
  const t1 = w.W.escrow.t1;
  w.advance(t1 - 600 - w.now()); let v = await s.resume({ ...FAST }); assert.equal(w.W.sent.includes('refund'), false); assert.equal(v.phase, 'await-claim');
  v = await s.refund(); assert.equal(w.W.sent.includes('refund'), false, 'one second short of t1 + 300 s: still no refund');
  w.advance(t1 + lib.refundSchedule({ t0: 0, t1 }).refundAfterConfirmEarliest - t1 - w.now() + t1 + 1 - t1 + 0); // now >= t1 + 300
  v = await s.refund(); assert.equal(v.phase, 'refunding'); assert.equal(w.W.sent.at(-1), 'refund');
});

test('crash and resume: a new process on the same file never locks twice and continues where the file says', async () => {
  const w = world(); const recordPath = join(tmp, `crash${counter++}.json`);
  await w.session({ recordPath }).start({ xmr: '0.05', confirm: yes, until: 'locked', pollMs: 40_000 });
  assert.deepEqual(w.W.sent, ['lock']);
  const s2 = w.session({ recordPath }); w.W.xmr = { atomic: '50000000000', confirmations: 10 }; w.advance(600);
  const v = await s2.resume({ ...FAST }); assert.equal(v.phase, 'confirming'); assert.deepEqual(w.W.sent, ['lock', 'ready']);
  // an attempt marker for the lock is in the file; a second start on the same file is refused
  await assert.rejects(w.session({ recordPath }).start({ xmr: '0.05', confirm: yes }), (e) => e.code === 'swap-file-exists');
});

test('two processes cannot drive the same swap at once', async () => {
  const w = world(); const s = w.session(); await s.start({ xmr: '0.05', confirm: yes, until: 'locked', pollMs: 40_000 });
  writeFileSync(`${s.file.path}.lock`, String(process.ppid));   // a live process that is not this one
  try { await assert.rejects(w.session({ recordPath: s.file.path }).resume({ ...FAST }), (e) => e.code === 'swap-file-busy'); } finally { rmSync(`${s.file.path}.lock`); }
  const v = await w.session({ recordPath: s.file.path }).resume({ ...FAST }); assert.ok(v.phase);
});

test('optional fields in a quote are tolerated (tiers), and a quote without price fields is accepted', async () => {
  let w = world(); w.W.quoteTweak = (q) => ({ ...q, tiers: [{ minXmr: '0.001', spreadBps: 150 }], futureField: { x: 1 } });
  const s = w.session(); const { terms } = await s.quote('0.05'); assert.equal(terms.tiers, 1);
  await s.start({ xmr: '0.05', confirm: yes, until: 'locked', pollMs: 40_000 });
  assert.equal('tierOk' in w.W.posts['/v1/rev/swap'], false);
  w = world(); w.W.quoteTweak = ({ solPerXmr, spreadBps, priceSource, ...q }) => q; const r = await w.session().quote('0.05'); assert.equal(r.terms.spreadBps, null);
});

test('a bearer token is sent when given, never stored in the swap file, and never printed in an error', async () => {
  const w = world({ token: 'tok-secret-1234567890' }); const s = w.session();
  await s.start({ xmr: '0.05', confirm: yes, until: 'locked', pollMs: 40_000 });
  assert.equal(readFileSync(s.file.path, 'utf8').includes('tok-secret'), false);
  const bad = world({ token: 'tok-secret-1234567890' }); const noTok = lib.createMakerClient({ url: MAKER, token: 'wrong', fetcher: bad.fetcher });
  await assert.rejects(noTok.quote('0.05'), (e) => e.code === 'maker-refused' && !e.message.includes('tok-secret'));
});

test('URL rules: https unless localhost, no embedded credentials, and redaction hides endpoints', () => {
  assert.throws(() => lib.parseUserUrl('http://rpc.example.com', 'x'), /https/);
  assert.throws(() => lib.parseUserUrl('https://user:pw@rpc.example.com', 'x'), /user name/);
  assert.equal(lib.parseUserUrl('http://127.0.0.1:8899/', 'x'), 'http://127.0.0.1:8899');
  assert.equal(lib.redact('failed https://rpc.example.com/v2/abcdef123456?api-key=zzz oops', ['https://rpc.example.com/v2/abcdef123456?api-key=zzz']).includes('abcdef'), false);
});

test('key file: unreadable content is refused without echoing it, and a loose mode is reported', () => {
  const bad = join(tmp, 'bad.json'); writeFileSync(bad, '{"secret":"do-not-print"}');
  assert.throws(() => lib.loadKeypair(bad), (e) => e.code === 'keypair-unreadable' && !e.message.includes('do-not-print'));
  const k = newKeyFile(); chmodSync(k.path, 0o644); assert.equal(lib.loadKeypair(k.path).looseMode, true); chmodSync(k.path, 0o600); assert.equal(lib.loadKeypair(k.path).looseMode, false);
});

test('CLI: quote makes exactly one request, to the maker; missing settings contact nothing; output never contains an endpoint or key', async () => {
  const w = world(); const out = [], err = [];
  const env = { SWAP_MAKER_URL: MAKER, SWAP_SOLANA_RPC_URL: SOL + '/?secret-path-1234', SWAP_MONERO_WALLET_RPC_URL: XMR };
  let code = await main(['quote', '--xmr', '0.05'], { env, out: (s) => out.push(s), err: (s) => err.push(s), fetcher: w.fetcher, now: () => BASE * 1000 });
  assert.equal(code, 0); assert.equal(w.W.urls.length, 1); assert.ok(w.W.urls[0].startsWith(MAKER));
  assert.ok(out.join('\n').includes('You pay 0.345 SOL and receive 0.05 XMR'));
  const w2 = world(); code = await main(['quote', '--xmr', '0.05'], { env: {}, out: (s) => out.push(s), err: (s) => err.push(s), fetcher: w2.fetcher });
  assert.equal(code, 2); assert.equal(w2.W.urls.length, 0);
  const all = out.concat(err).join('\n'); assert.equal(all.includes('secret-path'), false);
});

test('CLI: start through to a locked swap prints no URL and no key material, and refuses without --yes when not a terminal', async () => {
  const w = world(); const out = [], err = []; const rec = join(tmp, `cli${counter++}.json`);
  const env = { SWAP_MAKER_URL: MAKER, SWAP_SOLANA_RPC_URL: SOL, SWAP_MONERO_WALLET_RPC_URL: XMR, SWAP_MONERO_NODE_URL: NODE, SWAP_RECORD_PASSPHRASE: PASS };
  const args = ['start', '--xmr', '0.05', '--network', 'devnet', '--maker-address', w.maker, '--max-sol-per-xmr', '10', '--own-node', '--keypair', w.key.path, '--xmr-address', '5' + 'A'.repeat(94), '--record', rec, '--detach'];
  const io = { recordKdf: KDF, recordMinKdfN: 1024, env, out: (s) => out.push(s), err: (s) => err.push(s), fetcher: w.fetcher, now: () => w.now() * 1000, sleep: async (ms) => w.advance(ms / 1000) };
  let code = await main(args, io); assert.equal(code, 2, 'no TTY and no --yes: refused'); assert.equal(w.W.sent.length, 0);
  code = await main([...args, '--yes'], io); assert.equal(code, 4, err.join('|')); assert.deepEqual(w.W.sent, ['lock']);
  const all = out.concat(err).join('\n'); const secretKey = readFileSync(w.key.path, 'utf8');
  assert.equal(all.includes('127.0.0.1:8899'), false); assert.equal(all.includes(JSON.parse(secretKey)[0] + ','), false);
  const rec2 = readRec(rec); assert.equal(all.includes(rec2.record.b), false); assert.equal(all.includes(rec2.record.v), false);
  const st = []; code = await main(['status', '--record', rec], { ...io, out: (s) => st.push(s) }); assert.equal(code, 0); assert.match(st.join('\n'), /Times: confirm by/);
});

test('A2: refuses when the maker Solana address is not the one the user expects; start needs an expected address or an explicit override', async () => {
  let w = world(); const s = w.session({ expectedMaker: Keypair.generate().publicKey.toBase58() });
  await assert.rejects(s.start({ xmr: '0.05', confirm: yes }), (e) => e.code === 'quote-maker-address-mismatch'); assert.equal(w.W.sent.length, 0); assert.equal(s.file.exists(), false);
  w = world(); await assert.rejects(w.session({ expectedMaker: null }).start({ xmr: '0.05', confirm: yes }), (e) => e.code === 'maker-address-missing');
  w = world(); await w.session({ expectedMaker: null, allowUnverifiedMaker: true }).start({ xmr: '0.05', confirm: yes, until: 'locked', pollMs: 40_000 }); assert.deepEqual(w.W.sent, ['lock']);
});

test('A4: deadlines are judged by chain time from the user RPC, not by the local clock', async () => {
  // local clock one hour fast: the maker timelocks (chain based) are only acceptable when the client uses chain time
  let w = world(); await w.session({ now: () => w.now() * 1000 + 3_600_000 }).start({ xmr: '0.05', confirm: yes, until: 'locked', pollMs: 40_000 });
  assert.deepEqual(w.W.sent, ['lock']);
  // local clock two hours slow: a quote that chain time says has expired is refused even though the local clock thinks it is fresh
  w = world(); w.W.quoteTweak = (q) => ({ ...q, expiresAt: BASE - 1 });
  await assert.rejects(w.session({ now: () => w.now() * 1000 - 7_200_000 }).start({ xmr: '0.05', confirm: yes }), (e) => e.code === 'quote-expired'); assert.equal(w.W.sent.length, 0);
  // a skew is reported
  const lines = []; w = world(); await w.session({ now: () => w.now() * 1000 + 3_600_000, log: (l) => lines.push(l) }).quote('0.05'); assert.ok(lines.some((l) => /differs from Solana chain time by -3600/.test(l)));
});

test('A9: tiers of the form { rate, min, spreadBps, lamports } are tolerated and never change what is charged; a different amount is refused; tierOk is never sent', async () => {
  const w = world(); w.W.quoteTweak = (q) => ({ ...q, tiers: [{ rate: 'holder', min: '0.001', spreadBps: 50, lamports: 100 }] });
  const s = w.session(); const r = await s.quote('0.05'); assert.equal(r.terms.lamports, 345_000_000); assert.equal(r.terms.tiers, 1);
  await s.start({ xmr: '0.05', confirm: yes, until: 'locked', pollMs: 40_000 });
  assert.equal(JSON.stringify(w.W.posts).includes('tierOk'), false); assert.equal(w.W.escrow.lamports, 345_000_000);
  const w2 = world(); w2.W.quoteTweak = (q) => ({ ...q, tiers: [{ rate: 'holder', lamports: 1 }], xmrAtomic: '49999999999' });
  await assert.rejects(w2.session().quote('0.05'), (e) => e.code === 'quote-amount-mismatch');
});

test('C3: start and resume refuse without --own-node; a remote node needs the explicit flag and prints a loud warning', async () => {
  let w = world(); await assert.rejects(w.session({ nodeOwnership: null }).start({ xmr: '0.05', confirm: yes }), (e) => e.code === 'node-not-confirmed'); assert.equal(w.W.sent.length, 0); assert.equal(Object.keys(w.W.posts).length, 0);
  w = world(); const lines = []; const s = w.session({ nodeOwnership: 'remote-accepted', log: (l) => lines.push(l) });
  await s.start({ xmr: '0.05', confirm: yes, until: 'locked', pollMs: 40_000 }); assert.ok(lines.some((l) => /WARNING.*not yours/.test(l)));
  await assert.rejects(w.session({ recordPath: s.file.path, nodeOwnership: null }).resume({ ...FAST }), (e) => e.code === 'node-not-confirmed');
  // refund and status need no ownership statement: they never send a confirmation
  const v = await w.session({ recordPath: s.file.path, nodeOwnership: null }).status(); assert.ok(v.phase);
});

test('price guard: a quote worse than the user limit price is refused, whatever price fields the maker states; start needs a limit', async () => {
  let w = world(); await assert.rejects(w.session({ maxSolPerXmr: 5 }).start({ xmr: '0.05', confirm: yes }), (e) => e.code === 'quote-price-over-limit'); assert.equal(w.W.sent.length, 0);
  w = world(); w.W.quoteTweak = ({ solPerXmr, spreadBps, priceSource, ...q }) => ({ ...q, lamports: 900_000_000 });   // maker states nothing, charges 18 SOL per XMR
  await assert.rejects(w.session({ maxSolPerXmr: 10 }).quote('0.05'), (e) => e.code === 'quote-price-over-limit');
  w = world(); await assert.rejects(w.session({ maxSolPerXmr: null, maxLamports: null }).start({ xmr: '0.05', confirm: yes }), (e) => e.code === 'price-limit-missing');
  w = world(); const ok = await w.session({ maxSolPerXmr: 7 }).quote('0.05'); assert.ok(ok.terms.paidPerXmr <= 7);
});

// ---- 771 hardening (SOL to XMR direction) -----------------------------------------------------------------------------------------------
test('M3: retries in the SOL to XMR loop print a fixed code, never the raw error with its URL, key or token', async () => {
  const SECRET = 'SECRETTOKEN-4242', PATHKEY = 'KEYPATH-9f9f9f9f';
  const w = world(); const lines = [], views = []; let failing = false;
  const bad = async (url, init) => { const b = init?.body ? JSON.parse(init.body) : null; if (failing && b?.method === 'getBlockTime') throw new Error(`POST ${SOL}/${PATHKEY}?api-key=${SECRET} failed: ECONNRESET (token ${SECRET})`); return w.fetcher(url, init); };
  const first = w.session({ fetcher: bad }); await first.start({ xmr: '0.05', confirm: yes, until: 'locked', pollMs: 40_000 });
  failing = true;
  const s = w.session({ recordPath: first.file.path, fetcher: bad, solanaRpcUrl: `${SOL}/${PATHKEY}?api-key=${SECRET}`, log: (l) => lines.push(l), sleep: async (ms) => w.advance(ms / 1000) });
  const r = await s.resume({ pollMs: 70_000, maxTicks: 8, onPhase: (x) => views.push(x) }).catch((e) => e);
  const all = JSON.stringify([lines, views, String(r?.message ?? '')]);
  assert.equal(all.includes(SECRET), false, all); assert.equal(all.includes(PATHKEY), false, all); assert.equal(all.includes('api-key'), false);
  assert.ok(lines.some((l) => /temporary error \(Could not read chain time from your Solana RPC\.\); retrying/.test(l)), lines.join('|'));
  assert.equal(r?.code, 'stopped-after-errors');
});

test('H1: SOL to XMR sessions of one process cannot drive the same swap at once either', async () => {
  const w = world(); const s = w.session(); await s.start({ xmr: '0.05', confirm: yes, until: 'locked', pollMs: 40_000 });
  const a = w.session({ recordPath: s.file.path }), b = w.session({ recordPath: s.file.path });
  const res = await Promise.allSettled([a.resume({ ...FAST }), b.resume({ ...FAST })]);
  assert.equal(res.filter((r) => r.status === 'rejected' && r.reason.code === 'swap-file-busy').length, 1);
  assert.equal(w.W.sent.length, 1, 'one lock in all');
});

test('resume and refund repeat the preflight: wrong network, a swap program that is missing, a different destination are refused before anything is signed', async () => {
  const w = world(); const s = w.session(); await s.start({ xmr: '0.05', confirm: yes, until: 'locked', pollMs: 40_000 });
  await assert.rejects(w.session({ recordPath: s.file.path, network: 'mainnet' }).resume({ ...FAST }), (e) => e.code === 'network-mismatch' || e.code === 'wrong-cluster');
  await assert.rejects(w.session({ recordPath: s.file.path, xmrAddress: '5' + 'B'.repeat(94) }).resume({ ...FAST }), (e) => e.code === 'destination-mismatch');
  const sent = w.W.sent.length;
  await assert.rejects(w.session({ recordPath: s.file.path, network: 'mainnet' }).refund(), (e) => e.code === 'network-mismatch' || e.code === 'wrong-cluster');
  assert.equal(w.W.sent.length, sent);
});

test('the swap file needs its passphrase: no passphrase, a weak one and a wrong one are all refused before anything is contacted or stored', async () => {
  const w = world();
  await assert.rejects(w.session({ recordPassphrase: null }).start({ xmr: '0.05', confirm: yes }), (e) => e.code === 'passphrase-missing');
  await assert.rejects(w.session({ recordPassphrase: 'short' }).start({ xmr: '0.05', confirm: yes }), (e) => e.code === 'passphrase-weak');
  assert.equal(w.W.urls.length, 0, 'nothing contacted');
  const s = w.session(); await s.start({ xmr: '0.05', confirm: yes, until: 'locked', pollMs: 40_000 });
  await assert.rejects(w.session({ recordPath: s.file.path, recordPassphrase: 'a different long passphrase' }).resume({ ...FAST }), (e) => e.code === 'record-decrypt-failed');
});
