/** Recovery ownership anchor (security review rounds 1 and 2, 18–19 October 2026).
 *
 * The server cannot verify anything encrypted under the vault key, so on its own it cannot tell a device that knows the
 * recovery code from one that only controls the email and waited out the recovery delay. Each vault therefore carries a
 * public Ed25519 key derived from its current recovery code (HKDF over the code's 160-bit body, bound to the vault id).
 * Only the public half reaches the server: at vault creation, and in the same compare-and-swap commit that replaces the
 * recovery slot. Replacing the code therefore replaces the anchor and erases every earlier proof; neither the old code, an
 * old recovery slot, nor a saved copy of the vault key can prove ownership afterwards (round 2: an anchor derived from
 * the vault key survived a code replacement, because the vault key does not change).
 *
 * A device that reached `recovered` proves it holds the current code by signing a short statement bound to its account,
 * device and vault. Until it does, it may only read ciphertext. The statement carries no time: replaying it can only
 * re-prove the same device, and only until the next code replacement. The private half is derived only while the code is
 * in hand (create, replacement, unlock with the code) and is zeroed straight after use; it is never stored.
 *
 * What a code replacement does not do: rotate the vault key. Anyone who already holds the vault key can still decrypt
 * ciphertext they can fetch, including data written after the replacement (a recovered device reads ciphertext after the
 * delay unless a device in use cancels it). This is a declared beta limitation until vault-key rotation exists. */
import {ed25519} from '@noble/curves/ed25519';
import {b64u, canonical, fromB64u, utf8} from './codec.mjs';
import {parseRecoveryCode} from './vault-keys.mjs';

export const AUTHORITY_PURPOSE = 'silo-recovery-proof-v2';
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

async function seed(recoveryCode, vaultId) {
  if (!/^[a-f0-9]{32}$/.test(vaultId ?? '')) throw Error('Recovery authority needs the vault id.');
  const body = parseRecoveryCode(recoveryCode);
  try {
    const material = await crypto.subtle.importKey('raw', body, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({name: 'HKDF', hash: 'SHA-256', salt: utf8('silo-recovery-authority-v2'), info: utf8(vaultId)}, material, 256));
  } finally { body.fill(0); }
}
/** The statement a recovered device signs: bound to its account, device and vault. */
export function authorityStatement({accountId, deviceId, vaultId}) {
  if (![accountId, deviceId, vaultId].every((id) => /^[a-f0-9]{32}$/.test(id ?? ''))) throw Error('Invalid authority statement.');
  return utf8(canonical({purpose: AUTHORITY_PURPOSE, accountId, deviceId, vaultId}));
}
/** Public anchor of a vault for one recovery code. */
export async function recoveryAuthorityPublicKey(recoveryCode, vaultId) {
  const secret = await seed(recoveryCode, vaultId);
  try { return b64u(ed25519.getPublicKey(secret)); } finally { secret.fill(0); }
}
/** Signs the recovery statement with the code-derived key. Returns {signature}. */
export async function signRecoveryProof(recoveryCode, {accountId, deviceId, vaultId}) {
  const secret = await seed(recoveryCode, vaultId);
  try { return {signature: b64u(ed25519.sign(authorityStatement({accountId, deviceId, vaultId}), secret))}; } finally { secret.fill(0); }
}
export const isAuthorityPublicKey = (value) => typeof value === 'string' && PUBLIC_KEY.test(value) && fromB64u(value, 32).length === 32;
/** Server side: true only for a well-formed signature by the vault's current anchor over this device's statement. */
export function verifyRecoveryProof(publicKey, {accountId, deviceId, vaultId, signature}) {
  try {
    if (!isAuthorityPublicKey(publicKey) || typeof signature !== 'string' || !SIGNATURE.test(signature)) return false;
    return ed25519.verify(fromB64u(signature, 64), authorityStatement({accountId, deviceId, vaultId}), fromB64u(publicKey, 32));
  } catch { return false; }
}
