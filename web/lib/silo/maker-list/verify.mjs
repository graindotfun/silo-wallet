// Signed maker list verifier (spec: docs/OPEN_MAKER_LIST.md).
// Pure functions. No network, no storage, no clock of its own: the caller passes `now` and `lastSeenVersion`.
// Plain .mjs so the wallet (browser) and the standalone CLI (Node) import the same file.
// Signature check: ed25519 from @noble/curves, the library lib/silo/atomic-swap/keys.mjs already uses.
import { ed25519 } from '@noble/curves/ed25519';

export const MAKER_LIST_FORMAT = 'silo-maker-list/1';
export const LIMITS = Object.freeze({
  payloadBytes: 65536, envelopeSignatures: 8, makers: 64, urlChars: 200, contactChars: 200,
  maxLifetimeMs: 90 * 24 * 3600 * 1000, clockSkewMs: 5 * 60 * 1000, maxSpreadBps: 2000, maxOpenSwaps: 1000, defaultMaxVersionJump: 50,
});
const NETWORKS = new Set(['mainnet-beta', 'devnet']);
const TOP_KEYS = ['format', 'version', 'issuedAt', 'expiresAt', 'network', 'programId', 'makers'];
const MAKER_KEYS = ['id', 'url', 'solanaAddress', 'caps', 'spreadBps', 'buildHash', 'buildHashStatus', 'contact'];
const CAP_KEYS = ['minXmr', 'maxXmrPerSwap', 'maxXmrPerDay', 'maxOpenSwaps'];
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameKeys = (o, keys) => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

const BAD_CHARS = /[^\x20-\x7e]/;
function stringsClean(v) {
  if (typeof v === 'string') return !BAD_CHARS.test(v);
  if (Array.isArray(v)) return v.every(stringsClean);
  if (isObj(v)) return Object.keys(v).every((k) => !BAD_CHARS.test(k) && stringsClean(v[k]));
  return true;
}

const refuse = (reason, detail, extra) => ({ ok: false, reason, detail, ...extra });

/** Strict standard base64 (with padding, no whitespace) to bytes, or null. */
export function decodeBase64(text) {
  if (typeof text !== 'string' || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  let bin;
  try { bin = atob(text); } catch { return null; }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
const hexBytes = (hex) => (typeof hex === 'string' && /^[0-9a-f]{64}$/.test(hex) ? Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16)) : null);

function base58Length(text) {
  let bytes = [];
  for (const ch of text) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return -1;
    for (let i = 0; i < bytes.length; i += 1) { carry += bytes[i] * 58; bytes[i] = carry & 255; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 255); carry >>= 8; }
  }
  for (const ch of text) { if (ch === '1') bytes.push(0); else break; }
  return bytes.length;
}
/** A Solana address: base58 that decodes to exactly 32 bytes. */
export const isSolanaAddress = (v) => typeof v === 'string' && v.length >= 32 && v.length <= 44 && base58Length(v) === 32;

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
function parseTime(v) {
  if (typeof v !== 'string' || !TIME.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(v.slice(0, 19)) ? ms : null;
}

/** Decimal XMR string ("0.05", at most 12 decimals, no sign, no exponent) to piconero BigInt, or null. */
export function xmrToPiconero(v) {
  if (typeof v !== 'string' || !/^\d{1,6}(\.\d{1,12})?$/.test(v)) return null;
  const [whole, frac = ''] = v.split('.');
  return BigInt(whole) * 10n ** 12n + BigInt(frac.padEnd(12, '0'));
}

/** Normalise a maker URL to origin plus path without a trailing slash, or null if unusable. Test mode allows http on localhost only. */
export function normalizeMakerUrl(value, { testMode = false, namesOnly = true } = {}) {
  if (typeof value !== 'string' || value.length > LIMITS.urlChars || /[\u0000- \u007f]/.test(value)) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.username || u.password || u.search || u.hash) return null;
  const host = u.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (u.protocol === 'http:') { if (!(testMode && local)) return null; }
  else if (u.protocol !== 'https:') return null;
  else if (!testMode && namesOnly && (local || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('['))) return null; // list entries: host names only
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

function parseMaker(m, i, testMode) {
  const where = `makers[${i}]`;
  if (!isObj(m) || !sameKeys(m, MAKER_KEYS)) return `${where} has missing or unknown fields`;
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,31}$/.test(m.id)) return `${where}.id is not a short lowercase id`;
  const url = normalizeMakerUrl(m.url, { testMode });
  if (!url) return `${where}.url must be a plain https URL`;
  if (!isSolanaAddress(m.solanaAddress)) return `${where}.solanaAddress is not a Solana address`;
  if (!isObj(m.caps) || !sameKeys(m.caps, CAP_KEYS)) return `${where}.caps has missing or unknown fields`;
  const min = xmrToPiconero(m.caps.minXmr), perSwap = xmrToPiconero(m.caps.maxXmrPerSwap), perDay = xmrToPiconero(m.caps.maxXmrPerDay);
  if (min === null || perSwap === null || perDay === null || min === 0n || min > perSwap || perSwap > perDay) return `${where}.caps amounts are invalid or out of order`;
  if (!Number.isInteger(m.caps.maxOpenSwaps) || m.caps.maxOpenSwaps < 1 || m.caps.maxOpenSwaps > LIMITS.maxOpenSwaps) return `${where}.caps.maxOpenSwaps is not an integer in range`;
  if (!Number.isInteger(m.spreadBps) || m.spreadBps < 0 || m.spreadBps > LIMITS.maxSpreadBps) return `${where}.spreadBps is not an integer from 0 to ${LIMITS.maxSpreadBps}`;
  if (m.buildHash !== null && !(typeof m.buildHash === 'string' && /^sha256:[0-9a-f]{64}$/.test(m.buildHash))) return `${where}.buildHash is not null or sha256:<64 hex>`;
  if (m.buildHashStatus !== 'not proven' && m.buildHashStatus !== 'proven') return `${where}.buildHashStatus must be "not proven" or "proven"`;
  if (m.buildHash === null && m.buildHashStatus !== 'not proven') return `${where} has no build hash but claims it is proven`;
  if (typeof m.contact !== 'string' || m.contact.length < 3 || m.contact.length > LIMITS.contactChars || /[\u0000-\u001f\u007f]/.test(m.contact)) return `${where}.contact is not short printable text`;
  return { id: m.id, url, solanaAddress: m.solanaAddress, caps: { ...m.caps }, spreadBps: m.spreadBps, buildHash: m.buildHash, buildHashStatus: m.buildHashStatus, contact: m.contact };
}

/** Build the keyId to public-key-bytes map, or null. Call it when the wallet or CLI loads its pins, and the verifier calls it again on every
 *  verify. A keyId may appear once, and one public key may appear under one keyId only: otherwise one signer would count twice toward the threshold. */
export function loadPinnedKeys(pinnedKeys) {
  if (!Array.isArray(pinnedKeys)) return null;
  const pins = new Map(), seen = new Set();
  for (const k of pinnedKeys) {
    const bytes = isObj(k) ? hexBytes(k.publicKey) : null;
    if (!bytes || typeof k.keyId !== 'string' || pins.has(k.keyId) || seen.has(k.publicKey)) return null;
    seen.add(k.publicKey);
    pins.set(k.keyId, bytes);
  }
  return pins;
}

/**
 * Verify a signed maker list envelope. Never throws on bad input; returns
 *   { ok: true, list, signedBy: [keyId, ...] }
 *   { ok: false, reason, detail, staleList? }   (staleList only for reason 'expired': a signature-checked and parsed list to show as stale)
 * Options:
 *   pinnedKeys      [{ keyId, publicKey: <64 hex> }, ...] compiled into the wallet / CLI
 *   threshold       distinct pinned keys that must sign (integer >= 1)
 *   now             milliseconds since epoch, from the caller
 *   lastSeenVersion highest version this client has accepted, or null
 *   network, programId  what this client is configured for
 *   testMode        allow http on localhost makers (tests and local rehearsal only)
 * Extra options: minVersion (lowest list version compiled into this release, closes fresh-install rollback), maxVersionJump (default 50, applied above 0 when nothing is remembered).
 * Rollback protection only works if the caller stores the highest accepted version and passes it back as lastSeenVersion; this file keeps no state.
 * Reasons: non-ascii, bad-characters, non-canonical, below-minimum, version-jump, bad-options, bad-envelope, payload-too-large, bad-base64, bad-signature-field, below-threshold, bad-json,
 *   unknown-format, bad-fields, wrong-network, wrong-program, rollback, not-yet-valid, expired, bad-maker, duplicate-maker.
 */
export function verifyMakerList(envelope, options = {}) {
  if (!isObj(options)) return refuse('bad-options', 'verifier options must be an object');
  const { pinnedKeys, threshold, now, lastSeenVersion = null, network, programId, testMode = false, minVersion = 0, maxVersionJump = LIMITS.defaultMaxVersionJump } = options;
  if (!Array.isArray(pinnedKeys) || !Number.isInteger(threshold) || threshold < 1 || threshold > pinnedKeys.length || !Number.isFinite(now) || !NETWORKS.has(network) || !isSolanaAddress(programId)
    || !(lastSeenVersion === null || (Number.isInteger(lastSeenVersion) && lastSeenVersion >= 0)) || !Number.isInteger(minVersion) || minVersion < 0 || !Number.isInteger(maxVersionJump) || maxVersionJump < 1) return refuse('bad-options', 'verifier options are missing or invalid');
  const pins = loadPinnedKeys(pinnedKeys);
  if (!pins) return refuse('bad-options', 'pinned keys are malformed, repeat a keyId, or repeat one public key under two key ids');
  if (!isObj(envelope) || !sameKeys(envelope, ['payload', 'signatures']) || !Array.isArray(envelope.signatures)) return refuse('bad-envelope', 'envelope must be { payload, signatures }');
  if (typeof envelope.payload === 'string' && envelope.payload.length > Math.ceil(LIMITS.payloadBytes / 3) * 4) return refuse('payload-too-large', `payload is over ${LIMITS.payloadBytes} bytes`);
  const bytes = decodeBase64(envelope.payload);
  if (!bytes || bytes.length === 0) return refuse('bad-base64', 'payload is not strict base64');
  if (bytes.length > LIMITS.payloadBytes) return refuse('payload-too-large', `payload is over ${LIMITS.payloadBytes} bytes`);
  if (envelope.signatures.length === 0 || envelope.signatures.length > LIMITS.envelopeSignatures) return refuse('bad-signature-field', 'signature count is out of range');

  const signedBy = new Set();
  for (const s of envelope.signatures) {
    if (!isObj(s) || !sameKeys(s, ['keyId', 'alg', 'sig']) || typeof s.keyId !== 'string' || s.alg !== 'ed25519') return refuse('bad-signature-field', 'each signature must be { keyId, alg: "ed25519", sig }');
    const sig = decodeBase64(s.sig);
    if (!sig || sig.length !== 64) return refuse('bad-signature-field', 'sig is not 64 bytes of base64');
    const pub = pins.get(s.keyId);
    if (!pub || signedBy.has(s.keyId)) continue; // unknown key ids never count; a key counts once
    let good = false;
    try { good = ed25519.verify(sig, bytes, pub); } catch { good = false; }
    if (good) signedBy.add(s.keyId);
  }
  if (signedBy.size < threshold) return refuse('below-threshold', `${signedBy.size} valid pinned signatures, ${threshold} needed`);

  // Only after the signatures hold do we parse the payload.
  // Strict byte rules: printable ASCII only, so no raw control, direction-override or look-alike characters can be signed.
  for (const b of bytes) if (b < 0x20 || b > 0x7e) return refuse('non-ascii', 'payload must be printable ASCII');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let p;
  try { p = JSON.parse(text); } catch { return refuse('bad-json', 'payload is not JSON'); }
  if (!isObj(p)) return refuse('bad-json', 'payload is not a JSON object');
  // Escaped characters decode after parsing: scan every key and string again.
  if (!stringsClean(p)) return refuse('bad-characters', 'a key or value holds a control, format or direction-override character');
  // Canonical bytes: the signed bytes must equal the compact re-serialisation of what was parsed. This refuses duplicate keys,
  // number spellings such as 1e2 or 5.0, redundant escapes and any spacing, so two verifiers cannot read one payload two ways.
  if (JSON.stringify(p) !== text) return refuse('non-canonical', 'payload is not the compact canonical serialisation of its own content');
  if (p.format !== MAKER_LIST_FORMAT) return refuse('unknown-format', 'format is not silo-maker-list/1');
  if (!sameKeys(p, TOP_KEYS)) return refuse('bad-fields', 'payload has missing or unknown top-level fields');
  if (!Number.isSafeInteger(p.version) || p.version < 1) return refuse('bad-fields', 'version is not a positive integer');
  const issued = parseTime(p.issuedAt), expires = parseTime(p.expiresAt);
  if (issued === null || expires === null || expires <= issued || expires - issued > LIMITS.maxLifetimeMs) return refuse('bad-fields', 'issuedAt and expiresAt must be UTC times, in order, within 90 days');
  if (p.network !== network) return refuse('wrong-network', `list is for ${String(p.network)}, this client is on ${network}`);
  if (p.programId !== programId) return refuse('wrong-program', 'list is for a different swap program');
  if (!Array.isArray(p.makers) || p.makers.length > LIMITS.makers) return refuse('bad-fields', `makers must be an array of at most ${LIMITS.makers}`);
  if (p.version < minVersion) return refuse('below-minimum', `list version ${p.version} is below the ${minVersion} shipped with this release`);
  if (lastSeenVersion !== null && p.version < lastSeenVersion) return refuse('rollback', `list version ${p.version} is older than the ${lastSeenVersion} already accepted`);
  const floor = Math.max(lastSeenVersion ?? 0, minVersion);
  // With no remembered version and no compiled minimum the floor is 0, so a first list is still bounded by maxVersionJump.
  if (p.version > floor + maxVersionJump) return refuse('version-jump', `list version ${p.version} jumps more than ${maxVersionJump} above ${floor}`);

  const makers = [], ids = new Set(), urls = new Set();
  for (let i = 0; i < p.makers.length; i += 1) {
    const m = parseMaker(p.makers[i], i, testMode);
    if (typeof m === 'string') return refuse('bad-maker', m);
    if (ids.has(m.id) || urls.has(m.url)) return refuse('duplicate-maker', `makers[${i}] repeats an id or URL`);
    ids.add(m.id); urls.add(m.url); makers.push(m);
  }
  const list = { format: p.format, version: p.version, issuedAt: p.issuedAt, expiresAt: p.expiresAt, network: p.network, programId: p.programId, makers };
  if (issued > now + LIMITS.clockSkewMs) return refuse('not-yet-valid', 'list is dated in the future');
  if (now >= expires) return refuse('expired', 'list has expired; show it as stale', { staleList: list });
  return { ok: true, list, signedBy: [...signedBy].sort() };
}

/** Label a maker URL against a verified list. A label only: nothing here blocks a maker.
 *  Returns { classification: 'listed', maker } | { classification: 'unlisted' } | { classification: 'invalid-url' }. */
export function classifyMaker(url, list, { testMode = false } = {}) {
  const norm = normalizeMakerUrl(url, { testMode, namesOnly: false }); // a typed URL may be an IP: still https, still allowed, labelled unlisted
  if (!norm) return { classification: 'invalid-url' };
  const maker = Array.isArray(list?.makers) ? list.makers.find((m) => m.url === norm) : undefined;
  return maker ? { classification: 'listed', maker } : { classification: 'unlisted' };
}

/** A2: the escrow counterparty key must be the Solana address of the list entry the user chose. Accepts a base58 string or an
 *  object with toBase58(). Any other value, or an invalid address, is a refusal (false). */
export function makerMatchesEscrow(listEntry, counterpartyKey) {
  const key = typeof counterpartyKey === 'string' ? counterpartyKey : (typeof counterpartyKey?.toBase58 === 'function' ? counterpartyKey.toBase58() : null);
  return isObj(listEntry) && isSolanaAddress(listEntry.solanaAddress) && isSolanaAddress(key) && key === listEntry.solanaAddress;
}
