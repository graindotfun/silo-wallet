// Astra 701-H1 (round 1 on PR 701): terminal cleanup must never destroy recovery material before the terminal result is FINAL.
// The real adapters (client/sol.mjs readSwap and readRevealedSecret at confirmed, maker/strict-sol.mjs for SOL -> XMR) and the real sender
// (maker/maker-send.mjs, with proveFinal) run against REAL web3.js 1.99.0 Connections whose fetch is a fake chain with separate confirmed and
// finalized views. A refund or claim that is confirmed but not finalized, an escrow that disappears at confirmed and reappears, and a restart
// in between must keep every secret, every attempt's bytes and the record's place in the recovery loop; only finalized proof ends it.
import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, renameSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { Keypair, Connection, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import * as sol from '../client/sol.mjs';
import { randomScalar, pub, toLE, hex } from '../client/keys.mjs';
import { makerStep, classifyRecord, finishIfFinal } from './maker-core.mjs';
import { makerReverseStep } from './maker-reverse.mjs';
import { createSender } from './maker-send.mjs';
import { strictPda, readStrictFinalized, readRevealedStrict } from './strict-sol.mjs';
import { REV_CLAIM_WINDOW, REV_COMMIT_WINDOW } from '../client/reverse-core.mjs';

const T0 = 1_900_000_000, T1 = T0 + 7200, NOW = T1 + 3600;
const CONF_SLOT = 5000, FIN_SLOT = 4968;
const tag = (name) => createHash('sha256').update(name).digest().subarray(0, 8);

function normalEscrow(s) {
  const b = Buffer.alloc(8 + 186); tag('account:Swap').copy(b, 0); const d = b.subarray(8);
  bs58.decode(s.refunder).forEach((x, i) => { d[i] = x; }); bs58.decode(s.claimer).forEach((x, i) => { d[32 + i] = x; });
  Buffer.from(s.A, 'hex').copy(d, 64); Buffer.from(s.B, 'hex').copy(d, 96);
  d.writeBigUInt64LE(BigInt(s.lamports), 128); d.writeBigInt64LE(BigInt(s.t0), 136); d.writeBigInt64LE(BigInt(s.t1), 144); d[152] = 0; Buffer.from(s.swapId, 'hex').copy(d, 153);
  return b.toString('base64');
}
function strictEscrow(s, c) {
  const b = Buffer.alloc(8 + 194); tag('account:StrictSwap').copy(b, 0); const d = b.subarray(8);
  bs58.decode(s.refunder).forEach((x, i) => { d[i] = x; }); bs58.decode(s.claimer).forEach((x, i) => { d[32 + i] = x; });
  Buffer.from(s.A, 'hex').copy(d, 64); Buffer.from(s.B, 'hex').copy(d, 96);
  d.writeBigUInt64LE(BigInt(s.lamports), 128); d.writeBigInt64LE(BigInt(s.t0), 136); d.writeBigInt64LE(BigInt(s.t1), 144); d[152] = 1; Buffer.from(s.swapId, 'hex').copy(d, 153); d.writeBigInt64LE(BigInt(c), 186);
  return b.toString('base64');
}
/** The closing transaction (refund or claim) as getTransaction json: fee payer, escrow, program; data = tag + scalar. */
function closingTx(feePayer, pda, ixName, scalar) {
  return { slot: CONF_SLOT - 2, blockTime: NOW, meta: null, version: 'legacy',
    transaction: { signatures: [bs58.encode(randomBytes(64))], message: { header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
      accountKeys: [feePayer, pda, sol.PROGRAM_ID.toBase58()], recentBlockhash: bs58.encode(randomBytes(32)),
      instructions: [{ programIdIndex: 2, accounts: [1, 0], data: bs58.encode(Buffer.concat([sol.disc(ixName), Buffer.from(scalar)])) }] } } };
}

/** views.conf / views.fin = { escrow: base64 | null, history: [sig] }; statuses: sig -> status. */
function makeChain(over = {}) {
  return { confTime: NOW, finTime: NOW - 13, height: 9000, finHeight: 8968, lifetime: 150, views: { conf: { escrow: null, history: [] }, fin: { escrow: null } }, statuses: new Map(), txs: new Map(), calls: [], sends: [], ...over };
}
function conn(chain, name) {
  const answer = (method, params) => {
    const cfg = params?.find?.((p) => p && typeof p === 'object' && !Array.isArray(p) && (p.commitment || p.minContextSlot !== undefined || p.limit)) ?? {};
    const fin = cfg.commitment === 'finalized';
    switch (method) {
      case 'getLatestBlockhash': return { context: { slot: CONF_SLOT }, value: { blockhash: bs58.encode(createHash('sha256').update(`bh-${chain.height}`).digest()), lastValidBlockHeight: chain.height + chain.lifetime } };
      case 'getSlot': return fin ? FIN_SLOT : CONF_SLOT;
      case 'getBlock': return { blockhash: 'x', previousBlockhash: 'x', parentSlot: params[0] - 1, blockTime: params[0] === FIN_SLOT ? chain.finTime : chain.confTime, blockHeight: params[0] === FIN_SLOT ? chain.finHeight : chain.height };
      case 'getBlockTime': return params[0] === FIN_SLOT ? chain.finTime : chain.confTime;
      case 'getBlockHeight': return chain.height;
      case 'isBlockhashValid': return { context: { slot: CONF_SLOT }, value: true };
      case 'getAccountInfo': {
        const per = chain.per?.[name] ?? {};   // per-endpoint finalized view and lag (a node that ignores minContextSlot answers from an older slot)
        const slot = fin ? FIN_SLOT - (per.finLag ?? 0) : CONF_SLOT, e = fin ? ('finEscrow' in per ? per.finEscrow : chain.views.fin.escrow) : chain.views.conf.escrow;
        if (!per.ignoreMin && Number.isInteger(cfg.minContextSlot) && cfg.minContextSlot > slot) return { error: { code: -32016, message: 'Minimum context slot has not been reached' } };
        return { context: { slot }, value: e ? { data: [e, 'base64'], executable: false, lamports: 1_002_000, owner: sol.PROGRAM_ID.toBase58(), rentEpoch: 0, space: Buffer.from(e, 'base64').length } : null };
      }
      case 'getSignaturesForAddress': return cfg.before ? [] : chain.views.conf.history.map((signature) => ({ signature, slot: CONF_SLOT - 2, err: null, memo: null, blockTime: NOW, confirmationStatus: 'confirmed' }));
      case 'getTransaction': return chain.txs.get(params[0]) ?? null;
      case 'getSignatureStatuses': return { context: { slot: CONF_SLOT }, value: params[0].map((sig) => chain.statuses.get(sig) ?? null) };
      case 'simulateTransaction': return { context: { slot: CONF_SLOT }, value: { err: null, logs: [], accounts: null, unitsConsumed: 900, returnData: null } };
      case 'sendTransaction': return bs58.encode(VersionedTransaction.deserialize(Buffer.from(params[0], 'base64')).signatures[0]);
      default: return undefined;
    }
  };
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body), reqs = Array.isArray(body) ? body : [body], outs = [];
    for (const r of reqs) {
      chain.calls.push({ endpoint: name, method: r.method });
      if (r.method === 'sendTransaction') chain.sends.push({ endpoint: name, tx: r.params[0] });
      const result = answer(r.method, r.params);
      outs.push(result?.error ? { jsonrpc: '2.0', id: r.id, error: result.error } : result === undefined ? { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: `unexpected ${r.method}` } } : { jsonrpc: '2.0', id: r.id, result });
    }
    return new Response(JSON.stringify(Array.isArray(body) ? outs : outs[0]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return new Connection(`http://127.0.0.1:9/${name}`, { commitment: 'confirmed', fetch, disableRetryOnRateLimit: true });
}
const confirmedOk = { slot: CONF_SLOT - 2, confirmations: 3, err: null, confirmationStatus: 'confirmed' };
const finalizedOk = { slot: CONF_SLOT - 2, confirmations: null, err: null, confirmationStatus: 'finalized' };

function world(rec) {
  const dir = mkdtempSync(join(tmpdir(), 'finality-')), file = join(dir, `${rec.swapId}.json`);
  const store = (x) => { writeFileSync(`${file}.tmp`, JSON.stringify(x)); renameSync(`${file}.tmp`, file); };
  const chain = makeChain(), logs = [];
  const conns = [conn(chain, 'primary'), conn(chain, 'secondary')];
  sol.setConnection(conns[0]);
  const newSender = (payer) => createSender({ conns, payer, store, log: (e) => logs.push(e), clock: () => chain.confTime * 1000 });
  store(rec);
  return { dir, file, store, chain, logs, conns, newSender, reload: () => JSON.parse(readFileSync(file, 'utf8')), done: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---- XMR -> SOL (ordinary direction, the maker is the refunder) ----
test('701-H1 forward: a refund confirmed but not finalized, the escrow gone at confirmed and back again, and a restart keep b, v and every attempt byte; only finalized proof ends the swap', async () => {
  const maker = Keypair.generate(), b = randomScalar();
  const rec = { swapId: randomBytes(32).toString('hex'), createdAt: '2026-11-09T10:00:00.000Z', A: hex(pub(randomScalar())), B: hex(pub(b)), b: hex(toLE(b)), v: 'ab'.repeat(32), V: 'cd'.repeat(32),
    claimer: Keypair.generate().publicKey.toBase58(), refunder: maker.publicKey.toBase58(), lamports: 1_000_000, t0: T0, t1: T1, lockedAt: T0 - 7200, xmrAtomic: '100', solLocked: true, lockSig: bs58.encode(randomBytes(64)), lockLastValidBlockHeight: 10 };
  const w = world(rec), id = Buffer.from(rec.swapId, 'hex'), pda = sol.swapPda(maker.publicKey, id).toBase58();
  w.chain.views.conf.escrow = w.chain.views.fin.escrow = normalEscrow(rec);
  let sender = w.newSender(maker);
  const deps = () => ({ readSwap: () => sol.readSwap(maker.publicKey, id), readRevealed: async (which, point, cursor, onCursor) => { const x = await sol.readRevealedSecret(maker.publicKey, id, which, point, { cursor, onCursor }); return x && { secretHex: hex(x.secret), sig: x.sig }; },
    chainNow: () => sol.chainNow(), scanXmr: async () => null, resolve: (x) => sender.resolve(x), proveFinal: (x, o) => sender.proveFinal(x, o),
    sendReady: (x) => sender.sendReady(x), sendRefund: (x, k) => sender.sendRefund(x, k), sweep: async () => null, store: w.store, log: () => {}, sweepAllowed: () => true });
  // 1. the maker's late refund goes out (b leaves, attempt bytes on disk)
  let s = w.reload();
  assert.equal((await makerStep(s, deps())).action, 'refund');
  const att = w.reload().refundAttempts[0]; assert.ok(att.raw);
  // 2. it is CONFIRMED, not finalized: the escrow is gone at confirmed and the confirmed history shows the refund carrying b
  const tx = closingTx(maker.publicKey.toBase58(), pda, 'refund', toLE(b)); w.chain.txs.set(att.sig, tx); w.chain.statuses.set(att.sig, confirmedOk);
  w.chain.views.conf = { escrow: null, history: [att.sig] };
  s = w.reload(); let r = await makerStep(s, deps());
  assert.deepEqual(r, { action: 'wait', reason: 'terminal-not-proven' });
  let d = w.reload(); assert.equal(d.done, undefined); assert.equal(d.b, rec.b); assert.equal(d.v, rec.v); assert.equal(d.refundAttempts[0].raw, att.raw); assert.equal(d.provisionalResult.result, 'refunded');
  // 3. restart (new sender, record from disk), the confirmation flips: the escrow is back at confirmed, the history forgets the refund
  sender = w.newSender(maker); w.chain.statuses.delete(att.sig); w.chain.views.conf = { escrow: normalEscrow(rec), history: [] };
  s = w.reload(); r = await makerStep(s, deps());
  assert.deepEqual(r, { action: 'wait', reason: 'attempt-unsettled' }, 'still tracked: the open attempt blocks a second variant, the swap is not dropped');
  d = w.reload(); assert.equal(d.done, undefined); assert.equal(d.b, rec.b); assert.ok(d.refundAttempts[0].raw);
  // 4. the refund lands for good: finalized status, escrow gone at confirmed AND finalized -> terminal, and only now scrubbed
  w.chain.statuses.set(att.sig, finalizedOk); w.chain.views.conf = { escrow: null, history: [att.sig] }; w.chain.views.fin = { escrow: null };
  s = w.reload(); r = await makerStep(s, deps());
  assert.equal(r.action, 'done'); d = w.reload();
  assert.equal(d.done, 'refunded'); assert.equal(d.b, undefined); assert.equal(d.v, undefined); assert.equal(d.refundAttempts[0].raw, undefined); assert.equal(d.refundAttempts[0].sig, att.sig);
  assert.equal(d.finalEvidence.outcomeSig, att.sig); assert.equal(d.finalEvidence.finalizedSlot, FIN_SLOT); assert.equal(d.provisionalResult, undefined);
  w.done();
});
test('701-H1 forward: with no attempt of our own, a confirmed refund by history while the escrow still exists at finalized is NOT terminal; secrets stay', async () => {
  const maker = Keypair.generate(), b = randomScalar();
  const rec = { swapId: randomBytes(32).toString('hex'), createdAt: '2026-11-09T10:00:00.000Z', A: hex(pub(randomScalar())), B: hex(pub(b)), b: hex(toLE(b)), v: 'ab'.repeat(32),
    claimer: Keypair.generate().publicKey.toBase58(), refunder: maker.publicKey.toBase58(), lamports: 1_000_000, t0: T0, t1: T1, lockedAt: T0 - 7200, xmrAtomic: '100', solLocked: true };
  const w = world(rec), id = Buffer.from(rec.swapId, 'hex'), pda = sol.swapPda(maker.publicKey, id).toBase58(), sig = bs58.encode(randomBytes(64));
  w.chain.txs.set(sig, closingTx(maker.publicKey.toBase58(), pda, 'refund', toLE(b))); w.chain.statuses.set(sig, confirmedOk);
  w.chain.views.conf = { escrow: null, history: [sig] }; w.chain.views.fin = { escrow: normalEscrow(rec) };
  const sender = w.newSender(maker);
  const deps = { readSwap: () => sol.readSwap(maker.publicKey, id), readRevealed: async (which, point, cursor, onCursor) => { const x = await sol.readRevealedSecret(maker.publicKey, id, which, point, { cursor, onCursor }); return x && { secretHex: hex(x.secret), sig: x.sig }; },
    chainNow: () => sol.chainNow(), scanXmr: async () => null, resolve: (x) => sender.resolve(x), proveFinal: (x, o) => sender.proveFinal(x, o), sendReady: async () => ({ refused: 'x' }), sendRefund: async () => ({ refused: 'x' }), sweep: async () => null, store: w.store, log: () => {} };
  const s = w.reload();
  assert.deepEqual(await makerStep(s, deps), { action: 'wait', reason: 'terminal-not-proven' });
  assert.equal(w.reload().provisionalResult.why, 'escrow-account-at-finalized'); assert.equal(w.reload().b, rec.b);
  // escrow gone at finalized but the refund only confirmed: still not terminal
  w.chain.views.fin = { escrow: null };
  assert.deepEqual(await makerStep(w.reload(), deps), { action: 'wait', reason: 'terminal-not-proven' }); assert.equal(w.reload().provisionalResult.why, 'outcome-not-finalized');
  // a failed (err) status on one endpoint is contradictory: not terminal
  w.chain.statuses.set(sig, { ...finalizedOk, err: { InstructionError: [0, 'Custom'] } });
  assert.deepEqual(await makerStep(w.reload(), deps), { action: 'wait', reason: 'terminal-not-proven' });
  w.chain.statuses.set(sig, finalizedOk);
  // EVERY endpoint must agree: the secondary still shows the escrow at finalized -> not terminal
  w.chain.per = { secondary: { finEscrow: normalEscrow(rec) } };
  assert.deepEqual(await makerStep(w.reload(), deps), { action: 'wait', reason: 'terminal-not-proven' }); assert.equal(w.reload().provisionalResult.why, 'escrow-account-at-finalized');
  // a node that ignores minContextSlot and answers "absent" from an older finalized slot is stale, not proof
  w.chain.per = { secondary: { finEscrow: null, finLag: 20, ignoreMin: true } };
  assert.deepEqual(await makerStep(w.reload(), deps), { action: 'wait', reason: 'terminal-not-proven' }); assert.equal(w.reload().provisionalResult.why, 'stale-finalized-context'); assert.equal(w.reload().b, rec.b);
  w.chain.per = {};
  assert.equal((await makerStep(w.reload(), deps)).action, 'done'); assert.equal(w.reload().b, undefined);
  w.done();
});

// ---- SOL -> XMR (the maker is the claimer of a strict escrow) ----
test('701-H1 reverse: a strict claim confirmed but not finalized, then gone and back at confirmed, and a restart keep a, v, the commit and claim bytes; only finalized proof ends it', async () => {
  const maker = Keypair.generate(), user = Keypair.generate(), a = randomScalar(), c0 = T1 - 1000;
  const rec = { direction: 'sol-xmr', swapId: randomBytes(32).toString('hex'), createdAt: '2026-11-09T10:00:00.000Z', A: hex(pub(a)), a: hex(toLE(a)), B: hex(pub(randomScalar())), v: 'ab'.repeat(32), V: 'cd'.repeat(32),
    claimer: maker.publicKey.toBase58(), refunder: user.publicKey.toBase58(), lamports: 7_000_000, t0: T1 - REV_CLAIM_WINDOW, t1: T1, xmrAtomic: '50000000000', xmrSendTxid: 'aa'.repeat(32), xmrRelayed: true, seenPda: true, userProofOk: true, quoteExpiresAt: 1 };
  const w = world(rec), id = Buffer.from(rec.swapId, 'hex'), pda = strictPda(user.publicKey, id).toBase58();
  w.chain.confTime = c0 + 60; w.chain.finTime = c0 + 47;
  w.chain.views.conf.escrow = w.chain.views.fin.escrow = strictEscrow(rec, c0);
  let sender = w.newSender(maker);
  const deps = () => ({ readSwapFinalized: () => readStrictFinalized(user.publicKey, id), readRevealed: async (which, point, cursor, onCursor) => { const x = await readRevealedStrict(user.publicKey, id, which, point, { cursor, onCursor }); return x && { secretHex: hex(x.secret), sig: x.sig }; },
    chainNow: () => sol.chainNow(), scanXmr: async () => null, resolve: (x) => sender.resolve(x), proveFinal: (x, o) => sender.proveFinal(x, o), sendCommit: (x) => sender.sendCommit(x), sendClaim: (x) => sender.sendClaim(x),
    recoverXmr: async () => { throw new Error('no recovery expected'); }, store: w.store, log: () => {}, sendAllowed: () => true, wallNow: () => 10 ** 12 });
  // a landed commit attempt (so the claim reads at least at its slot), then the claim goes out
  const s0 = w.reload(); s0.commitAttempts = [{ n: 1, action: 'commit-strict', sig: bs58.encode(randomBytes(64)), lastValidBlockHeight: 1, state: 'landed', resolvedSlot: FIN_SLOT - 1, raw: 'COMMITBYTES' }]; w.store(s0);
  assert.equal((await makerReverseStep(w.reload(), deps())).action, 'claim');
  const att = w.reload().claimAttempts[0]; assert.ok(att.raw);
  // confirmed, not finalized: the strict escrow is gone at confirmed AND (worst case) at finalized, the confirmed history shows the claim
  const tx = closingTx(maker.publicKey.toBase58(), pda, 'claim_strict', toLE(a)); w.chain.txs.set(att.sig, tx); w.chain.statuses.set(att.sig, confirmedOk);
  w.chain.views.conf = { escrow: null, history: [att.sig] }; w.chain.views.fin = { escrow: null };
  let r = await makerReverseStep(w.reload(), deps());
  assert.deepEqual(r, { action: 'wait', reason: 'terminal-not-proven' });
  let d = w.reload(); assert.equal(d.done, undefined); assert.equal(d.a, rec.a); assert.equal(d.v, rec.v); assert.equal(d.claimAttempts[0].raw, att.raw); assert.equal(d.commitAttempts[0].raw, 'COMMITBYTES'); assert.equal(d.provisionalResult.why, 'attempt-open');
  // restart, flip back: the escrow is open again (finalized view too), history forgets the claim: the swap is tracked, nothing destroyed
  sender = w.newSender(maker); w.chain.statuses.delete(att.sig); w.chain.views.conf = { escrow: strictEscrow(rec, c0), history: [] }; w.chain.views.fin = { escrow: strictEscrow(rec, c0) };
  r = await makerReverseStep(w.reload(), deps());
  assert.deepEqual(r, { action: 'wait', reason: 'attempt-unsettled' }); d = w.reload(); assert.equal(d.done, undefined); assert.equal(d.a, rec.a); assert.ok(d.claimAttempts[0].raw);
  // finalized for good -> terminal and scrubbed
  w.chain.statuses.set(att.sig, finalizedOk); w.chain.views.conf = { escrow: null, history: [att.sig] }; w.chain.views.fin = { escrow: null };
  r = await makerReverseStep(w.reload(), deps());
  assert.equal(r.result, 'completed'); d = w.reload();
  assert.equal(d.done, 'completed'); assert.equal(d.a, undefined); assert.equal(d.v, undefined); assert.equal(d.claimAttempts[0].raw, undefined); assert.equal(d.commitAttempts[0].raw, undefined); assert.equal(d.finalEvidence.outcomeSig, att.sig);
  w.done();
});
test('701-H1 reverse: an open COMMIT attempt and a quote "never locked" are terminal only on finalized proof', async () => {
  const maker = Keypair.generate(), user = Keypair.generate();
  const rec = { direction: 'sol-xmr', swapId: randomBytes(32).toString('hex'), createdAt: '2026-11-09T10:00:00.000Z', A: 'aa'.repeat(32), a: 'bb'.repeat(32), B: 'cc'.repeat(32), v: 'dd'.repeat(32),
    claimer: maker.publicKey.toBase58(), refunder: user.publicKey.toBase58(), lamports: 7, t0: T0, t1: T1, xmrAtomic: '1', userProofOk: true, quoteExpiresAt: 100 };
  const w = world(rec); const sender = w.newSender(maker);
  // not-locked: the strict escrow appears at finalized (a lock the maker had not seen): not terminal, a kept
  w.chain.views.fin = { escrow: strictEscrow(rec, 0) };
  assert.equal(await finishIfFinal(w.reload(), 'not-locked', null, { proveFinal: (x, o) => sender.proveFinal(x, o), store: w.store, log: () => {} }), false);
  assert.equal(w.reload().a, rec.a); assert.equal(w.reload().provisionalResult.why, 'escrow-account-at-finalized');
  w.chain.views.fin = { escrow: null };
  const s = w.reload(); assert.equal(await finishIfFinal(s, 'not-locked', null, { proveFinal: (x, o) => sender.proveFinal(x, o), store: w.store, log: () => {} }), true); assert.equal(s.a, undefined);
  // an open commit attempt blocks the terminal state even with everything else final
  const t = { ...rec, commitAttempts: [{ n: 1, action: 'commit-strict', sig: bs58.encode(randomBytes(64)), lastValidBlockHeight: 99_999, state: 'sent', raw: 'C' }] };
  assert.equal((await sender.proveFinal(t, null)).why, 'attempt-open');
  // a missing finality check is "not proven", never terminal
  const u = { ...rec }; assert.equal(await finishIfFinal(u, 'not-locked', null, { store: () => {}, log: () => {} }), false); assert.equal(u.done, undefined); assert.equal(u.a, rec.a);
  w.done();
});

// ---- quiesce: an attempt is "cannot land now" only with a fresh history index, and "never executed" only when the finalized history does not name it ----
test('701 round 1 (4): quiesce does not treat a lagging history index or an attempt named in the finalized history as settled', () => {
  const EXP = 20_000, sig = bs58.encode(Buffer.alloc(64, 9));
  const ev = (over = {}) => ({ expiry: { slot: EXP, height: EXP }, historyIndex: { ok: true }, account: { slot: EXP, kind: 'none' }, history: [], sigStatus: null, sigStatusSlot: EXP, boundary: {}, attempts: { [sig]: { status: null, slot: EXP } }, ...over });
  const r = { swapId: 'ab'.repeat(32), createdAt: '2026-11-09T10:00:00.000Z', done: 'refunded', refundAttempts: [{ n: 1, action: 'refund', sig, lastValidBlockHeight: 100, state: 'sent' }] };
  assert.equal(classifyRecord(r, ev()).k, 'K0', 'unknown, expired, fresh index, not in history');
  assert.match(classifyRecord(r, ev({ historyIndex: { ok: false } })).why, /history-index-behind-expiry/);
  assert.match(classifyRecord(r, ev({ history: null })).why, /pda-history-unreadable/);
  assert.match(classifyRecord(r, ev({ history: [{ signature: sig, err: null, slot: 5, kind: 'refund' }] })).why, /attempt-in-history-but-status-unknown/);
  const rr = { direction: 'sol-xmr', swapId: 'cd'.repeat(32), createdAt: '2026-11-09T10:00:00.000Z', refunder: Keypair.generate().publicKey.toBase58(), done: 'completed', claimAttempts: [{ n: 1, action: 'claim-strict', sig, lastValidBlockHeight: 100, state: 'send-error' }] };
  assert.match(classifyRecord(rr, ev({ historyIndex: { ok: false } })).why, /history-index-behind-expiry/);
  assert.equal(classifyRecord(rr, ev()).k, 'K0');
});
test('701 round 1 (4): the exposure mark stays meaningful across variants: the first secret-bearing attempt is named and every later variant is listed', async () => {
  const maker = Keypair.generate(), b = randomScalar();
  const rec = { swapId: randomBytes(32).toString('hex'), createdAt: '2026-11-09T10:00:00.000Z', A: hex(pub(randomScalar())), B: hex(pub(b)), b: hex(toLE(b)), claimer: Keypair.generate().publicKey.toBase58(), refunder: maker.publicKey.toBase58(), lamports: 1_000_000, t0: T0, t1: T1, solLocked: true };
  const w = world(rec); w.chain.views.fin.escrow = normalEscrow(rec);
  const sender = w.newSender(maker), s = w.reload();
  assert.equal((await sender.sendRefund(s, 'late')).sent, true);
  s.refundAttempts[0].state = 'expired';
  assert.equal((await sender.sendRefund(s, 'late')).sent, true);
  const d = w.reload();
  assert.equal(d.secretExposure.sig, d.refundAttempts[0].sig, 'the first exposure stays the reference point');
  assert.deepEqual(d.secretExposure.variants.map((x) => x.sig), d.refundAttempts.map((x) => x.sig), 'every variant is listed');
  w.done();
});
assert.ok(REV_COMMIT_WINDOW > 0);
