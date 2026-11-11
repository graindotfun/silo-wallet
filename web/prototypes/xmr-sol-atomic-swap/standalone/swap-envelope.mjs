// Authenticated encryption of the standalone client's recovery file (finding 771-M1).
//
// What is protected: the whole payload (swap secrets, the shared private view key, the throwaway fee payer key, the relayable XMR transaction, addresses,
// maker URL, timestamps). What is NOT protected: the envelope header (format name, cipher, key derivation parameters and salt, nonce, the direction and the
// network name). The header is authenticated (it is the associated data of the cipher), so changing it makes the file fail to open; it is readable by anyone.
//
// Construction: passphrase -> scrypt (N 2^15, r 8, p 1 by default; the floor and the ceiling are enforced when a file is read) -> 32 byte key ->
// AES-256-GCM with a fresh random 96 bit nonce for every write. A wrong passphrase, a changed byte anywhere (header or ciphertext) and a truncated file all
// fail the same way, closed: no payload is returned and nothing falls back to plain text. This module never writes plain text.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

export const ENVELOPE_FORMAT = 'silo-standalone-swap-envelope/1';
export const CIPHER = 'aes-256-gcm';
export const KDF_DEFAULT = Object.freeze({ N: 1 << 15, r: 8, p: 1 });
export const KDF_FLOOR_N = 1 << 14;      // a file with a cheaper derivation than this is refused when read (no silent downgrade)
export const KDF_CEILING_N = 1 << 17;    // and one that asks for more memory than this is refused (a file must not be able to exhaust the machine)
export const PASSPHRASE_MIN_CHARS = 12;

export class EnvelopeError extends Error {
  constructor(code, message) { super(message); this.name = 'EnvelopeError'; this.code = code; }
}
const fail = (code, message) => { throw new EnvelopeError(code, message); };

const HEXN = (s, n) => typeof s === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(s);
const normalise = (passphrase) => {
  if (typeof passphrase !== 'string' || passphrase.length === 0) fail('passphrase-missing', 'A passphrase for the swap file is needed.');
  return Buffer.from(passphrase.normalize('NFKC'), 'utf8');
};
/** The authenticated, canonical header text. Field order is fixed so both sides build the same bytes. */
const aadOf = (h) => Buffer.from(JSON.stringify({ format: h.format, cipher: h.cipher, kdf: { name: h.kdf.name, N: h.kdf.N, r: h.kdf.r, p: h.kdf.p, salt: h.kdf.salt }, direction: h.direction, network: h.network }), 'utf8');

/**
 * A codec bound to one passphrase. The derived key is cached per salt, so a session derives once. `kdf` applies to files this codec creates; `minN` is the
 * floor it accepts when reading (tests lower both; the defaults are the ones a user gets).
 */
export function createEnvelopeCodec({ passphrase, kdf = KDF_DEFAULT, minN = KDF_FLOOR_N } = {}) {
  const pw = normalise(passphrase);
  const keys = new Map();
  let current = null;                                  // { salt, kdf } of the file this codec last opened or sealed
  const keyFor = (params, saltHex) => {
    const id = `${params.N}:${params.r}:${params.p}:${saltHex}`;
    if (!keys.has(id)) keys.set(id, scryptSync(pw, Buffer.from(saltHex, 'hex'), 32, { N: params.N, r: params.r, p: params.p, maxmem: 512 * 1024 * 1024 }));
    return keys.get(id);
  };
  const checkParams = (k) => {
    if (!k || k.name !== 'scrypt' || !Number.isSafeInteger(k.N) || !Number.isSafeInteger(k.r) || !Number.isSafeInteger(k.p) || !HEXN(k.salt, 32)) fail('envelope-malformed', 'The swap file header is malformed.');
    if ((k.N & (k.N - 1)) !== 0 || k.N < minN) fail('envelope-kdf-weak', 'The swap file asks for a key derivation that is weaker than this tool accepts.');
    if (k.N > KDF_CEILING_N || k.r !== 8 || k.p !== 1) fail('envelope-kdf-unsupported', 'The swap file asks for key derivation settings this tool does not support.');
  };
  return {
    /** Encrypts `payload` (any JSON value). `pub` = { direction, network } goes into the clear, authenticated header. */
    seal(payload, pub) {
      if (!current) { const p = { name: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p }; current = { kdf: { ...p, salt: randomBytes(16).toString('hex') } }; checkParams(current.kdf); }
      const header = { format: ENVELOPE_FORMAT, cipher: CIPHER, kdf: current.kdf, direction: String(pub?.direction ?? 'sol-xmr'), network: String(pub?.network ?? '') };
      const iv = randomBytes(12);
      const c = createCipheriv(CIPHER, keyFor(header.kdf, header.kdf.salt), iv);
      c.setAAD(aadOf(header));
      const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(payload), 'utf8')), c.final()]);
      return `${JSON.stringify({ ...header, iv: iv.toString('hex'), ciphertext: ct.toString('base64'), tag: c.getAuthTag().toString('hex') }, null, 2)}\n`;
    },
    /** Decrypts. Throws EnvelopeError on a wrong passphrase, any change, or an unknown format. Returns { payload, header }. */
    open(text) {
      const h = parseHeader(text);
      checkParams(h.kdf);
      try {
        const d = createDecipheriv(CIPHER, keyFor(h.kdf, h.kdf.salt), Buffer.from(h.iv, 'hex'));
        d.setAAD(aadOf(h)); d.setAuthTag(Buffer.from(h.tag, 'hex'));
        const plain = Buffer.concat([d.update(Buffer.from(h.ciphertext, 'base64')), d.final()]);
        current = { kdf: h.kdf };
        return { payload: JSON.parse(plain.toString('utf8')), header: { direction: h.direction, network: h.network } };
      } catch (e) {
        if (e instanceof EnvelopeError) throw e;
        return fail('envelope-decrypt-failed', 'The swap file could not be opened: the passphrase is wrong, or the file was changed. Nothing was read.');
      }
    },
  };
}

/** Parses and shape-checks the header without a passphrase. Throws EnvelopeError for anything that is not an envelope of this format (plain text included). */
export function parseHeader(text) {
  let h;
  try { h = JSON.parse(text); } catch { return fail('envelope-malformed', 'This is not a swap file written by this tool (it is not an encrypted envelope).'); }
  if (!h || typeof h !== 'object' || h.format !== ENVELOPE_FORMAT) return fail('envelope-format', 'This is not an encrypted swap file of a format this tool opens. Plain text swap files are not read.');
  if (h.cipher !== CIPHER || !h.kdf || typeof h.direction !== 'string' || typeof h.network !== 'string' || !HEXN(h.iv, 24) || !HEXN(h.tag, 32) || typeof h.ciphertext !== 'string') return fail('envelope-malformed', 'The swap file header is malformed.');
  return h;
}
/** The two things the header shows in the clear (they are authenticated when the file is opened, not before). */
export function peekHeader(text) { const h = parseHeader(text); return { direction: h.direction, network: h.network }; }
