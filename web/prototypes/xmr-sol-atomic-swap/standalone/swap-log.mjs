// The one logging boundary of the standalone client (finding 771-M3). Every line the library or the command line prints goes through `scrub`, and an
// error that did not come from this tool's own checks is never printed by its message: only a fixed public code is.
//
// scrub removes, in this order: every known secret string (endpoint URLs, tokens, passwords, the record passphrase) together with the secret parts of a
// secret URL; any URL that carries credentials, a query string or a long path; long hex strings and long base58 or base64 looking strings.
// Output that deliberately shows a public identifier (an address in the terms, the program id) uses `show`, which keeps those strings but still removes
// every known secret and every URL with credentials.
export const LONG_HEX = /\b[0-9a-fA-F]{32,}\b/g;
export const LONG_B58 = /[1-9A-HJ-NP-Za-km-z]{32,}/g;
export const LONG_B64 = /[A-Za-z0-9+/_-]{40,}={0,2}/g;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi;
const BEARER = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi;

function removeKnown(text, secrets) {
  let out = text;
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length < 4) continue;
    out = out.split(s).join('<hidden>');
    try {
      const u = new URL(s);
      if (u.username) out = out.split(u.username).join('<hidden>');
      if (u.password) out = out.split(u.password).join('<hidden>');
      if (u.search.length > 1) out = out.split(u.search).join('?<hidden>');
      if (u.pathname.length > 4) out = out.split(u.pathname).join('/<hidden>');
    } catch { /* not a URL */ }
  }
  return out;
}
function removeUrls(text, { strict }) {
  return text.replace(URL_RE, (m) => {
    let u; try { u = new URL(m.replace(/[.,;:]+$/, '')); } catch { return '<url>'; }
    // In show mode a plain host (no credentials, no query, short path) may stay, it is what the user typed into the terms.
    if (!strict && !u.username && !u.password && u.search.length <= 1 && u.pathname.length <= 8) return m;
    return '<url>';
  });
}
/** @param {{strict?: boolean}} [mode] strict (default): also removes long hex, base58 and base64 looking strings and every URL. */
export function scrub(message, secrets = [], { strict = true } = {}) {
  let out = removeKnown(String(message ?? ''), secrets);
  out = out.replace(BEARER, '$1 <hidden>');
  out = removeUrls(out, { strict });
  if (strict) out = out.replace(LONG_HEX, '<hex>').replace(LONG_B58, '<hidden>').replace(LONG_B64, '<hidden>');
  else out = out.replace(LONG_HEX, (m) => (m.length >= 64 && m.length !== 64 ? '<hex>' : m));   // show mode keeps 64 hex ids (a swap id), drops longer runs
  return out;
}

/** A fixed public code for an error that is not one of this tool's own refusals. The raw message is never part of it. */
export function publicErrorCode(e) {
  if (e && typeof e.code === 'string' && /^[a-z][a-z0-9-]{2,40}$/.test(e.code) && e.name === 'SwapRefusal') return e.code;
  const m = String(e?.message ?? '');
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError' || /time ?out|timed out|aborted/i.test(m)) return 'network-timeout';
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|fetch failed|socket|network|connect/i.test(m)) return 'network-unreachable';
  if (/wallet|monero|rpc|daemon|not synced|busy/i.test(m)) return 'service-error';
  if (/blockhash|slot|solana|simulation|transaction/i.test(m)) return 'solana-error';
  return 'unexpected-error';
}
/** What may be printed about any thrown value: SwapRefusal messages (written by this tool, scrubbed anyway), a fixed code for everything else. */
export function describeError(e, secrets = []) {
  if (e?.name === 'SwapRefusal') return scrub(e.message, secrets, { strict: true });
  return publicErrorCode(e);
}

/**
 * The boundary. `sink` is where text finally goes (console, a test array). `secrets` is read at every call, so secrets learned later are covered.
 * line(...)  strict: for phase lines, retries, warnings, errors.
 * show(...)  for lines that deliberately print public identifiers (terms, program id). Still removes secrets and credential URLs.
 */
export function createLogger({ sink = () => {}, secrets = () => [] } = {}) {
  const list = () => (typeof secrets === 'function' ? secrets() : secrets);
  return {
    line: (s) => sink(scrub(s, list(), { strict: true })),
    show: (s) => sink(scrub(s, list(), { strict: false })),
    error: (e) => sink(describeError(e, list())),
    /** The text of a driver view (its `notice` and `reason` come from the shared drivers and may carry a raw error message) made safe to hand to a caller. */
    view: (v) => (v && (typeof v.notice === 'string' || typeof v.reason === 'string') ? { ...v, ...(typeof v.notice === 'string' ? { notice: scrub(v.notice, list(), { strict: true }) } : {}), ...(typeof v.reason === 'string' ? { reason: scrub(v.reason, list(), { strict: true }) } : {}) } : v),
  };
}
