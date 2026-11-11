// Unit tests of the standalone XMR -> SOL client against a fake maker, a fake Solana chain and a fake Monero wallet RPC.
// Run: node --test prototypes/xmr-sol-atomic-swap/standalone/swap-lib-xmr-sol.test.mjs
// Keys are throwaway keys generated here. Every request goes through ONE recording fetcher; globalThis.fetch is a trap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, Transaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { sha256 } from '@noble/hashes/sha256';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomScalar, pub, toLE, hex, unhex, proveShare, addPoints, moneroAddress, fromLE } from '../client/keys.mjs';
import { swapPda, PROGRAM_ID } from '../../../lib/silo/atomic-swap/sol.mjs';
import * as lib from './swap-lib.mjs';
import * as fwd from './swap-lib-xmr-sol.mjs';
import { main } from './silo-swap.mjs';
import { makeWorldFactory, MAKER, SOL, SOL2, XMR, NODE, ORIGINS, BASE, DEST, ok } from './swap-test-world.mjs';

const PASS = 'correct horse battery staple', KDF = { N: 1024, r: 8, p: 1 };      // test-only cheap key derivation; real files use N 32768
const REC = { recordPassphrase: PASS, recordKdf: KDF, recordMinKdfN: 1024 };
const readRec = (path) => lib.createSwapFile(path, { passphrase: PASS, kdf: KDF, minKdfN: 1024 }).load();
const disc = (n) => Buffer.from(sha256(new TextEncoder().encode(n))).subarray(0, 8);
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { throw new Error(`UNEXPECTED global fetch ${url}`); };
const tmp = mkdtempSync(join(tmpdir(), 'silo-swap-fwd-test-'));
test.after(() => { rmSync(tmp, { recursive: true, force: true }); globalThis.fetch = realFetch; });
let counter = 0;
const yes = async () => true;

const world = makeWorldFactory({ tmp, nextId: () => counter++, REC });
const FAST = { pollMs: 60_000, maxTicks: 1 };
const startPaid = (w, s, extra = {}) => s.start({ xmr: '0.05', confirm: yes, until: 'paid', pollMs: 60_000, maxTicks: 12, ...extra });

test('happy path: checks, one payment of the exact amount, claim through the user RPC only, SOL received', async () => {
  const w = world(); const lines = []; const s = w.session({ log: (l) => lines.push(l) });
  w.W.onRelay = () => { const f = readRec(s.file.path); assert.ok(f.record.fundingIntent?.txid && f.record.fundingAttempted, 'intent and txid on disk BEFORE the relay'); w.W.events.push('relay'); };
  let v = await startPaid(w, s);
  assert.equal(w.W.transfers, 1); assert.equal(w.W.relays, 1);
  assert.equal(w.W.built.amount, 50_000_000_000); assert.equal(w.W.built.address, readRec(s.file.path).record.jointAddress);
  assert.deepEqual(w.W.events.slice(0, 2), ['confirm', 'relay']);
  assert.equal(w.info[0].amount, '0.05'); assert.match(w.info[0].address, /^5/); assert.equal(w.info[0].claimBy, w.info[0].t1 - 300);
  const text = lines.join('\n'); assert.match(text, /YOU MUST CLAIM THE SOL BEFORE t1/); assert.match(text, /you cannot move your XMR alone/); assert.match(text, /upgrade authority/);
  // the maker sets ready, the client claims
  w.W.escrow.ready = true; w.advance(60); v = await s.resume({ ...FAST });
  assert.equal(v.phase, 'claiming'); assert.equal(w.W.sent.length, 1); assert.equal(w.W.escrow, null);
  w.advance(60); v = await s.resume({ ...FAST }); assert.equal(v.phase, 'received'); assert.equal(forwardCode(v), 0);
  for (const u of w.W.urls) assert.ok(ORIGINS.has(new URL(u).origin), u);
  assert.equal(w.W.transfers, 1, 'never a second payment');
  assert.deepEqual(Object.keys(w.W.posts['/v1/swap']).sort(), ['A', 'claimer', 'feePayer', 'proofA', 'quoteId', 'v']);
  assert.equal(JSON.stringify(w.W.posts).includes('tierOk'), false);
  const all = lines.join('\n'), file = readRec(s.file.path).record;
  for (const secret of [file.a, file.v, file.feePayerSecret, 'wallet-pass-123']) assert.equal(all.includes(secret), false);
});
const forwardCode = (v) => fwd.forwardOutcomeOf(v).code;

for (const [name, tweak] of [
  ['a different SOL amount', (e) => ({ ...e, lamports: e.lamports - 1 })],
  ['a claimer that is not the user address', (e) => ({ ...e, claimer: Keypair.generate().publicKey.toBase58() })],
  ['a different claim point', (e) => ({ ...e, A: hex(pub(randomScalar())) })],
  ['a different refund point', (e) => ({ ...e, B: hex(pub(randomScalar())) })],
  ['different timelocks', (e) => ({ ...e, t1: e.t1 + 1 })],
  ['another counterparty (refunder)', (e) => ({ ...e, refunder: Keypair.generate().publicKey.toBase58() })],
  ['an account owned by another program', (e) => ({ ...e, owner: Keypair.generate().publicKey.toBase58() })],
]) test(`refuses to pay: the on-chain escrow has ${name}`, async () => {
  const w = world(); w.W.escrowTweak = tweak; const s = w.session();
  const v = await startPaid(w, s, { maxTicks: 4 });
  assert.equal(w.W.transfers, 0); assert.equal(w.W.relays, 0); assert.equal(w.W.events.includes('confirm'), false, 'not even asked');
  assert.equal(readRec(s.file.path).record.fundingAttempted, undefined); assert.ok(v);
});

test('refuses to pay: the escrow is not on chain, or the fee payer is not funded', async () => {
  let w = world(); w.W.escrowTweak = () => null; let s = w.session(); await startPaid(w, s, { maxTicks: 3 }); assert.equal(w.W.transfers, 0);
  w = world(); w.W.feeBalanceAfter = 0; s = w.session(); await startPaid(w, s, { maxTicks: 3 }); assert.equal(w.W.transfers, 0);
});

for (const [name, tweak, msg] of [
  ['a different program or escrow address (pda)', (r) => ({ ...r, pda: Keypair.generate().publicKey.toBase58() }), /pda-mismatch/],
  ['a wrong share proof', (r) => ({ ...r, proofB: { ...r.proofB, s: '00'.repeat(32) } }), /maker-share-proof-invalid/],
  ['a joint address that is not A + B', (r) => ({ ...r, jointAddress: '5' + 'B'.repeat(94) }), /joint-address-mismatch/],
  ['timelocks too close', (r) => ({ ...r, t0: r.t0 - 5000, t1: r.t1 - 5000 }), /timelocks-outside-bounds/],
  ['a different XMR amount', (r) => ({ ...r, xmrAtomic: '1' }), /terms-mismatch/],
  ['a different SOL amount', (r) => ({ ...r, lamports: 1 }), /terms-mismatch/],
]) test(`refuses before paying: maker registration answers ${name}`, async () => {
  const w = world(); w.W.regTweak = tweak; const s = w.session();
  await assert.rejects(startPaid(w, s), (e) => e.code === 'registration-refused' && msg.test(e.message));
  assert.equal(w.W.transfers, 0); assert.equal(readRec(s.file.path).record.status, 'rejected');
});

test('refuses before paying: the maker locked from an address other than --maker-address', async () => {
  const w = world(); const s = w.session({ expectedMaker: Keypair.generate().publicKey.toBase58() });
  await assert.rejects(startPaid(w, s), (e) => e.code === 'maker-address-mismatch' || e.code === 'registration-refused'); assert.equal(w.W.transfers, 0);
});

for (const [name, tweak, code] of [
  ['amount differs from the request', (q) => ({ ...q, xmrAtomic: '40000000000' }), 'quote-amount-mismatch'],
  ['expired', (q) => ({ ...q, expiresAt: BASE - 1 }), 'quote-expired'],
  ['open too long', (q) => ({ ...q, expiresAt: BASE + 86_400 }), 'quote-ttl-too-long'],
  ['gas too low for a zero-SOL claim', (q) => ({ ...q, gasLamports: 100 }), 'quote-gas-too-low'],
  ['pays under the limit price', (q) => ({ ...q, lamports: 100_000_000, spreadBps: undefined, solPerXmr: undefined }), 'quote-price-under-limit'],
  ['spread above the limit', (q) => ({ ...q, spreadBps: 5000, lamports: Math.floor(6.9 * 0.05 * 0.5e9) - 1_000_000 }), 'quote-spread-too-high'],
  ['price fields that do not add up', (q) => ({ ...q, solPerXmr: 20 }), 'quote-price-inconsistent'],
  ['for the other direction', (q) => ({ ...q, direction: 'sol-xmr' }), 'quote-wrong-direction'],
]) test(`refuses before storing or paying: quote ${name}`, async () => {
  const w = world(); w.W.quoteTweak = tweak; const s = w.session({ minSolPerXmr: code === 'quote-spread-too-high' ? 1 : 6.5 });
  await assert.rejects(startPaid(w, s), (e) => e.code === code); assert.equal(s.file.exists(), false); assert.equal(w.W.posts['/v1/swap'], undefined); assert.equal(w.W.transfers, 0);
});

test('guards required by start: expected maker, a limit price, a funding wallet; a declined payment pays nothing', async () => {
  let w = world(); await assert.rejects(startPaid(w, w.session({ expectedMaker: null })), (e) => e.code === 'maker-address-missing');
  w = world(); await assert.rejects(startPaid(w, w.session({ minSolPerXmr: null })), (e) => e.code === 'price-limit-missing');
  w = world(); await assert.rejects(startPaid(w, w.session({ fundingWallet: null })), (e) => e.code === 'funding-wallet-missing');
  w = world(); const s = w.session({ confirmPayment: async () => false }); await startPaid(w, s, { maxTicks: 3 }).catch(() => {}); assert.equal(w.W.transfers, 0);
});

test('tiers are tolerated and change nothing; a different amount is refused', async () => {
  const w = world(); w.W.quoteTweak = (q) => ({ ...q, tiers: [{ rate: 'holder', min: '0.001', spreadBps: 10, lamports: 1 }] });
  const s = w.session(); const r = await s.quote('0.05'); assert.equal(r.terms.tiers, 1); assert.equal(r.terms.lamports, 344_000_000);
});

// ---- no double payment, crash and resume at every step around the transfer -------------------------------------------------------
test('crash after the intent is on disk but before the relay: resume relays the SAME transaction, one transfer, one payment', async () => {
  const w = world(); const rec = join(tmp, `crashA${counter++}.json`); w.W.relayThrows = true;
  const s = w.session({ recordPath: rec }); await startPaid(w, s, { maxTicks: 4 }).catch(() => {});
  const f = readRec(rec).record; assert.ok(f.fundingIntent && f.fundingAttempted && !f.xmrLockTxid); assert.equal(w.W.relays, 0);
  w.W.relayThrows = false; w.advance(120);
  const v = await w.session({ recordPath: rec }).resume({ ...FAST });
  assert.equal(w.W.transfers, 1, 'no second transfer built'); assert.equal(w.W.relays, 1); assert.equal(w.W.out.length, 1); assert.ok(v);
  assert.equal(readRec(rec).record.xmrLockTxid, f.fundingIntent.txid);
});

test('crash after the payment left the wallet but before the txid was saved: resume finds it in the wallet outgoing list and does not relay or pay', async () => {
  const w = world(); const rec = join(tmp, `crashB${counter++}.json`); w.W.relayThrowsAfter = true;
  await startPaid(w, w.session({ recordPath: rec }), { maxTicks: 4 }).catch(() => {});
  assert.equal(w.W.relays, 1); assert.equal(w.W.out.length, 1);
  w.W.relayThrowsAfter = false; w.advance(120);
  await w.session({ recordPath: rec }).resume({ ...FAST });
  assert.equal(w.W.relays, 1, 'not relayed again'); assert.equal(w.W.transfers, 1); assert.equal(w.W.out.length, 1);
});

test('a fresh process after a completed payment never pays again, however often it resumes', async () => {
  const w = world(); const rec = join(tmp, `crashC${counter++}.json`);
  await startPaid(w, w.session({ recordPath: rec })); assert.equal(w.W.transfers, 1);
  for (let i = 0; i < 3; i++) { w.advance(120); await w.session({ recordPath: rec }).resume({ ...FAST }); }
  assert.equal(w.W.transfers, 1); assert.equal(w.W.relays, 1);
});

test('a stale write from an older copy of the record cannot make the client forget the payment', async () => {
  const w = world(); const rec = join(tmp, `stale${counter++}.json`); const s = w.session({ recordPath: rec }); await startPaid(w, s);
  const f = readRec(rec); assert.ok(f.record.fundingAttempted);
  w.advance(60); await w.session({ recordPath: rec }).resume({ ...FAST });
  const g = readRec(rec); assert.ok(g.record.fundingAttempted && g.record.xmrLockTxid);
  assert.equal(w.W.transfers, 1);
});

test('the intent is on disk but the funding deadline passed before the relay on resume: the stale transaction is never relayed', async () => {
  const w = world(); const rec = join(tmp, `crashD${counter++}.json`); w.W.relayThrows = true;
  await startPaid(w, w.session({ recordPath: rec }), { maxTicks: 4 }).catch(() => {});
  w.W.relayThrows = false; w.advance(7200 - 3600 + 600);   // past t0 - LOCK_MIN_LEAD
  await w.session({ recordPath: rec }).resume({ ...FAST }).catch(() => {});
  assert.equal(w.W.relays, 0); assert.equal(readRec(rec).record.fundingAbandoned, 'deadline-before-relay');
});

test('a failed transfer (not enough funds) pays nothing and leaves no payment marker', async () => {
  const w = world(); w.W.unlocked = '1'; const s = w.session(); await startPaid(w, s, { maxTicks: 3 }).catch(() => {});
  assert.equal(w.W.transfers, 0); assert.equal(readRec(s.file.path).record.fundingAttempted, undefined);
});

// ---- the claim -----------------------------------------------------------------------------------------------------------------------
test('claim is retried: a failed broadcast is sent again a minute later; both user RPCs receive it; no relay and no other host', async () => {
  const w = world(); const rec = join(tmp, `claim${counter++}.json`); const mk = () => w.session({ recordPath: rec, secondSolanaRpcUrl: SOL2 });
  await startPaid(w, mk()); w.W.escrow.ready = true; w.W.claimFailures = 1;
  w.advance(60); let v = await mk().resume({ ...FAST }); assert.equal(v.phase, 'claiming'); assert.ok(w.W.escrow, 'initial broadcast failed, escrow still open');
  assert.equal(w.W.sent2.length, 1, 'the second RPC got it too');
  w.advance(70); v = await mk().resume({ ...FAST }); assert.equal(w.W.escrow, null); assert.equal(w.W.sent.length, 2);
  w.advance(60); v = await mk().resume({ ...FAST }); assert.equal(v.phase, 'received');
  for (const u of w.W.urls) assert.ok(ORIGINS.has(new URL(u).origin), u);
});

test('a loud warning appears as t1 approaches while the claim has not landed', async () => {
  const w = world(); const lines = []; const rec = join(tmp, `warn${counter++}.json`); await startPaid(w, w.session({ recordPath: rec }));
  const f = readRec(rec).record; w.advance(f.t1 - 300 - 1800 - w.now());
  await w.session({ recordPath: rec, log: (l) => lines.push(l) }).resume({ ...FAST });
  assert.ok(lines.some((l) => /WARNING: the claim window closes at/.test(l)));
});

test('the maker refunds instead: the client moves the XMR back to the user address; status sends nothing', async () => {
  const w = world(); const rec = join(tmp, `refund${counter++}.json`); await startPaid(w, w.session({ recordPath: rec }));
  const f = readRec(rec).record, b = w.W.escrow.b, pda = f.pda;
  w.W.escrow = null; w.W.history = [{ transaction: { message: { accountKeys: [f.refunder, pda, PROGRAM_ID.toBase58()], instructions: [{ programIdIndex: 2, accounts: [1, 0], data: bs58.encode(Buffer.concat([disc('global:refund'), Buffer.from(toLE(b))])) }] } }, meta: { err: null } }];
  w.advance(60); const st = await w.session({ recordPath: rec }).status(); assert.equal(st.phase, 'recovering'); assert.equal(w.W.sweeps.length, 0, 'status sweeps nothing'); assert.equal(w.W.sent.length, 0);
  const v = await w.session({ recordPath: rec }).resume({ ...FAST }); assert.equal(v.phase, 'recovering'); assert.deepEqual(w.W.sweeps, [DEST]);
});

test('CLI: forward quote prints the checked terms, start needs the explicit flags and prints no endpoint, key or password', async () => {
  const w = world(); const out = [], err = []; const rec = join(tmp, `cli${counter++}.json`), pwf = join(tmp, 'pw.txt');
  (await import('node:fs')).writeFileSync(pwf, 'wallet-pass-123\n', { mode: 0o600 });
  const env = { SWAP_MAKER_URL: MAKER, SWAP_SOLANA_RPC_URL: SOL + '/?secret-path-9876', SWAP_MONERO_WALLET_RPC_URL: XMR, SWAP_MONERO_NODE_URL: NODE, SWAP_RECORD_PASSPHRASE: PASS };
  const io = { recordKdf: KDF, recordMinKdfN: 1024, env, out: (s) => out.push(s), err: (s) => err.push(s), fetcher: w.fetcher, now: () => w.now() * 1000, sleep: async (ms) => w.advance(ms / 1000) };
  let code = await main(['quote', '--direction', 'xmr-sol', '--xmr', '0.05', '--min-sol-per-xmr', '6'], io); assert.equal(code, 0); assert.ok(out.join('\n').includes('You pay 0.05 XMR'));
  const base = ['start', '--direction', 'xmr-sol', '--xmr', '0.05', '--network', 'devnet', '--sol-address', w.user, '--xmr-address', DEST, '--monero-wallet', 'funder', '--monero-wallet-password-file', pwf, '--record', rec, '--maker-address', w.maker, '--min-sol-per-xmr', '6'];
  code = await main(base, io); assert.equal(code, 2, 'not a terminal and no --yes'); assert.equal(w.W.transfers, 0);
  code = await main([...base, '--yes', '--detach'], io); assert.equal(code, 4, err.join('|')); assert.equal(w.W.transfers, 1);
  const all = out.concat(err).join('\n'), file = readRec(rec);
  assert.equal(all.includes('secret-path'), false); assert.equal(all.includes('wallet-pass-123'), false); assert.equal(all.includes(file.record.a), false); assert.equal(all.includes(file.record.feePayerSecret), false);
  assert.equal(file.direction, 'xmr-sol');
  const st = []; code = await main(['status', '--record', rec], { ...io, out: (s) => st.push(s) }); assert.equal(code, 0); assert.match(st.join('\n'), /Times: pay by/);
  code = await main(['refund', '--record', rec], io); assert.equal(code, 4);
});

// ---- Specialist hardening: the txid alone decides whether a payment left ------------------------------------------------------------
test('a rescanned wallet that reports the outgoing transaction WITHOUT a destination still counts as paid: no relay, no abandon', async () => {
  const w = world(); const rec = join(tmp, `resc${counter++}.json`); w.W.relayThrowsAfter = true; w.W.noDestinations = true;
  await startPaid(w, w.session({ recordPath: rec }), { maxTicks: 4 }).catch(() => {});
  assert.equal(w.W.relays, 1); w.W.relayThrowsAfter = false; w.advance(7200 - 3600 + 600);   // even past the funding deadline
  await w.session({ recordPath: rec }).resume({ ...FAST });
  const f = readRec(rec).record;
  assert.equal(w.W.relays, 1, 'not relayed again'); assert.equal(w.W.transfers, 1); assert.equal(f.fundingAbandoned, undefined); assert.equal(f.xmrLockTxid, f.fundingIntent.txid);
});

test('an abandoned record whose txid later appears continues as paid: it claims', async () => {
  const w = world(); const rec = join(tmp, `aband${counter++}.json`); w.W.relayThrows = true;
  await startPaid(w, w.session({ recordPath: rec }), { maxTicks: 4 }).catch(() => {});
  w.W.relayThrows = false; w.advance(7200 - 3600 + 600);
  await w.session({ recordPath: rec }).resume({ ...FAST }).catch(() => {});
  let f = readRec(rec).record; assert.equal(f.fundingAbandoned, 'deadline-before-relay'); assert.equal(w.W.relays, 0);
  // the transaction turns up anywhere in the wallet lists (propagated by another route)
  w.W.out.push({ txid: f.fundingIntent.txid, confirmations: 2 }); w.W.built = { tx_hash: f.fundingIntent.txid };
  const st = await w.session({ recordPath: rec }).status(); assert.equal(st.record.xmrLockTxid, f.fundingIntent.txid, 'status sees it'); assert.equal(readRec(rec).record.xmrLockTxid, undefined, 'status writes nothing');
  w.W.escrow.ready = true; w.advance(60);
  let v = await w.session({ recordPath: rec }).resume({ ...FAST }); f = readRec(rec).record;
  assert.equal(f.fundingAbandoned, undefined); assert.equal(f.xmrLockTxid, f.fundingIntent.txid); assert.equal(v.phase, 'claiming'); assert.equal(w.W.relays, 0, 'nothing relayed');
  w.advance(60); v = await w.session({ recordPath: rec }).resume({ ...FAST }); assert.equal(v.phase, 'received'); assert.equal(w.W.transfers, 1);
});

test('a wallet error during the check is "unknown": no relay, no new transfer, never abandoned (before and after the funding deadline)', async () => {
  for (const [label, fail, late] of [['list and txid lookups fail', (W) => { W.listError = true; W.byTxidError = true; }, true], ['wallet unreachable', (W) => { W.walletDown = true; }, true], ['wallet unreachable early', (W) => { W.walletDown = true; }, false]]) {
    const w = world(); const rec = join(tmp, `unk${counter++}.json`); w.W.relayThrows = true;
    await startPaid(w, w.session({ recordPath: rec }), { maxTicks: 4 }).catch(() => {});
    w.W.relayThrows = false; fail(w.W); w.advance(late ? 7200 - 3600 + 600 : 120);
    await w.session({ recordPath: rec }).resume({ ...FAST }).catch(() => {});
    const f = readRec(rec).record;
    assert.equal(w.W.relays, 0, label); assert.equal(w.W.transfers, 1, label); assert.equal(f.fundingAbandoned, undefined, label); assert.equal(f.xmrLockTxid, undefined, label);
    // the wallet comes back: before the deadline the SAME transaction is relayed once; after it, it is abandoned (still not terminal)
    w.W.listError = w.W.byTxidError = w.W.walletDown = false;
    await w.session({ recordPath: rec }).resume({ ...FAST }).catch(() => {});
    assert.equal(w.W.transfers, 1, label); assert.equal(w.W.relays, late ? 0 : 1, label);
  }
});

// ---- 771 hardening: one payment owner (H1), payment consent right before the relay (M2), one logging boundary (M3) -----------------------------------
const unfunded = async (w, name) => {                       // a registered swap with the maker escrow on chain and nothing paid
  const rec = join(tmp, `${name}${counter++}.json`);
  await w.session({ recordPath: rec, confirmPayment: async () => false }).start({ xmr: '0.05', confirm: yes, until: 'paid', pollMs: 1000, maxTicks: 2 });
  const f = readRec(rec).record; assert.ok(f.refunder && !f.fundingAttempted && !f.xmrLockTxid, 'unfunded'); return rec;
};
const later = (ms) => new Promise((r) => setTimeout(r, ms));

test('H1: two sessions of one process on the same unfunded swap, each with its own funding wallet, cannot both pay: the second is refused, one transfer in all', async () => {
  const w = world(), w2 = world(); w2.W.address = 'WALLET-B-ADDRESS';
  const rec = await unfunded(w, 'h1a');
  const slow = async () => { await later(25); return true; };           // both reach the payment step with the confirmation pending
  const s1 = w.session({ recordPath: rec, confirmPayment: slow });
  const s2 = w.session({ recordPath: rec, confirmPayment: slow, walletFetcher: w2.fetcher });
  const res = await Promise.allSettled([s1.resume({ ...FAST }), s2.resume({ ...FAST })]);
  assert.equal(w.W.transfers + w2.W.transfers, 1, 'exactly one XMR transfer was built');
  assert.equal(w.W.relays + w2.W.relays, 1, 'exactly one relay');
  const rejected = res.filter((r) => r.status === 'rejected');
  assert.equal(rejected.length, 1); assert.equal(rejected[0].reason.code, 'swap-file-busy');
  assert.equal(readRec(rec).record.fundingIntent.txid.length, 64);
});

test('H1: a session cannot take the lock twice, and a finished session frees it', async () => {
  const w = world(); const rec = await unfunded(w, 'h1b'); const s = w.session({ recordPath: rec });
  s.file.lock();
  await assert.rejects(s.resume({ ...FAST }), (e) => e.code === 'swap-file-busy');
  await assert.rejects(w.session({ recordPath: rec }).refund?.() ?? Promise.reject(Object.assign(new Error('n/a'), { code: 'swap-file-busy' })), (e) => e.code === 'swap-file-busy');
  s.file.unlock();
  await w.session({ recordPath: rec }).resume({ ...FAST });
});

test('H1: the payment is reserved on disk (this wallet, this amount, this address) BEFORE the wallet builds anything', async () => {
  const w = world(); const rec = await unfunded(w, 'h1c'); let seen = null;
  const real = w.fetcher; const spy = async (url, init) => { const b = init?.body ? JSON.parse(init.body) : null; if (b?.method === 'transfer') seen = readRec(rec).record.fundingIntent; return real(url, init); };
  await w.session({ recordPath: rec, walletFetcher: spy, confirmPayment: yes }).resume({ ...FAST });
  assert.ok(seen && seen.state === 'reserved' && seen.txid === null && seen.walletId && seen.address, 'reserved before transfer');
  const f = readRec(rec).record; assert.equal(f.fundingIntent.state, 'built'); assert.equal(f.fundingIntent.walletId, seen.walletId);
});

test('H1: a payment reserved from one wallet is not continued with another: refused, tells the user to resume with the original, nothing is built or relayed', async () => {
  const w = world(); const rec = join(tmp, `h1d${counter++}.json`); w.W.relayThrows = true;
  await startPaid(w, w.session({ recordPath: rec }), { maxTicks: 4 }).catch(() => {});
  const f = readRec(rec).record; assert.ok(f.fundingIntent?.walletId && !f.xmrLockTxid);
  const other = world(); other.W.address = 'WALLET-B-ADDRESS';
  await assert.rejects(w.session({ recordPath: rec, walletFetcher: other.fetcher }).resume({ ...FAST }), (e) => e.code === 'funding-wallet-mismatch' && /original funding wallet/.test(e.message));
  await assert.rejects(w.session({ recordPath: rec, fundingWallet: 'another-wallet' }).resume({ ...FAST }), (e) => e.code === 'funding-wallet-mismatch');
  assert.equal(other.W.transfers + other.W.relays, 0); assert.equal(w.W.relays, 0);
  w.W.relayThrows = false; w.advance(60);
  await w.session({ recordPath: rec }).resume({ ...FAST });                    // the original wallet goes on, with the same transaction
  assert.equal(w.W.relays, 1); assert.equal(w.W.transfers, 1); assert.equal(readRec(rec).record.xmrLockTxid, f.fundingIntent.txid);
});

test('H1: a different non-null payment intent is never accepted over an existing one', () => {
  const a = { state: 'built', walletId: 'w1', amountAtomic: '5', address: 'X', txid: 'aa'.repeat(32) };
  assert.doesNotThrow(() => fwd.checkIntentTransition(null, a));
  assert.doesNotThrow(() => fwd.checkIntentTransition({ ...a, state: 'reserved', txid: null }, a), 'reserved -> built');
  assert.doesNotThrow(() => fwd.checkIntentTransition(a, { ...a }), 'the same intent again');
  assert.throws(() => fwd.checkIntentTransition(a, { ...a, txid: 'bb'.repeat(32) }), (e) => e.code === 'funding-conflict');
  assert.throws(() => fwd.checkIntentTransition(a, { ...a, walletId: 'w2' }), (e) => e.code === 'funding-wallet-mismatch');
  assert.throws(() => fwd.checkIntentTransition({ ...a, state: 'reserved', txid: null }, { ...a, address: 'Y' }), (e) => e.code === 'funding-conflict');
  assert.throws(() => fwd.checkIntentTransition(a, { ...a, amountAtomic: '6' }), (e) => e.code === 'funding-conflict');
});

test('H1: a failed transfer releases the reservation (nothing was built), a later attempt by the same wallet can go on', async () => {
  const w = world(); const rec = await unfunded(w, 'h1e'); w.W.transferThrows = true;
  await w.session({ recordPath: rec, confirmPayment: yes }).resume({ ...FAST });
  const f = readRec(rec).record; assert.equal(f.fundingIntent, undefined); assert.equal(f.fundingAttempted, undefined);
  w.W.transferThrows = false; await w.session({ recordPath: rec, confirmPayment: yes }).resume({ ...FAST });
  assert.equal(w.W.transfers, 1); assert.equal(w.W.relays, 1);
});

// ---- 771-H1/M1 closure: the reservation is owned by the run that created it ---------------------------------------------------------------------------------
const WALLET_A = () => lib.sha(`${fwd.WALLET_ID_DOMAIN}WALLET-A-ADDRESS`);
const reservationFor = (rec) => ({ walletId: WALLET_A(), amountAtomic: '50000000000', address: readRec(rec).record.jointAddress });
const plain = (rec) => lib.createSwapFile(rec, { passphrase: PASS, kdf: KDF, minKdfN: 1024 });

test('771-H1: a reservation made by another LIVE run is not built over: this run builds and transfers nothing and says so', async () => {
  const w = world(); const rec = await unfunded(w, 'own1');
  assert.equal(plain(rec).claimIntent(reservationFor(rec)).status, 'created');       // another execution (this test process, alive, holding no lock) owns the funding step
  const v = await w.session({ recordPath: rec, confirmPayment: yes }).resume({ ...FAST, pollMs: 1000 });     // the driver turns a refusal at the payment step into a notice on the view
  assert.equal(v.phase, 'awaiting-xmr'); assert.match(v.notice ?? '', /built and sent nothing/);
  assert.equal(w.W.transfers, 0); assert.equal(w.W.relays, 0);
});

test('771-H1: the other run persisted its built transaction meanwhile: this run builds nothing and relays that SAME transaction by txid, once', async () => {
  const w = world(); const rec = await unfunded(w, 'own2'); const txid = 'ab'.repeat(32);
  const real = w.fetcher; let planted = false;
  const spy = async (url, init) => {
    const b = init?.body ? JSON.parse(init.body) : null;
    if (b?.method === 'get_balance' && !planted) {                         // after this run's last look at the record, before it claims: the other run reserves and persists its built tx
      planted = true; const r = reservationFor(rec); plain(rec).claimIntent(r);
      const f = readRec(rec).record; const g = plain(rec); g.saveRecord({ ...f, fundingAttempted: 1, fundingIntent: { state: 'built', ...r, txid, hex: 'aa'.repeat(40), at: 1 } });
      w.W.built = { tx_hash: txid, tx_metadata: 'aa'.repeat(40), amount: r.amountAtomic, address: r.address };
    }
    return real(url, init);
  };
  await w.session({ recordPath: rec, walletFetcher: spy, confirmPayment: yes }).resume({ ...FAST, pollMs: 1000 });
  assert.equal(w.W.transfers, 0, 'this run built nothing'); assert.equal(w.W.relays, 1, 'the one recorded transaction was relayed');
  assert.equal(readRec(rec).record.xmrLockTxid, txid);
});

test('771-H1: a reservation whose run is gone (killed after it reserved) is taken over by the run that holds the swap lock: one build, one relay', async () => {
  const w = world(); const rec = await unfunded(w, 'own3');
  const child = join(dirname(fileURLToPath(import.meta.url)), 'swap-lock-race.child.mjs');
  const r = spawnSync(process.execPath, [child, 'plant-and-die', rec, `${rec}.log`, String(Date.now()), JSON.stringify(reservationFor(rec))], { stdio: 'ignore' });
  assert.equal(r.signal, 'SIGKILL'); assert.ok(existsSync(`${rec}.intent`));
  await w.session({ recordPath: rec, confirmPayment: yes }).resume({ ...FAST });
  assert.equal(w.W.transfers, 1); assert.equal(w.W.relays, 1); assert.equal(readRec(rec).record.fundingIntent.txid.length, 64);
});

test('771-H1: the built transaction is not recorded or relayed when the swap file changed under the run, or the reservation is no longer its own', async () => {
  const w = world(); const rec = await unfunded(w, 'own4'); const real = w.fetcher;
  const spy = async (url, init) => {                                       // another writer touches the swap file while the wallet is building
    const b = init?.body ? JSON.parse(init.body) : null;
    if (b?.method === 'transfer') { const g = plain(rec); g.saveRecord({ ...g.load().record, marker: 'someone else wrote' }); }
    return real(url, init);
  };
  const v = await w.session({ recordPath: rec, walletFetcher: spy, confirmPayment: yes }).resume({ ...FAST });
  assert.match(v.notice ?? '', /changed by another run/);
  assert.equal(w.W.relays, 0, 'nothing was relayed'); assert.equal(readRec(rec).record.fundingIntent?.txid ?? null, null, 'the unrecorded transaction is not on file');
  const w2 = world(); const rec2 = await unfunded(w2, 'own5'); const real2 = w2.fetcher;
  const spy2 = async (url, init) => { const b = init?.body ? JSON.parse(init.body) : null; if (b?.method === 'transfer') unlinkSync(`${rec2}.intent`); return real2(url, init); };   // the reservation disappears after the claim, before the transfer
  const v2 = await w2.session({ recordPath: rec2, walletFetcher: spy2, confirmPayment: yes }).resume({ ...FAST });
  assert.equal(w2.W.relays, 0, 'a reservation that is no longer this run\'s relays nothing'); assert.match(v2.notice ?? '', /no longer held|reservation changed/);
});

test('771-M1: after a funding step no file next to the swap file holds a payment identifier in plain text (address, amount, wallet id, txid, funding wallet address)', async () => {
  const w = world(); const rec = await unfunded(w, 'priv'); const r0 = reservationFor(rec);
  const dir = dirname(rec), pre = basename(rec);
  const everything = () => readdirSync(dir).filter((x) => x.startsWith(pre)).map((x) => ({ x, raw: readFileSync(join(dir, x)).toString('latin1') }));
  plain(rec).claimIntent(r0);                                               // an intent on disk, nothing else yet
  let files = everything(); assert.ok(files.some((f) => f.x.endsWith('.intent')));
  for (const f of files) for (const needle of [r0.address, r0.amountAtomic, r0.walletId, 'WALLET-A-ADDRESS']) assert.equal(f.raw.includes(needle), false, `${f.x} leaks ${needle.slice(0, 8)} while only reserved`);
  unlinkSync(`${rec}.intent`);
  await w.session({ recordPath: rec, confirmPayment: yes }).resume({ ...FAST });
  const done = readRec(rec).record; const txid = done.xmrLockTxid; assert.equal(txid.length, 64);
  files = everything(); assert.ok(files.length >= 2, 'the swap file and the intent (and no temp file) are there');
  for (const f of files) for (const needle of [done.jointAddress, '50000000000', r0.walletId, txid, done.fundingIntent.hex, 'WALLET-A-ADDRESS', 'funder']) assert.equal(f.raw.includes(needle), false, `${f.x} leaks ${needle.slice(0, 8)} after the payment`);
  assert.equal(files.some((f) => /\.tmp/.test(f.x)), false, 'no temp file is left behind');
});

test('M2: a quote that expires while the user confirms the payment is not paid: the escrow and the quote are read again after the confirmation', async () => {
  const w = world(); const rec = await unfunded(w, 'm2a'); let asked = 0;
  const v = await w.session({ recordPath: rec, confirmPayment: async () => { asked++; w.advance(700); return true; } }).resume({ ...FAST });
  assert.equal(w.W.transfers, 0); assert.equal(w.W.relays, 0); assert.equal(asked, 1);
  assert.match(String(v.notice ?? ''), /quote expired/i); assert.equal(readRec(rec).record.fundingAttempted, undefined);
  await w.session({ recordPath: rec, confirmPayment: async () => { asked++; return true; } }).resume({ ...FAST });
  assert.equal(asked, 1, 'an expired quote is not even offered for payment again'); assert.equal(w.W.transfers, 0);
});

test('M2: an escrow that changes, or disappears, while the user confirms is not paid', async () => {
  for (const [name, mutate] of [['lamports changed', (W) => { W.escrow.lamports += 1; }], ['claimer changed', (W) => { W.escrow.claimer = Keypair.generate().publicKey.toBase58(); }], ['escrow gone', (W) => { W.escrow = null; }]]) {
    const w = world(); const rec = await unfunded(w, 'm2b');
    const v = await w.session({ recordPath: rec, confirmPayment: async () => { mutate(w.W); return true; } }).resume({ ...FAST });
    assert.equal(w.W.transfers, 0, name); assert.equal(w.W.relays, 0, name); assert.match(String(v.notice ?? ''), /escrow|Nothing was paid/i, name);
  }
});

test('M2: the funding cutoff passing while the user confirms is not paid either', async () => {
  const w = world(); const rec = await unfunded(w, 'm2c');
  await w.session({ recordPath: rec, confirmPayment: async () => { w.advance(3800); return true; } }).resume({ ...FAST }).catch(() => {});
  assert.equal(w.W.transfers, 0); assert.equal(w.W.relays, 0);
});

test('M2: a built transaction is not relayed when the escrow changed before the relay (resume), and the reason is recorded; abandoned stays open', async () => {
  const w = world(); const rec = join(tmp, `m2d${counter++}.json`); w.W.relayThrows = true;
  await startPaid(w, w.session({ recordPath: rec }), { maxTicks: 4 }).catch(() => {});
  assert.ok(readRec(rec).record.fundingIntent.txid); w.W.relayThrows = false; w.W.escrow.lamports += 1;
  await w.session({ recordPath: rec }).resume({ ...FAST }).catch(() => {});
  assert.equal(w.W.relays, 0); assert.match(String(readRec(rec).record.fundingAbandoned), /^recheck-/);
  const w2 = world(); const rec2 = join(tmp, `m2e${counter++}.json`); w2.W.relayThrows = true;
  await startPaid(w2, w2.session({ recordPath: rec2 }), { maxTicks: 4 }).catch(() => {});
  w2.W.relayThrows = false; w2.advance(700);                          // the quote (600 s) has expired
  await w2.session({ recordPath: rec2 }).resume({ ...FAST }).catch(() => {});
  assert.equal(w2.W.relays, 0); assert.equal(readRec(rec2).record.fundingAbandoned, 'recheck-quote-expired');
});

test('M3: credential-bearing transport errors never reach the log or the views during retries (XMR to SOL)', async () => {
  const SECRET = 'SECRETTOKEN-7788', PATHKEY = 'KEYPATH-1234abcd';
  const w = world(); const rec = await unfunded(w, 'm3a');
  const lines = [], views = [];
  const bad = async (url, init) => { const b = init?.body ? JSON.parse(init.body) : null; if (b?.method === 'get_balance') throw new Error(`request to http://127.0.0.1:38293/${PATHKEY}?api-key=${SECRET} failed: fetch failed (Bearer ${SECRET}${SECRET})`); return w.fetcher(url, init); };
  await assert.rejects(w.session({ recordPath: rec, walletFetcher: bad, solanaRpcUrl: `${SOL}/${PATHKEY}?api-key=${SECRET}`, log: (l) => lines.push(l), confirmPayment: yes }).resume({ ...FAST, maxTicks: 8, pollMs: 1000, onPhase: (x) => views.push(x) }).then((v) => { views.push(v); throw new Error('done'); }), /done|stopped/);
  const all = JSON.stringify([lines, views]);
  assert.equal(all.includes(SECRET), false); assert.equal(all.includes(PATHKEY), false); assert.equal(all.includes('api-key'), false);
});

test('M3: a failing Solana RPC with credentials in its URL: retries print a fixed code; the stop message carries no URL or key (XMR to SOL and the CLI)', async () => {
  const SECRET = 'SECRETTOKEN-9911', PATHKEY = 'KEYPATH-5678efgh';
  const w = world(); const rec = await unfunded(w, 'm3b');
  const out = [], err = []; let failing = false;
  const bad = async (url, init) => { const b = init?.body ? JSON.parse(init.body) : null; if (failing && b?.method === 'getBlockTime') throw new Error(`GET ${SOL}/${PATHKEY}?api-key=${SECRET} ECONNRESET`); return w.fetcher(url, init); };
  const env = { SWAP_MAKER_URL: MAKER, SWAP_SOLANA_RPC_URL: `${SOL}/${PATHKEY}?api-key=${SECRET}`, SWAP_MONERO_WALLET_RPC_URL: XMR, SWAP_MONERO_NODE_URL: NODE, SWAP_RECORD_PASSPHRASE: PASS };
  const io = { recordKdf: KDF, recordMinKdfN: 1024, env, out: (s) => out.push(s), err: (s) => err.push(s), fetcher: bad, now: () => w.now() * 1000, sleep: async (ms) => w.advance(ms / 1000) };
  const okRun = await main(['status', '--record', rec], io); assert.equal(okRun, 0, err.join('|'));
  failing = true;
  const code = await main(['resume', '--record', rec], { ...io, sleep: async (ms) => w.advance(ms / 1000 + 30) });
  failing = false;
  const all = out.concat(err).join('\n');
  assert.notEqual(code, 0); assert.equal(all.includes(SECRET), false, all); assert.equal(all.includes(PATHKEY), false, all); assert.equal(all.includes('api-key'), false);
  assert.match(all, /temporary error \(Could not read chain time from your Solana RPC\.\); retrying/); assert.match(all, /stopped-after-errors/);
});

test('M3: a non-refusal error reaches the user as a fixed code, not as its message (CLI)', async () => {
  const w = world(); const out = [], err = [];
  const boom = async () => { throw new Error('connect ECONNREFUSED https://user:topsecret@maker.example/x?key=ABCDEF'); };
  const code = await main(['quote', '--direction', 'xmr-sol', '--xmr', '0.05', '--min-sol-per-xmr', '6'], { env: { SWAP_MAKER_URL: MAKER }, out: (s) => out.push(s), err: (s) => err.push(s), fetcher: boom, now: () => BASE * 1000 });
  assert.equal(code, 1); const all = err.join('\n'); assert.match(all, /network-unreachable/); assert.equal(all.includes('topsecret'), false); assert.equal(all.includes('ABCDEF'), false);
});
