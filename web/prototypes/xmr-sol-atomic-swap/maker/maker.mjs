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
import { reverseTimelocks, REV_T0_LEAD, REV_CLAIM_WINDOW } from '../client/reverse-core.mjs';
import { strictPda, readStrictFinalized, readRevealedStrict } from './strict-sol.mjs';
import { sweepDestination } from './maker-reverse.mjs';
import { scanSwaps, recoveryPass } from './maker-records.mjs';
import { pruneFinished } from './maker-retention.mjs';
import { limitInputs, unpaidCaps } from './maker-limits.mjs';
import { createPriceCheck, coingeckoPrice, krakenPrice, priceSettings } from './price-feeds.mjs';
import { priorityFeeConfig, createFeeSource } from './priority-fee.mjs';
import { parseLaneConfig, laneHealth, laneOf, laneRecords, laneCaps, laneAdmission, tokenHoldback, publicRoute, publicSwapView, corsHeaders, createBucket, createSourceLimiter, pruneQuotes, createQuoteStore, BUILD_HASH } from './maker-lanes.mjs';

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
  priceBandBps: priceSettings(E).bandBps, priceMaxAgeS: priceSettings(E).maxAgeS,
  ...unpaidCaps(E),
  // SOL -> XMR (maker = Alice, sends XMR from its treasury). Off unless explicitly enabled; on mainnet it also needs
  // the owner's yes for inventory, caps and the public enable (threat model: SOL_TO_XMR_THREAT_MODEL.md).
  solXmr: E.SOL_XMR_ENABLED === 'true',
  xmrFeeReserve: atomic(Number(E.XMR_FEE_RESERVE ?? 0.001)),
  // Owner decision 5 Nov 2026: XMR received in XMR -> SOL swaps stays with the maker as SOL -> XMR inventory, up to this
  // ceiling; anything above it goes to MAKER_XMR_SWEEP_ADDRESS (the owner). Off unless MAKER_RECYCLE_XMR=true.
  recycleXmr: E.MAKER_RECYCLE_XMR === 'true',
  inventoryCeiling: atomic(Number(E.MAKER_INVENTORY_CEILING_XMR ?? 0.15)),
};
// Open maker endpoint: the public lane is OFF unless MAKER_PUBLIC_LANE=true (maker-lanes.mjs). A bad value stops the start.
const PUB = parseLaneConfig(E, { min: CFG.minXmrPerSwap, perSwap: CFG.maxXmrPerSwap, perDay: CFG.maxXmrPerDay, open: CFG.maxOpenSwaps });
// Self-reported build hash for /v1/health, from the environment only; nothing here proves the running code equals any source.
if (E.MAKER_BUILD_HASH && !BUILD_HASH.test(E.MAKER_BUILD_HASH)) throw new Error('MAKER_BUILD_HASH must be sha256:<64 hex>');
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
const sender = createSender({ conns: [sol.conn, ...(E.SOL_RPC_SECONDARY ? [new Connection(E.SOL_RPC_SECONDARY, 'confirmed')] : [])], payer: maker, store, log, feeFor: createFeeSource(priorityFeeConfig(E), sol.conn) });
const quotes = new Map();
const reverseQuotes = new Map();   // SOL -> XMR quotes (they hold the maker's secret a until registration); dropped with the forward quotes on every closed read
// ONE quote ceiling per lane across both directions; check and reservation are one synchronous step (maker-lanes.mjs createQuoteStore).
const quoteStore = createQuoteStore({ maps: [quotes, reverseQuotes], pub: PUB });
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
// 709-H1: an unreadable swap record (or an unlistable directory) closes admission until it is readable again; recovery never stops.
const acct = { complete: true, bad: [], dirError: null, at: null };
const accepting = () => gate.isOpen() && admission.isOpen() && acct.complete;
const admissions = createAdmissionSerial(PUB.enabled ? { publicMaxQueued: PUB.admissionQueueDepth, publicDeadlineMs: PUB.admissionDeadlineMs } : {});
// Public admissions carry the request's signal and are bounded and cancellable while they wait (Sol M1); token admissions pass no options.
const admitOpts = (input) => (input?.lane === 'public' ? { public: true, signal: input.signal } : {});
// R9: journaled (fsync) at every process start, before the API listens. A swap file created before this time was written by a process
// that has ended; the quiesce check's K4 rule bounds the blockhashes that process could have used from this time.
// The generation id names THIS process: the quiesce check requires /v1/status to report the same generation as the journal's last
// maker-started, at the start and at the end of its run (K4 process boundary bound to the serving process), and the same state directory.
const startedAt = new Date().toISOString(), generation = randomBytes(16).toString('hex'), stateDir = realpathSync(STATE);
log({ event: 'maker-started', at: startedAt, generation, maker: maker.publicKey.toBase58(), network: CFG.network });
// Finalized evidence for unsettled locks (read-only get* JSON-RPC to the same Solana endpoint as sol.conn).
const chainRpc = rpcClient(sol.conn.rpcEndpoint);

// ---- Monero wallet access is serialized (one open wallet at a time; a failure never poisons the queue, H5) ----
// Recovery work (the watch loop, sweeps, refunds, the token lane) runs on the queue itself and is always served ahead of public jobs; public lane reads use their own
// bounded queue (withWallet.publicLane: depth, deadline, cancelled when the caller goes away). One executor, one open wallet at a time.
const withWallet = createWalletQueue(W, PW, PUB.enabled ? { publicMaxDepth: PUB.walletQueueDepth, publicDeadlineMs: PUB.walletDeadlineMs } : {});
const walletFor = (lane, signal) => (lane === 'public' ? (name, create, fn) => withWallet.publicLane(name, create, fn, { signal }) : withWallet);

// ---- Price: CoinGecko, checked against Kraken (SEC-P-07), plus a fixed spread ----
// Same CoinGecko provider, API base and asset ids as Silo's own price feed (lib/silo/prices.mjs), including its optional demo-key header.
// Kraken is a second, independent public source. No quote when either is down or stale or they differ by more than PRICE_BAND_BPS.
// Jupiter is not used: it can only price wXMR, the bridge token.
const price = createPriceCheck({ bandBps: CFG.priceBandBps, fetchers: [() => coingeckoPrice({ apiKey: E.COINGECKO_DEMO_API_KEY, maxAgeS: CFG.priceMaxAgeS }), () => krakenPrice()] });

// Every record not done stays in the recovery loop, including a lock proven never landed (it only stops counting toward the open cap).
// Every read goes through scanSwaps: one bad file never throws (709-H1). The cache `acct` is refreshed by every scan.
function scan() {
  const r = scanSwaps({ list: () => readdirSync(`${STATE}/swaps`), load });
  noteScan(r);
  return r;
}
function noteScan(r) {
  const key = (x) => JSON.stringify([x.dirError, x.bad.map((b) => `${b.id}:${b.why}`)]);
  if (key(r) !== key(acct) || r.complete !== acct.complete) log(r.complete ? { event: 'records-readable-again' } : { event: 'records-unreadable', dirError: r.dirError, files: r.bad.map((b) => ({ id: b.id.slice(0, 16), why: b.why })) });
  acct.complete = r.complete; acct.bad = r.bad; acct.dirError = r.dirError; acct.at = new Date().toISOString();
}
function openSwaps() { return scan().records.filter((s) => !s.done); }
// Each lane counts only its own records (laneRecords); with the public lane off there is one pool, exactly as before.
const cappedSwaps = (lane = 'token') => laneRecords(openSwaps(), lane, PUB.enabled).filter((s) => lockStage(s) !== 'never-landed');
const isOpenCounted = (s) => !s.done && lockStage(s) !== 'never-landed';
// F-12: the daily XMR allowance counts PAID swaps (plus a reservation for unpaid ones open right now); unpaid requests have their own counters.
const allSwaps = () => scan().records;
// Accounting must be complete to admit anything: a record that cannot be read could be a paid or open swap that the limits must count.
const limitsNow = (requester = null, lane = 'token') => { const r = scan(); if (!r.complete) throw new Error('maker-accounting-incomplete'); return limitInputs(laneRecords(r.records, lane, PUB.enabled), requester, { isOpenCounted }); };
const lockedToday = (lane = 'token') => limitsNow(null, lane).lockedTodayAtomic;
// Accounting must be complete for any admission; the lane check sees every record and filters by lane itself.
const completeRecords = () => { const r = scan(); if (!r.complete) throw new Error('maker-accounting-incomplete'); return r.records; };

// t0Delta/t1Delta in both quotes: the refund times this maker will register, in seconds after the lock (additive, so a client can show them before registering).
async function quote({ xmr, lane = 'token', signal }) {
  const xmrAtomic = atomic(Number(xmr)), C = laneCaps(lane, caps(), PUB);   // lane: set by the server
  if (!(xmrAtomic >= C.minAtomic && xmrAtomic <= C.maxPerSwapAtomic)) throw new Error('amount-outside-limits');
  if (lockedToday(lane) + xmrAtomic > C.maxPerDayAtomic) throw new Error('daily-limit-reached');
  if (!accepting()) throw new Error('maker-paused');
  if (cappedSwaps(lane).length >= C.maxOpen) throw new Error('busy-try-later');
  quoteLimits(xmrAtomic, lane);   // F-12: the unpaid counters, same error codes as at admission
  const slot = quoteStore.reserve(lane);   // M2: ceiling check and reservation in one synchronous step, before any await
  try {
  const p = await price();
  const gross = Number(xmrAtomic) / 1e12 * p.solPerXmr * (1 - CFG.spreadBps / 10_000);
  const lamports = Math.floor(gross * LAMPORTS_PER_SOL) - CFG.gasLamports;
  if (lamports <= 0) throw new Error('amount-too-small');
  const quoteId = hex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  // The swap id is fixed at quote time so both key-share proofs can be bound to it.
  const swapId = hex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const confirmations = xmrAtomic <= CFG.smallSwapMaxAtomic ? makerConfirmations(CFG.smallSwapConfirmations) : CONFIRMATIONS;
  const q = { quoteId, swapId, xmrAtomic: xmrAtomic.toString(), lamports, gasLamports: CFG.gasLamports, solPerXmr: p.solPerXmr, spreadBps: CFG.spreadBps, priceSource: 'coingecko', confirmations, t0Delta: CFG.t0Delta, t1Delta: CFG.t1Delta, expiresAt: Math.floor(Date.now() / 1000) + CFG.quoteTtl };
  if (!accepting()) throw new Error('maker-paused');   // closed while the price was fetched: issue nothing
  if (signal?.aborted) throw new Error('client-gone');
  slot.commit(quotes, quoteId, { ...q, lane });
  log({ event: 'quote', ...q });
  return q;
  } finally { slot.release(); }
}

// ONE admission gate for both directions (VBU-M1 + Astra r5): the drain file and the start gate are read live through accepting(); every
// admission (XMR -> SOL swap and SOL -> XMR registration) runs one at a time through the same createAdmissionSerial queue and the same
// admitSwap: entry check, shared limits (capsAdmission: per swap, open count, daily quota counted over BOTH directions), all awaits, then the
// last check with no await before the swap file (the first persistent commitment) is stored. For XMR -> SOL that file already holds the
// secret, the signed lock signature and its last valid block height, and only then is the lock broadcast.
const caps = () => ({ minAtomic: CFG.minXmrPerSwap, maxPerSwapAtomic: CFG.maxXmrPerSwap, maxPerDayAtomic: CFG.maxXmrPerDay, maxOpen: CFG.maxOpenSwaps, reserveAtomic: CFG.xmrFeeReserve, maxUnpaidOpen: CFG.maxUnpaidOpen, maxUnpaidPerAddress: CFG.maxUnpaidPerAddress, maxUnpaidPerDay: CFG.maxUnpaidPerDay });
// Quote time has no requester address yet: the global unpaid counters apply, the per-address one is checked at admission.
const quoteLimits = (xmrAtomic, lane = 'token') => laneAdmission({ lane, xmrAtomic, records: completeRecords(), isOpenCounted, base: caps(), pub: PUB });
// A quote belongs to the lane it was issued in: using it from the other lane is refused like an expired one (input.lane is set by the server).
const sharedLimits = (q, input) => { if (laneOf(q) !== laneOf(input)) throw new Error('quote-expired'); return laneAdmission({ lane: laneOf(q), xmrAtomic: q.xmrAtomic, requester: input?.claimer ?? input?.refunder ?? null, records: completeRecords(), isOpenCounted, base: caps(), pub: PUB }); };
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
}), admitOpts(input));

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
  // Token lane only: leave the unused part of the public lane's float alone (XMR-equivalent at this quote's price). Zero when the lane is off.
  const hold = laneOf(q) === 'token' ? Math.ceil(Number(tokenHoldback(completeRecords(), PUB, isOpenCounted)) / 1e12 * q.solPerXmr * LAMPORTS_PER_SOL) : 0;
  if (bal < q.lamports + q.gasLamports + CFG.solReserve + hold) throw new Error('inventory-low');
  const b = randomScalar(), B = pub(b);
  const V = pub(vS);
  const jointAddress = moneroAddress(addPoints(Ab, B), V, CFG.network);
  const proofB = proveShare(b, swapId, 1);
  const now = await sol.chainNow();
  const s = { swapId: hex(swapId), lane: laneOf(q), quoteId, feePayer: gasKey.toBase58(), createdAt: new Date().toISOString(), claimer, A, B: hex(B), b: hex(toLE(b)), v, V: hex(V), jointAddress,
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
// Token lane: the unused part of the public lane's float is not available to it (maker-lanes.mjs tokenHoldback). Public lane and lane off: unchanged.
function inventoryFor(lane, unlocked) {
  if (lane !== 'token' || !PUB.enabled) return unlocked;
  const left = BigInt(unlocked) - tokenHoldback(completeRecords(), PUB, isOpenCounted);
  return left > 0n ? left : 0n;
}
async function treasuryUnlocked(lane = 'token', signal) { return walletFor(lane, signal)(TREASURY, () => { throw new Error('treasury wallet missing'); }, async () => (await W('get_balance')).unlocked_balance); }
async function reverseQuote({ xmr, lane = 'token', signal }) {
  if (!CFG.solXmr) throw new Error('direction-disabled');
  if (!accepting()) throw new Error('maker-paused');
  const xmrAtomic = atomic(Number(xmr)), C = laneCaps(lane, caps(), PUB);
  if (!(xmrAtomic >= C.minAtomic && xmrAtomic <= C.maxPerSwapAtomic)) throw new Error('amount-outside-limits');
  if (lockedToday(lane) + xmrAtomic > C.maxPerDayAtomic) throw new Error('daily-limit-reached');
  if (cappedSwaps(lane).length >= C.maxOpen) throw new Error('busy-try-later');
  quoteLimits(xmrAtomic, lane);   // F-12
  const slot = quoteStore.reserve(lane);   // M2
  try {
  if (freeInventory(inventoryFor(lane, await treasuryUnlocked(lane, signal)), openReverse(), CFG.xmrFeeReserve) < xmrAtomic) throw new Error('inventory-low');
  const p = await price();
  // The user pays the SOL; the maker's spread is added on top of the market price.
  const lamports = Math.ceil(Number(xmrAtomic) / 1e12 * p.solPerXmr * (1 + CFG.spreadBps / 10_000) * LAMPORTS_PER_SOL);
  const quoteId = hex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const swapId = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const a = randomScalar(), A = pub(a);
  const q = { direction: 'sol-xmr', quoteId, swapId: hex(swapId), xmrAtomic: xmrAtomic.toString(), lamports, solPerXmr: p.solPerXmr, spreadBps: CFG.spreadBps, priceSource: 'coingecko',
    t0Delta: REV_T0_LEAD, t1Delta: REV_T0_LEAD + REV_CLAIM_WINDOW,
    A: hex(A), proofA: proveShare(a, swapId, 0), claimer: maker.publicKey.toBase58(), expiresAt: Math.floor(Date.now() / 1000) + CFG.quoteTtl };
  if (!accepting()) throw new Error('maker-paused');   // closed while the balance and price were fetched: issue nothing
  if (signal?.aborted) throw new Error('client-gone');
  slot.commit(reverseQuotes, quoteId, { ...q, a: hex(toLE(a)), lane });
  log({ event: 'rev-quote', quoteId, swapId: q.swapId, xmrAtomic: q.xmrAtomic, lamports, solPerXmr: p.solPerXmr, spreadBps: CFG.spreadBps, priceSource: 'coingecko', expiresAt: q.expiresAt });
  return q;
  } finally { slot.release(); }
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
}), admitOpts(input));
async function prepareReverse(q, { quoteId, refunder, B, proofB, v, signal }) {
  const swapId = unhex(q.swapId), Bb = unhex(B), vS = fromLE(unhex(v));
  if (!verifyShare(Bb, proofB, swapId, 1)) throw new Error('bad-share-proof');
  if (vS === 0n || vS >= (await import('../client/keys.mjs')).L) throw new Error('bad-view-key');
  const lane = laneOf(q), l = limitsNow(refunder, lane);
  reverseAdmission({ xmrAtomic: q.xmrAtomic, openCount: cappedSwaps(lane).length, lockedTodayAtomic: l.lockedTodayAtomic, unpaid: l.unpaid, unlockedAtomic: inventoryFor(lane, await treasuryUnlocked(lane, signal)), openReverse: openReverse(), caps: laneCaps(lane, caps(), PUB) });
  laneAdmission({ lane, xmrAtomic: q.xmrAtomic, requester: refunder, records: completeRecords(), isOpenCounted, base: caps(), pub: PUB });   // adds the public lane's float, read after the awaits
  const refunderKey = new PublicKey(refunder);
  const jointAddress = moneroAddress(addPoints(unhex(q.A), Bb), pub(vS), CFG.network);
  const { t0, t1 } = reverseTimelocks(await sol.chainNow());
  const record = { direction: 'sol-xmr', lane, swapId: q.swapId, quoteId, createdAt: new Date().toISOString(), refunder: refunderKey.toBase58(), claimer: q.claimer,
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

// Privacy retention: finished swaps are reduced to their outcome and amounts after 14 days (maker-retention.mjs). At start, then every hour.
const retain = () => { try { pruneFinished({ ids: () => readdirSync(`${STATE}/swaps`).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)), load, write: store, mtimeMs: (id) => statSync(swapFile(id)).mtimeMs, pdaOf: (s) => (s.direction === 'sol-xmr' ? strictPda(new PublicKey(s.refunder), unhex(s.swapId)) : sol.swapPda(maker.publicKey, unhex(s.swapId))).toBase58(), nowMs: () => Date.now(), log }); } catch (e) { log({ event: 'retention-error', error: String(e?.message ?? e).slice(0, 120) }); } };
let lastAdmission = null;
function admissionTick() {
  const a = admission.state();   // a closed read also drops every issued quote (R2)
  if (lastAdmission !== null && a.open !== lastAdmission) log({ event: a.open ? 'admission-opened' : 'admission-closed', reason: a.reason, ...admissions.counts() });
  else if (lastAdmission === null) log({ event: 'admission-state', open: a.open, reason: a.reason });
  lastAdmission = a.open;
}
const QUICK_RETRY_MS = 1500;   // F5: after a claim refused only for endpoint height skew, look again this soon (never later than the normal interval)
async function loop() {
  let quick = false;
  try {
    const g = await gate.check();
    if (!g.open) log({ event: 'gate-closed', reasons: g.reasons });
    admissionTick();
    { const t = Math.floor(Date.now() / 1000); pruneQuotes(quotes, t); pruneQuotes(reverseQuotes, t); }   // expired quotes do not pile up between quote requests
    let snapshot;
    const results = await recoveryPass({ scan, onScan: noteScan, log, handle: async (s) => {
      if (s.direction === 'sol-xmr') { const r = await reverseStep(s); return r?.reason === 'claim-refused: endpoint-heights-disagree' ? 'quick' : null; }   // F5: a skew-only refusal is re-read soon, not after the full poll interval   // no maker lock in this direction: nothing for resolveLock
      // A write-ahead record whose lock outcome is unknown (answer lost, crash) is settled from finalized evidence when possible: a late
      // landing marks it locked; two coherent K2 observations mark it never-landed, and it STAYS in this loop (file, secret, lockSig kept).
      // Recovery (makerStep) runs on every open record exactly as before, so a late landing is driven (ready, refund, sweep) in any case.
      const stage = lockStage(s);
      if (stage === 'pending' || stage === 'never-landed') {
        snapshot ??= await chainSnapshot(chainRpc);   // one expiry observation and history probe per pass; null = no evidence this pass
        await resolveLock(s, { evidence: (x) => collectEvidence(chainRpc, { snapshot, record: x, makerKey: maker.publicKey, program: sol.PROGRAM_ID.toBase58() }), store, log });
      }
      await step(s);
      return null;
    } });
    quick = results.includes('quick');
  } catch (e) { log({ event: 'error', where: 'loop', error: String(e?.message ?? e).slice(0, 200) }); }   // a failing gate check or journal write never ends the loop
  finally { setTimeout(loop, quick ? Math.min(CFG.loopMs, QUICK_RETRY_MS) : CFG.loopMs); }   // 709-H1: always rescheduled
}

const json = (res, code, body, extra = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...extra }); res.end(JSON.stringify(body)); };
// ---- Public lane gates (maker-lanes.mjs). All of this is inert while MAKER_PUBLIC_LANE is not true. ----
const STATUS_PATH = '/v1/status';
const buckets = PUB.enabled ? { quote: createBucket(PUB.rates.quote), swap: createBucket(PUB.rates.swap), status: createBucket(PUB.rates.status) } : null;
const sourceLimiter = PUB.enabled && PUB.perSource > 0 ? createSourceLimiter({ header: PUB.sourceHeader, perMin: PUB.perSource }) : null;
let publicInFlight = 0;
// A public caller sees a short code or a generic one, never an internal message (it could carry a path or an endpoint).
const publicError = (e) => { const m = String(e?.message ?? e); return /^[a-z][a-z0-9-]{1,48}$/.test(m) ? m : e instanceof SyntaxError ? 'bad-request' : 'request-failed'; };
const server = http.createServer(async (req, res) => {
  let lane = 'token', cors = {}, slot = false, signal;
  try {
    // Only the Silo server (holding MAKER_API_TOKEN) may use the token lane; this stops anyone tying up its caps.
    const h = (x) => createHash('sha256').update(String(x)).digest();
    const authorized = () => !!E.MAKER_API_TOKEN && timingSafeEqual(h(req.headers.authorization ?? ''), h(`Bearer ${E.MAKER_API_TOKEN}`));
    // SEC-P-06: every route except the minimal /v1/health needs the bearer token (GET included: swap ids are public on Solana, and the lookup
    // answers with the joint Monero address and transaction ids). No token configured = every protected route refuses, as /v1/status already did.
    const isHealth = req.method === 'GET' && req.url === '/v1/health';
    // Test networks without a token keep the old behaviour for POST only (local rehearsals); mainnet cannot start without a token (start gate).
    const devOpenPost = req.method === 'POST' && !E.MAKER_API_TOKEN && CFG.network !== 'mainnet';
    if (PUB.enabled && req.headers.authorization === undefined) cors = corsHeaders(PUB);   // answers to token-less callers only
    if (!isHealth && !(devOpenPost && !PUB.enabled) && !authorized()) {
      // Not the token lane. With the public lane off this is the old 401. With it on, a caller that sent NO Authorization header may use the
      // public routes; one that sent a wrong token still gets 401; operator status is never public.
      if (!PUB.enabled || req.headers.authorization !== undefined || req.url === STATUS_PATH) return json(res, 401, { error: 'unauthorized' });
      if (req.method === 'OPTIONS' && PUB.cors && (publicRoute('POST', req.url) || publicRoute('GET', req.url))) { res.writeHead(204, corsHeaders(PUB, true)); return res.end(); }
      const route = publicRoute(req.method, req.url);
      if (!route) return json(res, 404, { error: 'not-found' });
      const wait = buckets[route].take();
      if (!wait.ok) return json(res, 429, { error: 'rate-limited' }, { ...cors, 'retry-after': String(wait.retryAfterS) });
      const src = sourceLimiter?.take(req.headers);
      if (src && !src.ok) return json(res, 429, { error: 'rate-limited' }, { ...cors, 'retry-after': String(src.retryAfterS) });
      if (publicInFlight >= PUB.maxConcurrent) return json(res, 503, { error: 'busy-try-later' }, { ...cors, 'retry-after': '5' });
      publicInFlight += 1; slot = true;
      // M1: a client that goes away frees its slot AND cancels what it has queued (wallet read, quote in progress); its queued work never runs.
      const ac = new AbortController(); signal = ac.signal;
      res.on('close', () => { if (slot) { slot = false; publicInFlight -= 1; } if (!res.writableFinished) ac.abort(); });
      lane = 'public';
    }
    const maxBody = lane === 'public' ? PUB.maxBody : 8192;
    let body = ''; for await (const c of req) { body += c; if (body.length > maxBody) throw new Error('too-large'); }   // read and parsed only
    const input = body ? JSON.parse(body) : {};   // parsed only after authorization: an unauthenticated malformed body gets 401, not 400
    // R6: operator status, always token-protected (no token configured = always refused). Read-only.
    if (req.method === 'GET' && req.url === '/v1/status') {
      if (!authorized()) return json(res, 401, { error: 'unauthorized' });
      const a = admission.state(), open = openSwaps();
      return json(res, 200, { admission: a.open ? 'open' : 'closed', admissionReason: a.reason, startGate: { open: gate.isOpen() }, ...admissions.counts(), openCount: open.length,
        open: open.map((s) => ({ id: s.swapId.slice(0, 8), direction: s.direction ?? 'xmr-sol', lane: laneOf(s), lock: s.direction === 'sol-xmr' ? null : lockStage(s), lockedOnChain: s.direction === 'sol-xmr' ? Boolean(s.seenPda) : s.solLocked === true,
          ready: !!s.readySig, xmrSent: Boolean(s.xmrSendTxid), committed: !!s.commitSig, attemptsOpen: ATTEMPT_LISTS.flatMap((l) => s[l] ?? []).filter((a) => OPEN_ATTEMPT_STATES.has(a.state)).length,
          secretExposed: !!s.secretExposure, earlyAbort: s.earlyAbort ?? null, claimAbort: s.claimAbort ?? null })),
        accounting: { complete: acct.complete, unreadable: acct.bad.map((b) => ({ id: b.id.slice(0, 16), why: b.why })), dirError: acct.dirError },
        maker: maker.publicKey.toBase58(), programId: sol.PROGRAM_ID.toBase58(), network: CFG.network, startedAt, generation, stateDir });
    }
    // The lane is set here by the server and overrides anything the caller put in the body.
    if (req.method === 'POST' && req.url === '/v1/quote') return json(res, 200, await quote({ ...input, lane, signal }), cors);
    if (req.method === 'POST' && req.url === '/v1/swap') return json(res, 200, await startSwap({ ...input, lane, signal }), cors);
    if (req.method === 'POST' && req.url === '/v1/rev/quote') return json(res, 200, await reverseQuote({ ...input, lane, signal }), cors);
    if (req.method === 'POST' && req.url === '/v1/rev/swap') return json(res, 200, await reverseRegister({ ...input, lane, signal }), cors);
    if (req.method === 'GET' && req.url?.startsWith('/v1/swap/')) {
      let s;
      try { s = load(req.url.slice(9).replace(/[^0-9a-f]/g, '')); } catch (e) { return json(res, e?.code === 'ENOENT' ? 404 : 400, { error: e?.code === 'ENOENT' ? 'not-found' : 'unreadable' }, cors); }   // never the state path
      // The public lane sees only its own swaps, reduced (publicSwapView); the token lane sees the full lookup as before.
      if (lane === 'public') return laneOf(s) === 'public' ? json(res, 200, publicSwapView(s), cors) : json(res, 404, { error: 'not-found' }, cors);
      return json(res, 200, { swapId: s.swapId, direction: s.direction ?? 'xmr-sol', jointAddress: s.jointAddress, lockSig: s.lockSig ?? null, readySig: s.readySig ?? null, refundSig: s.refundSig ?? null, xmrSendTxid: s.xmrSendTxid ?? null, claimSig: s.claimSig ?? null, done: s.done ?? null });
    }
    if (req.method === 'GET' && req.url === '/v1/health') return json(res, 200, { ok: true, accepting: accepting(), maker: maker.publicKey.toBase58(), limits: { maxXmrPerSwap: fmt(CFG.maxXmrPerSwap), maxXmrPerDay: fmt(CFG.maxXmrPerDay), maxOpenSwaps: CFG.maxOpenSwaps }, solXmr: CFG.solXmr,
      // Both absent when off or unset. buildHash is what the operator says it runs (an environment value), not a proof of anything.
      ...(E.MAKER_BUILD_HASH ? { buildHash: E.MAKER_BUILD_HASH } : {}), ...(PUB.enabled ? { publicLane: laneHealth(PUB, { open: CFG.maxOpenSwaps, perDay: CFG.maxXmrPerDay }) } : {}) }, cors);
    json(res, 404, { error: 'not-found' }, cors);
  } catch (e) { json(res, 400, { error: lane === 'public' ? publicError(e) : String(e.message ?? e) }, cors); }
});
if (PUB.enabled) { server.headersTimeout = 10_000; server.requestTimeout = 20_000; }   // slow senders do not hold a public slot for minutes
server.listen(CFG.port, '127.0.0.1', () => { log({ event: 'start', port: CFG.port, maker: maker.publicKey.toBase58() }); retain(); setInterval(retain, 3600_000).unref(); loop(); });
