/** Adding a device by approval from an existing trusted device.
 *
 * 1. The new device creates an ECDH P-256 key pair (private key non-extractable, kept in its own storage) and posts
 *    the public key as an enrollment request.
 * 2. The new device shows an enrollment code: 160 bits of SHA-256 over the request id and its public key. The person
 *    carries the code to the existing device (types it or scans it). This is the out-of-band check: a server that
 *    swaps in its own key produces a request whose code does not match, and the existing device refuses.
 * 3. The existing device, after the person re-enters an unlock secret, encrypts a grant to that public key:
 *    ephemeral ECDH P-256 → HKDF-SHA256 → AES-256-GCM, with every identifier in the HKDF info and associated data.
 *    The grant carries the vault key and a checkpoint {revision, hash} of the head that registered the new device.
 * 4. The new device opens the grant, starts its high-water mark at the checkpoint and verifies it is in the
 *    authenticated device registry. Freshness is anchored by the approving device, not by first use of the server.
 *
 * This is the shape of HPKE (RFC 9180) built from WebCrypto primitives for the prototype. Production should use a
 * maintained HPKE implementation instead of this construction. */
import {b64u, canonical, fromB64u, sha256Hex, utf8} from './codec.mjs';
import {formatCode, parseCode} from './vault-keys.mjs';

const CURVE = {name: 'ECDH', namedCurve: 'P-256'};

export async function createEnrollmentKey() {
  const pair = await crypto.subtle.generateKey(CURVE, false, ['deriveBits']);
  return {privateKey: pair.privateKey, publicKey: b64u(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))};
}

export async function enrollmentCode(requestId, publicKey) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(`silo-enroll-v1:${requestId}:${publicKey}`)));
  return formatCode(digest.slice(0, 20), 'approval');
}
/** Accepts the approval code as typed (any case, spaces or dashes). Returns the canonical form or throws; a recovery code
 * is refused here with its own plain reason (vault-keys.mjs). */
export function normalizeEnrollmentCode(text) { return formatCode(parseCode(text, 'approval'), 'approval'); }

async function grantKey(privateKey, peerPublicKey, binding) {
  const peer = await crypto.subtle.importKey('raw', fromB64u(peerPublicKey, 128), CURVE, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({name: 'ECDH', public: peer}, privateKey, 256));
  try {
    const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({name: 'HKDF', hash: 'SHA-256', salt: utf8('silo-enroll-grant-v1'), info: utf8(canonical(binding))}, material, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
  } finally { shared.fill(0); }
}

/** binding: {requestId, deviceId, accountId, vaultId, devicePublicKey}. payload carries the raw vault key. */
export async function sealGrant(binding, payload) {
  const ephemeral = await crypto.subtle.generateKey(CURVE, false, ['deriveBits']);
  const ephemeralPublicKey = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey)));
  const full = {v: 1, ...binding, ephemeralPublicKey};
  const key = await grantKey(ephemeral.privateKey, binding.devicePublicKey, full);
  const iv = crypto.getRandomValues(new Uint8Array(12)), plain = utf8(JSON.stringify(payload));
  try {
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: utf8(canonical(full))}, key, plain));
    return {ephemeralPublicKey, ciphertext: b64u(iv) + '.' + b64u(ciphertext)};
  } finally { plain.fill(0); }
}

export async function openGrant(privateKey, binding, grant) {
  const full = {v: 1, ...binding, ephemeralPublicKey: grant.ephemeralPublicKey};
  const [iv, body] = String(grant.ciphertext).split('.');
  let plain;
  try {
    const key = await grantKey(privateKey, grant.ephemeralPublicKey, full);
    plain = new Uint8Array(await crypto.subtle.decrypt({name: 'AES-GCM', iv: fromB64u(iv, 16), additionalData: utf8(canonical(full))}, key, fromB64u(body, 8192)));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { throw Error('The approval could not be opened on this device.'); } finally { plain?.fill(0); }
}

export const publicKeyHash = (publicKey) => sha256Hex('silo-device-key-v1:' + publicKey);
