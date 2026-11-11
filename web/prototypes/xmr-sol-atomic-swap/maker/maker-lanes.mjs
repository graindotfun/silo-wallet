// Two lanes for the maker's HTTP surface (open maker endpoint, 11 Nov 2026).
//
// TOKEN lane: the Silo wallet through the Worker, which holds MAKER_API_TOKEN. Exactly as before.
// PUBLIC lane: the same POST routes without a token, OFF unless MAKER_PUBLIC_LANE=true. It has its own caps, taken out of the maker's
// totals (the MAX_* values stay the ceiling for both lanes together; the mainnet start gate still checks those totals), so the accounting keeps one
// lane from using a slot, a daily amount or float that belongs to the other. The process, wallet RPC, price feeds, journal and fee payer are shared. Pure functions only: no I/O, no clock except arguments.
import { createHash, randomBytes } from 'node:crypto';
import { limitInputs } from './maker-limits.mjs';
import { capsAdmission } from './maker-reverse.mjs';

export const laneOf = (s) => (s?.lane === 'public' ? 'public' : 'token');
export const BUILD_HASH = /^sha256:[0-9a-f]{64}$/;

/** The records that count for `lane`. With the public lane off there is one pool (every record), exactly as before the lanes existed. */
export const laneRecords = (records, lane, publicOn) => (publicOn ? records.filter((s) => laneOf(s) === lane) : records);

const bad = (name, why) => { throw new Error(`public-lane-config: ${name} ${why}`); };
function intVar(env, name, def, min, max) {
  const v = env[name];
  if (v === undefined || v === '') return def;
  if (!/^\d{1,9}$/.test(String(v))) bad(name, 'must be a whole number');
  const n = Number(v);
  if (n < min || n > max) bad(name, `must be between ${min} and ${max}`);
  return n;
}
function xmrVar(env, name, def) {
  const v = env[name];
  if (v === undefined || v === '') return def;
  if (!/^\d{1,6}(\.\d{1,12})?$/.test(String(v))) bad(name, 'must be a plain decimal XMR amount');
  const n = Number(v);
  if (!(n > 0)) bad(name, 'must be above zero');
  return BigInt(Math.round(n * 1e12));
}
const xmrText = (a) => (Number(a) / 1e12).toFixed(12);

/**
 * Validated public-lane settings. `total` = the maker's own ceilings { min, perSwap, perDay, open } (atomic bigint, open a number).
 * Disabled (the default) returns { enabled: false } and reads nothing else. Anything that is not a clean number, or that would leave the
 * token lane with nothing, throws, so the maker refuses to start rather than run with nonsense.
 */
export function parseLaneConfig(env, total) {
  const flag = env.MAKER_PUBLIC_LANE;
  if (flag === undefined || flag === '' || flag === 'false') return { enabled: false };
  if (flag !== 'true') bad('MAKER_PUBLIC_LANE', 'must be true or false');
  if (!(total.open >= 2)) bad('MAX_OPEN_SWAPS', 'must be at least 2 so the token lane keeps a slot');
  const maxOpen = intVar(env, 'MAKER_PUBLIC_MAX_OPEN', 1, 1, total.open - 1);
  const maxPerSwap = xmrVar(env, 'MAKER_PUBLIC_MAX_XMR_PER_SWAP', total.perSwap < 10_000_000_000n ? total.perSwap : 10_000_000_000n);   // default 0.01 XMR
  if (maxPerSwap > total.perSwap) bad('MAKER_PUBLIC_MAX_XMR_PER_SWAP', 'is above MAX_XMR_PER_SWAP');
  if (maxPerSwap < total.min) bad('MAKER_PUBLIC_MAX_XMR_PER_SWAP', 'is below MIN_XMR_PER_SWAP');
  const dailyDefault = total.perDay / 2n < maxPerSwap * 3n ? total.perDay / 2n : maxPerSwap * 3n;
  const maxPerDay = xmrVar(env, 'MAKER_PUBLIC_MAX_XMR_PER_DAY', dailyDefault);
  if (maxPerDay >= total.perDay) bad('MAKER_PUBLIC_MAX_XMR_PER_DAY', 'must be below MAX_XMR_PER_DAY so the token lane keeps a daily amount');
  if (maxPerDay < maxPerSwap) bad('MAKER_PUBLIC_MAX_XMR_PER_DAY', 'is below the per swap maximum');
  const floatXmr = xmrVar(env, 'MAKER_PUBLIC_MAX_FLOAT_XMR', maxPerSwap * BigInt(maxOpen));
  if (floatXmr < maxPerSwap) bad('MAKER_PUBLIC_MAX_FLOAT_XMR', 'is below the per swap maximum');
  const sourceHeader = (env.MAKER_PUBLIC_SOURCE_HEADER ?? '').toLowerCase();
  if (sourceHeader && !/^[a-z0-9-]{1,40}$/.test(sourceHeader)) bad('MAKER_PUBLIC_SOURCE_HEADER', 'must be a header name');
  const perSource = intVar(env, 'MAKER_PUBLIC_RATE_PER_SOURCE_PER_MIN', 0, 0, 6000);
  if (perSource > 0 && !sourceHeader) bad('MAKER_PUBLIC_RATE_PER_SOURCE_PER_MIN', 'needs MAKER_PUBLIC_SOURCE_HEADER (a trusted proxy header)');
  const cors = env.MAKER_PUBLIC_CORS_ORIGIN ?? '';
  if (cors && cors !== '*') { let u; try { u = new URL(cors); } catch { bad('MAKER_PUBLIC_CORS_ORIGIN', 'must be * or one origin'); } if (!/^https?:$/.test(u.protocol) || u.origin !== cors) bad('MAKER_PUBLIC_CORS_ORIGIN', 'must be * or one origin such as https://example.org'); }
  const unpaidOpen = intVar(env, 'MAKER_PUBLIC_MAX_UNPAID_OPEN', maxOpen, 1, maxOpen);
  const rate = (n, perMin, burst) => ({ perMin: intVar(env, `MAKER_PUBLIC_RATE_${n}_PER_MIN`, perMin, 1, 6000), burst: intVar(env, `MAKER_PUBLIC_RATE_${n}_BURST`, burst, 1, 600) });
  return {
    enabled: true, maxOpen, maxPerSwap, maxPerDay, floatXmr,
    maxUnpaidOpen: unpaidOpen, maxUnpaidPerAddress: intVar(env, 'MAKER_PUBLIC_MAX_UNPAID_PER_ADDRESS', 1, 1, 10), maxUnpaidPerDay: intVar(env, 'MAKER_PUBLIC_MAX_UNPAID_PER_DAY', 24, 1, 1000),
    maxBody: intVar(env, 'MAKER_PUBLIC_MAX_BODY', 4096, 256, 8192), maxConcurrent: intVar(env, 'MAKER_PUBLIC_MAX_CONCURRENT', 8, 1, 64), maxQuotes: intVar(env, 'MAKER_PUBLIC_MAX_QUOTES', 32, 1, 1000),
    walletQueueDepth: intVar(env, 'MAKER_PUBLIC_WALLET_QUEUE_DEPTH', 4, 1, 64), walletDeadlineMs: intVar(env, 'MAKER_PUBLIC_WALLET_DEADLINE_MS', 10000, 500, 60000),
    admissionQueueDepth: intVar(env, 'MAKER_PUBLIC_ADMISSION_QUEUE_DEPTH', 4, 1, 64), admissionDeadlineMs: intVar(env, 'MAKER_PUBLIC_ADMISSION_DEADLINE_MS', 10000, 500, 60000),
    rates: { quote: rate('QUOTE', 30, 10), swap: rate('SWAP', 10, 5), status: rate('STATUS', 120, 30) },
    sourceHeader: perSource > 0 ? sourceHeader : '', perSource, cors: cors || null,
  };
}

/** What /v1/health reports about the lane (absent when the lane is off, so an off maker answers exactly as before). */
export function laneHealth(pub, total) {
  return { enabled: true, maxOpenSwaps: pub.maxOpen, maxXmrPerSwap: xmrText(pub.maxPerSwap), maxXmrPerDay: xmrText(pub.maxPerDay), maxFloatXmr: xmrText(pub.floatXmr),
    tokenLaneOpenSwaps: total.open - pub.maxOpen, tokenLaneXmrPerDay: xmrText(total.perDay - pub.maxPerDay) };
}

/** The limits one lane is admitted against. Off: the maker's own caps untouched. On: public gets its own, token gets the rest of the totals. */
export function laneCaps(lane, base, pub) {
  if (!pub.enabled) return base;
  if (lane === 'public') return { ...base, maxPerSwapAtomic: pub.maxPerSwap, maxPerDayAtomic: pub.maxPerDay, maxOpen: pub.maxOpen, maxUnpaidOpen: pub.maxUnpaidOpen, maxUnpaidPerAddress: pub.maxUnpaidPerAddress, maxUnpaidPerDay: pub.maxUnpaidPerDay };
  return { ...base, maxOpen: base.maxOpen - pub.maxOpen, maxPerDayAtomic: base.maxPerDayAtomic - pub.maxPerDay };
}

/** The public lane's XMR-equivalent float in use: every public swap that is open and holds maker float. */
export const publicReserved = (records, isOpenCounted) => records.filter((s) => laneOf(s) === 'public' && isOpenCounted(s)).reduce((t, s) => t + BigInt(s.xmrAtomic), 0n);

/**
 * Float the token lane must leave alone: the part of the public lane's float that is not in use right now. Zero when the lane is off.
 * Subtract it from the Monero treasury (SOL to XMR) or convert it at the quote's price for the Solana balance (XMR to SOL).
 */
export function tokenHoldback(records, pub, isOpenCounted) {
  if (!pub.enabled) return 0n;
  const left = pub.floatXmr - publicReserved(records, isOpenCounted);
  return left > 0n ? left : 0n;
}

/**
 * ONE admission for a lane: its own open count, its own paid and unpaid counters (records of the other lane are not seen), and for the
 * public lane its float. Throws the same error codes as before. `base` is the maker's totals as capsAdmission takes them.
 */
export function laneAdmission({ lane, xmrAtomic, requester = null, records, isOpenCounted, base, pub, now }) {
  const mine = laneRecords(records, lane, pub.enabled);
  const l = limitInputs(mine, requester, { now, isOpenCounted });
  capsAdmission({ xmrAtomic, openCount: mine.filter(isOpenCounted).length, lockedTodayAtomic: l.lockedTodayAtomic, unpaid: l.unpaid, caps: laneCaps(lane, base, pub) });
  if (pub.enabled && lane === 'public' && publicReserved(records, isOpenCounted) + BigInt(xmrAtomic) > pub.floatXmr) throw new Error('busy-try-later');
  return true;
}

// ---- request rate and size bounds, public lane only ----
export function createBucket({ perMin, burst, now = Date.now }) {
  let tokens = burst, last = now();
  return { take() { const t = now(); tokens = Math.min(burst, tokens + ((t - last) * perMin) / 60000); last = t; if (tokens >= 1) { tokens -= 1; return { ok: true }; } return { ok: false, retryAfterS: Math.max(1, Math.ceil(((1 - tokens) * 60) / perMin)) }; } };
}

/** Optional per source limit, only with a trusted proxy header. Sources are hashed with a per process salt and live in memory only. */
export function createSourceLimiter({ header, perMin, now = Date.now, max = 4096 }) {
  const salt = randomBytes(16), seen = new Map();
  const key = (headers) => { const raw = String(headers[header] ?? '').split(',').pop().trim(); return createHash('sha256').update(salt).update(raw || 'unknown').digest('hex').slice(0, 24); };
  return { take(headers) {
    const k = key(headers); let b = seen.get(k);
    if (!b) { if (seen.size >= max) seen.delete(seen.keys().next().value); b = createBucket({ perMin, burst: Math.max(1, Math.min(perMin, 5)), now }); seen.set(k, b); }
    return b.take();
  }, size: () => seen.size };
}

/** Drops expired quotes (they hold the maker's secrets until used). Returns how many were dropped. */
export function pruneQuotes(map, nowSec) { let n = 0; for (const [id, q] of map) if (q.expiresAt < nowSec) { map.delete(id); n += 1; } return n; }
export const countLane = (map, lane) => { let n = 0; for (const q of map.values()) if (laneOf(q) === lane) n += 1; return n; };

/**
 * ONE ceiling on the quotes a lane holds, across both directions (Sol M2). The check and the reservation are ONE synchronous step, taken
 * before any await of a quote request, so parallel requests do not all pass the check and then insert past the ceiling. A reservation
 * counts like a stored quote until it is committed (the quote goes into its map in the same step) or released (any failure, closing, a
 * client that went away). Only the public lane has a ceiling; the token lane (bearer token, the Silo Worker) is unchanged.
 * `now` is seconds; `maps` are the quote maps of both directions.
 */
export function createQuoteStore({ maps, pub, now = () => Math.floor(Date.now() / 1000) }) {
  const held = { public: 0, token: 0 };
  return {
    reserve(lane) {
      const t = now();
      for (const m of maps) pruneQuotes(m, t);
      lane = lane === 'public' ? 'public' : 'token';
      if (lane === 'public' && pub.enabled && maps.reduce((n, m) => n + countLane(m, 'public'), 0) + held.public >= pub.maxQuotes) throw new Error('busy-try-later');
      held[lane] += 1;
      let live = true;
      const drop = () => { if (live) { live = false; held[lane] -= 1; } };
      return { commit(map, id, value) { drop(); map.set(id, value); }, release: drop };
    },
    held: (lane) => held[lane],
  };
}

/** The routes the public lane serves. Everything else needs the token. */
export function publicRoute(method, url) {
  if (method === 'POST') return { '/v1/quote': 'quote', '/v1/rev/quote': 'quote', '/v1/swap': 'swap', '/v1/rev/swap': 'swap' }[url] ?? null;
  if (method === 'GET' && typeof url === 'string' && /^\/v1\/swap\/[0-9a-f]{64}$/.test(url)) return 'status';
  return null;
}

/**
 * The public outcome states. They follow ONLY finalized Solana observations that the maker records independently of any Monero work
 * (s.pubSol, written by recordSolObservation in maker-core.mjs, or by finishIfFinal from the same proof), plus the Solana absence proof of
 * a quote that was never locked. The record's raw `done` is NOT what the status follows for a record that has pubSol: `done` is set only
 * after Monero recovery or sweep work, so reading it would show that work's progress (open until recovery completes) to anyone holding the
 * swap id.
 * - 'open'     : no finalized claim or refund observed yet;
 * - 'finished' : the escrow was claimed (finalized claim signature observed);
 * - 'refunded' : the escrow was refunded (finalized refund signature observed), whatever happened on the Monero side;
 * - 'closed'   : no escrow was ever locked (SOL to XMR, quote expired, proven absent at finalized), or a value this code does not know.
 * Only a record that finished BEFORE pubSol existed (no pubSol, `done` set) falls back to the closed table below, so old records keep
 * their answer; a record finalized by this code always has pubSol first.
 */
export const PUBLIC_OUTCOME = Object.freeze({
  completed: 'finished',
  refunded: 'refunded', 'refunded-before-send': 'refunded', 'xmr-recovered': 'refunded', 'xmr-never-relayed': 'refunded',
  'not-locked': 'closed',
});
export const publicOutcome = (done) => (done === null || done === undefined ? 'open' : Object.hasOwn(PUBLIC_OUTCOME, done) ? PUBLIC_OUTCOME[done] : 'closed');
const SOL_KIND = Object.freeze({ claimed: 'finished', refunded: 'refunded' });
export function publicState(s) {
  const k = s.pubSol?.kind;
  if (typeof k === 'string' && Object.hasOwn(SOL_KIND, k)) return SOL_KIND[k];
  if (s.done === 'not-locked') return 'closed';   // decided from the Solana absence proof alone
  if (s.pubSol === undefined || s.pubSol === null) return publicOutcome(s.done);   // legacy record (finished before pubSol existed) or still open
  return 'closed';
}

/**
 * What the public status route shows: progress, the on-chain signatures (public anyway) and a neutral outcome state (publicState). Not the
 * joint Monero address, not the Monero transaction id, no xmrSent and not the raw `done`. Every field is a Solana signature or a state derived
 * from finalized Solana observations recorded independently of Monero work, so identical Solana histories give the same response whether the
 * Monero recovery or sweep has completed, is pending or failed (regression in maker-lanes.test.mjs). claimSig in the forward direction is the
 * OBSERVED claim signature (it used to be copied only after the sweep succeeded). Not claimed: that the response is independent of the
 * maker's own Solana send timing (readySig, refundSig appear when the maker's own transaction is recorded), which is on chain anyway.
 * The swap id is a bearer lookup key: whoever holds it can read this view.
 */
export function publicSwapView(s) {
  const obs = s.pubSol && typeof s.pubSol.sig === 'string' ? s.pubSol : null;
  const claimSig = obs?.kind === 'claimed' ? obs.sig : (s.direction === 'sol-xmr' ? s.claimSig ?? null : null);   // reverse: the maker's own Solana claim, not Monero dependent
  const refundSig = obs?.kind === 'refunded' ? obs.sig : s.refundSig ?? null;
  return { swapId: s.swapId, direction: s.direction ?? 'xmr-sol', lockSig: s.lockSig ?? null, readySig: s.readySig ?? null, refundSig, claimSig, state: publicState(s) };
}

/** CORS headers for public responses, only when configured. Never allows the Authorization header. */
export function corsHeaders(pub, preflight = false) {
  if (!pub.enabled || !pub.cors) return {};
  const h = { 'access-control-allow-origin': pub.cors };
  if (pub.cors !== '*') h.vary = 'Origin';
  if (preflight) Object.assign(h, { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' });
  return h;
}
