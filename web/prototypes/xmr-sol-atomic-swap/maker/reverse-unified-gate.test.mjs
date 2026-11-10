// SOL -> XMR (protocol v2) under the ONE admission gate, the ONE send discipline and the ONE quiesce check of the maker (9 Nov 2026).
// The maker is the claimer of a strict escrow: its secret a leaves only with claim_strict, after its secret-free claim_commit_strict is
// FINALIZED. These tests drive maker/maker-send.mjs through REAL web3.js 1.99.0 Connections whose fetch is a fake chain (two endpoints),
// so every JSON-RPC payload checked is what web3.js puts on the wire, plus the real admission gate and the real quiesce classifier.
import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, renameSync, readFileSync, rmSync, statSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { Keypair, Connection, VersionedTransaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import * as sol from '../client/sol.mjs';
import { REV_COMMIT_WINDOW, REV_T0_LEAD, REV_CLAIM_WINDOW } from '../client/reverse-core.mjs';
import { createSender, strictClaimGate, heightTolerance, HEIGHT_AGREEMENT, HEIGHT_SKEW_CAP, SLOTS_PER_SECOND, claimRebroadcastBlock, CLAIM_SEND_MIN_LEAD, CLAIM_LANDING_MARGIN, MAX_SECONDS_PER_BLOCK, ATTEMPT_EXPIRY_MARGIN } from './maker-send.mjs';
import { makerReverseStep } from './maker-reverse.mjs';
import { createAdmission, admitSwap, classifyRecord, attemptsProblem, scrubSecrets, EXPIRY_MARGIN } from './maker-core.mjs';
import { collectEvidence } from './maker-chain.mjs';
import { quiesceVerdict, recordProblem } from './quiesce-check.mjs';
import { strictPda } from './strict-sol.mjs';

const T0 = 1_900_000_000, T1 = T0 + REV_CLAIM_WINDOW, C0 = T1 - 1000, DEADLINE = C0 + REV_COMMIT_WINDOW;
const CONF_SLOT = 5000, FIN_SLOT = 4968;
const STRICT_TAG = createHash('sha256').update('account:StrictSwap').digest().subarray(0, 8);

function strictData(s, { ready, c }) {
  const b = Buffer.alloc(8 + 194); STRICT_TAG.copy(b, 0); const d = b.subarray(8);
  bs58.decode(s.refunder).forEach((x, i) => { d[i] = x; }); bs58.decode(s.claimer).forEach((x, i) => { d[32 + i] = x; });
  Buffer.from(s.A, 'hex').copy(d, 64); Buffer.from(s.B, 'hex').copy(d, 96);
  d.writeBigUInt64LE(BigInt(s.lamports), 128); d.writeBigInt64LE(BigInt(s.t0), 136); d.writeBigInt64LE(BigInt(s.t1), 144);
  d[152] = ready ? 1 : 0; Buffer.from(s.swapId, 'hex').copy(d, 153); d.writeBigInt64LE(BigInt(c), 186);
  return b.toString('base64');
}

/** Fake cluster with per-endpoint views. escrow = { ready, c } or null; finalized reads answer from FIN_SLOT - accountLag. */
function makeChain(over = {}) {
  return { confTime: C0 + 60, finTime: C0 + 47, height: 9000, finHeight: 8968, lifetime: 150, escrow: { ready: true, c: C0 }, accountLag: 0,
    statuses: new Map(), calls: [], sends: [], sendFails: false, per: {}, ...over };
}
function conn(chain, name, s) {
  const P = (k) => (chain.per[name] && k in chain.per[name] ? chain.per[name][k] : chain[k]);
  const answer = (method, params) => {
    const cfg = params?.find?.((p) => p && typeof p === 'object' && (p.commitment || p.minContextSlot !== undefined)) ?? {};
    const fin = cfg.commitment === 'finalized';
    switch (method) {
      case 'getLatestBlockhash': return { context: { slot: CONF_SLOT }, value: { blockhash: bs58.encode(createHash('sha256').update(`bh-${chain.height}`).digest()), lastValidBlockHeight: chain.height + chain.lifetime } };
      case 'getSlot': return fin ? FIN_SLOT : CONF_SLOT;
      case 'getBlock': return { blockhash: 'x', previousBlockhash: 'x', parentSlot: params[0] - 1, blockTime: params[0] === FIN_SLOT ? chain.finTime : chain.confTime, blockHeight: params[0] === FIN_SLOT ? chain.finHeight : chain.height };
      case 'getBlockTime': return params[0] === FIN_SLOT ? chain.finTime : chain.confTime;
      case 'getBlockHeight': return P('height');
      case 'isBlockhashValid': return { context: { slot: CONF_SLOT }, value: P('bhValid') ?? true };
      case 'getAccountInfo': {
        const slot = (fin ? FIN_SLOT : CONF_SLOT) - P('accountLag');
        if (Number.isInteger(cfg.minContextSlot) && cfg.minContextSlot > slot) return { error: { code: -32016, message: 'Minimum context slot has not been reached' } };
        const e = P('escrow');
        return { context: { slot }, value: e ? { data: [strictData(s, e), 'base64'], executable: false, lamports: 1_002_000, owner: sol.PROGRAM_ID.toBase58(), rentEpoch: 0, space: 202 } : null };
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
      if (r.method === 'sendTransaction') { chain.sends.push({ endpoint: name, tx: r.params[0], cfg: r.params[1], onDisk: chain.readDisk?.() }); if (chain.sendFails) throw new TypeError('fetch failed (response lost)'); }
      if (chain.latency) await chain.latency(name, r.method);
      const result = answer(r.method, r.params);
      outs.push(result?.error ? { jsonrpc: '2.0', id: r.id, error: result.error } : result === undefined ? { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: `unexpected ${r.method}` } } : { jsonrpc: '2.0', id: r.id, result });
    }
    return new Response(JSON.stringify(Array.isArray(body) ? outs : outs[0]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return new Connection(`http://127.0.0.1:9/${name}`, { commitment: 'confirmed', fetch, disableRetryOnRateLimit: true });
}

function setup(chainOver = {}, recOver = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reverse-gate-')), maker = Keypair.generate(), user = Keypair.generate(), a = randomBytes(32);
  const s = { direction: 'sol-xmr', swapId: randomBytes(32).toString('hex'), createdAt: '2026-11-09T10:00:00.000Z', A: randomBytes(32).toString('hex'), B: randomBytes(32).toString('hex'),
    a: a.toString('hex'), v: randomBytes(32).toString('hex'), claimer: maker.publicKey.toBase58(), refunder: user.publicKey.toBase58(), lamports: 7_000_000, t0: T0, t1: T1,
    xmrAtomic: '50000000000', xmrSendTxid: 'aa'.repeat(32), xmrRelayed: true, seenPda: true, userProofOk: true, quoteExpiresAt: T0 - REV_T0_LEAD + 120, ...recOver };
  const file = join(dir, `${s.swapId}.json`);
  const store = (x) => { writeFileSync(`${file}.tmp`, JSON.stringify(x)); renameSync(`${file}.tmp`, file); };
  const chain = makeChain(chainOver); chain.readDisk = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
  const clock = { ms: chain.confTime * 1000 }, logs = [];
  const conns = [conn(chain, 'primary', s), conn(chain, 'secondary', s)];
  const sender = createSender({ conns, payer: maker, store, log: (e) => logs.push(e), clock: () => clock.ms });
  return { dir, maker, user, a, s, file, store, chain, clock, logs, sender, reload: () => JSON.parse(readFileSync(file, 'utf8')), done: () => rmSync(dir, { recursive: true, force: true }) };
}

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
const withSecret = (t) => t.chain.calls.filter((c) => carries(c.params, t.a));
const validSigs = (b64, key) => { const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64')); const m = tx.message.serialize(); return tx.signatures.filter((g) => { try { return ed25519.verify(g, m, key.publicKey.toBytes()); } catch { return false; } }).map((g) => bs58.encode(g)); };
const finalized = (err = null) => ({ slot: FIN_SLOT, confirmations: null, err, confirmationStatus: 'finalized' });

// ---- secrets absent from simulation and fee payloads; record before broadcast; two endpoints ----
test('claim (a): never simulated, never priced; a is in the two sendTransaction payloads only, the attempt and exposure mark are on disk before each send', async () => {
  const t = setup();
  const r = await t.sender.sendClaim(t.s);
  assert.equal(r.sent, true, JSON.stringify(r));
  assert.deepEqual(t.chain.calls.filter((c) => /^simulateTransaction$|^getFeeForMessage$/.test(c.method)), [], 'no simulation and no fee query in the claim pass');
  assert.deepEqual(withSecret(t).map((c) => `${c.endpoint}:${c.method}`), ['primary:sendTransaction', 'secondary:sendTransaction'], 'a leaves in the two sends and nowhere else');
  assert.equal(t.chain.sends[0].tx, t.chain.sends[1].tx, 'one variant, the same bytes to both endpoints');
  const att = t.reload().claimAttempts; assert.equal(att.length, 1); assert.equal(att[0].deadline, DEADLINE, 'deadline c + W from the finalized escrow');
  assert.deepEqual(validSigs(t.chain.sends[0].tx, t.maker), [att[0].sig]); assert.equal(att[0].raw, t.chain.sends[0].tx);
  for (const x of t.chain.sends) { assert.equal(x.cfg.skipPreflight, true); assert.equal(x.onDisk?.claimAttempts?.[0]?.sig, att[0].sig, 'on disk before this send'); assert.equal(x.onDisk.secretExposure?.kind, 'claim-strict'); }
  // every strict account read for the decision was at FINALIZED commitment, on BOTH endpoints
  const reads = t.chain.calls.filter((c) => c.method === 'getAccountInfo');
  assert.deepEqual(reads.map((c) => c.endpoint).sort(), ['primary', 'secondary']); for (const c of reads) assert.equal(c.params[1].commitment, 'finalized');
  t.done();
});
test('commit (no secret): simulated UNSIGNED only, recorded before broadcast, both endpoints; a appears in no commit payload', async () => {
  const t = setup({ escrow: { ready: true, c: 0 } });
  const r = await t.sender.sendCommit(t.s);
  assert.equal(r.sent, true);
  const sim = t.chain.calls.filter((c) => c.method === 'simulateTransaction'); assert.equal(sim.length, 1);
  assert.deepEqual(validSigs(sim[0].params[0], t.maker), [], 'the simulation carries no valid maker signature'); assert.equal(sim[0].params[1].sigVerify, false);
  assert.deepEqual(withSecret(t), [], 'a is in no payload of the commit');
  const att = t.reload().commitAttempts; assert.equal(att.length, 1);
  for (const x of t.chain.sends) assert.equal(x.onDisk?.commitAttempts?.[0]?.sig, att[0].sig);
  assert.equal(t.reload().secretExposure, undefined, 'a commit exposes nothing');
  t.done();
});

// ---- the claim gate: finalized commit on every endpoint, agreement, freshness, blockhash bound against c + W ----
test('claim gate: no finalized commit, not ready, a mismatch, endpoints disagreeing on c, a stale context or an unreadable endpoint each refuse, and a never leaves', async () => {
  const cases = [
    [{ escrow: { ready: true, c: 0 } }, 'commit-not-finalized'],
    [{ escrow: { ready: false, c: 0 } }, 'escrow-not-ready'],
    [{ escrow: null }, 'escrow-not-open'],
    [{ per: { secondary: { escrow: { ready: true, c: C0 + 5 } } } }, 'endpoints-disagree-on-commit'],
    [{ per: { secondary: { escrow: { ready: true, c: 0 } } } }, 'commit-not-finalized'],
    [{ per: { secondary: { bhValid: false } } }, 'blockhash-not-valid-on-secondary'],
    [{ per: { secondary: { height: 9020 } } }, 'endpoint-heights-disagree'],
  ];
  for (const [over, why] of cases) {
    const t = setup(over);
    const r = await t.sender.sendClaim(t.s);
    assert.equal(r.refused, why, JSON.stringify(over)); assert.deepEqual(withSecret(t), [], why); assert.equal(t.chain.sends.length, 0); assert.equal(t.s.secretExposure, undefined);
    t.done();
  }
  // a landed commit attempt at slot X makes every finalized read require a context at least X: a lagging endpoint is refused
  const t = setup({ per: { secondary: { accountLag: 40 } } }, { commitAttempts: [{ n: 1, action: 'commit-strict', sig: bs58.encode(randomBytes(64)), lastValidBlockHeight: 1, state: 'landed', resolvedSlot: FIN_SLOT - 10 }] });
  assert.equal((await t.sender.sendClaim(t.s)).refused, 'escrow-unread-on-an-endpoint'); assert.deepEqual(withSecret(t), []); t.done();
});
test('claim gate: the bytes must provably expire before c + W: near the end of the window, with the later of chain time and local clock, nothing is signed', async () => {
  const need = Math.max(CLAIM_SEND_MIN_LEAD, 150 * MAX_SECONDS_PER_BLOCK + CLAIM_LANDING_MARGIN);
  let t = setup({ confTime: DEADLINE - need });           // exactly enough lead
  assert.equal((await t.sender.sendClaim(t.s)).sent, true); t.done();
  t = setup({ confTime: DEADLINE - need + 1 });
  assert.equal((await t.sender.sendClaim(t.s)).refused, 'blockhash-may-outlive-claim-window'); assert.deepEqual(withSecret(t), []); t.done();
  t = setup({ confTime: DEADLINE - need + 1 }); t.clock.ms = C0 * 1000;   // local clock early, chain time late: the later counts
  assert.equal((await t.sender.sendClaim(t.s)).refused, 'blockhash-may-outlive-claim-window'); assert.deepEqual(withSecret(t), []); t.done();
  t = setup(); t.clock.ms = (DEADLINE - need + 1) * 1000;   // chain time early, local clock late: the later counts
  assert.equal((await t.sender.sendClaim(t.s)).refused, 'blockhash-may-outlive-claim-window'); assert.deepEqual(withSecret(t), []); t.done();
  t = setup({ lifetime: 400 });                               // a blockhash that claims to live longer than any fresh one
  assert.equal((await t.sender.sendClaim(t.s)).refused, 'blockhash-lifetime-unbounded'); t.done();
  // pure: a record already ambiguous, or not a reverse record, never passes
  const ok = { account: { claimer: 'M', refunder: 'U', claimPoint: 'aa', refundPoint: 'bb', t0: T0, t1: T1, ready: true, claimCommittedAt: C0 }, slot: 10, minSlot: 0 };
  const rec = { direction: 'sol-xmr', claimer: 'M', refunder: 'U', A: 'aa', B: 'bb', t0: T0, t1: T1 };
  assert.equal(strictClaimGate({ record: rec, reads: [ok, ok], tipTime: C0 + 60, localNow: C0 + 60, remainingBlocks: 150 }).ok, true);
  assert.equal(strictClaimGate({ record: { ...rec, claimAbort: 'ambiguous' }, reads: [ok], tipTime: C0 + 60, localNow: C0 + 60, remainingBlocks: 150 }).why, 'claim-ambiguous');
  assert.equal(strictClaimGate({ record: { ...rec, direction: undefined }, reads: [ok], tipTime: C0 + 60, localNow: C0 + 60, remainingBlocks: 150 }).why, 'not-a-reverse-swap');
  assert.equal(strictClaimGate({ record: rec, reads: [ok], tipTime: null, localNow: C0 + 60, remainingBlocks: 150 }).why, 'chain-time-unobserved');
});

// ---- one variant while open; rebroadcast of the same bytes only while the timing holds; ambiguity at c + W - margin ----
test('claim: no second variant while an attempt is open; a failed send is rebroadcast as the SAME bytes while the timing holds, withheld after; ambiguous near c + W stops every claim', async () => {
  const t = setup({ sendFails: true });
  const first = await t.sender.sendClaim(t.s); assert.equal(first.sent, true); const sig = t.reload().claimAttempts[0].sig;
  assert.equal((await t.sender.sendClaim(t.s)).refused, 'attempt-open');
  assert.equal(t.s.claimAttempts[0].state, 'send-error');
  t.chain.sendFails = false; t.chain.sends.length = 0;
  assert.equal((await t.sender.resolve(t.s)).open, 1);
  assert.equal(t.chain.sends.length, 2, 'rebroadcast to both endpoints'); for (const x of t.chain.sends) assert.deepEqual(validSigs(x.tx, t.maker), [sig], 'same signature, same bytes');
  // later: the window end is near; the same open attempt is not rebroadcast and the swap turns ambiguous
  t.s.claimAttempts[0].state = 'send-error'; t.chain.sends.length = 0; t.chain.confTime = DEADLINE - CLAIM_LANDING_MARGIN;
  await t.sender.resolve(t.s);
  assert.equal(t.chain.sends.length, 0, 'withheld'); assert.equal(t.s.claimAbort, 'ambiguous'); assert.ok(t.logs.some((e) => e.event === 'alarm-claim-ambiguous'));
  assert.ok(t.logs.some((e) => e.event === 'rebroadcast-withheld' && e.why === 'claim-ambiguous'));
  // expired later: still no new claim, ever
  t.s.claimAttempts[0].state = 'expired'; const callsBefore = t.chain.calls.length;
  assert.equal((await t.sender.sendClaim(t.s)).refused, 'claim-ambiguous');
  assert.equal(t.chain.calls.length, callsBefore, 'an ambiguous swap is refused before any read: no blockhash, no account read');
  assert.equal(claimRebroadcastBlock({}, { deadline: DEADLINE, lastValidBlockHeight: 9150 }, DEADLINE - 2000, 9000), null);
  assert.equal(claimRebroadcastBlock({}, { deadline: DEADLINE, lastValidBlockHeight: 9150 }, DEADLINE - 500, 9000), 'claim-timing-no-longer-holds');
  assert.equal(claimRebroadcastBlock({}, { deadline: DEADLINE, lastValidBlockHeight: 9150 }, DEADLINE, 9000), 'after-claim-window');
  assert.equal(claimRebroadcastBlock({}, { lastValidBlockHeight: 9150 }, DEADLINE - 2000, 9000), 'claim-deadline-unknown');
  t.done();
});
test('settlement: a landed commit and a landed claim are recorded from finalized evidence on either endpoint; directions never cross', async () => {
  const t = setup({ escrow: { ready: true, c: 0 } });
  await t.sender.sendCommit(t.s); const cs = t.s.commitAttempts[0].sig;
  t.chain.per.secondary = { statuses: new Map([[cs, finalized()]]) };
  assert.equal((await t.sender.resolve(t.s)).open, 0); assert.equal(t.s.commitSig, cs); assert.equal(t.s.commitAttempts[0].resolvedSlot, FIN_SLOT);
  t.chain.escrow = { ready: true, c: C0 }; delete t.chain.per.secondary;
  await t.sender.sendClaim(t.s); const ls = t.s.claimAttempts[0].sig; t.chain.statuses.set(ls, finalized());
  assert.equal((await t.sender.resolve(t.s)).open, 0); assert.equal(t.s.claimSig, ls);
  assert.equal((await t.sender.sendRefund(t.s, 'late')).refused, 'wrong-direction', 'the maker never refunds a strict escrow');
  assert.equal((await t.sender.sendReady(t.s)).refused, 'wrong-direction');
  assert.equal((await t.sender.sendClaim({ ...t.s, direction: undefined, claimAttempts: [] })).refused, 'wrong-direction');
  assert.equal((await t.sender.sendCommit({ ...t.s, direction: 'xmr-sol', commitAttempts: [] })).refused, 'wrong-direction');
  t.done();
});

// ---- the real step with the real sender: an open attempt blocks every new decision, never recovery ----
test('makerReverseStep + sender: an open claim attempt blocks every new Solana decision; a user refund still leads to recovery; ambiguous never claims again', async () => {
  const t = setup({ sendFails: true });
  const rev = (over = {}) => ({ readSwapFinalized: async () => ({ ready: true, claimCommittedAt: C0, t0: T0, t1: T1, lamports: t.s.lamports, claimPoint: t.s.A, refundPoint: t.s.B, claimer: t.s.claimer, refunder: t.s.refunder }),
    readRevealed: async () => null, chainNow: async () => t.chain.confTime, scanXmr: async () => null, store: t.store, log: () => {}, sendAllowed: () => true,
    resolve: (x) => t.sender.resolve(x), sendCommit: (x) => t.sender.sendCommit(x), sendClaim: (x) => t.sender.sendClaim(x), recoverXmr: async () => ({ status: 'recovered', txids: ['r'] }), wallNow: () => 0, ...over });
  assert.equal((await makerReverseStep(t.s, rev())).action, 'claim');
  assert.equal(t.chain.sends.length, 2);
  t.chain.sendFails = false; const before = t.chain.sends.length;
  const w = await makerReverseStep(t.s, rev({ wallNow: () => 10 ** 9 }));
  assert.deepEqual(w, { action: 'wait', reason: 'attempt-unsettled' });
  assert.equal(t.s.claimAttempts.length, 1, 'no second variant'); assert.ok(t.chain.sends.length - before <= 2, 'at most the same bytes again');
  // the user refunds (escrow gone, b revealed): recovery runs although the claim attempt is still open
  const out = await makerReverseStep(t.s, rev({ readSwapFinalized: async () => null, readRevealed: async (which) => (which === 'refund' ? { secretHex: 'bb'.repeat(32), sig: 'rs' } : null) }));
  assert.equal(out.action, 'recover-xmr');
  // an ambiguous swap with an escrow still open never claims again, whatever the decision says
  const u = setup(); u.s.claimAbort = 'ambiguous';
  const r = await makerReverseStep(u.s, { ...rev(), resolve: (x) => u.sender.resolve(x), sendClaim: (x) => u.sender.sendClaim(x), chainNow: async () => u.chain.confTime, store: u.store,
    readSwapFinalized: async () => ({ ready: true, claimCommittedAt: C0, t0: T0, t1: T1, lamports: u.s.lamports, claimPoint: u.s.A, refundPoint: u.s.B, claimer: u.s.claimer, refunder: u.s.refunder }) });
  assert.deepEqual(r, { action: 'wait', reason: 'claim-ambiguous-await-refund' }); assert.equal(u.chain.sends.length, 0);
  t.done(); u.done();
});

// ---- admission closed while recovery continues ----
test('one gate: with the drain file present a SOL -> XMR registration is refused before anything is stored, while the open swap keeps committing, claiming and recovering', async () => {
  const d = mkdtempSync(join(tmpdir(), 'drain-')), file = join(d, 'ADMISSION_CLOSED');
  const gate = createAdmission({ file, fs: { statSync, accessSync, W_OK: constants.W_OK } });
  writeFileSync(file, '');
  const stored = [];
  await assert.rejects(admitSwap({ quoteId: 'q' }, { isOpen: () => gate.isOpen(), takeQuote: () => ({ xmrAtomic: '1' }), checkLimits: () => true, prepare: async () => ({ record: { swapId: 'r' }, signed: null }), store: (x) => stored.push(x), broadcast: async () => ({}) }), /maker-paused/);
  assert.deepEqual(stored, []);
  // closed after the awaits of prepare: refused at the last check, still nothing stored
  rmSync(file); let closeNow;
  const p = admitSwap({ quoteId: 'q' }, { isOpen: () => gate.isOpen(), takeQuote: () => ({ xmrAtomic: '1' }), checkLimits: () => true, prepare: () => new Promise((res) => { closeNow = () => res({ record: { swapId: 'r' }, signed: null }); }), store: (x) => stored.push(x), broadcast: async () => ({}) });
  await new Promise((r) => setImmediate(r)); writeFileSync(file, ''); closeNow();
  await assert.rejects(p, /maker-paused/); assert.deepEqual(stored, []);
  // recovery of an open SOL -> XMR swap never reads the gate: commit, claim and recover all run with the file present
  const t = setup({ escrow: { ready: true, c: 0 } });
  let gateReads = 0; const counting = { isOpen: () => { gateReads++; return gate.isOpen(); } };
  const base = { readRevealed: async () => null, chainNow: async () => t.chain.confTime, scanXmr: async () => ({ atomic: t.s.xmrAtomic, confirmations: 10 }), store: t.store, log: () => {}, sendAllowed: () => false, wallNow: () => 0,
    resolve: (x) => t.sender.resolve(x), sendCommit: (x) => t.sender.sendCommit(x), sendClaim: (x) => t.sender.sendClaim(x), recoverXmr: async () => ({ status: 'recovered', txids: ['r'] }) };
  const esc = (c) => async () => ({ ready: true, claimCommittedAt: c, t0: T0, t1: T1, lamports: t.s.lamports, claimPoint: t.s.A, refundPoint: t.s.B, claimer: t.s.claimer, refunder: t.s.refunder });
  t.chain.confTime = T0 + 100;
  assert.equal((await makerReverseStep(t.s, { ...base, readSwapFinalized: esc(0) })).action, 'commit-claim');
  t.chain.statuses.set(t.s.commitAttempts[0].sig, finalized()); t.chain.escrow = { ready: true, c: C0 }; t.chain.confTime = C0 + 60;
  assert.equal((await makerReverseStep(t.s, { ...base, readSwapFinalized: esc(C0), wallNow: () => 10 ** 9 })).action, 'claim');
  assert.equal(t.s.claimAttempts.length, 1);
  const out = await makerReverseStep({ ...t.s, claimAttempts: [] }, { ...base, readSwapFinalized: async () => null, readRevealed: async (w) => (w === 'refund' ? { secretHex: 'cc'.repeat(32), sig: 'r' } : null) });
  assert.equal(out.action, 'recover-xmr');
  assert.equal(gateReads, 0, 'the step never consulted the admission gate'); assert.equal(counting.isOpen(), false);
  rmSync(d, { recursive: true, force: true }); t.done();
});

// ---- ambiguous records block quiesce (the one check, both directions) ----
const EXP = 20_000;
const ev = (over = {}) => ({ expiry: { slot: EXP, height: EXP }, historyIndex: { ok: true }, account: { slot: EXP, kind: 'none' }, history: [], sigStatus: null, sigStatusSlot: EXP, boundary: { started: null, H: null }, attempts: {}, ...over });
const sigA = bs58.encode(Buffer.alloc(64, 7));
const revRec = (over = {}) => ({ direction: 'sol-xmr', swapId: 'cd'.repeat(32), createdAt: '2026-11-09T10:00:00.000Z', refunder: Keypair.generate().publicKey.toBase58(), xmrAtomic: '1', ...over });
test('quiesce: an open SOL -> XMR swap always blocks; a final one passes only when its strict PDA is empty and every send attempt is settled', () => {
  assert.equal(classifyRecord(revRec(), ev()).why, 'reverse-swap-open');
  assert.equal(classifyRecord(revRec({ done: 'completed' }), ev()).k, 'K0');
  for (const done of ['xmr-recovered', 'refunded-before-send', 'not-locked', 'xmr-never-relayed']) assert.equal(classifyRecord(revRec({ done }), ev()).k, 'K0', done);
  assert.equal(classifyRecord(revRec({ done: 'whatever' }), ev()).k, null);
  assert.equal(classifyRecord(revRec({ done: 'completed' }), ev({ account: { slot: EXP, kind: 'escrow' } })).why, 'escrow-at-pda');
  assert.equal(classifyRecord(revRec({ done: 'completed' }), ev({ account: { slot: EXP - 1, kind: 'none' } })).why, 'stale-account-context');
  assert.equal(classifyRecord(revRec({ done: 'completed' }), ev({ account: { slot: EXP, kind: 'unknown-type' } })).why, 'unknown-account-at-pda', 'a pre-v2 strict layout at the PDA blocks');
});
test('quiesce: a send attempt that may still land blocks a record of either direction until it is finalized or provably expired, from fresh reads only', () => {
  const att = (action, state = 'sent', lvbh = EXP - EXPIRY_MARGIN) => ({ n: 1, action, sig: sigA, lastValidBlockHeight: lvbh, state });
  for (const [rec, list, action] of [[revRec({ done: 'completed' }), 'claimAttempts', 'claim-strict'], [revRec({ done: 'xmr-recovered' }), 'commitAttempts', 'commit-strict'],
    [{ swapId: 'ef'.repeat(32), createdAt: '2026-11-09T10:00:00.000Z', done: 'refunded' }, 'refundAttempts', 'refund'], [{ swapId: 'ef'.repeat(32), createdAt: '2026-11-09T10:00:00.000Z', done: 'completed' }, 'readyAttempts', 'set-ready']]) {
    const r = { ...rec, [list]: [att(action)] };
    assert.match(classifyRecord(r, ev({ attempts: {} })).why, /attempt-status-unread/, action);
    assert.match(classifyRecord(r, ev({ attempts: { [sigA]: { status: null, slot: EXP } } })).why, /attempt-may-still-land/, `${action}: unknown but not yet expired`);
    assert.match(classifyRecord(r, ev({ attempts: { [sigA]: { status: null, slot: EXP - 1 } } })).why, /stale-attempt-status-context/, action);
    assert.match(classifyRecord(r, ev({ attempts: { [sigA]: { status: { confirmationStatus: 'confirmed', err: null }, slot: EXP } } })).why, /attempt-not-finalized/, action);
    assert.equal(classifyRecord(r, ev({ attempts: { [sigA]: { status: finalized(), slot: EXP } } })).k, 'K0', `${action}: finalized`);
    const old = { ...rec, [list]: [att(action, 'sent', EXP - EXPIRY_MARGIN - 1)] };
    assert.equal(classifyRecord(old, ev({ attempts: { [sigA]: { status: null, slot: EXP } } })).k, 'K0', `${action}: unknown and expired`);
    assert.equal(classifyRecord({ ...rec, [list]: [att(action, 'landed')] }, ev()).k, 'K0', 'a settled attempt needs no read');
  }
  assert.equal(attemptsProblem({ claimAttempts: [{ sig: sigA, state: 'persisted', lastValidBlockHeight: 1 }] }, ev({ attempts: { [sigA]: { status: null, slot: EXP } } })), null);
});
test('quiesce: an open record with an ambiguity mark blocks; the verdict refuses any NOT OK class; the schema knows both directions', () => {
  for (const mark of [{ earlyAbort: 'ambiguous' }, { claimAbort: 'ambiguous' }, { endpointDisagreement: { sig: 'x' } }])
    assert.equal(classifyRecord({ swapId: 'ab'.repeat(32), createdAt: '2026-11-09T10:00:00.000Z', ...mark }, ev()).why, 'ambiguity-mark-on-open-swap', JSON.stringify(mark));
  const v = quiesceVerdict({ status: { admission: 'closed', inflight: 0 }, classes: [{ id: 'cdcdcdcd', ...classifyRecord(revRec(), ev()) }], chain: { ours: [], foreign: [], undecodable: [], strictAll: [] }, binding: { ok: true }, generation: { ok: true } });
  assert.equal(v.ok, false); assert.match(v.problems.join(), /reverse-swap-open/);
  const r = revRec({ done: 'completed', claimAttempts: [{ n: 1, action: 'claim-strict', sig: sigA, lastValidBlockHeight: 5, state: 'landed' }] });
  assert.equal(recordProblem(r, r.swapId), null);
  assert.match(String(recordProblem({ ...r, done: 'refunded' }, r.swapId)), /done/, 'a forward-only final state is not a reverse one');
  assert.match(String(recordProblem({ ...r, refunder: undefined }, r.swapId)), /refunder/);
  assert.match(String(recordProblem({ ...r, claimAttempts: [{ sig: 'O0Il', lastValidBlockHeight: 5, state: 'sent' }] }, r.swapId)), /claimAttempts entry/);
  assert.match(String(recordProblem({ ...r, direction: 'sideways' }, r.swapId)), /direction/);
});
test('quiesce evidence: a SOL -> XMR record is read at its STRICT PDA (refunder = the user) and every open attempt status is read; only get* methods', async () => {
  const user = Keypair.generate().publicKey, maker = Keypair.generate().publicKey, swapId = 'cd'.repeat(32);
  const want = strictPda(user, Buffer.from(swapId, 'hex')).toBase58(), calls = [];
  const rpc = async (m, params) => { calls.push([m, params?.[0]]); if (m === 'getAccountInfo') return { context: { slot: EXP }, value: null }; if (m === 'getSignaturesForAddress') return []; if (m === 'getSignatureStatuses') return { context: { slot: EXP }, value: [null] }; throw new Error(m); };
  const rec = revRec({ swapId, refunder: user.toBase58(), done: 'completed', claimAttempts: [{ n: 1, action: 'claim-strict', sig: sigA, lastValidBlockHeight: 1, state: 'sent' }] });
  const e = await collectEvidence(rpc, { snapshot: { expiry: { slot: EXP, height: EXP }, historyIndex: { ok: true } }, record: rec, makerKey: maker, program: sol.PROGRAM_ID.toBase58() });
  assert.deepEqual(calls.map((c) => c[0]), ['getAccountInfo', 'getSignaturesForAddress', 'getSignatureStatuses']); assert.equal(calls[0][1], want); assert.equal(calls[1][1], want, 'the strict PDA history is read');
  assert.deepEqual(e.attempts[sigA], { status: null, slot: EXP }); assert.equal(classifyRecord(rec, e).k, 'K0', 'unknown and long expired');
});

// ---- hygiene: once final, the secret-bearing bytes of attempts go too; identities stay ----
test('hygiene: a final state also drops the raw bytes of refund and claim attempts (they carry b or a); signatures, heights and states stay', () => {
  const s = { swapId: 'ab', a: 'aa'.repeat(32), v: 'vv', done: 'completed', finalEvidence: { finalizedSlot: 3 }, claimAttempts: [{ sig: 'S', lastValidBlockHeight: 9, state: 'landed', raw: 'AAAA' }], refundAttempts: [{ sig: 'R', lastValidBlockHeight: 9, state: 'expired', raw: 'BBBB' }] };
  // 701-H1: without finalized proof, or with any attempt still open, nothing is removed
  for (const bad of [{ finalEvidence: undefined }, { done: undefined }, { claimAttempts: [{ sig: 'S', lastValidBlockHeight: 9, state: 'sent', raw: 'AAAA' }] }]) {
    const x = JSON.parse(JSON.stringify({ ...s, ...bad })); assert.equal(scrubSecrets(x, 5), 0, JSON.stringify(bad)); assert.equal(x.a, s.a); assert.ok(x.claimAttempts[0].raw && x.refundAttempts[0].raw);
  }
  scrubSecrets(s, 5);
  assert.deepEqual(s.claimAttempts, [{ sig: 'S', lastValidBlockHeight: 9, state: 'landed' }]); assert.deepEqual(s.refundAttempts, [{ sig: 'R', lastValidBlockHeight: 9, state: 'expired' }]);
  assert.equal(s.a, undefined); assert.equal(s.secretsWipedAt, 5);
});
assert.equal(ATTEMPT_EXPIRY_MARGIN, EXPIRY_MARGIN, 'the sender and the quiesce check use the same expiry margin');

// ---- F5 (9 Nov rehearsal): a slow secondary is judged by measured read latency, not by read order; real forks still refuse ----
const realClock = (t) => { const base = t.clock.ms, t00 = Date.now(); Object.defineProperty(t.clock, 'ms', { get: () => base + (Date.now() - t00), set: () => {}, configurable: true }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slowSecondary = (ms) => async (name) => { if (name === 'secondary') await sleep(ms); };
test('F5: a secondary that takes 1.3 s per call on an identical, moving chain does not stall the claim (concurrent reads, drift is not a disagreement)', async () => {
  const start = Date.now(); const drift = () => 9000 + Math.floor((SLOTS_PER_SECOND * (Date.now() - start)) / 1000);
  const t = setup({ latency: slowSecondary(1300), per: { secondary: { get height() { return drift(); } } } }); realClock(t);
  const r = await t.sender.sendClaim(t.s); assert.equal(r.sent, true, JSON.stringify(r)); t.done();
});
test('F5: the latency allowance is measured: +11 blocks with a 1.3 s secondary passes (8 + ceil(3.25) = 12), +13 refuses, and +11 from a fast secondary still refuses', async () => {
  let t = setup({ latency: slowSecondary(1300), per: { secondary: { height: 9011 } } }); realClock(t);
  assert.equal((await t.sender.sendClaim(t.s)).sent, true); t.done();
  t = setup({ latency: slowSecondary(1300), per: { secondary: { height: 9013 } } }); realClock(t);
  assert.equal((await t.sender.sendClaim(t.s)).refused, 'endpoint-heights-disagree'); assert.deepEqual(withSecret(t), []); assert.equal(t.chain.sends.length, 0); t.done();
  t = setup({ per: { secondary: { height: 9011 } } });   // no measured latency (frozen clock): base tolerance only
  assert.equal((await t.sender.sendClaim(t.s)).refused, 'endpoint-heights-disagree'); t.done();
});
test('F5: a real fork or a secondary stuck 50+ slots behind or ahead still refuses, however slow it answers', async () => {
  for (const h of [8950, 9050, 9400]) {
    const t = setup({ latency: slowSecondary(1300), per: { secondary: { height: h } } }); realClock(t);
    assert.equal((await t.sender.sendClaim(t.s)).refused, 'endpoint-heights-disagree', String(h)); assert.deepEqual(withSecret(t), []); assert.equal(t.chain.sends.length, 0); t.done();
  }
});
test('F5: heightTolerance = HEIGHT_AGREEMENT + ceil(gap * SLOTS_PER_SECOND), capped at HEIGHT_SKEW_CAP; no measurement means no allowance', () => {
  const tm = (gapMs) => ({ timing: { primaryStart: 1000, primaryEnd: 1100, secondaryStart: 1000, secondaryEnd: 1000 + gapMs } });
  assert.equal(heightTolerance({}), HEIGHT_AGREEMENT); assert.equal(heightTolerance({ timing: { primaryStart: NaN } }), HEIGHT_AGREEMENT);
  assert.equal(heightTolerance(tm(0)), HEIGHT_AGREEMENT + 1, 'the primary read alone (100 ms) still counts');
  assert.equal(heightTolerance(tm(1300)), HEIGHT_AGREEMENT + Math.ceil(1.3 * SLOTS_PER_SECOND));
  assert.equal(heightTolerance(tm(60_000)), HEIGHT_AGREEMENT + HEIGHT_SKEW_CAP, 'the cap holds for a very slow endpoint');
  assert.ok(HEIGHT_AGREEMENT + HEIGHT_SKEW_CAP < 50, 'even at the cap a 50 block gap refuses');
});
test('F5 (Astra): lifetime uses the LOWER height: a secondary that is falsely high cannot shorten the margin; a lower primary lengthens it', async () => {
  const need = Math.max(CLAIM_SEND_MIN_LEAD, 150 * MAX_SECONDS_PER_BLOCK + CLAIM_LANDING_MARGIN);
  // lifetime 150 from the primary height 9000; secondary 9005 (tolerated skew). With the LOWER height remaining = 150, need as computed for 150 blocks.
  const t = setup({ confTime: DEADLINE - need, per: { secondary: { height: 9005 } } });
  assert.equal((await t.sender.sendClaim(t.s)).sent, true); assert.equal(t.reload().claimAttempts[0].deadline, DEADLINE); t.done();
  // the same chain with the secondary BELOW the primary by 5: remaining blocks grow to 155 (the lower height), beyond the 150 block lifetime bound, so it refuses (the old max-height math would have said 150 and signed)
  const u = setup({ confTime: DEADLINE - need, per: { secondary: { height: 8995 } } });
  const r = await u.sender.sendClaim(u.s); assert.equal(r.refused, 'blockhash-lifetime-unbounded'); assert.equal(r.unsent, true); u.done();
});
test('F5 (Astra): timing from a clock that went backwards, or missing, gives no allowance (monotonic input is required)', async () => {
  const back = { timing: { primaryStart: 5000, primaryEnd: 4000, secondaryStart: 1000, secondaryEnd: 9000 } };
  assert.equal(heightTolerance(back), HEIGHT_AGREEMENT); assert.equal(heightTolerance({ timing: { primaryStart: 1, primaryEnd: Infinity, secondaryStart: 1, secondaryEnd: 2 } }), HEIGHT_AGREEMENT);
  // end to end: an injected monotonic clock that runs backwards never widens the tolerance (+9 would pass with an allowance of 1)
  const t = setup({ per: { secondary: { height: 9009 } } }); let n = 1e9;
  const sender = createSender({ conns: [conn(t.chain, 'primary', t.s), conn(t.chain, 'secondary', t.s)], payer: t.maker, store: t.store, log: () => {}, clock: () => t.clock.ms, monotonic: () => (n -= 1000) });
  assert.equal((await sender.sendClaim(t.s)).refused, 'endpoint-heights-disagree'); t.done();
  const u = setup({ per: { secondary: { height: 9009 } } }); let m = 0;
  const forward = createSender({ conns: [conn(u.chain, 'primary', u.s), conn(u.chain, 'secondary', u.s)], payer: u.maker, store: u.store, log: () => {}, clock: () => u.clock.ms, monotonic: () => (m += 400) });
  assert.equal((await forward.sendClaim(u.s)).sent, true, 'a forward monotonic clock with measured latency does widen it'); u.done();
});
