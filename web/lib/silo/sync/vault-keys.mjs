/** Vault key and key slots for the Silo sync prototype.
 *
 * A random 256-bit vault key (VK) is created on the first device and never leaves a device in clear. Every synced
 * object is encrypted under subkeys derived from VK with HKDF-SHA256. VK itself is stored on the server only inside
 * "wrap slots": AES-256-GCM encryptions of VK under a key-encryption key (KEK) that the server never sees.
 *
 *  - passphrase slot: KEK = PBKDF2-SHA256, 600,000 iterations, 16-byte salt (the same KDF and parameters as the
 *    existing local envelope; no KDF change). The passphrase is NFC-normalized like local-envelope.mjs.
 *  - recovery slot:   KEK = HKDF-SHA256 over a random 160-bit recovery code shown once to the user.
 *  - prf slot:        KEK = HKDF-SHA256 over a WebAuthn PRF output (optional; only where the authenticator supports it).
 *
 * Slot associated data binds the slot to its account, vault, kind and KDF parameters, so a slot copied into another
 * vault or account, or a slot with altered parameters, fails authentication instead of opening. */
import {SILO_KDF_ITERATIONS} from '../local-envelope.mjs';
import {b64u, canonical, fromB64u, randomBytes, randomId, utf8, hex} from './codec.mjs';

export const SYNC_SLOT_VERSION = 1;
const RECOVERY_BYTES = 20;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function assertPassphrase(typed) {
  const passphrase = typeof typed === 'string' ? typed.normalize('NFC') : typed;
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 256) throw Error('Use a passphrase of 12–256 characters.');
  return passphrase;
}
async function passphraseKek(typed, salt, iterations) {
  if (iterations !== SILO_KDF_ITERATIONS) throw Error('sync-slot-params');
  const material = await crypto.subtle.importKey('raw', utf8(assertPassphrase(typed)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name: 'PBKDF2', salt, iterations, hash: 'SHA-256'}, material, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}
async function hkdfKek(secret, salt, info) {
  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name: 'HKDF', hash: 'SHA-256', salt, info: utf8(info)}, material, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}

/** 20 bytes as 32 Crockford base32 characters in groups of four. */
export function encodeCrockford20(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== RECOVERY_BYTES) throw Error('sync-code-length');
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xfff; bits += 8;
    while (bits >= 5) { out += CROCKFORD[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return out.match(/.{4}/g).join('-');
}
/** Two kinds of 160-bit code a person handles (security review round 1): the recovery code, which opens the vault and must
 * never reach another device, and the approval code a new device shows. Each is written with its kind as a word and ends
 * in two check characters computed over its kind and body, so the kind is known even if the word is dropped:
 *   RECOVERY-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-CC     APPROVE-XXXX-...-XXXX-CC
 * Only the 160-bit body derives keys. A recovery code issued before the kinds existed (32 characters, no word or check)
 * is still accepted as a recovery code, and only as one. */
export const CODE_KINDS = Object.freeze({recovery: {word: 'RECOVERY', seed: 7}, approval: {word: 'APPROVE', seed: 19}});
function codeCheck(body, kind) {
  let sum = CODE_KINDS[kind].seed * 31;
  for (let i = 0; i < body.length; i++) sum = (sum + (i + 1) * (CROCKFORD.indexOf(body[i]) + 1) * 17) % 1021;
  return CROCKFORD[(sum >>> 5) & 31] + CROCKFORD[sum & 31];
}
const codeError = (message, syncCode) => Object.assign(Error(message), {syncCode});
export function formatCode(bytes, kind) {
  if (!Object.hasOwn(CODE_KINDS, kind)) throw Error('sync-code-kind');
  const grouped = encodeCrockford20(bytes), body = grouped.replace(/-/g, '');
  return `${CODE_KINDS[kind].word}-${grouped}-${codeCheck(body, kind)}`;
}
/** The 20 body bytes of a code of `kind`, as typed (any case, spaces or dashes). A code of the other kind is refused with
 * a plain reason; a recovery code is never accepted where an approval code belongs. */
export function parseCode(text, kind) {
  if (!Object.hasOwn(CODE_KINDS, kind)) throw Error('sync-code-kind');
  let rest = String(text ?? '').trim().toUpperCase().replace(/^SILO[\s-]*/, ''), word = null;
  for (const [name, entry] of Object.entries(CODE_KINDS)) if (rest.startsWith(entry.word)) { word = name; rest = rest.slice(entry.word.length); break; }
  const clean = rest.replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (![...clean].every((c) => CROCKFORD.includes(c))) throw codeError('This code is not valid.', 'code-invalid');
  let found;
  if (clean.length === 34) {
    const body = clean.slice(0, 32), check = clean.slice(32);
    found = Object.keys(CODE_KINDS).find((name) => codeCheck(body, name) === check);
    if (!found || (word && word !== found)) throw codeError('This code is not valid. Check it for typing mistakes.', 'code-invalid');
    rest = body;
  } else if (clean.length === 32 && !word) { found = 'recovery'; rest = clean; } // issued before code kinds existed
  else throw codeError('This code is not valid.', 'code-invalid');
  if (found !== kind) throw found === 'recovery'
    ? codeError('This is your account recovery code. Never give it to another device or to anyone: it can open your account vault.', 'recovery-code-given')
    : codeError('This is a device approval code, not your account recovery code.', 'approval-code-given');
  const bytes = new Uint8Array(RECOVERY_BYTES);
  let bits = 0, value = 0, index = 0;
  for (const c of rest) {
    value = ((value << 5) | CROCKFORD.indexOf(c)) & 0xfff; bits += 5;
    if (bits >= 8) { bytes[index++] = (value >>> (bits - 8)) & 255; bits -= 8; }
  }
  return bytes;
}
/** 160 random bits, shown once. */
export function createRecoveryCode() {
  const bytes = randomBytes(RECOVERY_BYTES);
  try { return formatCode(bytes, 'recovery'); } finally { bytes.fill(0); }
}
export const parseRecoveryCode = (text) => parseCode(text, 'recovery');

const slotAad = (slot, binding) => utf8(canonical({v: slot.v, kind: slot.kind, kdf: slot.kdf, slotId: slot.slotId, accountId: binding.accountId, vaultId: binding.vaultId}));

async function kekFor(slot, secret) {
  const salt = fromB64u(slot.salt, 64);
  if (salt.length !== 16) throw Error('sync-slot-structure');
  if (slot.kind === 'passphrase' && slot.kdf?.name === 'PBKDF2-SHA256') return passphraseKek(secret, salt, slot.kdf.iterations);
  if (slot.kind === 'recovery' && slot.kdf?.name === 'HKDF-SHA256') return hkdfKek(parseRecoveryCode(secret), salt, 'silo-sync-recovery-kek-v1');
  if (slot.kind === 'prf' && slot.kdf?.name === 'HKDF-SHA256') {
    if (!(secret instanceof Uint8Array) || secret.length !== 32) throw Error('sync-prf-output');
    return hkdfKek(secret, salt, 'silo-sync-prf-kek-v1');
  }
  throw Error('sync-slot-params');
}

/** Wraps raw VK bytes for one slot. `secret` is the passphrase, the recovery code, or the 32-byte PRF output. */
export async function wrapVaultKey(rawVaultKey, kind, secret, binding, {credentialIdHash} = {}) {
  if (!(rawVaultKey instanceof Uint8Array) || rawVaultKey.length !== 32) throw Error('sync-vault-key');
  const slot = {
    v: SYNC_SLOT_VERSION, kind, slotId: randomId(8),
    kdf: kind === 'passphrase' ? {name: 'PBKDF2-SHA256', iterations: SILO_KDF_ITERATIONS} : {name: 'HKDF-SHA256'},
    salt: b64u(randomBytes(16)),
    ...(kind === 'prf' ? {credentialIdHash} : {}),
  };
  if (kind === 'prf' && !/^[a-f0-9]{64}$/.test(credentialIdHash ?? '')) throw Error('sync-prf-credential');
  const iv = randomBytes(12);
  const wrapped = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: slotAad(slot, binding)}, await kekFor(slot, secret), rawVaultKey);
  return {...slot, iv: b64u(iv), wrapped: b64u(new Uint8Array(wrapped))};
}

/** Returns raw VK bytes. Every failure (wrong secret, altered slot, slot from another vault) is the same error. */
export async function unwrapVaultKey(slot, secret, binding) {
  if (slot?.v !== SYNC_SLOT_VERSION || !['passphrase', 'recovery', 'prf'].includes(slot.kind)) throw Error('sync-slot-params');
  const kek = await kekFor(slot, secret);
  try {
    const iv = fromB64u(slot.iv, 64);
    const raw = new Uint8Array(await crypto.subtle.decrypt({name: 'AES-GCM', iv, additionalData: slotAad(slot, binding)}, kek, fromB64u(slot.wrapped, 128)));
    if (raw.length !== 32) throw Error();
    return raw;
  } catch { throw Object.assign(Error('The unlock secret is wrong, or the stored vault key was changed.'), {syncUnlock: 'auth'}); }
}

export const createVaultKeyBytes = () => randomBytes(32);

/** Non-extractable subkeys. The raw VK is zeroed by the caller after this resolves. */
export async function deriveVaultKeys(rawVaultKey, vaultId) {
  const base = await crypto.subtle.importKey('raw', rawVaultKey, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const salt = utf8(`silo-sync-vault:${vaultId}`);
  const aes = (info) => crypto.subtle.deriveKey({name: 'HKDF', hash: 'SHA-256', salt, info: utf8(info)}, base, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
  const hmac = (info) => crypto.subtle.deriveKey({name: 'HKDF', hash: 'SHA-256', salt, info: utf8(info)}, base, {name: 'HMAC', hash: 'SHA-256', length: 256}, false, ['sign', 'verify']);
  const check = hex(new Uint8Array(await crypto.subtle.deriveBits({name: 'HKDF', hash: 'SHA-256', salt, info: utf8('silo-sync-key-check-v1')}, base, 128)));
  return {
    vaultId,
    objectKey: await aes('silo-sync-object-v1'),
    manifestKey: await hmac('silo-sync-manifest-v1'),
    contentIdKey: await hmac('silo-sync-content-id-v1'),
    /** Public fingerprint of VK, safe to keep in local storage to detect a substituted vault. Not a secret. */
    keyCheck: check,
  };
}
