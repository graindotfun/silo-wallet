// In-process fake maker for the conformance suite's own tests. It is built from the real request and response shapes of maker.mjs and the
// real core (keys.mjs, sol.mjs, refunder-tx.mjs); it holds no wallet and touches no network. `breakRule` makes it violate exactly one rule.
import http from 'node:http';
import { PublicKey } from '@solana/web3.js';
import { randomScalar, pub, proveShare, verifyShare, addPoints, moneroAddress, hex, unhex, fromLE } from '../client/keys.mjs';
import { swapPda } from '../client/sol.mjs';
import { atomicSwapPda } from '../../../lib/silo/atomic-swap/refunder-tx.mjs';

const rnd = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const now = () => Math.floor(Date.now() / 1000);
const SPREAD = 200, GAS = 1_000_000, SOL_PER_XMR = 2.0, CAP = 50_000_000_000n, MIN = 1_000_000_000n;

export function startFakeMaker({ breakRule = null, token = null, solXmr = true, tiers = false, network = 'stagenet', statusReadable = true, servesMonero = null } = {}) {
  const makerKey = new PublicKey(rnd(32)), maker = makerKey.toBase58();
  const quotes = new Map(), rquotes = new Map(), known = new Map();
  const stats = { registrations: 0, requests: 0, tierOkSeen: 0, swapPosts: 0, log: [] };   // swapPosts counts EVERY POST to a registration route, valid or not; log is the request order
  const xmrNet = servesMonero ?? (network === 'mainnet' ? 'mainnet' : 'stagenet');
  const fixedB = breakRule === 'reused-share' ? randomScalar() : null, fixedA = breakRule === 'reused-share' ? randomScalar() : null;
  const atomicOf = (x) => { if (typeof x !== 'string' || !/^\d{1,4}(\.\d{1,12})?$/.test(x)) throw new Error('amount-outside-limits'); const [w, f = ''] = x.split('.'); return BigInt(w) * 10n ** 12n + BigInt(f.padEnd(12, '0')); };
  const checkAmount = (x) => { const a = atomicOf(x); if (!(a >= MIN && (a <= CAP || breakRule === 'over-cap'))) throw new Error('amount-outside-limits'); return a; };
  const take = (map, id) => { const q = map.get(id); if (!q || q.expiresAt < now()) { if (breakRule !== 'accepts-unknown-quote') throw new Error('quote-expired'); return null; } if (breakRule !== 'reuse-quote') map.delete(id); return q; };
  function quote({ xmr }) {
    const a = breakRule === 'accepts-wrong-types' ? (() => { const n = BigInt(Math.round(Number(xmr) * 1e12) || 0) || MIN; if (n > CAP) throw new Error('amount-outside-limits'); return n; })() : checkAmount(xmr);
    const lamports = Math.floor(Number(a) / 1e12 * SOL_PER_XMR * (1 - SPREAD / 10_000) * 1e9) - GAS;
    const q = { quoteId: hex(rnd(16)), swapId: hex(rnd(32)), xmrAtomic: breakRule === 'quote-units' ? Number(a) : a.toString(), lamports: breakRule === 'quote-spread' ? lamports - 100_000 : lamports, gasLamports: GAS, solPerXmr: SOL_PER_XMR, spreadBps: SPREAD, priceSource: 'fake', confirmations: 10, expiresAt: now() + (breakRule === 'quote-ttl' ? 86_400 : 120) };
    if (tiers) q.tiers = [{ rate: 'holder', min: '1000000', spreadBps: 100, lamports: breakRule === 'tiers-worse' ? lamports - 1000 : lamports + 100_000 }];
    quotes.set(q.quoteId, q);
    return breakRule === 'unknown-field-breaks' && xmr === undefined ? {} : q;
  }
  function revQuote({ xmr }) {
    if (!solXmr) throw new Error('direction-disabled');
    const a = checkAmount(xmr);
    const swapId = rnd(32), s = fixedA ?? randomScalar();
    const lamports = Math.ceil(Number(a) / 1e12 * SOL_PER_XMR * (1 + SPREAD / 10_000) * 1e9);
    const q = { direction: 'sol-xmr', quoteId: hex(rnd(16)), swapId: hex(swapId), xmrAtomic: a.toString(), lamports, solPerXmr: SOL_PER_XMR, spreadBps: SPREAD, priceSource: 'fake', A: hex(pub(s)),
      proofA: breakRule === 'rev-bad-proof' ? { R: '00'.repeat(32), s: '00'.repeat(32) } : proveShare(s, swapId, 0), claimer: maker, expiresAt: now() + 120 };
    if (tiers) q.tiers = [{ rate: 'holder', min: '1000000', spreadBps: 100, lamports: lamports - 100_000 }];
    rquotes.set(q.quoteId, q);
    return q;
  }
  function swap(i) {
    const q = take(quotes, i.quoteId);
    if (!q) { stats.registrations++; return { swapId: 'x' }; }
    if (!verifyShare(unhex(i.A), i.proofA, unhex(q.swapId), 0)) throw new Error('bad-share-proof');
    stats.registrations++; known.set(q.swapId, 'xmr-sol');
    const b = fixedB ?? randomScalar(), B = pub(b), swapId = unhex(q.swapId), t = now();
    const joint = moneroAddress(addPoints(unhex(i.A), B), pub(fromLE(unhex(i.v))), xmrNet);
    const pda = breakRule === 'wrong-pda' ? swapPda(new PublicKey(rnd(32)), swapId) : swapPda(makerKey, swapId);
    return { swapId: q.swapId, B: hex(B), proofB: breakRule === 'bad-proofB' ? { R: '00'.repeat(32), s: '00'.repeat(32) } : proveShare(b, swapId, 1), jointAddress: joint, pda: pda.toBase58(), refunder: maker,
      t0: t + (breakRule === 'bad-timelocks' ? 60 : 7200), t1: t + 14_400, lamports: q.lamports, lockSig: '5'.repeat(88), xmrAtomic: q.xmrAtomic };
  }
  function revSwap(i) {
    const q = take(rquotes, i.quoteId);
    if (!q) { stats.registrations++; return { swapId: 'x' }; }
    if (!verifyShare(unhex(i.B), i.proofB, unhex(q.swapId), 1)) throw new Error('bad-share-proof');
    stats.registrations++; known.set(q.swapId, 'sol-xmr');
    const t0 = now() + 10_800;
    const joint = moneroAddress(addPoints(unhex(q.A), breakRule === 'rev-bad-joint' ? pub(randomScalar()) : unhex(i.B)), pub(fromLE(unhex(i.v))), xmrNet);
    return { swapId: q.swapId, jointAddress: joint, t0, t1: t0 + 7200, lamports: q.lamports, xmrAtomic: q.xmrAtomic, claimer: maker, claimPoint: q.A, pda: atomicSwapPda(i.refunder, unhex(q.swapId)).toBase58() };
  }
  const server = http.createServer(async (req, res) => {
    stats.requests++; stats.log.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && (req.url === '/v1/swap' || req.url === '/v1/rev/swap')) stats.swapPosts++;
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 8192 && breakRule !== 'no-oversize-limit') throw new Error('too-large'); }
      if (req.method === 'POST' && token && req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });
      const input = body ? JSON.parse(body) : {};
      if ('tierOk' in input) stats.tierOkSeen++;
      if (req.method === 'POST' && req.url === '/v1/quote') return send(200, quote(input));
      if (req.method === 'POST' && req.url === '/v1/swap') return send(200, swap(input));
      if (req.method === 'POST' && req.url === '/v1/rev/quote') return send(200, revQuote(input));
      if (req.method === 'POST' && req.url === '/v1/rev/swap') return send(200, revSwap(input));
      if (req.method === 'GET' && req.url.startsWith('/v1/swap/') && known.has(req.url.slice(9))) return send(200, { swapId: req.url.slice(9), direction: known.get(req.url.slice(9)), jointAddress: 'x', lockSig: null, readySig: breakRule === 'ready-and-refund' ? 's' : null, refundSig: breakRule === 'ready-and-refund' ? 's' : null, xmrSendTxid: null, claimSig: null, done: null });
      if (req.method === 'GET' && req.url.startsWith('/v1/swap/')) return send(400, { error: breakRule === 'path-leak' ? "ENOENT: no such file or directory, open '/var/maker/swaps/00.json'" : 'not-found' });
      if (req.method === 'GET' && req.url === '/v1/status') { if (token && req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' }); return statusReadable ? send(200, { network, maker }) : send(200, { admission: 'open' }); }
      if (req.method === 'GET' && req.url === '/v1/health') return send(200, breakRule === 'health-shape' ? { ok: true, accepting: true, maker } : { ok: true, accepting: true, maker, limits: { maxXmrPerSwap: '0.050000000000', maxXmrPerDay: '0.300000000000', maxOpenSwaps: 3 }, solXmr });
      send(404, { error: 'not-found' });
    } catch (e) { send(400, { error: String(e.message ?? e) }); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, maker, stats, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) })));
}

/** In-process fake Solana JSON-RPC: answers getGenesisHash and getBalance only, and counts calls. No network. */
export function startFakeRpc({ genesis, balance = 5_000_000_000, garbage = false } = {}) {
  const stats = { calls: 0 };
  const server = http.createServer(async (req, res) => {
    stats.calls++;
    let body = ''; for await (const c of req) body += c;
    if (garbage) { res.writeHead(200); return res.end('not json'); }
    const { method, id } = JSON.parse(body);
    const result = method === 'getGenesisHash' ? genesis : method === 'getBalance' ? { context: { slot: 1 }, value: balance } : undefined;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result === undefined ? { jsonrpc: '2.0', id, error: { code: -32601, message: 'x' } } : { jsonrpc: '2.0', id, result }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, stats, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) })));
}
