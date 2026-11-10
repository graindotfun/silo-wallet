// Admission gate (VBU-M1) and ambiguous-lock tests. Spec: MAKER_ADMISSION_GATE_SPEC.md, acceptance tests T1 to T9 (T10 is the stagenet and
// devnet end-to-end run, not part of this file), T11 to T15, and Astra round 1 of PR 697 (AG-H1, AG-H2, AG-M1, K4 items). Every side
// effect is injected or confined to a temporary directory; the only network is loopback (fake RPC and fake maker status servers).
import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, accessSync, readFileSync, readdirSync, realpathSync, appendFileSync, constants } from 'node:fs';
import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Keypair, PublicKey, Transaction, SystemProgram, Connection, VersionedTransaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import http from 'node:http';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import { createAdmission, createAdmissionSerial, admitSwap, classifyRecord, resolveLock, lockStage, makerStep, createStartGate, LOCK_FORMAT, K4_HEIGHT_MARGIN, K4_TIME_MARGIN_S, EXPIRY_MARGIN, NEVER_LANDED_RECHECK_S } from './maker-core.mjs';
import { quiesceVerdict, classifyEscrows, bindingCheck, generationCheck, recordProblem, boundaryHeight, runCheck, MAINNET_GENESIS, SWAP_PROGRAM } from './quiesce-check.mjs';
import { prepareSigned, broadcastSigned, rpcClient, chainSnapshot, collectEvidence } from './maker-chain.mjs';
import * as sol from '../client/sol.mjs';

const realFs = { statSync, accessSync, W_OK: constants.W_OK };
const tmp = () => mkdtempSync(join(tmpdir(), 'gate-'));
const errno = (code) => Object.assign(new Error(code), { code });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sigOf = (id) => bs58.encode(Buffer.from(createHash('sha256').update(`sig:${id}`).digest()));
const BH = Keypair.generate().publicKey.toBase58();   // any 32-byte base58 value serves as a blockhash in the fakes

// ---- the gate itself ----
test('T1/T6: drain file present means closed, also for a fresh reader (restart); removing it reopens', () => {
  const d = tmp(), file = join(d, 'ADMISSION_CLOSED');
  const a = createAdmission({ file, fs: realFs });
  assert.equal(a.isOpen(), true);
  writeFileSync(file, '');
  assert.deepEqual(a.state(), { open: false, reason: 'drain-file-present' });
  assert.equal(createAdmission({ file, fs: realFs }).isOpen(), false, 'a restarted maker still reads it closed');
  rmSync(file); assert.equal(a.isOpen(), true);
});
test('T7 / R5: any stat error other than ENOENT is closed (fail closed)', () => {
  for (const code of ['EACCES', 'EPERM', 'ENOTDIR', 'EIO', undefined]) {
    const a = createAdmission({ file: '/etc/swapmaker/ADMISSION_CLOSED', fs: { statSync: () => { throw errno(code); }, accessSync: () => {}, W_OK: 2 } });
    assert.equal(a.isOpen(), false, String(code));
  }
});
test('R1: on mainnet the drain directory must be unwritable by the maker; writable or missing keeps admission closed', () => {
  const enoent = () => { throw errno('ENOENT'); };
  const mk = (access) => createAdmission({ file: '/etc/swapmaker/ADMISSION_CLOSED', requireUnwritableDir: true, fs: { statSync: enoent, accessSync: access, W_OK: 2 } });
  assert.deepEqual(mk(() => {}).state(), { open: false, reason: 'drain-dir-writable-by-maker' });
  assert.equal(mk(() => { throw errno('ENOENT'); }).isOpen(), false, 'missing directory');
  for (const code of ['EACCES', 'EPERM', 'EROFS']) assert.equal(mk(() => { throw errno(code); }).isOpen(), true, code);
  // a real writable temp dir (the default STATE path on a test network) is refused once the mainnet rule applies
  const d = tmp(); assert.equal(createAdmission({ file: join(d, 'X'), fs: realFs, requireUnwritableDir: true }).isOpen(), false);
});
test('the gate is read live, never cached: with the start gate open and its address check cached for the process life, a new file closes admission at the next call', async () => {
  const OWNER = '8' + 'B'.repeat(94), L = { perSwap: 1n, perDay: 1n, open: 1 }; let calls = 0;
  const g = createStartGate({ network: 'mainnet', sweepTo: OWNER, token: 'x'.repeat(48), caps: L, limits: L, validate: async () => { calls++; return { valid: true, nettype: 'mainnet', integrated: false }; } });
  await g.check(); await g.check(); assert.equal(calls, 1); assert.equal(g.isOpen(), true);
  const d = tmp(), file = join(d, 'ADMISSION_CLOSED'), a = createAdmission({ file, fs: realFs });
  const accepting = () => g.isOpen() && a.isOpen();
  assert.equal(accepting(), true); writeFileSync(file, ''); assert.equal(accepting(), false); assert.equal(g.isOpen(), true, 'start gate unaffected');
});
test('R2: every closed read drops issued quotes', () => {
  const d = tmp(), file = join(d, 'ADMISSION_CLOSED'), quotes = new Map([['q', 1]]);
  const a = createAdmission({ file, fs: realFs, onClosed: () => quotes.clear() });
  a.isOpen(); assert.equal(quotes.size, 1); writeFileSync(file, ''); a.isOpen(); assert.equal(quotes.size, 0);
});

// ---- admission path ----
function harness(over = {}) {
  const d = tmp(), file = join(d, 'ADMISSION_CLOSED'), quotes = new Map(), stored = [], sent = [];
  const admission = createAdmission({ file, fs: realFs, onClosed: () => quotes.clear() });
  const serial = createAdmissionSerial();
  const deps = {
    isOpen: () => admission.isOpen(),
    takeQuote: (id) => { const q = quotes.get(id); if (!q) throw new Error('quote-expired'); quotes.delete(id); return q; },
    checkLimits: () => {},
    prepare: over.prepare ?? (async (q) => ({ record: { swapId: q.swapId, lockFormat: LOCK_FORMAT, lockSig: 'SIG' + q.swapId, lockBlockhash: 'BH', lockLastValidBlockHeight: 100 }, signed: { sig: 'SIG' + q.swapId } })),
    store: (s) => stored.push(structuredClone(s)),
    broadcast: over.broadcast ?? (async (signed, s) => { sent.push(signed.sig); s.solLocked = true; return { swapId: s.swapId }; }),
  };
  const start = (quoteId) => serial.run(() => admitSwap({ quoteId }, deps));
  return { file, quotes, stored, sent, serial, start, admission, close: () => writeFileSync(file, '') };
}
test('T1: drain file present: a swap is refused with maker-paused, nothing stored, nothing sent', async () => {
  const h = harness(); h.quotes.set('q1', { swapId: 'a1' }); h.close();
  await assert.rejects(h.start('q1'), /quote-expired|maker-paused/); assert.equal(h.stored.length, 0); assert.equal(h.sent.length, 0);
});
test('T2: file created between quote and swap: the swap is refused and the issued quote is gone', async () => {
  const h = harness(); h.quotes.set('q1', { swapId: 'a1' });
  h.close(); h.admission.isOpen();            // the loop tick (or any request) reads it closed
  assert.equal(h.quotes.size, 0, 'issued quote dropped');
  await assert.rejects(h.start('q1'), /quote-expired/); assert.equal(h.stored.length, 0);
});
test('T3 / R4: file created while an admission waits inside prepare: refused at the last check, no swap file, no lock', async () => {
  let release; const gateOpen = new Promise((r) => { release = r; });
  const h = harness({ prepare: async (q) => { await gateOpen; return { record: { swapId: q.swapId }, signed: { sig: 'S' } }; } });
  h.quotes.set('q1', { swapId: 'a1' });
  const p = h.start('q1'); await wait(5);
  assert.deepEqual(h.serial.counts(), { queued: 0, running: 1, inflight: 1 });
  h.close(); release();
  await assert.rejects(p, /maker-paused/); assert.equal(h.stored.length, 0); assert.equal(h.sent.length, 0);
  assert.equal(h.serial.counts().inflight, 0);
});
test('T4: two concurrent swaps run one after the other; queued and running are counted and return to 0', async () => {
  const order = [];
  const h = harness({ prepare: async (q) => { order.push('start-' + q.swapId); await wait(20); order.push('end-' + q.swapId); return { record: { swapId: q.swapId }, signed: { sig: q.swapId } }; } });
  h.quotes.set('q1', { swapId: 'a' }); h.quotes.set('q2', { swapId: 'b' });
  const p1 = h.start('q1'), p2 = h.start('q2'); await wait(5);
  assert.deepEqual(h.serial.counts(), { queued: 1, running: 1, inflight: 2 });
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['start-a', 'end-a', 'start-b', 'end-b']); assert.deepEqual(h.serial.counts(), { queued: 0, running: 0, inflight: 0 });
});
test('R2/R4: an admission queued behind a running one is refused when the file appears meanwhile', async () => {
  let release; const hold = new Promise((r) => { release = r; });
  const h = harness({ prepare: async (q) => { if (q.swapId === 'a') await hold; return { record: { swapId: q.swapId }, signed: { sig: q.swapId } }; } });
  h.quotes.set('q1', { swapId: 'a' }); h.quotes.set('q2', { swapId: 'b' });
  const p1 = h.start('q1'), p2 = h.start('q2'); await wait(5);
  h.close(); release();
  await assert.rejects(p1, /maker-paused/); await assert.rejects(p2, /maker-paused|quote-expired/);
  assert.equal(h.stored.length, 0); assert.equal(h.sent.length, 0);
});
test('ambiguous lock: the record stored before the broadcast already names the lock signature and its expiry', async () => {
  const h = harness({ broadcast: async () => { throw new Error('socket hang up'); } });   // accepted by the RPC, response lost
  h.quotes.set('q1', { swapId: 'a1' });
  await assert.rejects(h.start('q1'), /socket hang up/);
  assert.equal(h.stored.length, 1);
  const r = h.stored[0];
  assert.equal(r.lockSig, 'SIGa1'); assert.equal(r.lockBlockhash, 'BH'); assert.equal(r.lockLastValidBlockHeight, 100); assert.equal(r.solLocked, undefined);
  assert.equal(lockStage(r), 'pending', 'a lost response is pending, never "never locked"');
});

// ---- AG-H1: the real web3.js 1.99.0 serialization path with an intercepted JSON-RPC transport ----
// The Connection is real; only its fetch is replaced, so every payload asserted on is exactly what web3.js would put on the wire.
function interceptedConnection(answer) {
  const calls = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body), reqs = Array.isArray(body) ? body : [body], outs = [];
    for (const r of reqs) { calls.push({ method: r.method, params: r.params }); outs.push({ jsonrpc: '2.0', id: r.id, ...(await answer(r.method, r.params)) }); }
    return new Response(JSON.stringify(Array.isArray(body) ? outs : outs[0]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { conn: new Connection('http://127.0.0.1:9', { commitment: 'confirmed', fetch, disableRetryOnRateLimit: true }), calls };
}
/** Signatures in a wire transaction (base64) that verify for the maker's key over the transaction's own message. */
function validMakerSignatures(b64, maker) {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64')); const msg = tx.message.serialize();
  return tx.signatures.filter((sg) => { try { return ed25519.verify(sg, msg, maker.publicKey.toBytes()); } catch { return false; } }).map((sg) => bs58.encode(sg));
}
const messageBytes = (b64) => Buffer.from(VersionedTransaction.deserialize(Buffer.from(b64, 'base64')).message.serialize()).toString('hex');
const WIRE = new Set(['simulateTransaction', 'sendTransaction']);
async function realAdmission({ simErr = null, closeAfterSimulation = false, storeThrows = false, sendError = 'socket hang up' } = {}) {
  const maker = Keypair.generate(), claimer = Keypair.generate().publicKey, swapId = new Uint8Array(32).fill(7);
  let closed = false, storedAt = null, stored = null;
  const { conn, calls } = interceptedConnection(async (method) => {
    if (method === 'getLatestBlockhash') return { result: { context: { slot: 100 }, value: { blockhash: BH, lastValidBlockHeight: 777 } } };
    if (method === 'simulateTransaction') { if (closeAfterSimulation) closed = true; return { result: { context: { slot: 100 }, value: { err: simErr, logs: ['log'], accounts: null, unitsConsumed: 1000, returnData: null } } }; }
    if (method === 'sendTransaction') return { error: { code: -32000, message: sendError } };   // the RPC took the bytes; the answer is lost
    return { error: { code: -32601, message: `unexpected ${method}` } };
  });
  const prev = sol.conn; sol.setConnection(conn);
  let error = null;
  try {
    await admitSwap({ quoteId: 'q' }, {
      isOpen: () => !closed, takeQuote: () => ({ swapId: hexOf(swapId) }), checkLimits: () => {},
      async prepare() {   // the same steps as maker.mjs prepareSwap: build the lock, prepareSigned, write-ahead fields
        const ixs = [sol.lockIx({ refunder: maker.publicKey, swapId, claimer, claimPoint: new Uint8Array(32).fill(1), refundPoint: new Uint8Array(32).fill(2), lamports: 1000, t0: 10, t1: 20 })];
        const signed = await prepareSigned(ixs, maker);
        return { record: { swapId: hexOf(swapId), b: 'secret', lockFormat: LOCK_FORMAT, lockSig: signed.sig, lockBlockhash: signed.blockhash, lockLastValidBlockHeight: signed.lastValidBlockHeight }, signed };
      },
      store(r) { if (storeThrows) throw new Error('killed before the durable store'); storedAt = calls.length; stored = structuredClone(r); },
      broadcast: (signed) => broadcastSigned(signed),
    });
  } catch (e) { error = e; } finally { sol.setConnection(prev); }
  const wire = calls.map((c, i) => ({ i, method: c.method, tx: WIRE.has(c.method) ? c.params[0] : null, cfg: c.params?.[1] })).filter((c) => c.tx);
  return { maker, calls, wire, storedAt, stored, error };
}
const hexOf = (u8) => Buffer.from(u8).toString('hex');
test('AG-H1: no simulateTransaction or sendTransaction payload carries a valid maker signature before the durable store; one signed variant only', async () => {
  const r = await realAdmission();
  assert.match(String(r.error?.message), /socket hang up/, 'the lost answer surfaces as an error');
  assert.ok(Number.isInteger(r.storedAt), 'the write-ahead record was stored');
  const before = r.wire.filter((c) => c.i < r.storedAt), after = r.wire.filter((c) => c.i >= r.storedAt);
  assert.deepEqual(before.map((c) => c.method), ['simulateTransaction'], 'only the simulation goes out before the store');
  assert.deepEqual(validMakerSignatures(before[0].tx, r.maker), [], 'the simulated bytes carry no valid signature');
  assert.equal(before[0].cfg.sigVerify, false); assert.equal(before[0].cfg.replaceRecentBlockhash, false);
  assert.deepEqual(after.map((c) => c.method), ['sendTransaction']);
  assert.deepEqual(validMakerSignatures(after[0].tx, r.maker), [r.stored.lockSig], 'the broadcast is exactly the recorded signature');
  assert.equal(messageBytes(before[0].tx), messageBytes(after[0].tx), 'the simulation and the broadcast are the same message (same blockhash, no second variant)');
  assert.equal(r.calls.filter((c) => c.method === 'getLatestBlockhash').length, 1, 'one blockhash, fetched once');
  assert.equal(r.stored.lockBlockhash, BH); assert.equal(r.stored.lockLastValidBlockHeight, 777);
});
test('AG-H1: simulation failure, drain close after the simulation, and a crash before the store: no payload ever carries a valid maker signature, nothing sent', async () => {
  for (const [opts, err] of [[{ simErr: { InstructionError: [1, 'Custom'] } }, /simulation refused/], [{ closeAfterSimulation: true }, /maker-paused/], [{ storeThrows: true }, /killed before the durable store/]]) {
    const r = await realAdmission(opts);
    assert.match(String(r.error?.message), err, JSON.stringify(opts));
    assert.equal(r.storedAt, null, 'nothing stored');
    assert.equal(r.wire.filter((c) => c.method === 'sendTransaction').length, 0, 'nothing sent');
    for (const c of r.wire) assert.deepEqual(validMakerSignatures(c.tx, r.maker), [], `${c.method} ${JSON.stringify(opts)}`);
  }
});
test('R10: prepareSigned uses a recent blockhash it fetched itself, signs without sending, and no code path builds a durable-nonce transaction or a signed simulation', async () => {
  const r = await realAdmission({ storeThrows: true });
  assert.deepEqual(r.calls.map((c) => c.method), ['getLatestBlockhash', 'simulateTransaction']);
  const tx = VersionedTransaction.deserialize(Buffer.from(r.wire[0].tx, 'base64'));
  assert.equal(tx.message.recentBlockhash, BH);
  const legacy = Transaction.populate(tx.message);
  assert.equal(legacy.nonceInfo, undefined); assert.ok(!legacy.instructions[0].programId.equals(SystemProgram.programId), 'the first instruction is not a nonce advance');
  const strip = (f) => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const f of ['../client/sol.mjs', './maker.mjs', './maker-chain.mjs', './maker-core.mjs']) assert.doesNotMatch(strip(f), /nonceInfo|NonceAccount|nonceAdvance|advanceNonce|durableNonce/, f);
  assert.doesNotMatch(strip('./maker-chain.mjs'), /simulateTransaction\([^)]*\[/, 'never the signers overload of simulateTransaction');
  assert.doesNotMatch(strip('./maker.mjs'), /simulateTransaction|\.sign\(/, 'maker.mjs never signs or simulates the lock itself');
});

// ---- lock records and classification K0 to K4 (spec revision 2; AG-H2 fresh contexts; AG-M1 non-escrow accounts) ----
const pendingRec = (over = {}) => ({ swapId: 'ab'.repeat(32), createdAt: '2026-11-08T10:00:00.000Z', lockFormat: LOCK_FORMAT, lockSig: 'LockSig1', lockBlockhash: 'BH', lockLastValidBlockHeight: 1000, ...over });
const EXP = 1000 + EXPIRY_MARGIN + 1;
const ev = (over = {}) => ({ expiry: { slot: EXP, height: EXP }, historyIndex: { ok: true }, account: { slot: EXP, kind: 'none' }, history: [], sigStatus: null, sigStatusSlot: EXP, boundary: { started: null, H: null }, ...over });
test('K2: a write-ahead lock is accepted only once it is unknown to the cluster, expired with margin, and every absence answer is fresh', () => {
  assert.equal(classifyRecord(pendingRec(), ev()).k, 'K2');
  const cases = [
    [{ expiry: { slot: EXP, height: EXP - 1 } }, 'lock-may-still-land'], [{ expiry: null }, 'expiry-unobserved'],
    [{ sigStatus: { confirmationStatus: 'confirmed', err: null } }, 'lock-signature-known-to-cluster'], [{ sigStatus: undefined }, 'lock-status-unread'],
    [{ history: [{ signature: 'x', err: null, kind: 'other' }] }, 'pda-has-program-history'], [{ history: [{ signature: 'LockSig1', err: { x: 1 }, kind: 'failed' }] }, 'lock-in-pda-history'],
    [{ history: null }, 'pda-history-unreadable'],
    [{ account: { slot: EXP, kind: 'escrow' } }, 'escrow-at-pda'], [{ account: null }, 'pda-unreadable'], [{ account: { slot: EXP, kind: 'unknown-type' } }, 'unknown-account-at-pda'],
    // AG-H2: an absence answer from a context older than the expiry observation is rejected, never combined with it
    [{ account: { slot: EXP - 1, kind: 'none' } }, 'stale-account-context'], [{ account: { slot: null, kind: 'none' } }, 'stale-account-context'],
    [{ sigStatusSlot: EXP - 1 }, 'stale-status-context'], [{ historyIndex: { ok: false } }, 'history-index-behind-expiry'], [{ historyIndex: undefined }, 'history-index-behind-expiry'],
  ];
  for (const [over, why] of cases) { const c = classifyRecord(pendingRec(), ev(over)); assert.deepEqual([c.k, c.why], [null, why], JSON.stringify(over)); }
});
test('AG-M1: a plain lamport balance at the PDA is reported, not blocking, once the escrow is proven closed or never created; unknown account types block', () => {
  const funded = { slot: EXP, kind: 'non-escrow', owner: SystemProgram.programId.toBase58(), lamports: 5000 };
  const unrelated = [{ signature: 'Gift', err: null, kind: 'unrelated' }, { signature: 'Spam', err: { x: 1 }, kind: 'failed' }];
  assert.deepEqual(classifyRecord(pendingRec(), ev({ account: funded, history: unrelated })).nonEscrow, { owner: funded.owner, lamports: 5000 });
  assert.equal(classifyRecord(pendingRec(), ev({ account: funded, history: unrelated })).k, 'K2');
  assert.equal(classifyRecord({ ...pendingRec(), done: 'refunded' }, ev({ account: funded })).k, 'K0');
  assert.equal(classifyRecord(pendingRec(), ev({ account: funded, history: [...unrelated, { signature: 'L', err: null, kind: 'lock' }, { signature: 'R', err: null, kind: 'refund' }] })).k, 'K1');
  assert.equal(classifyRecord({ ...pendingRec(), done: 'refunded' }, ev({ account: { slot: EXP, kind: 'unknown-type' } })).k, null);
  assert.equal(classifyRecord({ ...pendingRec(), done: 'refunded' }, ev({ account: { slot: EXP, kind: 'escrow' } })).k, null);
});
test('K0, K1, K3: final with no escrow; outcome proven by lock plus claim or refund in the PDA history; aborted before signing', () => {
  assert.equal(classifyRecord({ ...pendingRec(), done: 'completed' }, ev({ history: null })).k, 'K0');
  assert.equal(classifyRecord({ ...pendingRec(), done: 'refunded' }, ev({ account: { slot: EXP, kind: 'escrow' } })).k, null, 'K0 needs no escrow at the PDA');
  assert.equal(classifyRecord({ ...pendingRec(), done: 'refunded' }, ev({ account: { slot: EXP - 5, kind: 'none' } })).why, 'stale-account-context');
  assert.equal(classifyRecord({ ...pendingRec(), done: 'weird' }, ev()).k, null);
  assert.equal(classifyRecord({ ...pendingRec(), done: 'never-locked' }, ev()).k, null, 'no longer written; never accepted');
  const hist = [{ signature: 'REF', err: null, kind: 'refund' }, { signature: 'LCK', err: null, kind: 'lock' }];
  assert.deepEqual(classifyRecord(pendingRec(), ev({ history: hist, expiry: { slot: EXP, height: 10 } })), { k: 'K1', why: 'lock and refund found in the PDA history', txids: ['LCK', 'REF'] });
  assert.equal(classifyRecord(pendingRec(), ev({ history: [{ signature: 'LCK', err: null, kind: 'lock' }, { signature: 'C', err: { x: 1 }, kind: 'failed' }] })).k, null, 'a failed claim proves nothing');
  assert.equal(classifyRecord(pendingRec(), ev({ history: [], historyIndex: { ok: true } })).k, 'K2', 'an empty history is absence evidence only with a fresh index, never positive');
  const aborted = { swapId: 'cd'.repeat(32), createdAt: '2026-11-08T10:00:00.000Z', abortedBeforeSign: { at: 'x', reason: 'y' } };
  assert.equal(classifyRecord(aborted, ev()).k, 'K3'); assert.equal(classifyRecord(aborted, ev({ history: [{ signature: 'x', err: null, kind: 'other' }] })).k, null);
  assert.equal(classifyRecord(aborted, ev({ historyIndex: { ok: false } })).k, null);
});
test('K4: a file without the R9 fields passes only when written before maker-started and the finalized height is above H + 300', () => {
  const old = { swapId: 'ef'.repeat(32), createdAt: '2026-11-07T10:00:00.000Z' };
  const b = { started: '2026-11-08T00:00:00.000Z', H: 5000 }, at = (h) => ({ slot: h, height: h });
  assert.equal(classifyRecord(old, ev({ boundary: b, expiry: at(5000 + K4_HEIGHT_MARGIN + 1), account: { slot: 9999, kind: 'none' } })).k, 'K4');
  assert.equal(classifyRecord(old, ev({ boundary: b, expiry: at(5000 + K4_HEIGHT_MARGIN), account: { slot: 9999, kind: 'none' } })).why, 'process-boundary-not-yet-expired');
  assert.equal(classifyRecord(old, ev({ boundary: { ...b, H: null }, expiry: at(99999), account: { slot: 99999, kind: 'none' } })).k, null);
  assert.equal(classifyRecord({ ...old, createdAt: '2026-11-08T00:00:01.000Z' }, ev({ boundary: b, expiry: at(99999), account: { slot: 99999, kind: 'none' } })).why, 'no-process-boundary', 'written by the current process');
  assert.equal(classifyRecord(old, ev({ boundary: b, expiry: at(99999), account: { slot: 99999, kind: 'none' }, history: [{ signature: 'x', err: null, kind: 'lock' }] })).k, null);
  assert.equal(classifyRecord(old, ev({ boundary: b, expiry: at(99999), account: { slot: 99998, kind: 'none' } })).why, 'stale-account-context');
});
test('T14: regression of the revision 1 rule: an empty lockSig with no account and no K1 to K4 evidence is NOT OK (ambiguous)', () => {
  for (const r of [{ swapId: '11'.repeat(32), createdAt: '2026-11-08T10:00:00.000Z' }, { swapId: '11'.repeat(32), createdAt: '2026-11-08T10:00:00.000Z', lockSig: '' }]) {
    const c = classifyRecord(r, ev({ boundary: { started: null, H: null } })); assert.equal(c.k, null, JSON.stringify(r));
    assert.equal(lockStage(r), 'legacy');
  }
});
test('R10: a record naming a durable nonce never gets K2 or K4', () => {
  assert.equal(classifyRecord(pendingRec({ lockNonce: 'N' }), ev()).why, 'durable-nonce-lock-never-expires');
  assert.equal(classifyRecord({ swapId: 'ef'.repeat(32), createdAt: '2026-11-07T10:00:00.000Z', lockNonce: 'N' }, ev({ boundary: { started: '2026-11-08T00:00:00.000Z', H: 1 }, expiry: { slot: 9999, height: 9999 }, account: { slot: 9999, kind: 'none' } })).k, null);
});
test('maker side: late landing marks the record locked; never-landed needs two coherent observations apart in time and context, stays in recovery; stale or unknown stays pending', async () => {
  const stored = [], log = []; let now = Date.parse('2026-11-08T12:00:00.000Z');
  const io = { store: (s) => stored.push(structuredClone(s)), log: (e) => log.push(e), now: () => now };
  assert.equal((await resolveLock(pendingRec({ b: 'kept' }), { ...io, evidence: async () => ev({ account: { slot: 1, kind: 'escrow' } }) })).state, 'locked', 'an escrow counts in any context');
  assert.equal(stored.at(-1).solLocked, true); assert.equal(log.at(-1).event, 'lock-landed-late');
  assert.equal((await resolveLock(pendingRec({ b: 'kept' }), { ...io, evidence: async () => ev({ expiry: { slot: 5, height: 5 }, sigStatus: { confirmationStatus: 'finalized', err: null } }) })).state, 'locked');
  const r = pendingRec({ b: 'kept' });
  assert.equal((await resolveLock(r, { ...io, evidence: async () => ev() })).why, 'first-observation');
  assert.equal(lockStage(r), 'pending'); assert.equal(r.done, undefined);
  now += NEVER_LANDED_RECHECK_S * 1000;
  assert.equal((await resolveLock(r, { ...io, evidence: async () => ev() })).state, 'pending', 'same context: not a second observation');
  now += 1000; const later = { slot: EXP + 10, height: EXP + 10 };
  assert.equal((await resolveLock(r, { ...io, evidence: async () => ev({ expiry: later, account: { slot: EXP + 10, kind: 'none' }, sigStatusSlot: EXP + 10 }) })).state, 'never-landed');
  assert.equal(lockStage(r), 'never-landed'); assert.equal(r.done, undefined, 'never set done: it stays in the recovery loop'); assert.equal(r.b, 'kept'); assert.equal(r.lockSig, 'LockSig1');
  assert.equal(log.at(-1).event, 'lock-never-landed');
  assert.equal((await resolveLock(r, { ...io, evidence: async () => ev({ account: { slot: 1, kind: 'escrow' } }) })).state, 'locked', 'a later escrow still flips it (alarm)');
  assert.equal(log.at(-1).event, 'lock-landed-after-never-landed'); assert.equal(lockStage(r), 'locked');
  // too soon, and a stale answer between two observations resets the first
  const q = pendingRec(); await resolveLock(q, { ...io, evidence: async () => ev() }); now += 1000;
  assert.equal((await resolveLock(q, { ...io, evidence: async () => ev({ expiry: later, account: { slot: EXP + 10, kind: 'none' }, sigStatusSlot: EXP + 10 }) })).state, 'pending', 'too soon');
  assert.equal((await resolveLock(q, { ...io, evidence: async () => ev({ account: { slot: 1, kind: 'none' } }) })).why, 'stale-account-context');
  assert.equal(q.lockAbsenceSeen, null, 'a stale answer drops the unconfirmed first observation');
  const n = stored.length;
  assert.equal((await resolveLock(pendingRec(), { ...io, evidence: async () => { throw new Error('rpc down'); } })).state, 'pending');
  assert.equal((await resolveLock(pendingRec(), { ...io, evidence: async () => ev({ expiry: { slot: EXP, height: 1001 } }) })).state, 'pending');
  assert.equal(stored.length, n, 'a pending record is not rewritten');
});

// ---- T5: recovery does not depend on admission ----
test('T5: with the drain file present, set-ready, refund and sweep still run (makerStep never reads admission)', async () => {
  const d = tmp(), file = join(d, 'ADMISSION_CLOSED'); writeFileSync(file, '');
  const a = createAdmission({ file, fs: realFs }); assert.equal(a.isOpen(), false);
  const NOW = 1_800_000_000, sent = [];
  const deps = (over) => ({ readSwap: async () => over.pda ?? null, readRevealed: over.readRevealed ?? (async () => null), chainNow: async () => NOW,
    scanXmr: async () => ({ atomic: '5', confirmations: 20 }), sendReady: async () => { sent.push('ready'); return { sig: 'R' }; }, sendRefund: async () => { sent.push('refund'); return { sig: 'F' }; },
    sweep: async () => { sent.push('sweep'); return ['t']; }, store: () => {}, log: () => {}, sweepAllowed: () => true /* start gate only */ });
  const s = () => ({ swapId: 'ef'.repeat(32), A: 'aa', B: 'bb', b: '00', lockedAt: NOW - 600, xmrAtomic: '5', solLocked: true });
  await makerStep(s(), deps({ pda: { ready: false, t0: NOW + 3600, t1: NOW + 10800 } }));
  await makerStep(s(), deps({ pda: { ready: false, t0: NOW - 10, t1: NOW - 60 } }));
  await makerStep(s(), deps({ readRevealed: async (w) => (w === 'claim' ? { secretHex: '11', sig: 'C' } : null) }));
  assert.deepEqual(sent, ['ready', 'refund', 'sweep']);
});
test('wiring: sweepAllowed stays tied to the start gate only; the last check sits right before store with no await; the lock is never sent before the store; never-landed stays in recovery', () => {
  const src = readFileSync(new URL('./maker.mjs', import.meta.url), 'utf8');
  assert.match(src, /sweepAllowed: \(\) => gate\.isOpen\(\)/); assert.doesNotMatch(src, /sweepAllowed:[^\n]*admission/);
  assert.doesNotMatch(src, /sendAndConfirmTransaction|sol\.send\(ixs/, 'the lock goes only through prepareSigned + broadcastSigned');
  const core = readFileSync(new URL('./maker-core.mjs', import.meta.url), 'utf8');
  const body = core.slice(core.indexOf('export async function admitSwap'), core.indexOf('// ---- Lock records and their classification'));
  const tail = body.slice(body.lastIndexOf('await d.prepare'));
  assert.match(tail, /if \(!d\.isOpen\(\)\) throw new Error\('maker-paused'\);[^\n]*\n\s*d\.store\(record\);\n\s*return d\.broadcast/);
  const code = tail.split('\n').slice(1).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.doesNotMatch(code.slice(0, code.indexOf('d.store(record)')), /await/, 'no await between the last check and store');
  assert.match(src, /lockFormat: LOCK_FORMAT, lockSig: signed\.sig, lockBlockhash: signed\.blockhash, lockLastValidBlockHeight: signed\.lastValidBlockHeight/);
  assert.doesNotMatch(src, /lockSig = (null|undefined|'')|delete s\.lockSig/, 'lockSig is never cleared');
  assert.match(src, /log\(\{ event: 'maker-started', at: startedAt, generation/);
  assert.match(src, /log\(\{ event: 'swap-recorded', swapId: s\.swapId \}\)/);
  assert.doesNotMatch(src + core, /done = 'never-locked'|done: 'never-locked'/, 'a never-landed lock is never closed as done');
  assert.match(src, /filter\(\(s\) => !s\.done\)/, 'the recovery loop takes every record that is not done');
});

// ---- T9: quiesce check verdict ----
const makerKey = Keypair.generate().publicKey.toBase58();
const okStatus = { admission: 'closed', inflight: 0, queued: 0, running: 0, openCount: 0, programId: SWAP_PROGRAM, network: 'mainnet', maker: makerKey, stateDir: '/s', generation: 'g1', startedAt: '2026-11-08T00:00:00.000Z' };
const okBase = { status: okStatus, classes: [{ id: 'aa', k: 'K0', why: '' }, { id: 'bb', k: 'K2', why: '' }], chain: { ours: [], foreign: [], undecodable: [], strictAll: [] }, binding: { ok: true, why: '' }, generation: { ok: true, why: '' } };
test('T9: quiesce OK only for a closed maker with nothing in flight, classified files and no maker escrow; strangers do not block', () => {
  assert.deepEqual(quiesceVerdict(okBase), { ok: true, problems: [] });
  assert.equal(quiesceVerdict({ ...okBase, chain: { ours: [], foreign: [{ pubkey: 'S', refunder: 'X', t0: 1, t1: 2, ready: false }], undecodable: [], strictAll: [] } }).ok, true);
});
test('T9: in-flight, open admission, an unclassified file, a maker escrow, unreadable input, wrong genesis, program, state dir or process each block', () => {
  const bad = [
    { status: { ...okStatus, inflight: 1 } }, { status: { ...okStatus, inflight: undefined } }, { status: { ...okStatus, admission: 'open' } }, { status: null },
    { classes: [{ id: 'cc', k: null, why: 'ambiguous' }] }, { classes: null },
    { chain: { ours: ['K'.repeat(44)], foreign: [], undecodable: [], strictAll: [] } }, { chain: { ours: [], foreign: [], undecodable: ['U'], strictAll: [] } }, { chain: null },
    { chain: { ours: [], foreign: [], undecodable: [], strictAll: ['S'] } }, { chain: { ours: [], foreign: [], undecodable: [] } },
    { binding: { ok: false, why: 'x' } }, { generation: { ok: false, why: 'x' } }, { generation: undefined }, { missing: ['ab'.repeat(32)] },
  ];
  for (const b of bad) assert.equal(quiesceVerdict({ ...okBase, ...b }).ok, false, JSON.stringify(b));
  const bind = (over) => bindingCheck({ genesis: MAINNET_GENESIS, program: SWAP_PROGRAM, status: okStatus, makerKey, stateDir: '/s', ...over });
  assert.match(bind({ genesis: 'other' }).why, /not mainnet/);
  assert.match(bind({ program: 'Other111' }).why, /not the swap program/);
  assert.equal(bind({ status: { ...okStatus, maker: 'someone' } }).ok, false);
  assert.equal(bind({ status: { ...okStatus, network: 'devnet' } }).ok, false);
  assert.match(bind({ stateDir: '/other' }).why, /different state directory/); assert.equal(bind({ stateDir: undefined }).ok, false);
  assert.equal(bind({}).ok, true);
  const started = { at: okStatus.startedAt, generation: 'g1' };
  assert.equal(generationCheck({ started, first: okStatus, last: okStatus }).ok, true);
  assert.equal(generationCheck({ started: { ...started, generation: 'g0' }, first: okStatus, last: okStatus }).ok, false, 'journal from another process');
  assert.equal(generationCheck({ started: { ...started, at: '2026-11-08T00:00:01.000Z' }, first: okStatus, last: okStatus }).ok, false);
  assert.equal(generationCheck({ started, first: okStatus, last: { ...okStatus, generation: 'g2' } }).ok, false, 'restart during the check');
  assert.equal(generationCheck({ started, first: okStatus, last: { ...okStatus, inflight: 1 } }).ok, false);
  assert.equal(generationCheck({ started, first: okStatus, last: null }).ok, false);
  assert.equal(generationCheck({ started: { at: started.at, generation: null }, first: okStatus, last: okStatus }).ok, false);
});
test('K4 items: swap file schema; only skipped slots are stepped over by the boundary search', async () => {
  const good = { swapId: 'ab'.repeat(32), createdAt: '2026-11-08T10:00:00.000Z', lockSig: sigOf('x'), lockBlockhash: BH, lockLastValidBlockHeight: 5, solLocked: false, xmrAtomic: '10' };
  assert.equal(recordProblem(good, good.swapId), null);
  for (const [over, why] of [[{ swapId: 'AB' }, /swapId/], [{ createdAt: 'yesterday' }, /createdAt/], [{ lockSig: 'O0Il' }, /lockSig/], [{ lockLastValidBlockHeight: '5' }, /lockLastValidBlockHeight/],
    [{ done: 'never-locked' }, /done/], [{ solLocked: 'yes' }, /solLocked/], [{ xmrAtomic: 10 }, /xmrAtomic/], [{ lockBlockhash: 'BH' }, /lockBlockhash/]])
    assert.match(String(recordProblem({ ...good, ...over }, good.swapId)), why, JSON.stringify(over));
  assert.match(recordProblem(good, 'cd'.repeat(32)), /file name/); assert.match(recordProblem([], undefined), /not an object/);
  // slot n has blockTime 1000 + n; the search reads slot 68 first (window [tip - 32, tip]), which fails in the way given
  const rpcWith = (fail) => async (_m, [slot]) => { if (slot === 68) throw Object.assign(new Error(fail.message), { code: fail.code }); return { blockHeight: slot, blockTime: 1000 + slot }; };
  const started = new Date((1000 + 40 - K4_TIME_MARGIN_S) * 1000).toISOString();
  assert.equal((await boundaryHeight(rpcWith({ code: -32007, message: 'Slot 68 was skipped' }), started, 100))?.H, 40);
  for (const fail of [{ code: -32009, message: 'missing in long-term storage' }, { code: 429, message: 'rate limited' }, { code: undefined, message: 'socket hang up' }])
    assert.equal(await boundaryHeight(rpcWith(fail), started, 100), null, fail.message);
});
const SWAP_TAG = createHash('sha256').update('account:Swap').digest().subarray(0, 8);
function escrowData({ refunder, claimer = Keypair.generate().publicKey, t0 = 5, t1 = 9, ready = 0 }) {
  const b = Buffer.alloc(sol.SWAP_ACCOUNT_LEN); SWAP_TAG.copy(b, 0); refunder.toBuffer().copy(b, 8); claimer.toBuffer().copy(b, 40);
  b.writeBigInt64LE(BigInt(t0), 8 + 136); b.writeBigInt64LE(BigInt(t1), 8 + 144); b[8 + 152] = ready; return b.toString('base64');
}
test('T9: escrows with the maker as refunder (offset 8) or claimer (offset 40) block; strangers are listed with refunder, t0, t1, ready; undecodable block', () => {
  const me = new PublicKey(makerKey), other = Keypair.generate().publicKey;
  const c = classifyEscrows([{ pubkey: 'MINE', data: escrowData({ refunder: me }) }, { pubkey: 'CLAIMER', data: escrowData({ refunder: other, claimer: me }) },
    { pubkey: 'THEIRS', data: escrowData({ refunder: other, ready: 1 }) }, { pubkey: 'JUNK', data: Buffer.alloc(sol.SWAP_ACCOUNT_LEN).toString('base64') }], makerKey);
  assert.deepEqual(c.ours, ['MINE', 'CLAIMER']); assert.deepEqual(c.undecodable, ['JUNK']);
  assert.deepEqual(c.foreign, [{ pubkey: 'THEIRS', refunder: other.toBase58(), t0: 5, t1: 9, ready: true }]);
});

// ---- T8: the real maker process: /v1/status needs the token; /v1/health shows accepting false when closed and no swap details ----
test('T8: /v1/status refuses a missing or wrong token; health and quote follow the drain file live, without a restart', async (t) => {
  const state = tmp(); mkdirSync(join(state, 'swaps'));
  writeFileSync(join(state, 'maker-sol.json'), JSON.stringify([...Keypair.generate().secretKey]));   // throwaway test key in a temp dir
  writeFileSync(join(state, 'wallet-password'), 'test-only');
  const token = 't'.repeat(48), port = 38000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./maker.mjs', import.meta.url))], {
    env: { PATH: process.env.PATH, MAKER_STATE: state, MAKER_PORT: String(port), MAKER_API_TOKEN: token, XMR_NETWORK: 'stagenet', SOL_RPC: 'http://127.0.0.1:9', MAKER_WALLET_RPC: 'http://127.0.0.1:9/json_rpc', XMR_DAEMON: 'http://127.0.0.1:9/json_rpc', LOOP_MS: '3600000' },
    stdio: 'ignore',
  });
  t.after(() => { child.kill(); rmSync(state, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { await fetch(`${url}/v1/health`); break; } catch { await wait(50); } }
  assert.equal((await fetch(`${url}/v1/status`)).status, 401);
  assert.equal((await fetch(`${url}/v1/status`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  const status = async () => (await fetch(`${url}/v1/status`, { headers: { authorization: `Bearer ${token}` } })).json();
  const health = async () => (await fetch(`${url}/v1/health`)).json();
  let s = await status(); assert.equal(s.admission, 'open'); assert.equal(s.inflight, 0); assert.equal(s.network, 'stagenet'); assert.equal(typeof s.maker, 'string'); assert.equal(typeof s.programId, 'string');
  assert.equal(s.stateDir, realpathSync(state)); assert.match(s.generation, /^[0-9a-f]{32}$/);
  const started = readFileSync(join(state, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event === 'maker-started');
  assert.deepEqual([started.at, started.generation], [s.startedAt, s.generation], 'the journal names the serving process');
  assert.equal((await health()).accepting, true);
  writeFileSync(join(state, 'ADMISSION_CLOSED'), '');
  s = await status(); assert.equal(s.admission, 'closed'); assert.equal(s.admissionReason, 'drain-file-present'); assert.equal(s.openCount, 0);
  const h = await health(); assert.equal(h.accepting, false); assert.equal(h.open, undefined); assert.equal(h.inflight, undefined, 'no swap details on the public health');
  assert.equal(h.generation, undefined); assert.equal(h.stateDir, undefined);
  const q = await fetch(`${url}/v1/quote`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ xmr: 0.01 }) });
  assert.deepEqual(await q.json(), { error: 'maker-paused' });
  const sw = await fetch(`${url}/v1/swap`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ quoteId: 'none' }) });
  assert.match((await sw.json()).error, /quote-expired|maker-paused/);
  rmSync(join(state, 'ADMISSION_CLOSED')); assert.equal((await status()).admission, 'open');
});

// ---- T11 to T15, AG-H2, AG-M1: the real quiesce check and the real evidence collectors against a simulated finalized chain ----
// Slot n has block height n and blockTime BASE + floor(n / 2); every 7th slot is skipped. Only get* methods exist. Each method can answer from
// an OLDER context (lag[method]) and can ignore minContextSlot (honorMin false), and the history services (address index and status history)
// can lag behind the node (histIdx), so answers of mixed ages can be served.
const BASE = Math.floor(Date.parse('2026-11-08T00:00:00.000Z') / 1000) - 3600;
const PROBE_PAYER = Keypair.generate().publicKey.toBase58();
function fakeChain() {
  const c = { tip: 20000, lag: {}, histIdx: null, honorMin: true, accounts: new Map(), history: new Map(), txs: new Map(), statuses: new Map(), methods: [] };
  const skipped = (n) => n % 7 === 3;
  const block = (n) => (skipped(n) || n > c.tip || n < 0 ? null : { blockHeight: n, blockTime: BASE + Math.floor(n / 2) });
  const fin = () => { let n = c.tip; while (skipped(n)) n -= 1; return n; };
  const ctx = (m) => c.lag[m] ?? fin();
  const hidx = () => c.histIdx ?? fin();
  const needMin = (m, cfg) => { if (c.honorMin && Number.isInteger(cfg?.minContextSlot) && cfg.minContextSlot > ctx(m)) throw Object.assign(new Error('Minimum context slot has not been reached'), { code: -32016 }); };
  const acct = (pda, slot) => { const a = c.accounts.get(pda); if (!a) return null; const v = typeof a === 'string' ? { data: a, owner: SWAP_PROGRAM, lamports: 1 } : a; return (v.since ?? 0) <= slot ? v : null; };
  const wire = (v) => ({ data: [v.data, 'base64'], owner: v.owner, lamports: v.lamports, executable: false, rentEpoch: 0 });
  c.handle = (method, params) => {
    c.methods.push(method);
    const cfg = params?.[1];
    switch (method) {
      case 'getGenesisHash': return MAINNET_GENESIS;
      case 'getSlot': case 'getBlockHeight': return fin();
      case 'getBlock': { const b = block(params[0]); if (!b) throw Object.assign(new Error('Slot was skipped'), { code: -32007 }); return cfg?.transactionDetails === 'signatures' ? { ...b, signatures: ['Probe' + params[0]] } : b; }
      case 'getTransaction': if (params[0].startsWith('Probe')) return { slot: Number(params[0].slice(5)), transaction: { message: { accountKeys: [PROBE_PAYER], instructions: [] } }, meta: { err: null } }; return c.txs.get(params[0]) ?? null;
      case 'getSignaturesForAddress': {
        needMin(method, cfg);
        if (params[0] === PROBE_PAYER) return [{ signature: 'Probe' + hidx(), slot: hidx(), err: null }];
        if (cfg?.before) return [];
        return (c.history.get(params[0]) ?? []).filter((h) => (h.slot ?? 0) <= hidx());
      }
      case 'getAccountInfo': { needMin(method, cfg); const slot = ctx(method), v = acct(params[0], slot); return { context: { slot }, value: v ? wire(v) : null }; }
      case 'getSignatureStatuses': {
        const slot = ctx(method);
        return { context: { slot }, value: params[0].map((s) => {
          if (s.startsWith('Probe')) { const n = Number(s.slice(5)); return n <= hidx() ? { slot: n, confirmations: null, err: null, confirmationStatus: 'finalized' } : null; }
          const st = c.statuses.get(s); return st && (st.slot ?? 0) <= Math.min(slot, hidx()) ? st : null;
        }) };
      }
      case 'getProgramAccounts': {
        needMin(method, cfg); const slot = ctx(method);
        const size = cfg?.filters?.find((f) => Number.isInteger(f.dataSize))?.dataSize;   // honoured like a real node; no filter = every program account
        const value = [...c.accounts.keys()].map((k) => [k, acct(k, slot)]).filter(([, v]) => v && v.owner === SWAP_PROGRAM && (size === undefined || Buffer.from(v.data, 'base64').length === size)).map(([pubkey, v]) => ({ pubkey, account: wire(v) }));
        return cfg?.withContext ? { context: { slot }, value } : value;
      }
      default: throw new Error(`unexpected ${method}`);
    }
  };
  return c;
}
function serve(handler) {
  const srv = http.createServer(async (req, res) => {
    let body = ''; for await (const ch of req) body += ch;
    try { const out = await handler(req, body); res.writeHead(out.code ?? 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out.body)); }
    catch (e) { res.writeHead(500); res.end('{}'); }
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections(); srv.close(); } })));
}
const STARTED = '2026-11-08T00:00:00.000Z', GEN = 'a'.repeat(32);
async function world(t) {
  const chain = fakeChain(), token = 'q'.repeat(48);
  const rpc = await serve(async (req, body) => { const j = JSON.parse(body); try { return { body: { jsonrpc: '2.0', id: j.id, result: chain.handle(j.method, j.params) } }; } catch (e) { return { body: { jsonrpc: '2.0', id: j.id, error: { code: e.code ?? -32000, message: e.message } } }; } });
  const state = tmp(); mkdirSync(join(state, 'swaps'));
  const status = { ...okStatus, stateDir: realpathSync(state), startedAt: STARTED, generation: GEN }; let statusReads = 0; const later = [];
  const maker = await serve(async (req) => { statusReads += 1; return req.headers.authorization === `Bearer ${token}` ? { body: { ...status, ...(later[statusReads - 1] ?? {}) } } : { code: 401, body: { error: 'unauthorized' } }; });
  writeFileSync(join(state, 'journal.jsonl'), JSON.stringify({ ts: STARTED, event: 'maker-started', at: STARTED, generation: GEN }) + '\n');
  t.after(() => { rpc.close(); maker.close(); rmSync(state, { recursive: true, force: true }); });
  sol.setProgramId(SWAP_PROGRAM);
  const pdaOf = (id) => sol.swapPda(new PublicKey(makerKey), Buffer.from(id, 'hex')).toBase58();
  const put = (r) => writeFileSync(join(state, 'swaps', `${r.swapId}.json`), JSON.stringify(r));
  const journal = (e) => appendFileSync(join(state, 'journal.jsonl'), JSON.stringify({ ts: STARTED, ...e }) + '\n');
  const check = () => { statusReads = 0; return runCheck({ state, makerUrl: maker.url, token, rpcUrl: rpc.url, makerKey, allowMainnetReads: true }); };
  // the maker's own loop view of one record, through the same collectors (resolveLock with the real evidence path)
  const chainRpc = rpcClient(rpc.url);
  const makerEvidence = async (x) => collectEvidence(chainRpc, { snapshot: await chainSnapshot(chainRpc), record: x, makerKey: new PublicKey(makerKey), program: SWAP_PROGRAM });
  return { chain, status, later, state, pdaOf, put, journal, check, rpc, maker, token, makerEvidence };
}
function txOfKind(kind, pda) {
  const keys = kind === 'lock' ? [makerKey, pda, SystemProgram.programId.toBase58(), SWAP_PROGRAM] : [pda, makerKey, SWAP_PROGRAM];
  const data = Buffer.concat([Buffer.from(sol.disc(kind)), Buffer.alloc(32)]);
  return { transaction: { message: { accountKeys: keys, instructions: [{ programIdIndex: keys.length - 1, accounts: kind === 'lock' ? [0, 1, 2] : [0, 1], data: bs58.encode(data) }] } } };
}
const transferTx = (pda) => ({ transaction: { message: { accountKeys: [Keypair.generate().publicKey.toBase58(), pda, SystemProgram.programId.toBase58()], instructions: [{ programIdIndex: 2, accounts: [0, 1], data: bs58.encode(Buffer.alloc(12)) }] } }, meta: { err: null } });
const LVBH = 19000, CLEAR = LVBH + EXPIRY_MARGIN + 10;   // 19042: not a skipped slot
const writeAhead = (id, over = {}) => ({ swapId: id, createdAt: '2026-11-08T01:00:00.000Z', b: 'secret-kept', lockFormat: LOCK_FORMAT, lockSig: sigOf(id), lockBlockhash: BH, lockLastValidBlockHeight: LVBH, ...over });
const land = (w, id, slot) => { const pda = w.pdaOf(id), sig = sigOf(id);
  w.chain.accounts.set(pda, { data: escrowData({ refunder: new PublicKey(makerKey) }), owner: SWAP_PROGRAM, lamports: 1, since: slot });
  w.chain.statuses.set(sig, { slot, confirmations: null, err: null, confirmationStatus: 'finalized' });
  w.chain.history.set(pda, [{ signature: sig, err: null, slot }]); w.chain.txs.set(sig, txOfKind('lock', pda)); return pda; };
test('T11a: lock accepted, answer lost, and it lands: NOT OK while the maker escrow exists, then K1 once refunded', async (t) => {
  const w = await world(t), id = '1a'.repeat(32); w.put(writeAhead(id)); const pda = land(w, id, 18000);
  let r = await w.check(); assert.equal(r.ok, false); assert.match(r.problems.join(), /escrow-at-pda/); assert.match(r.problems.join(), /refunder or claimer/);
  w.chain.accounts.delete(pda); w.chain.history.set(pda, [{ signature: 'Refund1', err: null, slot: 18500 }, { signature: sigOf(id), err: null, slot: 18000 }]); w.chain.txs.set('Refund1', txOfKind('refund', pda));
  r = await w.check(); assert.equal(r.ok, true, r.problems.join('; ')); assert.equal(r.report.classes[0].k, 'K1'); assert.deepEqual(r.report.classes[0].txids, [sigOf(id), 'Refund1']);
});
test('T11b: lock accepted, answer lost, and it never lands: NOT OK until the finalized height passes lockLastValidBlockHeight + margin, then K2', async (t) => {
  const w = await world(t), id = '1b'.repeat(32); w.put(writeAhead(id));
  w.chain.tip = LVBH + EXPIRY_MARGIN; let r = await w.check(); assert.equal(r.ok, false); assert.match(r.problems.join(), /lock-may-still-land/);
  w.chain.tip = CLEAR; r = await w.check(); assert.equal(r.ok, true, r.problems.join('; ')); assert.equal(r.report.classes[0].k, 'K2');
});
test('AG-H2: fresh expiry height with OLDER account, status and history answers: the landed lock stays in recovery and quiescence never passes; after catch-up the escrow blocks', async (t) => {
  const w = await world(t), id = '2a'.repeat(32); const rec = writeAhead(id, { lockLastValidBlockHeight: 999 }); w.put(rec);
  land(w, id, 990);                          // the lock landed at height 990, before its expiry at 999
  w.chain.tip = 1100; w.chain.honorMin = false;   // a lagging node behind a proxy that ignores minContextSlot
  w.chain.lag = { getAccountInfo: 980, getSignatureStatuses: 980, getProgramAccounts: 980 }; w.chain.histIdx = 980;
  let r = await w.check(); assert.equal(r.ok, false); assert.match(r.problems.join(), /stale-account-context/); assert.match(r.problems.join(), /chain check not run or failed/);
  // the maker loop sees the same answers through the same collectors: pending, never never-landed, however long it waits
  const stored = [], log = []; let now = Date.parse('2026-11-08T12:00:00.000Z');
  const io = { store: (s) => stored.push(structuredClone(s)), log: (e) => log.push(e), now: () => now, evidence: w.makerEvidence };
  for (let i = 0; i < 3; i++) { w.chain.tip += 50; now += 10 * 60 * 1000; const c = await resolveLock(rec, io); assert.equal(c.state, 'pending', c.why); }
  assert.equal(lockStage(rec), 'pending'); assert.equal(rec.lockNeverLanded, undefined); assert.equal(rec.done, undefined);
  // only the account is fresh now (the escrow is visible): positive, whatever the rest says
  w.chain.lag = { getSignatureStatuses: 980, getProgramAccounts: 980 };
  assert.equal((await resolveLock(rec, io)).state, 'locked'); assert.equal(rec.solLocked, true);
  w.chain.lag = {}; w.chain.histIdx = null; w.chain.honorMin = true;
  r = await w.check(); assert.equal(r.ok, false); assert.match(r.problems.join(), /escrow-at-pda/); assert.match(r.problems.join(), /refunder or claimer/);
});
test('AG-H2: each stale piece alone blocks: account context, status context, history index; a node honouring minContextSlot makes the read unreadable', async (t) => {
  const w = await world(t), id = '2b'.repeat(32); w.put(writeAhead(id)); w.chain.tip = CLEAR;
  const why = async () => (await w.check()).report.classes[0].why;
  w.chain.honorMin = false;
  w.chain.lag = { getAccountInfo: CLEAR - 60 }; assert.equal(await why(), 'stale-account-context');
  w.chain.lag = { getSignatureStatuses: CLEAR - 60 }; assert.equal(await why(), 'stale-status-context');
  w.chain.lag = {}; w.chain.histIdx = CLEAR - 60; assert.equal(await why(), 'history-index-behind-expiry');
  w.chain.histIdx = null; w.chain.honorMin = true; w.chain.lag = { getAccountInfo: CLEAR - 60 }; assert.equal(await why(), 'pda-unreadable');
  w.chain.lag = {}; const r = await w.check(); assert.equal(r.ok, true, r.problems.join('; ')); assert.equal(r.report.classes[0].k, 'K2');
});
test('AG-H2: the maker marks never-landed only after two coherent observations, keeps it in recovery, and still catches a later escrow', async (t) => {
  const w = await world(t), id = '2c'.repeat(32); const rec = writeAhead(id); w.chain.tip = CLEAR;
  const log = []; let now = Date.parse('2026-11-08T12:00:00.000Z');
  const io = { store: () => {}, log: (e) => log.push(e), now: () => now, evidence: w.makerEvidence };
  assert.equal((await resolveLock(rec, io)).why, 'first-observation');
  now += (NEVER_LANDED_RECHECK_S + 1) * 1000; assert.equal((await resolveLock(rec, io)).state, 'pending', 'same finalized context');
  w.chain.tip = CLEAR + 7; now += 1000; assert.equal((await resolveLock(rec, io)).state, 'never-landed');
  assert.equal(lockStage(rec), 'never-landed'); assert.equal(rec.done, undefined); assert.equal(rec.lockNeverLanded.observations.length, 2);
  land(w, id, CLEAR + 8); w.chain.tip = CLEAR + 9;   // a dishonest or wrong earlier answer: the escrow shows up later
  assert.equal((await resolveLock(rec, io)).state, 'locked'); assert.equal(log.at(-1).event, 'lock-landed-after-never-landed');
});
test('AG-M1: a closed or never-created escrow PDA funded by a stranger does not block; program-owned or data-carrying accounts at the PDA do', async (t) => {
  const w = await world(t), a = 'a1'.repeat(32), b = 'b1'.repeat(32), c = 'c1'.repeat(32); w.chain.tip = CLEAR;
  const sys = SystemProgram.programId.toBase58();
  // a: refunded swap (K0) whose closed PDA was then funded; b: never-landed write-ahead lock (K2) whose PDA was funded after expiry
  w.put({ ...writeAhead(a), done: 'refunded', solLocked: true });
  for (const [id, slots] of [[a, [18000, 18500, 19020]], [b, [19020]]]) {
    const pda = w.pdaOf(id); w.chain.accounts.set(pda, { data: '', owner: sys, lamports: 5000, since: 19020 });
    w.chain.txs.set('Gift' + id.slice(0, 4), transferTx(pda));
    w.chain.history.set(pda, [{ signature: 'Gift' + id.slice(0, 4), err: null, slot: slots.at(-1) }]);
  }
  w.put(writeAhead(b));
  let r = await w.check(); assert.equal(r.ok, true, r.problems.join('; '));
  const byId = Object.fromEntries(r.report.classes.map((x) => [x.id, x]));
  assert.equal(byId[a.slice(0, 8)].k, 'K0'); assert.equal(byId[b.slice(0, 8)].k, 'K2');
  assert.deepEqual(byId[b.slice(0, 8)].nonEscrow, { owner: sys, lamports: 5000 }); assert.equal(byId[b.slice(0, 8)].unrelatedHistory, 1);
  // c: an account owned by the program that is not a swap account, then a system account carrying data: both block
  w.put({ ...writeAhead(c), done: 'refunded' });
  w.chain.accounts.set(w.pdaOf(c), { data: Buffer.alloc(10).toString('base64'), owner: SWAP_PROGRAM, lamports: 1 });
  r = await w.check(); assert.equal(r.ok, false); assert.match(r.problems.join(), /unknown-account-at-pda/);
  w.chain.accounts.set(w.pdaOf(c), { data: Buffer.alloc(10).toString('base64'), owner: sys, lamports: 1 });
  r = await w.check(); assert.equal(r.ok, false); assert.match(r.problems.join(), /unknown-account-at-pda/);
  // a program transaction in an absence history still blocks
  w.chain.accounts.delete(w.pdaOf(c)); w.chain.history.set(w.pdaOf(b), [{ signature: 'Other1', err: null, slot: 19020 }]); w.chain.txs.set('Other1', txOfKind('claim', w.pdaOf(b)));
  r = await w.check(); assert.equal(r.ok, false);
});
test('T12: late landing: a held-back lock submitted after a first run, before its expiry: no run prints OK', async (t) => {
  const w = await world(t), id = '12'.repeat(32); w.put(writeAhead(id));
  w.chain.tip = LVBH - 50; const runs = [await w.check()];
  w.chain.tip = LVBH - 20; land(w, id, LVBH - 22);   // slot LVBH - 20 is a skipped slot in the fake
  runs.push(await w.check());
  w.chain.tip = LVBH + 500; runs.push(await w.check());   // expired, but it landed: still NOT OK (account, history, known signature)
  assert.deepEqual(runs.map((r) => r.ok), [false, false, false]);
  assert.match(runs[0].problems.join(), /lock-may-still-land/); assert.match(runs[1].problems.join(), /escrow-at-pda/);
});
test('T13: crashes: killed after the write-ahead store and before the send (K2 after expiry), and an older file without R9 fields (K4 after the boundary); files kept', async (t) => {
  const w = await world(t);
  // crash between signing+store and send, through the real admission path
  const stored = []; const id = '13'.repeat(32);
  await assert.rejects(admitSwap({ quoteId: 'q' }, { isOpen: () => true, takeQuote: () => ({ swapId: id }), checkLimits: () => {},
    prepare: async () => ({ record: writeAhead(id), signed: {} }), store: (s) => { stored.push(s); w.put(s); }, broadcast: async () => { throw new Error('killed'); } }), /killed/);
  // a file from before this change (or from a crash before signing in old code): no lockSig, created before maker-started
  const old = '0d'.repeat(32); w.put({ swapId: old, createdAt: '2026-11-07T23:00:00.000Z', b: 'secret-kept' });
  const target = Math.floor(Date.parse(STARTED) / 1000) + K4_TIME_MARGIN_S;
  let H = (target - BASE) * 2; while (H % 7 === 3) H += 1;           // first block at or after the boundary time
  w.chain.tip = H + K4_HEIGHT_MARGIN; let r = await w.check();
  assert.equal(r.ok, false); assert.equal(r.report.boundary.H, H);
  w.chain.tip = Math.max(H + K4_HEIGHT_MARGIN + 1, CLEAR); r = await w.check();
  assert.equal(r.ok, true, r.problems.join('; ')); assert.deepEqual(r.report.classes.map((c) => c.k).sort(), ['K2', 'K4']);
  for (const f of [id, old]) assert.equal(JSON.parse(readFileSync(join(w.state, 'swaps', `${f}.json`), 'utf8')).b, 'secret-kept');
});
test('T13b: a maker-started at or before the file time gives no K4', async (t) => {
  const w = await world(t); w.put({ swapId: '0e'.repeat(32), createdAt: STARTED });
  w.chain.tip = 30000; const r = await w.check(); assert.equal(r.ok, false); assert.match(r.problems.join(), /no-process-boundary/);
});
test('K4 items end to end: invalid schema, a swap file missing from the directory, another state dir, and a maker restart during the check each block', async (t) => {
  const w = await world(t); w.chain.tip = CLEAR;
  let r = await w.check(); assert.equal(r.ok, true, r.problems.join('; '));
  writeFileSync(join(w.state, 'swaps', `${'5a'.repeat(32)}.json`), JSON.stringify({ swapId: '5a'.repeat(32), createdAt: 'later' }));
  r = await w.check(); assert.equal(r.ok, false); assert.match(r.problems.join(), /invalid record: createdAt/);
  rmSync(join(w.state, 'swaps', `${'5a'.repeat(32)}.json`));
  w.journal({ event: 'swap-recorded', swapId: '5b'.repeat(32) });
  r = await w.check(); assert.equal(r.ok, false); assert.match(r.problems.join(), /named in the journal but its swap file is missing/);
  w.put(writeAhead('5b'.repeat(32))); r = await w.check(); assert.equal(r.ok, true, r.problems.join('; '));
  w.status.stateDir = '/var/lib/other'; r = await w.check(); assert.match(r.problems.join(), /different state directory/); w.status.stateDir = realpathSync(w.state);
  w.later[1] = { generation: 'b'.repeat(32) }; r = await w.check(); assert.equal(r.ok, false); assert.match(r.problems.join(), /process changed during the check/);
  w.later[1] = { inflight: 1 }; r = await w.check(); assert.equal(r.ok, false); assert.match(r.problems.join(), /admission started during the check/); w.later.length = 0;
  w.journal({ event: 'maker-started', at: '2026-11-08T05:00:00.000Z', generation: 'c'.repeat(32) });
  r = await w.check(); assert.equal(r.ok, false); assert.match(r.problems.join(), /not the process of the journal/);
});
test('T9 end to end: open admission, in-flight, and an unknown RPC each fail; stranger escrows are listed only', async (t) => {
  const w = await world(t), other = Keypair.generate().publicKey;
  w.chain.accounts.set('Stranger1111111111111111111111111111111111', escrowData({ refunder: other }));
  let r = await w.check(); assert.equal(r.ok, true, r.problems.join('; ')); assert.equal(r.report.strangers.length, 1);
  w.status.admission = 'open'; r = await w.check(); assert.equal(r.ok, false); w.status.admission = 'closed';
  w.status.inflight = 1; r = await w.check(); assert.equal(r.ok, false); w.status.inflight = 0;
  r = await runCheck({ state: w.state, makerUrl: w.maker.url, token: 'wrong', rpcUrl: w.rpc.url, makerKey, allowMainnetReads: true }); assert.equal(r.ok, false);
});
const treeHash = (dir) => {
  const out = []; const walk = (d) => { for (const f of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const p = join(d, f.name); if (f.isDirectory()) walk(p); else out.push([p.slice(dir.length), createHash('sha256').update(readFileSync(p)).digest('hex')]); } };
  walk(dir); return JSON.stringify(out);
};
test('T15: the check is read-only: the state directory is byte-identical after OK and NOT OK CLI runs; only get* RPC methods are called; the report must lie outside the state dir', async (t) => {
  const w = await world(t), id = '15'.repeat(32); w.put(writeAhead(id)); w.put({ swapId: '16'.repeat(32), createdAt: '2026-11-08T05:00:00.000Z' });
  const tokenFile = join(tmp(), 'token'); writeFileSync(tokenFile, w.token);
  const run = (report) => new Promise((res) => { const p = spawn(process.execPath, [fileURLToPath(new URL('./quiesce-check.mjs', import.meta.url)), '--state', w.state, '--maker', w.maker.url, '--token-file', tokenFile, '--maker-key', makerKey, '--rpc', w.rpc.url, '--report', report], { env: { PATH: process.env.PATH, ALLOW_MAINNET_READS: '1' } }); let out = ''; p.stdout.on('data', (d) => { out += d; }); p.on('close', (code) => res({ code, out })); });
  const before = treeHash(w.state);
  const outDir = tmp();
  w.chain.tip = 25000; const bad = await run(join(outDir, 'r1.json')); assert.equal(bad.code, 1, bad.out); assert.match(bad.out, /NOT OK/);
  assert.equal(treeHash(w.state), before);
  rmSync(join(w.state, 'swaps', `${'16'.repeat(32)}.json`)); const before2 = treeHash(w.state);   // test setup only, not the check
  const good = await run(join(outDir, 'r2.json')); assert.equal(good.code, 0, good.out); assert.match(good.out, /^OK:/m);
  assert.equal(treeHash(w.state), before2);
  assert.equal(JSON.parse(readFileSync(join(outDir, 'r2.json'), 'utf8')).ok, true);
  const inside = await run(join(w.state, 'report.json')); assert.equal(inside.code, 2); assert.equal(treeHash(w.state), before2);
  assert.ok(w.chain.methods.length > 0 && w.chain.methods.every((m) => /^get[A-Z]/.test(m)), [...new Set(w.chain.methods)].join());
});
