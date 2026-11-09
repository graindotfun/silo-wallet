// Minimal maker bot for the XMR -> SOL beta (maker = Bob: holds SOL, receives XMR).
// One process: a small HTTP API for quotes/swaps plus a watch loop that drives every open
// swap with swap-core.makerNext (set ready, abort/late refund, sweep after claim).
// Test networks only in this prototype (devnet + stagenet). Caps and inventory floor are hard.
import http from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, readdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { randomScalar, pub, addPoints, addScalars, moneroAddress, isPrimeOrder, toLE, fromLE, hex, unhex, proveShare, verifyShare } from '../client/keys.mjs';
import { rpc, atomic, fmt, daemonHeight } from '../client/xmr.mjs';
import { loadKeypair } from '../client/node-keys.mjs';
import * as sol from '../client/sol.mjs';
import { usableFromTransfers, createWalletQueue, makerStep, createStartGate } from './maker-core.mjs';
import { CONFIRMATIONS, makerConfirmations } from '../client/swap-core.mjs';

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
const quotes = new Map();

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

function openSwaps() { return readdirSync(`${STATE}/swaps`).filter((f) => f.endsWith('.json')).map((f) => load(f.slice(0, -5))).filter((s) => !s.done); }
function lockedToday() {
  const day = new Date().toISOString().slice(0, 10);
  return readdirSync(`${STATE}/swaps`).filter((f) => f.endsWith('.json')).map((f) => load(f.slice(0, -5))).filter((s) => s.createdAt.startsWith(day)).reduce((t, s) => t + BigInt(s.xmrAtomic), 0n);
}

async function quote({ xmr }) {
  const xmrAtomic = atomic(Number(xmr));
  if (!(xmrAtomic >= CFG.minXmrPerSwap && xmrAtomic <= CFG.maxXmrPerSwap)) throw new Error('amount-outside-limits');
  if (lockedToday() + xmrAtomic > CFG.maxXmrPerDay) throw new Error('daily-limit-reached');
  if (!gate.isOpen()) throw new Error('maker-paused');
  if (openSwaps().length >= CFG.maxOpenSwaps) throw new Error('busy-try-later');
  const p = await price();
  const gross = Number(xmrAtomic) / 1e12 * p.solPerXmr * (1 - CFG.spreadBps / 10_000);
  const lamports = Math.floor(gross * LAMPORTS_PER_SOL) - CFG.gasLamports;
  if (lamports <= 0) throw new Error('amount-too-small');
  const quoteId = hex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  // The swap id is fixed at quote time so both key-share proofs can be bound to it.
  const swapId = hex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const confirmations = xmrAtomic <= CFG.smallSwapMaxAtomic ? makerConfirmations(CFG.smallSwapConfirmations) : CONFIRMATIONS;
  const q = { quoteId, swapId, xmrAtomic: xmrAtomic.toString(), lamports, gasLamports: CFG.gasLamports, solPerXmr: p.solPerXmr, spreadBps: CFG.spreadBps, priceSource: 'coingecko', confirmations, expiresAt: Math.floor(Date.now() / 1000) + CFG.quoteTtl };
  quotes.set(quoteId, q);
  log({ event: 'quote', ...q });
  return q;
}

async function startSwap({ quoteId, claimer, feePayer, A, proofA, v }) {
  const q = quotes.get(quoteId);
  if (!q || q.expiresAt < Date.now() / 1000) throw new Error('quote-expired');
  quotes.delete(quoteId);
  if (!gate.isOpen()) throw new Error('maker-paused');
  if (openSwaps().length >= CFG.maxOpenSwaps) throw new Error('busy-try-later');
  if (lockedToday() + BigInt(q.xmrAtomic) > CFG.maxXmrPerDay) throw new Error('daily-limit-reached');
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
    xmrAtomic: q.xmrAtomic, confirmations: q.confirmations, lamports: q.lamports, t0: now + CFG.t0Delta, t1: now + CFG.t1Delta, lockedAt: now, restoreHeight: (await daemonHeight()) - 5 };
  store(s); // persist the secret BEFORE any money moves
  const ixs = [];
  if ((await sol.conn.getBalance(gasKey)) < q.gasLamports) ixs.push(SystemProgram.transfer({ fromPubkey: maker.publicKey, toPubkey: gasKey, lamports: q.gasLamports }));
  ixs.push(sol.lockIx({ refunder: maker.publicKey, swapId, claimer: claimerKey, claimPoint: Ab, refundPoint: B, lamports: q.lamports, t0: s.t0, t1: s.t1 }));
  const r = await sol.send(ixs, maker);
  s.lockSig = r.sig; s.solLocked = true; store(s);
  log({ event: 'sol-locked', swapId: s.swapId, sig: r.sig, lamports: s.lamports, xmrAtomic: s.xmrAtomic, t0: s.t0, t1: s.t1, gas: ixs.length > 1 });
  return { swapId: s.swapId, B: s.B, proofB, jointAddress, pda: sol.swapPda(maker.publicKey, swapId).toBase58(), refunder: maker.publicKey.toBase58(), t0: s.t0, t1: s.t1, lamports: s.lamports, lockSig: r.sig, xmrAtomic: s.xmrAtomic };
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
  const dest = SWEEP_TO ?? await withWallet(TREASURY, () => { throw new Error('treasury wallet missing'); }, async () => (await W('get_address')).address);
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
    sendReady: () => sol.send(sol.readyIx({ refunder: maker.publicKey, swapId: id }), maker),
    sendRefund: () => sol.send(sol.refundIx({ refunder: maker.publicKey, swapId: id, secret: unhex(s.b) }), maker),
    sweep, store, log, sweepAllowed: () => gate.isOpen(),
  });
}

async function loop() {
  const g = await gate.check();
  if (!g.open) log({ event: 'gate-closed', reasons: g.reasons });
  for (const s of openSwaps()) { try { await step(s); } catch (e) { log({ event: 'error', swapId: s.swapId, error: String(e.message ?? e) }); } }
  setTimeout(loop, CFG.loopMs);
}

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
http.createServer(async (req, res) => {
  try {
    let body = ''; for await (const c of req) { body += c; if (body.length > 8192) throw new Error('too-large'); }
    const input = body ? JSON.parse(body) : {};
    // Only the Silo server (holding MAKER_API_TOKEN) may quote or open swaps; this stops anyone tying up the caps.
    if (req.method === 'POST' && E.MAKER_API_TOKEN) {
      const h = (x) => createHash('sha256').update(String(x)).digest();
      if (!timingSafeEqual(h(req.headers.authorization ?? ''), h(`Bearer ${E.MAKER_API_TOKEN}`))) return json(res, 401, { error: 'unauthorized' });
    }
    if (req.method === 'POST' && req.url === '/v1/quote') return json(res, 200, await quote(input));
    if (req.method === 'POST' && req.url === '/v1/swap') return json(res, 200, await startSwap(input));
    if (req.method === 'GET' && req.url?.startsWith('/v1/swap/')) {
      const s = load(req.url.slice(9).replace(/[^0-9a-f]/g, ''));
      return json(res, 200, { swapId: s.swapId, jointAddress: s.jointAddress, lockSig: s.lockSig, readySig: s.readySig ?? null, refundSig: s.refundSig ?? null, done: s.done ?? null });
    }
    if (req.method === 'GET' && req.url === '/v1/health') return json(res, 200, { ok: true, accepting: gate.isOpen(), maker: maker.publicKey.toBase58(), limits: { maxXmrPerSwap: fmt(CFG.maxXmrPerSwap), maxXmrPerDay: fmt(CFG.maxXmrPerDay), maxOpenSwaps: CFG.maxOpenSwaps } });
    json(res, 404, { error: 'not-found' });
  } catch (e) { json(res, 400, { error: String(e.message ?? e) }); }
}).listen(CFG.port, '127.0.0.1', () => { log({ event: 'start', port: CFG.port, maker: maker.publicKey.toBase58() }); loop(); });
