/** Small byte/JSON helpers for the Silo sync prototype. WebCrypto only; runs in browsers and Node 22+. */
const encoder = new TextEncoder(), decoder = new TextDecoder();
export const utf8 = (text) => encoder.encode(text);
export const fromUtf8 = (bytes) => decoder.decode(bytes);

export function b64u(bytes) {
  let raw = '';
  for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromB64u(text, maxBytes = 256 * 1024 * 1024) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length > Math.ceil(maxBytes * 4 / 3) + 4) throw Error('sync-encoding');
  const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
/** Canonical JSON: object keys sorted, no whitespace. Used for every MAC, hash and AES-GCM associated data. */
export function canonical(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}
export const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
export async function sha256Hex(input) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof input === 'string' ? utf8(input) : input)));
}
export const randomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));
export const randomId = (length = 16) => hex(randomBytes(length));
/** Constant-time comparison of equal-length strings (MACs, hashes). */
export function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
