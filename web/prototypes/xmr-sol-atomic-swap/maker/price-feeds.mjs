// Two independent public price sources and a sanity band (review 10 Nov 2026, SEC-P-07).
// Source 1: CoinGecko (same provider and ids as Silo's own feed). Source 2: Kraken public ticker (a different company and data path).
// The maker quotes only when BOTH answer, both are fresh, and they agree within the band. Otherwise it refuses with a clear code and locks nothing.
// Errors: price-config-invalid (a setting is not a finite number inside policy bounds), price-unavailable (a source is down, malformed or not positive), price-stale (a source's own timestamp is too old),
// prices-disagree (outside the band). The quote uses CoinGecko's number, as before; Kraken is the check.
export const DEFAULT_BAND_BPS = 300;       // 3 percent
export const DEFAULT_MAX_AGE_S = 300;      // CoinGecko reports when it last updated each coin
// 709-M3: fail closed. The settings must be finite numbers inside these policy bounds, else the maker refuses to quote (price-config-invalid);
// it never crashes and never falls back to "accept anything". A source timestamp more than MAX_FUTURE_S ahead of our clock is not fresh either.
export const BAND_BPS_LIMITS = [10, 1000];   // 0.1 to 10 percent
export const MAX_AGE_S_LIMITS = [30, 900];
export const MAX_FUTURE_S = 60;
const inRange = (v, [lo, hi]) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
export const validBand = (v) => inRange(v, BAND_BPS_LIMITS);
export const validMaxAge = (v) => inRange(v, MAX_AGE_S_LIMITS);
/** Settings from the environment; an unset value is the default, anything else must parse to a valid number or the config is invalid (checked at every quote). */
export function priceSettings(env = {}) {
  const num = (raw, d) => (raw === undefined ? d : raw === '' ? NaN : Number(raw));
  return { bandBps: num(env.PRICE_BAND_BPS, DEFAULT_BAND_BPS), maxAgeS: num(env.PRICE_MAX_AGE_S, DEFAULT_MAX_AGE_S) };
}

const get = async (fetcher, url, headers, timeoutMs) => {
  const r = await fetcher(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (r.ok === false) throw new Error('price-unavailable');
  return r.json();
};

export async function coingeckoPrice({ fetcher = fetch, apiKey, nowS = () => Date.now() / 1000, maxAgeS = DEFAULT_MAX_AGE_S, timeoutMs = 8000 } = {}) {
  if (!validMaxAge(maxAgeS)) throw new Error('price-config-invalid');
  const j = await get(fetcher, 'https://api.coingecko.com/api/v3/simple/price?ids=monero,solana&vs_currencies=usd&include_last_updated_at=true', apiKey ? { 'x-cg-demo-api-key': apiKey } : {}, timeoutMs);
  const xmr = j?.monero?.usd, sol = j?.solana?.usd;
  if (!(xmr > 0 && sol > 0 && Number.isFinite(xmr) && Number.isFinite(sol))) throw new Error('price-unavailable');
  const at = [j?.monero?.last_updated_at, j?.solana?.last_updated_at];
  if (!at.every((t) => Number.isFinite(t))) throw new Error('price-stale');   // no timestamp = cannot show it is fresh
  if (at.some((t) => nowS() - t > maxAgeS || t - nowS() > MAX_FUTURE_S)) throw new Error('price-stale');   // too old, or from the future
  return { source: 'coingecko', xmrUsd: xmr, solUsd: sol };
}

/** Kraken's ticker has no timestamp: a live answer is the freshness (a failed or empty answer refuses). */
export async function krakenPrice({ fetcher = fetch, timeoutMs = 8000 } = {}) {
  const j = await get(fetcher, 'https://api.kraken.com/0/public/Ticker?pair=XMRUSD,SOLUSD', {}, timeoutMs);
  if (Array.isArray(j?.error) && j.error.length) throw new Error('price-unavailable');
  const rows = Object.entries(j?.result ?? {});
  const last = (name) => Number(rows.find(([k]) => k.includes(name))?.[1]?.c?.[0]);
  const xmr = last('XMR'), sol = last('SOL');
  if (!(xmr > 0 && sol > 0 && Number.isFinite(xmr) && Number.isFinite(sol))) throw new Error('price-unavailable');
  return { source: 'kraken', xmrUsd: xmr, solUsd: sol };
}

/** Relative gap of the SOL per XMR rate, in basis points of the smaller rate's reference (symmetric: uses the mean). */
export function gapBps(a, b) {
  const ra = a.xmrUsd / a.solUsd, rb = b.xmrUsd / b.solUsd;
  return Math.abs(ra - rb) / ((ra + rb) / 2) * 10_000;
}

export function createPriceCheck({ fetchers, bandBps = DEFAULT_BAND_BPS } = {}) {
  const [primary, secondary] = fetchers;
  return async function price() {
    if (!validBand(bandBps)) throw new Error('price-config-invalid');   // checked on every quote: never accept anything because of a bad setting
    // Both are always asked; either failing (or being stale) refuses. A timeout in one never lets the other quote alone.
    const [a, b] = await Promise.allSettled([primary(), secondary()]);
    for (const r of [a, b]) if (r.status === 'rejected') throw new Error(['price-stale', 'price-unavailable', 'price-config-invalid'].includes(r.reason?.message) ? r.reason.message : 'price-unavailable');
    const gap = gapBps(a.value, b.value);
    if (!(gap <= bandBps)) throw Object.assign(new Error('prices-disagree'), { gapBps: Math.round(gap) });
    return { xmrUsd: a.value.xmrUsd, solUsd: a.value.solUsd, solPerXmr: a.value.xmrUsd / a.value.solUsd, check: { source: b.value.source, gapBps: Math.round(gap) } };
  };
}
