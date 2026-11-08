// SPDX-License-Identifier: AGPL-3.0-only
// Joint-key math and Monero address encoding for the XMR<->SOL swap prototype.
// Reuses audited @noble libraries (MIT). No hand-written curve arithmetic.
import { ed25519 } from '@noble/curves/ed25519';
import { keccak_256 } from '@noble/hashes/sha3';
const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

const Point = ed25519.ExtendedPoint;
export const L = ed25519.CURVE.n; // 2^252 + 27742317777372353535851937790883648493

export const toLE = (n) => { const b = new Uint8Array(32); let x = n; for (let i = 0; i < 32; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
export const fromLE = (b) => { let x = 0n; for (let i = 31; i >= 0; i--) x = (x << 8n) | BigInt(b[i]); return x; };
export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const unhex = (h) => { if (!/^([0-9a-f]{2})*$/i.test(h)) throw new Error('bad hex'); return new Uint8Array(h.match(/../g)?.map((x) => parseInt(x, 16)) ?? []); };

/** Uniform non-zero scalar mod l (reduce 64 random bytes, like sc_reduce). */
export function randomScalar() {
  for (;;) {
    const wide = randomBytes(64);
    let x = 0n; for (let i = 63; i >= 0; i--) x = (x << 8n) | BigInt(wide[i]);
    const s = x % L;
    if (s !== 0n) return s;
  }
}
export const pub = (s) => Point.BASE.multiply(s).toRawBytes();
export const addPoints = (p, q) => Point.fromHex(p).add(Point.fromHex(q)).toRawBytes();
export const addScalars = (a, b) => (a + b) % L;

/** Prime-order check: rejects points with a small-order (torsion) component. */
export function isPrimeOrder(pBytes) {
  const P = Point.fromHex(pBytes);
  return !P.equals(Point.ZERO) && P.isTorsionFree();
}

// ---- Monero base58 (block-wise, 8 bytes -> 11 chars) ----
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ENC_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];
function encodeBlock(block) {
  let n = 0n; for (const byte of block) n = (n << 8n) | BigInt(byte);
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  return out.padStart(ENC_SIZES[block.length], '1');
}
export function moneroBase58(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8) out += encodeBlock(bytes.subarray(i, Math.min(i + 8, bytes.length)));
  return out;
}

export const NETWORK_PREFIX = { mainnet: 18, testnet: 53, stagenet: 24 };

/** Standard address from public spend + public view keys. */
export function moneroAddress(spendPub, viewPub, network = 'stagenet') {
  const prefix = NETWORK_PREFIX[network];
  if (prefix === undefined || prefix > 127) throw new Error('unsupported network');
  const body = new Uint8Array([prefix, ...spendPub, ...viewPub]);
  const check = keccak_256(body).subarray(0, 4);
  return moneroBase58(new Uint8Array([...body, ...check]));
}

// ---- Proof of knowledge of a key share (Schnorr, Fiat-Shamir, domain separated) ----
// Stops the rogue-key attack: without it, Bob could pick B = B' - A, so that he alone
// knows the discrete log of A + B and could take Alice's XMR. Bound to swap id and role.
import { sha512 } from '@noble/hashes/sha512';
const DOMAIN = new TextEncoder().encode('grain/xmr-sol-swap/share-pok/v1');
function challenge(swapId, role, P, R) {
  const h = sha512(new Uint8Array([...DOMAIN, ...swapId, role, ...P, ...R]));
  let x = 0n; for (let i = 63; i >= 0; i--) x = (x << 8n) | BigInt(h[i]);
  return x % L;
}
/** role: 0 = Alice (claim share), 1 = Bob (refund share). */
export function proveShare(x, swapId, role) {
  const P = pub(x), r = randomScalar(), R = pub(r);
  const c = challenge(swapId, role, P, R);
  return { R: hex(R), s: hex(toLE((r + c * x) % L)) };
}
export function verifyShare(Pbytes, proof, swapId, role) {
  if (!isPrimeOrder(Pbytes)) return false;
  const R = unhex(proof.R), s = fromLE(unhex(proof.s));
  if (s >= L || !isPrimeOrder(R)) return false;
  const c = challenge(swapId, role, Pbytes, R);
  if (s === 0n || c === 0n) return false; // negligible probability; noble rejects zero scalars
  return Point.BASE.multiply(s).equals(Point.fromHex(R).add(Point.fromHex(Pbytes).multiply(c)));
}
