// Minimal maker bot for the XMR -> SOL beta (maker = Bob: holds SOL, receives XMR).
// One process: a small HTTP API for quotes/swaps plus a watch loop that drives every open
// swap with swap-core.makerNext (set ready, abort/late refund, sweep after claim).
// Test networks only in this prototype (devnet + stagenet). Caps and inventory floor are hard.
import http from 'node:http';
import { timingSafeEqual, createHash, randomBytes } from 'node:crypto';
import { readFileSync, mkdirSync, readdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, statSync, accessSync, realpathSync, constants as fsConstants } from 'node:fs';
import { Connection, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { randomScalar, pub, addPoints, addScalars, moneroAddress, isPrimeOrder, toLE, fromLE, hex, unhex, proveShare, verifyShare } from '../client/keys.mjs';
import { rpc, atomic, fmt, daemonHeight } from '../client/xmr.mjs';
import { loadKeypair } from '../client/node-keys.mjs';
import * as sol from '../client/sol.mjs';
import { usableFromTransfers, usableFromTransfersOf, createWalletQueue, makerStep, createStartGate, createAdmission, createAdmissionSerial, admitSwap, resolveLock, lockStage, LOCK_FORMAT, ATTEMPT_LISTS, OPEN_ATTEMPT_STATES } from './maker-core.mjs';
import { prepareSigned, broadcastSigned, rpcClient, chainSnapshot, collectEvidence } from './maker-chain.mjs';
import { createSender } from './maker-send.mjs';
import { CONFIRMATIONS, makerConfirmations } from '../client/swap-core.mjs';
import { makerReverseStep, freeInventory, xmrTransferRequest, xmrTransferResult, reverseAdmission, capsAdmission, canSendNow, classifyJointBalance } from './maker-reverse.mjs';
import { reverseTimelocks } from '../client/reverse-core.mjs';
import { strictPda, readStrictFinalized, readRevealedStrict } from './strict-sol.mjs';
import { sweepDestination } from './maker-reverse.mjs';

const E = process.env;
const STATE = E.MAKER_STATE ?? (() => { throw new Error('set MAKER_STATE'); })();
const CFG = {
  port: Number(E.MAKER_PORT ?? 38400),
  network: E.XMR_NETWORK ?? 'stagenet',
  maxXmrPerSwap: atomic(Number(E.MAX_XMR_PER_SWAP ?? 0.05)),
  maxXmrPerDay: atomic(Number(E.MAX_XMR_PER_DAY ?? 0.3)),
  maxOpenSwaps: Number(E.MAX_OPEN_SWAPS ?? 3),
  minXmrPerSwap: atomic(Number(E.MIN_XMR_PER_SWAP ?? 0.001)),
  solReserve: Math.round(Number(E.SOL_RESERVE ?? 0.05) * LAMPORTS_PER_SOL),
  spreadBps: Number(E.SPREAD_BPS ?? 200),
  gasLamports: Number(E.GAS_LAMPORTS ?? 1_000_000), // 0.001 SOL so a zero-SOL user can pay her own claim fee
  // Proposal (5 Nov 2026, not enabled): a shallower Monero depth for swaps of at most SMALL_SWAP_MAX_XMR. Only the maker bears
  // it (swap-core makerConfirmations). Unset = 10 for every swap, exactly as before; values outside 1..10 also mean 10.
  smallSwapConfirmations: Number(E.SMALL_SWAP_CONFIRMATIONS ?? 10), smallSwapMaxAtomic: atomic(0.05),
  quoteTtl: 120, t0Delta: Number(E.T0 ?? 7200), t1Delta: Number(E.T1 ?? 14400),
  loopMs: Number(E.LOOP_MS ?? 30_000),
  // SOL -> XMR (maker = Alice, sends XMR from its treasury). Off unless explicitly enabled; on mainnet it also needs
  // the owner's yes for inventory, caps and the public enable (threat model: SOL_TO_XMR_THREAT_MODEL.md).
  solXmr: E.SOL_XMR_ENABLED === 'true',
  xmrFeeReserve: atomic(Number(E.XMR_FEE_RESERVE ?? 0.001)),
  // Owner decision 5 Nov 2026: XMR received in XMR -> SOL swaps stays with the maker as SOL -> XMR inventory, up to this
  // ceiling; anything above it goes to MAKER_XMR_SWEEP_ADDRESS (the owner). Off unless MAKER_RECYCLE_XMR=true.
  recycleXmr: E.MAKER_RECYCLE_XMR === 'true',
  inventoryCeiling: atomic(Number(E.MAKER_INVENTORY_CEILING_XMR ?? 0.15)),
};
mkdirSync(`${STATE}/swaps`, { recursive: true });
const maker = await loadKeypair(`${STATE}/maker-sol.json`);
// Optional wallet-rpc login ("user:password" in a root-provisioned file); never in a URL or the environment.
const LOGIN = E.MAKER_WALLET_RPC_LOGIN_FILE ? readFileSync(E.MAKER_WALLET_RPC_LOGIN_FILE, 'utf8').trim() : null;
const W = rpc(E.MAKER_WALLET_RPC ?? 'http://127.0.0.1:38291/json_rpc', LOGIN ? { username: LOGIN.slice(0, LOGIN.indexOf(':')), password: LOGIN.slice(LOGIN.indexOf(':') + 1) } : {});
const PW = readFileSync(`${STATE}/wallet-password`, 'utf8').trim();
const TREASURY = E.MAKER_XMR_TREASURY_WALLET ?? 'bob';
// Owner decision 4 Nov: received XMR goes straight to the owner's own address when set.
const SWEEP_TO = E.MAKER_XMR_SWEEP_ADDRESS || null;
// Mainnet guard (owner package, 4 Nov 2026): received XMR may only go to the owner's own mainnet address (checked by
// monero-wallet-rpc itself), the approved caps are a ceiling, and a token is required. A failed check never stops the
// refund loop (Astra round 4, N1): it only closes the gate for new swaps and sweeps.
const gate = createStartGate({
  network: CFG.network, sweepTo: SWEEP_TO, token: E.MAKER_API_TOKEN,
  caps: { perSwap: CFG.maxXmrPerSwap, perDay: CFG.maxXmrPerDay, open: CFG.maxOpenSwaps },
  limits: CFG.network === 'mainnet' ? { perSwap: atomic(0.05), perDay: atomic(0.3), open: 3 } : { perSwap: Infinity, perDay: Infinity, open: Infinity },
  validate: (address) => W('validate_address', { address, any_net_type: true }),
  // AG-R2-H1: set-ready and refund bytes go to two independent RPC endpoints (SOL_RPC and SOL_RPC_SECONDARY); required on mainnet.
  secondaryRpc: !!E.SOL_RPC_SECONDARY,
});
// Durability pattern from our holder-claim app (write, fsync, rename, directory fsync).
const syncDir = (d) => { const fd = openSync(d, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
function appendDurable(path, line) { const fd = openSync(path, 'a', 0o600); try { writeSync(fd, line); fsyncSync(fd); } finally { closeSync(fd); } }
function writeDurable(path, data) {
  const tmp = `${path}.tmp`; const fd = openSync(tmp, 'w', 0o600);
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path); syncDir(path.slice(0, path.lastIndexOf('/')));
}
const log = (e) => appendDurable(`${STATE}/journal.jsonl`, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');
const swapFile = (id) => `${STATE}/swaps/${id}.json`;
const load = (id) => JSON.parse(readFileSync(swapFile(id), 'utf8'));
const store = (s) => writeDurable(swapFile(s.swapId), JSON.stringify(s, null, 2));
// Set-ready and refund (AG-R2-H1): attempt persisted durably before broadcast, the refund never simulated, sent to every endpoint.
const sender = createSender({ conns: [sol.conn, ...(E.SOL_RPC_SECONDARY ? [new Connection(E.SOL_RPC_SECONDARY, 'confirmed')] : [])], payer: maker, store, log });
const quotes = new Map();
const reverseQuotes = new Map();   // SOL -> XMR quotes (they hold the maker's secret a until registration); dropped with the forward quotes on every closed read
// The watch wallet starts at least 900 s (8 Monero blocks of 120 s) before the lock, so a payment sent just before it is seen too.
const XMR_LOOKBACK_BLOCKS = 8;

// ---- Admission gate (VBU-M1, MAKER_ADMISSION_GATE_SPEC.md) ----
// Operator drain file, read live on every quote, swap and status call. On mainnet MAKER_ADMISSION_FILE must point into a directory the maker
// cannot write (/etc/swapmaker, root-owned): otherwise admission stays closed. Only the operator creates (close) or removes (reopen) it.
// Closing refuses new quotes and swaps and drops issued quotes; set-ready, refund, XMR sweep and the Worker claim relay are untouched
// (sweepAllowed stays tied to the start gate only).
const admission = createAdmission({
  file: E.MAKER_ADMISSION_FILE ?? `${STATE}/ADMISSION_CLOSED`,
  fs: { statSync, accessSync, W_OK: fsConstants.W_OK },
  requireUnwritableDir: CFG.network === 'mainnet',
  onClosed: () => { quotes.clear(); reverseQuotes.clear(); },
});
const accepting = () => gate.isOpen() && admission.isOpen();
const admissions = createAdmissionSerial();
// R9: journaled (fsync) at every process start, before the API listens. A swap file created before this time was written by a process
// that has ended; the quiesce check's K4 rule bounds the blockhashes that process could have used from this time.
// The generation id names THIS process: the quiesce check requires /v1/status to report the same generation as the journal's last
// maker-started, at the start and at the end of its run (K4 process boundary bound to the serving process), and the same state directory.
const startedAt = new Date().toISOString(), generation = randomBytes(16).toString('hex'), stateDir = realpathSync(STATE);
log({ event: 'maker-started', at: startedAt, generation, maker: maker.publicKey.toBase58(), network: CFG.network });
// Finalized evidence for unsettled locks (read-only get* JSON-RPC to the same Solana endpoint as sol.conn).
const chainRpc = rpcClient(sol.conn.rpcEndpoint);

// ---- Monero wallet access is serialized (one open wallet at a time; a failure never poisons the queue, H5) ----
const withWallet = createWalletQueue(W, PW);

// ---- Price: one public source plus a fixed spread ----
// Same provider, API base and asset ids as Silo's own price feed (lib/silo/prices.mjs), including
// its optional demo-key header. Jupiter is not used: it can only price wXMR, the bridge token.
async function price() {
  const headers = E.COINGECKO_DEMO_API_KEY ? { 'x-cg-demo-api-key': E.COINGECKO_DEMO_API_KEY } : {};
  const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=monero,solana&vs_currencies=usd', { headers, signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  const xmr = j?.monero?.usd, solUsd = j?.solana?.usd;
  if (!(xmr > 0 && solUsd > 0)) throw new Error('price-unavailable');
  return { xmrUsd: xmr, solUsd, solPerXmr: xmr / solUsd };
}

// Every record not done stays in the recovery loop, including a lock proven never landed (it only stops counting toward the open cap).
function openSwaps() { return readdirSync(`${STATE}/swaps`).filter((f) => f.endsWith('.json')).map((f) => load(f.slice(0, -5))).filter((s) => !s.done); }
const cappedSwaps = () => openSwaps().filter((s) => lockStage(s) !== 'never-landed');
function lockedToday() {
  const day = new Date().toISOString().slice(0, 10);
  return readdirSync(`${STATE}/swaps`).filter((f) => f.endsWith('.json')).map((f) => load(f.slice(0, -5))).filter((s) => s.createdAt.startsWith(day)).reduce((t, s) => t + BigInt(s.xmrAtomic), 0n);
}

async function quote({ xmr }) {
  const xmrAtomic = atomic(Number(xmr));
  if (!(xmrAtomic >= CFG.minXmrPerSwap && xmrAtomic <= CFG.maxXmrPerSwap)) throw new Error('amount-outside-limits');
  if (lockedToday() + xmrAtomic > CFG.maxXmrPerDay) throw new Error('daily-limit-reached');
  if (!accepting()) throw new Error('maker-paused');
  if (cappedSwaps().length >= CFG.maxOpenSwaps) throw new Error('busy-try-later');
  const p = await price();
  const gross = Number(xmrAtomic) / 1e12 * p.solPerXmr * (1 - CFG.spreadBps / 10_000);
  const lamports = Math.floor(gross * LAMPORTS_PER_SOL) - CFG.gasLamports;
  if (lamports <= 0) throw new Error('amount-too-small');
  const quoteId = hex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  // The swap id is fixed at quote time so both key-share proofs can be bound to it.
  const swapId = hex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const confirmations = xmrAtomic <= CFG.smallSwapMaxAtomic ? makerConfirmations(CFG.smallSwapConfirmations) : CONFIRMATIONS;
  const q = { quoteId, swapId, xmrAtomic: xmrAtomic.toString(), lamports, gasLamports: CFG.gasLamports, solPerXmr: p.solPerXmr, spreadBps: CFG.spreadBps, priceSource: 'coingecko', confirmations, expiresAt: Math.floor(Date.now() / 1000) + CFG.quoteTtl };
  if (!accepting()) throw new Error('maker-paused');   // closed while the price was fetched: issue nothing
  quotes.set(quoteId, q);
  log({ event: 'quote', ...q });
  return q;
}

// ONE admission gate for both directions (VBU-M1 + Astra r5): the drain file and the start gate are read live through accepting(); every
// admission (XMR -> SOL swap and SOL -> XMR registration) runs one at a time through the same createAdmissionSerial queue and the same
// admitSwap: entry check, shared limits (capsAdmission: per swap, open count, daily quota counted over BOTH directions), all awaits, then the
// last check with no await before the swap file (the first persistent commitment) is stored. For XMR -> SOL that file already holds the
// secret, the signed lock signature and its last valid block height, and only then is the lock broadcast.
const caps = () => ({ minAtomic: CFG.minXmrPerSwap, maxPerSwapAtomic: CFG.maxXmrPerSwap, maxPerDayAtomic: CFG.maxXmrPerDay, maxOpen: CFG.maxOpenSwaps, reserveAtomic: CFG.xmrFeeReserve });
const sharedLimits = (q) => capsAdmission({ xmrAtomic: q.xmrAtomic, openCount: cappedSwaps().length, lockedTodayAtomic: lockedToday(), caps: caps() });
const startSwap = (input) => admissions.run(() => admitSwap(input, {
  isOpen: accepting,
  takeQuote(quoteId) {
    const q = quotes.get(quoteId);
    if (!q || q.expiresAt < Date.now() / 1000) throw new Error('quote-expired');
    quotes.delete(quoteId);
    return q;
  },
  checkLimits: sharedLimits,
  prepare: prepareSwap,
  // The journal names every recorded swap, so the quiesce check can see a swap file that went missing from the directory.
  store(s) { store(s); log({ event: 'swap-recorded', swapId: s.swapId }); },
  async broadcast(signed, s) {
    const r = await broadcastSigned(signed);
    s.solLocked = true; store(s);
    log({ event: 'sol-locked', swapId: s.swapId, sig: r.sig, lamports: s.lamports, xmrAtomic: s.xmrAtomic, t0: s.t0, t1: s.t1, gas: signed.gas });
    return { swapId: s.swapId, B: s.B, proofB: signed.proofB, jointAddress: s.jointAddress, pda: sol.swapPda(maker.publicKey, unhex(s.swapId)).toBase58(), refunder: maker.publicKey.toBase58(), t0: s.t0, t1: s.t1, lamports: s.lamports, lockSig: r.sig, xmrAtomic: s.xmrAtomic };
  },
}));

async function prepareSwap(q, { quoteId, claimer, feePayer, A, proofA, v }) {
  const claimerKey = new PublicKey(claimer);
  // Gas goes to the user's throwaway fee payer, so her wallet key never has to sign.
  const gasKey = new PublicKey(feePayer ?? claimer);
  const Ab = unhex(A), vS = fromLE(unhex(v));
  const swapId = unhex(q.swapId);
  // verifyShare also rejects small-order / identity points.
  if (!verifyShare(Ab, proofA, swapId, 0)) throw new Error('bad-share-proof');
  if (vS === 0n || vS >= (await import('../client/keys.mjs')).L) throw new Error('bad-view-key');
  // Locked SOL already sits in PDAs, so the wallet balance is the free inventory.
  const bal = await sol.conn.getBalance(maker.publicKey);
  if (bal < q.lamports + q.gasLamports + CFG.solReserve) throw new Error('inventory-low');
  const b = randomScalar(), B = pub(b);
  const V = pub(vS);
  const jointAddress = moneroAddress(addPoints(Ab, B), V, CFG.network);
  const proofB = proveShare(b, swapId, 1);
  const now = await sol.chainNow();
  const s = { swapId: hex(swapId), quoteId, feePayer: gasKey.toBase58(), createdAt: new Date().toISOString(), claimer, A, B: hex(B), b: hex(toLE(b)), v, V: hex(V), jointAddress,
    xmrAtomic: q.xmrAtomic, confirmations: q.confirmations, lamports: q.lamports, t0: now + CFG.t0Delta, t1: now + CFG.t1Delta, lockedAt: now, restoreHeight: (await daemonHeight()) - XMR_LOOKBACK_BLOCKS };
  const ixs = [];
  if ((await sol.conn.getBalance(gasKey)) < q.gasLamports) ixs.push(SystemProgram.transfer({ fromPubkey: maker.publicKey, toPubkey: gasKey, lamports: q.gasLamports }));
  ixs.push(sol.lockIx({ refunder: maker.publicKey, swapId, claimer: claimerKey, claimPoint: Ab, refundPoint: B, lamports: q.lamports, t0: s.t0, t1: s.t1 }));
  // The lock carries no secret, so its unsigned simulation (maker-chain prepareSigned, not sol.send) exposes nothing; only ready and
  // refund go through maker-send.mjs, and only the refund is never simulated.
  const signed = await prepareSigned(ixs, maker);   // simulated unsigned, then signed locally in memory; nothing valid has been sent
  // Persisted with the secret BEFORE any broadcast: a lost send response leaves a record that names the exact signature and its expiry.
  Object.assign(s, { lockFormat: LOCK_FORMAT, lockSig: signed.sig, lockBlockhash: signed.blockhash, lockLastValidBlockHeight: signed.lastValidBlockHeight });
  return { record: s, signed: { ...signed, proofB, gas: ixs.length > 1 } };
}

// ---- SOL -> XMR: quote, register, then the user locks SOL; the loop sends XMR and claims ----
const openReverse = () => openSwaps().filter((s) => s.direction === 'sol-xmr');
async function treasuryUnlocked() { return withWallet(TREASURY, () => { throw new Error('treasury wallet missing'); }, async () => (await W('get_balance')).unlocked_balance); }
async function reverseQuote({ xmr }) {
  if (!CFG.solXmr) throw new Error('direction-disabled');
  if (!accepting()) throw new Error('maker-paused');
  const xmrAtomic = atomic(Number(xmr));
  if (!(xmrAtomic >= CFG.minXmrPerSwap && xmrAtomic <= CFG.maxXmrPerSwap)) throw new Error('amount-outside-limits');
  if (lockedToday() + xmrAtomic > CFG.maxXmrPerDay) throw new Error('daily-limit-reached');
  if (cappedSwaps().length >= CFG.maxOpenSwaps) throw new Error('busy-try-later');
  if (freeInventory(await treasuryUnlocked(), openReverse(), CFG.xmrFeeReserve) < xmrAtomic) throw new Error('inventory-low');
  const p = await price();
  // The user pays the SOL; the maker's spread is added on top of the market price.
  const lamports = Math.ceil(Number(xmrAtomic) / 1e12 * p.solPerXmr * (1 + CFG.spreadBps / 10_000) * LAMPORTS_PER_SOL);
  const quoteId = hex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const swapId = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const a = randomScalar(), A = pub(a);
  const q = { direction: 'sol-xmr', quoteId, swapId: hex(swapId), xmrAtomic: xmrAtomic.toString(), lamports, solPerXmr: p.solPerXmr, spreadBps: CFG.spreadBps, priceSource: 'coingecko',
    A: hex(A), proofA: proveShare(a, swapId, 0), claimer: maker.publicKey.toBase58(), expiresAt: Math.floor(Date.now() / 1000) + CFG.quoteTtl };
  if (!accepting()) throw new Error('maker-paused');   // closed while the balance and price were fetched: issue nothing
  reverseQuotes.set(quoteId, { ...q, a: hex(toLE(a)) });
  log({ event: 'rev-quote', quoteId, swapId: q.swapId, xmrAtomic: q.xmrAtomic, lamports, solPerXmr: p.solPerXmr, spreadBps: CFG.spreadBps, priceSource: 'coingecko', expiresAt: q.expiresAt });
  return q;
}
// N1: registration is where capacity becomes a commitment. It is an admission like any other: the same queue, the same admitSwap, the same
// live gate read before and after every await, the same shared limits; the inventory check (live treasury) runs inside prepare. The swap file
// (with the maker's secret a, before the user can lock against A) is the reservation the next admission counts. Nothing is broadcast here.
const reverseRegister = (input) => admissions.run(() => admitSwap(input, {
  isOpen: () => accepting() && CFG.solXmr,
  takeQuote(quoteId) {
    const q = reverseQuotes.get(quoteId);
    if (!q || q.expiresAt < Date.now() / 1000) throw new Error('quote-expired');
    reverseQuotes.delete(quoteId);
    return q;
  },
  checkLimits: sharedLimits,
  prepare: prepareReverse,
  store(s) { store(s); log({ event: 'swap-recorded', swapId: s.swapId, direction: 'sol-xmr' }); },
  async broadcast(_none, s) {
    log({ event: 'rev-registered', swapId: s.swapId, refunder: s.refunder, lamports: s.lamports, xmrAtomic: s.xmrAtomic, t0: s.t0, t1: s.t1 });
    return { swapId: s.swapId, jointAddress: s.jointAddress, t0: s.t0, t1: s.t1, lamports: s.lamports, xmrAtomic: s.xmrAtomic, claimer: s.claimer, claimPoint: s.A, pda: strictPda(new PublicKey(s.refunder), unhex(s.swapId)).toBase58() };
  },
}));
async function prepareReverse(q, { quoteId, refunder, B, proofB, v }) {
  const swapId = unhex(q.swapId), Bb = unhex(B), vS = fromLE(unhex(v));
  if (!verifyShare(Bb, proofB, swapId, 1)) throw new Error('bad-share-proof');
  if (vS === 0n || vS >= (await import('../client/keys.mjs')).L) throw new Error('bad-view-key');
  reverseAdmission({ xmrAtomic: q.xmrAtomic, openCount: cappedSwaps().length, lockedTodayAtomic: lockedToday(), unlockedAtomic: await treasuryUnlocked(), openReverse: openReverse(), caps: caps() });
  const refunderKey = new PublicKey(refunder);
  const jointAddress = moneroAddress(addPoints(unhex(q.A), Bb), pub(vS), CFG.network);
  const { t0, t1 } = reverseTimelocks(await sol.chainNow());
  const record = { direction: 'sol-xmr', swapId: q.swapId, quoteId, createdAt: new Date().toISOString(), refunder: refunderKey.toBase58(), claimer: q.claimer,
    A: q.A, a: q.a, B, v, V: hex(pub(vS)), jointAddress, xmrAtomic: q.xmrAtomic, lamports: q.lamports, t0, t1, quoteExpiresAt: q.expiresAt,
    restoreHeight: (await daemonHeight()) - XMR_LOOKBACK_BLOCKS, userProofOk: true };
  return { record, signed: null };
}
async function sweepJoint(s, spend, dest) {
  if (moneroAddress(pub(spend), unhex(s.V), CFG.network) !== s.jointAddress) throw new Error('joint key mismatch');
  const fn = `mk-spend-${s.swapId.slice(0, 16)}`;
  return withWallet(fn, () => W('generate_from_keys', { filename: fn, address: s.jointAddress, spendkey: hex(toLE(spend)), viewkey: s.v, password: PW, restore_height: s.restoreHeight ?? 0, autosave_current: true }), async () => {
    // Four distinct answers (Astra r8): sweepable -> swept (recovered); locked or listed funds -> pending; zero and nothing listed -> absent; any wallet or RPC error throws (unknown, never counted).
    const bal = await W('get_balance');
    const verdict = classifyJointBalance(bal, bal && BigInt(bal.unlocked_balance ?? 0) > 0n ? null : await W('get_transfers', { in: true, pool: true }));
    if (verdict.status === 'sweepable') return { status: 'recovered', txids: (await W('sweep_all', { address: dest, priority: 0 })).tx_hash_list };
    return { status: verdict.status };
  });
}
async function reverseStep(s) {
  const id = unhex(s.swapId), refunder = new PublicKey(s.refunder);
  return makerReverseStep(s, {
    readSwapFinalized: () => readStrictFinalized(refunder, id),
    readRevealed: async (which, point, cursor, onCursor) => { const x = await readRevealedStrict(refunder, id, which, point, { cursor, onCursor }); return x && { secretHex: hex(x.secret), sig: x.sig }; },
    chainNow: () => sol.chainNow(),
    scanXmr: scanXmrOwn,
    canSend: async (rs) => canSendNow({ unlockedAtomic: await treasuryUnlocked(), xmrAtomic: rs.xmrAtomic, reserveAtomic: CFG.xmrFeeReserve }),
    buildXmrTransfer: () => withWallet(TREASURY, () => { throw new Error('treasury wallet missing'); }, async () => {
      return xmrTransferResult(await W('transfer', xmrTransferRequest(s.jointAddress, s.xmrAtomic)));
    }),
    // The window check runs inside the wallet queue, after it has opened and refreshed the wallet: right before the bytes leave.
    relayXmr: (txHex, hooks) => withWallet(TREASURY, () => { throw new Error('treasury wallet missing'); }, async () => { if (!(await hooks.authorize())) return { sent: false }; hooks.mark(); await W('relay_tx', { hex: txHex }); return { sent: true }; }),
    // The ONE send discipline (maker-send.mjs, AG-R2-H1) for the reverse direction too: commit and claim attempts are stored (fsync) before
    // their exact bytes go to every endpoint, settled from finalized evidence, and the claim carrying a is never simulated or priced.
    resolve: (x) => sender.resolve(x),
    proveFinal: (x, o) => sender.proveFinal(x, o),   // 701-H1: terminal only on finalized proof
    sendCommit: (x) => sender.sendCommit(x),
    sendClaim: (x) => sender.sendClaim(x),
    recoverXmr: async (rs, bHex) => {
      const b = fromLE(unhex(bHex));
      if (hex(pub(b)) !== rs.B) throw new Error('revealed scalar does not open B');
      const dest = await withWallet(TREASURY, () => { throw new Error('treasury wallet missing'); }, async () => (await W('get_address')).address);
      return sweepJoint(rs, addScalars(fromLE(unhex(rs.a)), b), dest);
    },
    store, log, sendAllowed: () => gate.isOpen() && CFG.solXmr,
  });
}

// N2: the SOL -> XMR claim rule is the maker's OWN confirmed transfer, so only the transaction recorded before relay (xmrSendTxid) counts.
async function scanXmrOwn(s) {
  return withWallet(`mk-watch-${s.swapId.slice(0, 16)}`, () => W('generate_from_keys', { filename: `mk-watch-${s.swapId.slice(0, 16)}`, address: s.jointAddress, viewkey: s.v, password: PW, restore_height: s.restoreHeight ?? 0, autosave_current: true }), async () => usableFromTransfersOf(await W('get_transfers', { in: true, pool: true }), s.xmrSendTxid));
}

async function scanXmr(s) {
  return withWallet(`mk-watch-${s.swapId.slice(0, 16)}`, () => W('generate_from_keys', { filename: `mk-watch-${s.swapId.slice(0, 16)}`, address: s.jointAddress, viewkey: s.v, password: PW, restore_height: s.restoreHeight ?? 0, autosave_current: true }), async () => {
    // Only unlock_time 0 outputs count; confirmations are the minimum over everything seen (H4).
    return usableFromTransfers(await W('get_transfers', { in: true, pool: true }));
  });
}

async function sweep(s, secretHex) {
  const a = fromLE(unhex(secretHex));
  if (hex(pub(a)) !== s.A) throw new Error('revealed scalar does not open A');
  const spend = addScalars(a, fromLE(unhex(s.b)));
  if (moneroAddress(pub(spend), unhex(s.V), CFG.network) !== s.jointAddress) throw new Error('joint key mismatch');
  // Recycling off (the default, and the live mainnet maker until the owner's later yes): exactly the old rule, no treasury read.
  let dest;
  if (!CFG.recycleXmr) { dest = SWEEP_TO ?? await withWallet(TREASURY, () => { throw new Error('treasury wallet missing'); }, async () => (await W('get_address')).address); log({ event: 'sweep-destination', swapId: s.swapId, to: SWEEP_TO ? 'owner' : 'treasury' }); }
  else {
    const treasury = await withWallet(TREASURY, () => { throw new Error('treasury wallet missing'); }, async () => ({ address: (await W('get_address')).address, balance: (await W('get_balance')).balance }));
    const pick = sweepDestination({ recycle: true, treasuryAtomic: treasury.balance, incomingAtomic: s.xmrAtomic, ceilingAtomic: CFG.inventoryCeiling, ownerAddress: SWEEP_TO, treasuryAddress: treasury.address });
    log({ event: 'sweep-destination', swapId: s.swapId, to: pick.kind, treasuryAtomic: String(treasury.balance), ceilingAtomic: String(CFG.inventoryCeiling) });
    dest = pick.address;
  }
  const fn = `mk-spend-${s.swapId.slice(0, 16)}`;
  return withWallet(fn, () => W('generate_from_keys', { filename: fn, address: s.jointAddress, spendkey: hex(toLE(spend)), viewkey: s.v, password: PW, restore_height: s.restoreHeight ?? 0, autosave_current: true }), async () => {
    const bal = await W('get_balance');
    if (BigInt(bal.unlocked_balance) === 0n) return null; // not spendable yet; next loop
    return (await W('sweep_all', { address: dest, priority: 0 })).tx_hash_list;
  });
}

async function step(s) {
  const id = unhex(s.swapId);
  return makerStep(s, {
    readSwap: () => sol.readSwap(maker.publicKey, id),
    // Paged history resumes from the saved cursor (H7).
    readRevealed: async (which, point, cursor, onCursor) => { const x = await sol.readRevealedSecret(maker.publicKey, id, which, point, { cursor, onCursor }); return x && { secretHex: hex(x.secret), sig: x.sig }; },
    chainNow: () => sol.chainNow(),
    scanXmr,
    // AG-R2-H1: never through sol.send (which simulates). The refund carrying b is never simulated or priced; each attempt is stored
    // (fsync) before its exact bytes go out, and settled from finalized evidence before anything new is sent for this swap.
    resolve: (x) => sender.resolve(x),
    proveFinal: (x, o) => sender.proveFinal(x, o),   // 701-H1: terminal only on finalized proof
    sendReady: (x) => sender.sendReady(x),
    sendRefund: (x, kind) => sender.sendRefund(x, kind),
    sweep, store, log, sweepAllowed: () => gate.isOpen(),
  });
}

let lastAdmission = null;
function admissionTick() {
  const a = admission.state();   // a closed read also drops every issued quote (R2)
  if (lastAdmission !== null && a.open !== lastAdmission) log({ event: a.open ? 'admission-opened' : 'admission-closed', reason: a.reason, ...admissions.counts() });
  else if (lastAdmission === null) log({ event: 'admission-state', open: a.open, reason: a.reason });
  lastAdmission = a.open;
}
const QUICK_RETRY_MS = 1500;   // F5: after a claim refused only for endpoint height skew, look again this soon (never later than the normal interval)
async function loop() {
  const g = await gate.check();
  if (!g.open) log({ event: 'gate-closed', reasons: g.reasons });
  admissionTick();
  let snapshot, quick = false;
  for (const s of openSwaps()) {
    try {
      if (s.direction === 'sol-xmr') { const r = await reverseStep(s); if (r?.reason === 'claim-refused: endpoint-heights-disagree') quick = true; continue; }   // F5: a skew-only refusal is re-read soon, not after the full poll interval   // no maker lock in this direction: nothing for resolveLock
      // A write-ahead record whose lock outcome is unknown (answer lost, crash) is settled from finalized evidence when possible: a late
      // landing marks it locked; two coherent K2 observations mark it never-landed, and it STAYS in this loop (file, secret, lockSig kept).
      // Recovery (makerStep) runs on every open record exactly as before, so a late landing is driven (ready, refund, sweep) in any case.
      const stage = lockStage(s);
      if (stage === 'pending' || stage === 'never-landed') {
        snapshot ??= await chainSnapshot(chainRpc);   // one expiry observation and history probe per pass; null = no evidence this pass
        await resolveLock(s, { evidence: (x) => collectEvidence(chainRpc, { snapshot, record: x, makerKey: maker.publicKey, program: sol.PROGRAM_ID.toBase58() }), store, log });
      }
      await step(s);
    } catch (e) { log({ event: 'error', swapId: s.swapId, error: String(e.message ?? e) }); }
  }
  setTimeout(loop, quick ? Math.min(CFG.loopMs, QUICK_RETRY_MS) : CFG.loopMs);
}

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
http.createServer(async (req, res) => {
  try {
    let body = ''; for await (const c of req) { body += c; if (body.length > 8192) throw new Error('too-large'); }
    const input = body ? JSON.parse(body) : {};
    // Only the Silo server (holding MAKER_API_TOKEN) may quote or open swaps; this stops anyone tying up the caps.
    const h = (x) => createHash('sha256').update(String(x)).digest();
    const authorized = () => !!E.MAKER_API_TOKEN && timingSafeEqual(h(req.headers.authorization ?? ''), h(`Bearer ${E.MAKER_API_TOKEN}`));
    if (req.method === 'POST' && E.MAKER_API_TOKEN && !authorized()) return json(res, 401, { error: 'unauthorized' });
    // R6: operator status, always token-protected (no token configured = always refused). Read-only.
    if (req.method === 'GET' && req.url === '/v1/status') {
      if (!authorized()) return json(res, 401, { error: 'unauthorized' });
      const a = admission.state(), open = openSwaps();
      return json(res, 200, { admission: a.open ? 'open' : 'closed', admissionReason: a.reason, startGate: { open: gate.isOpen() }, ...admissions.counts(), openCount: open.length,
        open: open.map((s) => ({ id: s.swapId.slice(0, 8), direction: s.direction ?? 'xmr-sol', lock: s.direction === 'sol-xmr' ? null : lockStage(s), lockedOnChain: s.direction === 'sol-xmr' ? Boolean(s.seenPda) : s.solLocked === true,
          ready: !!s.readySig, xmrSent: Boolean(s.xmrSendTxid), committed: !!s.commitSig, attemptsOpen: ATTEMPT_LISTS.flatMap((l) => s[l] ?? []).filter((a) => OPEN_ATTEMPT_STATES.has(a.state)).length,
          secretExposed: !!s.secretExposure, earlyAbort: s.earlyAbort ?? null, claimAbort: s.claimAbort ?? null })),
        maker: maker.publicKey.toBase58(), programId: sol.PROGRAM_ID.toBase58(), network: CFG.network, startedAt, generation, stateDir });
    }
    if (req.method === 'POST' && req.url === '/v1/quote') return json(res, 200, await quote(input));
    if (req.method === 'POST' && req.url === '/v1/swap') return json(res, 200, await startSwap(input));
    if (req.method === 'POST' && req.url === '/v1/rev/quote') return json(res, 200, await reverseQuote(input));
    if (req.method === 'POST' && req.url === '/v1/rev/swap') return json(res, 200, await reverseRegister(input));
    if (req.method === 'GET' && req.url?.startsWith('/v1/swap/')) {
      const s = load(req.url.slice(9).replace(/[^0-9a-f]/g, ''));
      return json(res, 200, { swapId: s.swapId, direction: s.direction ?? 'xmr-sol', jointAddress: s.jointAddress, lockSig: s.lockSig ?? null, readySig: s.readySig ?? null, refundSig: s.refundSig ?? null, xmrSendTxid: s.xmrSendTxid ?? null, claimSig: s.claimSig ?? null, done: s.done ?? null });
    }
    if (req.method === 'GET' && req.url === '/v1/health') return json(res, 200, { ok: true, accepting: accepting(), maker: maker.publicKey.toBase58(), limits: { maxXmrPerSwap: fmt(CFG.maxXmrPerSwap), maxXmrPerDay: fmt(CFG.maxXmrPerDay), maxOpenSwaps: CFG.maxOpenSwaps }, solXmr: CFG.solXmr });
    json(res, 404, { error: 'not-found' });
  } catch (e) { json(res, 400, { error: String(e.message ?? e) }); }
}).listen(CFG.port, '127.0.0.1', () => { log({ event: 'start', port: CFG.port, maker: maker.publicKey.toBase58() }); loop(); });
