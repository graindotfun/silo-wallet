// Conformance checks for a swap maker endpoint (docs/OPEN_MAKER_PROTOCOL.md, section "Conformance suite").
// Safe by default: only GET /v1/health and quote requests. EVERY request to a registration route (POST /v1/swap, POST /v1/rev/swap), including a
// deliberately malformed one, runs only with allowRegistration set AND a passed network check (networkGuard); a maker that is faulty or hostile may
// record a swap from any such request, so no probe of those routes is "safe" and none is sent without the guard. A quote request is not free of effect either (a maker may reserve capacity), but it records no swap.
// A request that makes the maker record a swap (and, for XMR to SOL, lock SOL) runs only with allowRegistration set AND a passed network check (networkGuard: Solana genesis hash,
// the maker's own reported network, the maker's funded address), and that is for test-network makers only unless a second explicit flag is given.
// Every proof and every term check reuses the real client core (keys.mjs, alice-flow.mjs, bob-flow.mjs): no copy of any rule lives here.
import { PublicKey } from '@solana/web3.js';
import { verifyShare, unhex } from '../client/keys.mjs';
import { setProgramId } from '../client/sol.mjs';
import { newSwapRecord, swapRequest, acceptMakerLock } from '../client/alice-flow.mjs';
// The SOL to XMR user side lives only in the wallet copy today (see "Gaps" in the protocol doc).
import { newReverseRecord, reverseRegisterRequest, acceptMakerRegistration } from '../../../lib/silo/atomic-swap/bob-flow.mjs';

export const MAX_RESPONSE_BYTES = 16384;   // the Silo Worker refuses larger maker answers (lib/silo/atomic-server.mjs callMaker)
export const MAX_QUOTE_TTL_S = 600;
/** Solana genesis hashes (public constants). The registration guard classifies the RPC it is given by these and nothing else. */
export const GENESIS = { mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY' };
const TEST_NETWORKS = ['stagenet', 'devnet', 'testnet'];   // what a maker's own status may call a test network
const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
const DECIMAL12 = /^\d+\.\d{12}$/;
const isInt = (x) => Number.isSafeInteger(x);
const isBase58Key = (s) => { try { return typeof s === 'string' && new PublicKey(s).toBase58() === s; } catch { return false; } };
const fmtAtomic = (a) => { const s = a.toString().padStart(13, '0'); return `${s.slice(0, -12)}.${s.slice(-12)}`; };
const toAtomic = (xmrText) => { const [w, f = ''] = String(xmrText).split('.'); return BigInt(w) * 10n ** 12n + BigInt(f.padEnd(12, '0').slice(0, 12)); };
const randHex = (n) => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(n)), (x) => x.toString(16).padStart(2, '0')).join('');
const randomPubkey = () => new PublicKey(globalThis.crypto.getRandomValues(new Uint8Array(32))).toBase58();   // no secret key exists for it
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);
const errString = (res) => (typeof res.json?.error === 'string' ? res.json.error : null);
const refused = (res) => res.status >= 400 && res.status < 500 && typeof res.json?.error === 'string' && res.json.error.length > 0 && res.json?.quoteId === undefined && res.json?.swapId === undefined;
/** Optional tier fields (draft PR 769): absent is fine; when present each entry must be a holder rate strictly better for the user than the standard quote. */
function tiersOk(q, side) {
  if (q.tiers === undefined) return { ok: true, detail: 'no tiers (optional)' };
  if (!Array.isArray(q.tiers) || q.tiers.length > 8) return { ok: false, detail: 'tiers is not a short array' };
  for (const t of q.tiers) {
    const fine = t && t.rate === 'holder' && typeof t.min === 'string' && /^\d{1,13}$/.test(t.min) && Number.isFinite(t.spreadBps) && t.spreadBps >= 0 && t.spreadBps < q.spreadBps && isInt(t.lamports) && t.lamports > 0
      && (side === 'receive' ? t.lamports > q.lamports : t.lamports < q.lamports);
    if (!fine) return { ok: false, detail: 'a tier is malformed or not strictly better for the user' };
  }
  return { ok: true, detail: `${q.tiers.length} holder tier(s), each strictly better than the standard rate` };
}
/** Printed under every table. Passing proves the interface shape and the checks listed; it does not prove the maker is safe to use. */
export const SCOPE_NOTE = 'A pass means this maker answered these interface checks correctly. It does not show that its escrows, swap lifecycle, refunds or recovery work, or that the maker is honest, online or safe to use with real funds.';
const short = (x) => String(x).slice(0, 60);
const shortDetail = (x) => String(x).slice(0, 240);

/** One Solana JSON-RPC read against the RPC the operator named; returns the result or throws a short code (never the URL). */
async function rpcRead(rpcUrl, method, params, fetchImpl = fetch, timeoutMs = 20_000) {
  let res;
  try { res = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) }); }
  catch { throw new Error('rpc-unreachable'); }
  let j = null; try { j = JSON.parse(await res.text()); } catch { /* not JSON */ }
  if (res.status !== 200 || !j || j.error || j.result === undefined) throw new Error('rpc-bad-answer');
  return j.result;
}
/**
 * Fail-closed network check, run before ANY request that makes a maker record a swap (and, XMR to SOL, lock SOL). It does not trust the opt-in flag.
 * 1. The Solana RPC the operator names must answer getGenesisHash with a known hash: devnet or testnet, or mainnet only with allowMainnetRegistration.
 * 2. The maker's own operator status (GET /v1/status, token required) must report a network: stagenet/devnet/testnet, or mainnet only with the second flag,
 *    and mainnet-ness must agree with the RPC (a mismatch is refused either way).
 * 3. The maker's address must hold SOL on that RPC's network (independent corroboration: the status answer is self-reported by the endpoint).
 * Unreadable, unknown or missing answers refuse. Returns { ok, detail }.
 */
export async function networkGuard({ call, solanaRpc, allowMainnet = false, makerAddress, rpcFetch = fetch, timeoutMs }) {
  if (!solanaRpc) return { ok: false, detail: 'refused: --solana-rpc is required with --allow-registration, to confirm which Solana network this is' };
  let genesis;
  try { genesis = await rpcRead(solanaRpc, 'getGenesisHash', [], rpcFetch, timeoutMs); } catch (e) { return { ok: false, detail: `refused: could not read the Solana genesis hash (${e.message})` }; }
  const solNet = Object.entries(GENESIS).find(([, h]) => h === genesis)?.[0] ?? null;
  if (!solNet) return { ok: false, detail: 'refused: the Solana RPC reports an unknown genesis hash (not mainnet, devnet or testnet)' };
  const st = await call('GET', '/v1/status');
  const makerNet = st.status === 200 && typeof st.json?.network === 'string' ? st.json.network : null;
  if (!makerNet) return { ok: false, detail: `refused: the maker's network could not be read from /v1/status (status ${st.status}; it needs the operator token)` };
  if (!TEST_NETWORKS.includes(makerNet) && makerNet !== 'mainnet') return { ok: false, detail: `refused: the maker reports an unknown network "${short(makerNet)}"` };
  const anyMainnet = solNet === 'mainnet' || makerNet === 'mainnet';
  if (anyMainnet && !allowMainnet) return { ok: false, detail: `refused: MAINNET (Solana RPC ${solNet}, maker ${makerNet}). Registration on mainnet needs the second flag --allow-mainnet-registration` };
  if ((solNet === 'mainnet') !== (makerNet === 'mainnet')) return { ok: false, detail: `refused: network mismatch (Solana RPC ${solNet}, maker ${makerNet})` };
  let lamports;
  try { lamports = await rpcRead(solanaRpc, 'getBalance', [makerAddress, { commitment: 'confirmed' }], rpcFetch, timeoutMs); } catch (e) { return { ok: false, detail: `refused: could not read the maker's balance on the named Solana network (${e.message})` }; }
  const bal = lamports?.value;
  if (!(Number.isSafeInteger(bal) && bal > 0)) return { ok: false, detail: `refused: the maker address holds no SOL on the ${solNet} RPC you named, so it is not confirmed to run there` };
  if (makerNet === 'testnet') return { ok: false, detail: 'refused: a maker on "testnet" cannot be matched to a Monero network this suite verifies (stagenet or mainnet)' };
  const moneroNetwork = makerNet === 'mainnet' ? 'mainnet' : 'stagenet';   // the Monero address prefix the registration is checked against
  return { ok: true, moneroNetwork, detail: `Solana ${solNet} (genesis checked), maker reports ${makerNet}, maker address funded there, joint addresses checked as Monero ${moneroNetwork}${anyMainnet ? '; MAINNET allowed by the second flag' : ''}` };
}

/** One HTTP client; never logs headers, so the token cannot reach any output. */
export function makeClient({ baseUrl, token = null, fetchImpl = fetch, timeoutMs = 20_000 }) {
  const base = baseUrl.replace(/\/+$/, '');
  return async function call(method, path, { body, raw, auth = true } = {}) {
    const headers = {};
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    if (payload !== undefined) headers['content-type'] = 'application/json';
    if (auth && token) headers.authorization = `Bearer ${token}`;
    try {
      const res = await fetchImpl(base + path, { method, headers, body: payload, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, json, text, bytes: Buffer.byteLength(text) };
    } catch (e) { return { status: 0, json: null, text: '', bytes: 0, error: e?.name === 'TimeoutError' ? 'timeout' : 'connection-failed' }; }
  };
}

/**
 * Runs the suite. options: { makerUrl, token, fetchImpl, direction: 'both'|'forward'|'reverse', amount (decimal string), referencePrice (SOL per XMR),
 * maxDeviationBps, allowRegistration (false | 'stagenet' | 'devnet'), solanaRpc (URL, required with allowRegistration), allowMainnetRegistration (second flag, default false), rpcFetchImpl, waitTtl (bool), programId, timeoutMs, onResult }.
 * Returns { results: [{ id, group, level, status, detail }], maker }. status: pass | fail | warn | skip. A MUST that fails is 'fail'; a SHOULD that fails is 'warn'.
 */
export async function runConformance(options) {
  const o = { direction: 'both', maxDeviationBps: 500, allowRegistration: false, allowMainnetRegistration: false, waitTtl: false, ...options };
  const results = [];
  const rec = (id, group, level, ok, detail = '') => { const r = { id, group, level, status: ok === 'skip' ? 'skip' : ok ? 'pass' : level === 'MUST' ? 'fail' : 'warn', detail: shortDetail(detail) }; results.push(r); o.onResult?.(r); return ok === true; };
  const must = (id, group, ok, detail) => rec(id, group, 'MUST', ok, detail);
  const should = (id, group, ok, detail) => rec(id, group, 'SHOULD', ok, detail);
  const skip = (id, group, why) => rec(id, group, 'MUST', 'skip', why);
  const guard = async (id, group, fn) => { try { await fn(); } catch (e) { must(id, group, false, `check crashed: ${String(e?.message ?? e)}`); } };

  if (o.allowRegistration && !['stagenet', 'devnet'].includes(o.allowRegistration)) throw new Error('allowRegistration must be "stagenet" or "devnet"');
  if (o.programId) setProgramId(o.programId);
  const call = makeClient({ baseUrl: o.makerUrl, token: o.token, fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs });

  // ---- health ----
  const hres = await call('GET', '/v1/health', { auth: false });
  const h = hres.json;
  let health = null;
  await guard('health.shape', 'health', async () => {
    const lim = h?.limits;
    const ok = hres.status === 200 && h?.ok === true && typeof h.accepting === 'boolean' && isBase58Key(h.maker) && typeof h.solXmr === 'boolean'
      && DECIMAL12.test(lim?.maxXmrPerSwap ?? '') && DECIMAL12.test(lim?.maxXmrPerDay ?? '') && isInt(lim?.maxOpenSwaps) && lim.maxOpenSwaps > 0 && hres.bytes <= MAX_RESPONSE_BYTES;
    if (must('health.shape', 'health', ok, ok ? 'ok, accepting, maker, limits, solXmr present' : `status ${hres.status}${hres.error ? ' ' + hres.error : ''}, fields missing or wrong type`)) health = h;
  });
  if (!health) { return { results, maker: null }; }
  await guard('health.limits-order', 'health', async () => {
    must('health.limits-order', 'health', toAtomic(health.limits.maxXmrPerSwap) <= toAtomic(health.limits.maxXmrPerDay) && toAtomic(health.limits.maxXmrPerSwap) > 0n, 'per-swap cap is positive and not above the daily cap');
  });
  const capAtomic = toAtomic(health.limits.maxXmrPerSwap);
  const amount = o.amount ?? (capAtomic < 2_000_000_000n ? fmtAtomic(capAtomic) : '0.002000000000');
  const amountAtomic = toAtomic(amount);
  const makerAddress = health.maker;

  // ---- auth ----
  await guard('auth.bad-token', 'auth', async () => {
    const r = await call('POST', '/v1/quote', { body: { xmr: amount }, auth: false });
    should('auth.bad-token', 'auth', r.status === 401 || r.status === 403, r.status === 401 || r.status === 403 ? 'calls without a token are refused' : `calls without a token get ${r.status}: a public maker needs its own rate limits`);
  });
  const probe = await call('POST', '/v1/quote', { body: { xmr: amount } });
  if (probe.status === 401 || probe.status === 403) {
    must('auth.token-accepted', 'auth', false, 'the maker refused the supplied token (or none was supplied); set the token variable and retry');
    return { results, maker: makerAddress };
  }

  const wantForward = o.direction !== 'reverse', wantReverse = o.direction !== 'forward';

  // ---- generic refusals and routing ----
  await guard('route.unknown-path', 'http', async () => {
    const r = await call('GET', '/v1/does-not-exist', { auth: false });
    must('route.unknown-path', 'http', r.status === 404 && typeof r.json?.error === 'string', `status ${r.status}`);
  });
  await guard('status.unknown-id', 'http', async () => {
    const r = await call('GET', `/v1/swap/${randHex(32)}`, { auth: false });
    const ok = r.status >= 400 && r.status < 500 && typeof errString(r) === 'string';
    must('status.unknown-id', 'http', ok, ok ? `refused with ${r.status}` : `status ${r.status}`);
    should('status.error-has-no-path', 'http', ok && !/[\\/]/.test(errString(r)), ok && /[\\/]/.test(errString(r)) ? 'the error text contains a filesystem path' : 'error text is a short code');
  });

  // ---- XMR to SOL (maker locks SOL before the user acts) ----
  let fq = null;
  if (wantForward) {
    await guard('forward.quote.shape', 'forward-quote', async () => {
      const r = await call('POST', '/v1/quote', { body: { xmr: amount } });
      const q = r.json;
      const ok = r.status === 200 && HEX(32).test(q?.quoteId ?? '') && HEX(64).test(q?.swapId ?? '') && typeof q.xmrAtomic === 'string' && /^\d{1,18}$/.test(q.xmrAtomic)
        && isInt(q.lamports) && q.lamports > 0 && isInt(q.gasLamports) && q.gasLamports >= 0 && Number.isFinite(q.solPerXmr) && q.solPerXmr > 0
        && Number.isFinite(q.spreadBps) && q.spreadBps >= 0 && q.spreadBps < 10_000 && typeof q.priceSource === 'string' && q.priceSource.length > 0
        && isInt(q.confirmations) && q.confirmations >= 1 && q.confirmations <= 10 && isInt(q.expiresAt) && r.bytes <= MAX_RESPONSE_BYTES;
      if (must('forward.quote.shape', 'forward-quote', ok, ok ? 'fields, types and units as specified' : `status ${r.status}${errString(r) ? ' error ' + errString(r) : ''}, a field is missing or has the wrong type`)) fq = q;
    });
    if (fq) {
      await guard('forward.quote.amount', 'forward-quote', async () => { must('forward.quote.amount', 'forward-quote', BigInt(fq.xmrAtomic) === amountAtomic, 'xmrAtomic equals the requested amount'); });
      await guard('forward.quote.caps', 'forward-quote', async () => { must('forward.quote.caps', 'forward-quote', BigInt(fq.xmrAtomic) <= capAtomic, 'quote is within the per-swap cap the health endpoint reports'); });
      await guard('forward.quote.ttl', 'forward-quote', async () => { const ttl = fq.expiresAt - nowS(); must('forward.quote.ttl', 'forward-quote', ttl >= -30 && ttl <= MAX_QUOTE_TTL_S + 30, `expires in ${ttl} s (allowed: up to ${MAX_QUOTE_TTL_S} s, 30 s clock slack)`); });
      await guard('forward.quote.consistency', 'forward-quote', async () => {
        const expected = Math.floor(Number(fq.xmrAtomic) / 1e12 * fq.solPerXmr * (1 - fq.spreadBps / 10_000) * 1e9) - fq.gasLamports;
        must('forward.quote.consistency', 'forward-quote', Math.abs(fq.lamports - expected) <= 2, `lamports ${Math.abs(fq.lamports - expected) <= 2 ? 'match' : 'do not match'} xmr * solPerXmr * (1 - spread) - gas (within 2)`);
      });
      if (o.referencePrice) await guard('forward.quote.reference-price', 'forward-quote', async () => {
        const eff = fq.lamports / 1e9 / (Number(fq.xmrAtomic) / 1e12), dev = (o.referencePrice - eff) / o.referencePrice * 10_000, mk = Math.abs(fq.solPerXmr - o.referencePrice) / o.referencePrice * 10_000;
        must('forward.quote.reference-price', 'forward-quote', dev <= o.maxDeviationBps && mk <= o.maxDeviationBps, `user receives ${dev.toFixed(0)} bps below the reference; quoted market price differs by ${mk.toFixed(0)} bps (limit ${o.maxDeviationBps})`);
      });
      await guard('forward.quote.tiers', 'forward-quote', async () => { const t = tiersOk(fq, 'receive'); must('forward.quote.tiers', 'forward-quote', t.ok, t.detail); });
      await guard('forward.quote.unique-ids', 'forward-quote', async () => {
        const r = await call('POST', '/v1/quote', { body: { xmr: amount } });
        must('forward.quote.unique-ids', 'forward-quote', r.status === 200 && r.json?.quoteId !== fq.quoteId && r.json?.swapId !== fq.swapId, 'a second quote has a different quoteId and swapId');
      });
    }
    await guard('forward.quote.unknown-field', 'forward-quote', async () => {
      const r = await call('POST', '/v1/quote', { body: { xmr: amount, conformanceUnknownField: 1 } });
      must('forward.quote.unknown-field', 'forward-quote', r.status === 200 && HEX(32).test(r.json?.quoteId ?? ''), `an unknown request field is ignored (status ${r.status})`);
    });
    await guard('forward.quote.reject-wrong-types', 'forward-quote', async () => {
      const bad = [{}, { xmr: null }, { xmr: {} }, { xmr: 'abc' }, { xmr: '-1' }, { xmr: 0 }, { xmr: '0' }, { xmr: '1e400' }];
      const accepted = [];
      for (const b of bad) { const r = await call('POST', '/v1/quote', { body: b }); if (!refused(r)) accepted.push(JSON.stringify(b)); }
      must('forward.quote.reject-wrong-types', 'forward-quote', accepted.length === 0, accepted.length ? `accepted: ${accepted.join(' ')}` : `${bad.length} malformed amounts refused with a JSON error`);
    });
    await guard('forward.quote.reject-over-cap', 'forward-quote', async () => {
      const r = await call('POST', '/v1/quote', { body: { xmr: fmtAtomic(capAtomic * 2n) } });
      must('forward.quote.reject-over-cap', 'forward-quote', refused(r), refused(r) ? 'twice the per-swap cap is refused' : `status ${r.status}: an over-cap quote was issued`);
      should('forward.quote.over-cap-error', 'forward-quote', errString(r) === 'amount-outside-limits', `error text: ${errString(r)}`);
    });
    await guard('forward.quote.reject-bad-json', 'forward-quote', async () => {
      const r = await call('POST', '/v1/quote', { raw: '{"xmr": ' });
      must('forward.quote.reject-bad-json', 'forward-quote', refused(r), `status ${r.status}`);
    });
    await guard('forward.quote.reject-oversize', 'forward-quote', async () => {
      const r = await call('POST', '/v1/quote', { raw: JSON.stringify({ xmr: amount, pad: 'a'.repeat(65_536) }) });
      must('forward.quote.reject-oversize', 'forward-quote', r.status === 0 || refused(r), r.status === 0 ? 'connection closed on a 64 KiB body' : `status ${r.status}`);
    });
  }

  // ---- SOL to XMR (user locks SOL before the maker sends XMR) ----
  if (wantReverse) {
    if (!health.solXmr) {
      await guard('reverse.disabled', 'reverse-quote', async () => {
        const r = await call('POST', '/v1/rev/quote', { body: { xmr: amount } });
        must('reverse.disabled', 'reverse-quote', refused(r), 'health reports solXmr false: the reverse quote is refused');
        should('reverse.disabled-error', 'reverse-quote', errString(r) === 'direction-disabled', `error text: ${errString(r)}`);
      });
    } else {
      let rq = null;
      await guard('reverse.quote.shape', 'reverse-quote', async () => {
        const r = await call('POST', '/v1/rev/quote', { body: { xmr: amount } });
        const q = r.json;
        const ok = r.status === 200 && q?.direction === 'sol-xmr' && HEX(32).test(q.quoteId ?? '') && HEX(64).test(q.swapId ?? '') && typeof q.xmrAtomic === 'string' && /^\d{1,18}$/.test(q.xmrAtomic)
          && isInt(q.lamports) && q.lamports > 0 && Number.isFinite(q.solPerXmr) && q.solPerXmr > 0 && Number.isFinite(q.spreadBps) && q.spreadBps >= 0 && q.spreadBps < 10_000
          && typeof q.priceSource === 'string' && HEX(64).test(q.A ?? '') && HEX(64).test(q.proofA?.R ?? '') && HEX(64).test(q.proofA?.s ?? '') && isBase58Key(q.claimer) && isInt(q.expiresAt) && r.bytes <= MAX_RESPONSE_BYTES;
        if (must('reverse.quote.shape', 'reverse-quote', ok, ok ? 'fields, types and units as specified' : `status ${r.status}${errString(r) ? ' error ' + errString(r) : ''}, a field is missing or has the wrong type`)) rq = q;
      });
      if (rq) {
        await guard('reverse.quote.amount', 'reverse-quote', async () => { must('reverse.quote.amount', 'reverse-quote', BigInt(rq.xmrAtomic) === amountAtomic && BigInt(rq.xmrAtomic) <= capAtomic, 'xmrAtomic equals the request and is within the cap'); });
        await guard('reverse.quote.proof', 'reverse-quote', async () => { must('reverse.quote.proof', 'reverse-quote', verifyShare(unhex(rq.A), rq.proofA, unhex(rq.swapId), 0), 'the key share proof verifies against this swap id (client core verifyShare)'); });
        await guard('reverse.quote.claimer', 'reverse-quote', async () => { must('reverse.quote.claimer', 'reverse-quote', rq.claimer === makerAddress, 'the claimer is the address the health endpoint reports'); });
        await guard('reverse.quote.ttl', 'reverse-quote', async () => { const ttl = rq.expiresAt - nowS(); must('reverse.quote.ttl', 'reverse-quote', ttl >= -30 && ttl <= MAX_QUOTE_TTL_S + 30, `expires in ${ttl} s`); });
        await guard('reverse.quote.tiers', 'reverse-quote', async () => { const t = tiersOk(rq, 'pay'); must('reverse.quote.tiers', 'reverse-quote', t.ok, t.detail); });
        await guard('reverse.quote.fresh-share', 'reverse-quote', async () => {
          const r2 = await call('POST', '/v1/rev/quote', { body: { xmr: amount } });
          const ok = r2.status === 200 && r2.json?.A !== rq.A && r2.json?.swapId !== rq.swapId;
          must('reverse.quote.fresh-share', 'reverse-quote', ok, ok ? 'two quotes return different maker shares and swap ids' : 'a maker share or swap id was reused across quotes');
        });
        await guard('reverse.quote.consistency', 'reverse-quote', async () => {
          const expected = Math.ceil(Number(rq.xmrAtomic) / 1e12 * rq.solPerXmr * (1 + rq.spreadBps / 10_000) * 1e9);
          must('reverse.quote.consistency', 'reverse-quote', Math.abs(rq.lamports - expected) <= 2, `lamports ${Math.abs(rq.lamports - expected) <= 2 ? 'match' : 'do not match'} xmr * solPerXmr * (1 + spread) (within 2)`);
        });
        if (o.referencePrice) await guard('reverse.quote.reference-price', 'reverse-quote', async () => {
          const eff = rq.lamports / 1e9 / (Number(rq.xmrAtomic) / 1e12), dev = (eff - o.referencePrice) / o.referencePrice * 10_000, mk = Math.abs(rq.solPerXmr - o.referencePrice) / o.referencePrice * 10_000;
          must('reverse.quote.reference-price', 'reverse-quote', dev <= o.maxDeviationBps && mk <= o.maxDeviationBps, `user pays ${dev.toFixed(0)} bps above the reference; quoted market price differs by ${mk.toFixed(0)} bps (limit ${o.maxDeviationBps})`);
        });
      }
      await guard('reverse.quote.unknown-field', 'reverse-quote', async () => {
        const r = await call('POST', '/v1/rev/quote', { body: { xmr: amount, conformanceUnknownField: 1 } });
        must('reverse.quote.unknown-field', 'reverse-quote', r.status === 200 && r.json?.direction === 'sol-xmr', `an unknown request field is ignored (status ${r.status})`);
      });
      await guard('reverse.quote.reject-wrong-types', 'reverse-quote', async () => {
        const bad = [{}, { xmr: null }, { xmr: 'abc' }, { xmr: '-1' }, { xmr: 0 }];
        const accepted = [];
        for (const b of bad) { const r = await call('POST', '/v1/rev/quote', { body: b }); if (!refused(r)) accepted.push(JSON.stringify(b)); }
        must('reverse.quote.reject-wrong-types', 'reverse-quote', accepted.length === 0, accepted.length ? `accepted: ${accepted.join(' ')}` : `${bad.length} malformed amounts refused`);
      });
      await guard('reverse.quote.reject-over-cap', 'reverse-quote', async () => {
        const r = await call('POST', '/v1/rev/quote', { body: { xmr: fmtAtomic(capAtomic * 2n) } });
        must('reverse.quote.reject-over-cap', 'reverse-quote', refused(r), refused(r) ? 'twice the per-swap cap is refused' : `status ${r.status}: an over-cap quote was issued`);
      });
    }
  }

  // ---- registration (records a swap on the maker; stagenet and devnet only) ----
  let netGuard = null;
  if (o.allowRegistration) {
    // The flag is only a declaration. Before any registration POST the suite checks the network itself and refuses on any doubt (fail closed).
    netGuard = await networkGuard({ call, solanaRpc: o.solanaRpc, allowMainnet: o.allowMainnetRegistration === true, makerAddress, rpcFetch: o.rpcFetchImpl, timeoutMs: o.timeoutMs }).catch((e) => ({ ok: false, detail: `refused: network check crashed: ${String(e?.message ?? e)}` }));
    must('network.guard', 'network', netGuard.ok, netGuard.detail);
  }
  if (!o.allowRegistration || !netGuard.ok) {
    const why = !o.allowRegistration ? 'opt-in: --allow-registration stagenet|devnet with --solana-rpc' : 'skipped: the network check above failed, nothing was sent to a registration route';
    if (wantForward) { skip('forward.swap.unknown-quote', 'forward-register', `${why} (a registration route may record a swap even from a malformed request)`); skip('forward.register.terms', 'forward-register', `${why} (the maker locks SOL)`); }
    if (wantReverse && health.solXmr) { skip('reverse.swap.unknown-quote', 'reverse-register', `${why} (a registration route may record a swap even from a malformed request)`); skip('reverse.register.terms', 'reverse-register', `${why} (the maker records a swap)`); }
  } else {
    const network = netGuard.moneroNetwork;   // Monero address prefix used to verify the joint address, taken from the network the guard verified (stagenet unless a mainnet pair was allowed)
    if (wantForward) {
    await guard('forward.swap.unknown-quote', 'forward-register', async () => {
      // Invalid proofs on purpose, but a faulty maker may still record something: this runs only after the network guard passed.
      const junk = { quoteId: randHex(16), claimer: randomPubkey(), feePayer: randomPubkey(), A: '00'.repeat(32), proofA: { R: '00'.repeat(32), s: '00'.repeat(32) }, v: '00'.repeat(32) };
      const r = await call('POST', '/v1/swap', { body: junk });
      must('forward.swap.unknown-quote', 'forward-register', refused(r), refused(r) ? 'an unknown quote id is refused' : `status ${r.status}`);
      should('forward.swap.unknown-quote-error', 'forward-register', errString(r) === 'quote-expired', `error text: ${errString(r)}`);
    });
    if (o.waitTtl) await guard('forward.swap.expired-quote', 'forward-register', async () => {
      const r = await call('POST', '/v1/quote', { body: { xmr: amount } });
      if (r.status !== 200 || !isInt(r.json?.expiresAt)) return skip('forward.swap.expired-quote', 'forward-register', 'no quote to expire');
      const wait = Math.max(0, r.json.expiresAt - nowS() + 3) * 1000;
      await sleep(wait);
      const junk = { quoteId: r.json.quoteId, claimer: randomPubkey(), feePayer: randomPubkey(), A: '00'.repeat(32), proofA: { R: '00'.repeat(32), s: '00'.repeat(32) }, v: '00'.repeat(32) };
      const s = await call('POST', '/v1/swap', { body: junk });
      must('forward.swap.expired-quote', 'forward-register', refused(s), refused(s) ? 'an expired quote is refused' : `status ${s.status}`);
    });
    else skip('forward.swap.expired-quote', 'forward-register', 'needs --wait-ttl (waits for the quote to expire)');
    }
    if (wantReverse && health.solXmr) {
      await guard('reverse.swap.unknown-quote', 'reverse-register', async () => {
        const junk = { quoteId: randHex(16), refunder: randomPubkey(), B: '00'.repeat(32), proofB: { R: '00'.repeat(32), s: '00'.repeat(32) }, v: '00'.repeat(32) };
        const r = await call('POST', '/v1/rev/swap', { body: junk });
        must('reverse.swap.unknown-quote', 'reverse-register', refused(r), refused(r) ? 'an unknown quote id is refused' : `status ${r.status}`);
        should('reverse.swap.unknown-quote-error', 'reverse-register', errString(r) === 'quote-expired', `error text: ${errString(r)}`);
      });
    }
    if (wantForward) await guard('forward.register.terms', 'forward-register', async () => {
      const q = await call('POST', '/v1/quote', { body: { xmr: amount } });
      if (q.status !== 200) return must('forward.register.terms', 'forward-register', false, `no quote (status ${q.status})`);
      const r0 = newSwapRecord({ claimer: randomPubkey(), quote: q.json, network });   // throwaway key shares, held in memory only
      const reg = await call('POST', '/v1/swap', { body: swapRequest(r0) });
      const m = reg.json;
      const shape = reg.status === 200 && HEX(64).test(m?.swapId ?? '') && HEX(64).test(m?.B ?? '') && HEX(64).test(m?.proofB?.R ?? '') && HEX(64).test(m?.proofB?.s ?? '') && typeof m.jointAddress === 'string'
        && isBase58Key(m.pda) && isBase58Key(m.refunder) && isInt(m.t0) && isInt(m.t1) && isInt(m.lamports) && typeof m.xmrAtomic === 'string' && typeof m.lockSig === 'string' && m.lockSig.length > 0 && reg.bytes <= MAX_RESPONSE_BYTES;
      if (!must('forward.register.shape', 'forward-register', shape, shape ? 'fields and types as specified' : `status ${reg.status}${errString(reg) ? ' error ' + errString(reg) : ''}`)) return;
      let verdict = 'accepted';
      try { acceptMakerLock(r0, m); } catch (e) { verdict = String(e?.message ?? e); }   // timelocks, proofB, joint address, escrow address, amounts
      must('forward.register.terms', 'forward-register', verdict === 'accepted', verdict === 'accepted' ? 'client core acceptMakerLock accepts the registration' : `client core refuses: ${verdict}`);
      must('forward.register.refunder', 'forward-register', m.refunder === makerAddress, 'the escrow refunder is the address the health endpoint reports');
      const again = await call('POST', '/v1/swap', { body: swapRequest(r0) });
      must('forward.register.reuse', 'forward-register', refused(again), refused(again) ? 'the same quote id is refused the second time' : `status ${again.status}: a quote was used twice`);
      // Fresh secrets per swap: a second registration (own quote, own key shares) must not return the same maker share, joint address or swap id.
      const q2 = await call('POST', '/v1/quote', { body: { xmr: amount } });
      if (q2.status === 200) {
        const r2 = newSwapRecord({ claimer: randomPubkey(), quote: q2.json, network });
        const reg2 = await call('POST', '/v1/swap', { body: swapRequest(r2) });
        const fresh = reg2.status === 200 && reg2.json?.B !== m.B && reg2.json?.swapId !== m.swapId && reg2.json?.jointAddress !== m.jointAddress;
        must('forward.register.fresh-secrets', 'forward-register', fresh, fresh ? 'two registrations return different maker shares, swap ids and joint addresses' : `status ${reg2.status}: a maker share, swap id or address was reused`);
      } else skip('forward.register.fresh-secrets', 'forward-register', 'no second quote');
      // One action at a time: the public status never shows a ready and a refund together, and a new swap shows neither.
      const st = await call('GET', `/v1/swap/${m.swapId}`, { auth: false });
      const okst = st.status === 200 && st.json?.swapId === m.swapId && st.json?.direction === 'xmr-sol' && !(st.json.readySig && st.json.refundSig);
      must('forward.register.one-action', 'forward-register', okst, okst ? 'status shows no ready and refund together' : `status ${st.status}, wrong swap, or ready and refund both set`);
    });
    if (wantReverse && health.solXmr) await guard('reverse.register.terms', 'reverse-register', async () => {
      const q = await call('POST', '/v1/rev/quote', { body: { xmr: amount } });
      if (q.status !== 200) return must('reverse.register.terms', 'reverse-register', false, `no quote (status ${q.status})`);
      const r0 = newReverseRecord({ owner: randomPubkey(), quote: q.json, network });
      const reg = await call('POST', '/v1/rev/swap', { body: reverseRegisterRequest(r0) });
      const m = reg.json;
      const shape = reg.status === 200 && HEX(64).test(m?.swapId ?? '') && typeof m.jointAddress === 'string' && isInt(m.t0) && isInt(m.t1) && isInt(m.lamports) && typeof m.xmrAtomic === 'string' && isBase58Key(m.claimer) && HEX(64).test(m.claimPoint ?? '') && isBase58Key(m.pda) && reg.bytes <= MAX_RESPONSE_BYTES;
      if (!must('reverse.register.shape', 'reverse-register', shape, shape ? 'fields and types as specified' : `status ${reg.status}${errString(reg) ? ' error ' + errString(reg) : ''}`)) return;
      let verdict = 'accepted';
      try { acceptMakerRegistration(r0, m); } catch (e) { verdict = String(e?.message ?? e); }
      must('reverse.register.terms', 'reverse-register', verdict === 'accepted', verdict === 'accepted' ? 'client core acceptMakerRegistration accepts the registration' : `client core refuses: ${verdict}`);
      const st = await call('GET', `/v1/swap/${m.swapId}`, { auth: false });
      const okst = st.status === 200 && st.json?.swapId === m.swapId && st.json?.direction === 'sol-xmr' && !(st.json.readySig && st.json.refundSig);
      must('reverse.register.one-action', 'reverse-register', okst, okst ? 'status shows the swap and no ready and refund together' : `status ${st.status}, wrong swap, or ready and refund both set`);
      const again = await call('POST', '/v1/rev/swap', { body: reverseRegisterRequest(r0) });
      must('reverse.register.reuse', 'reverse-register', refused(again), refused(again) ? 'the same quote id is refused the second time' : `status ${again.status}: a quote was used twice`);
    });
  }
  return { results, maker: makerAddress };
}

/** Plain pass/fail table. Contains check ids, levels and short details only. */
export function formatTable(results) {
  const w = Math.max(...results.map((r) => r.id.length), 2);
  const lines = [`${'RESULT'.padEnd(6)}  ${'LEVEL'.padEnd(6)}  ${'CHECK'.padEnd(w)}  DETAIL`];
  for (const r of results) lines.push(`${r.status.toUpperCase().padEnd(6)}  ${r.level.padEnd(6)}  ${r.id.padEnd(w)}  ${r.detail}`);
  const c = (s) => results.filter((r) => r.status === s).length;
  lines.push('', `pass ${c('pass')}  fail ${c('fail')}  warn ${c('warn')}  skip ${c('skip')}`);
  return lines.join('\n');
}
