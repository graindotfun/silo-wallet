/** Encrypted sync objects. The server stores only these ciphertexts and their sizes.
 *
 * Classes are separated so a small change never re-uploads the large scan cache and so each class has its own
 * merge rule (see merge.mjs):
 *   keys       recovery material (seed, engine) — immutable after creation; any difference is a conflict.
 *   journal    pending/unresolved payments, swaps and conversion orders — grow-only, never last-write-wins.
 *   xmr-state  birthday, account, issued/scanned subaddress high-water marks — monotone merge.
 *   profile    non-secret wallet expectations (expected Solana owner, target networks) — explicit replace only.
 *   devices    authenticated device registry (how each device was enrolled, by whom, removal) — grow-only.
 *   scan-cache the large Monero wallet cache, in content-addressed chunks — replaced only by a further-scanned copy.
 *
 * Every object is AES-256-GCM under the vault object key with a fresh 96-bit nonce. Associated data binds vault,
 * class and object id; the manifest binds the object's ciphertext hash, so a swapped, reordered or replayed
 * object is rejected. Plaintext is padded to a size bucket to blunt size-based inference. */
import {b64u, canonical, fromB64u, fromUtf8, hex, randomBytes, randomId, sha256Hex, utf8} from './codec.mjs';

export const SYNC_CLASSES = Object.freeze(['keys', 'journal', 'xmr-state', 'profile', 'devices', 'scan-cache']);
export const SYNC_UPLOAD_CLASSES=Object.freeze([...SYNC_CLASSES.filter(cls=>cls!=='scan-cache'),'scan-chunk']);
export const SYNC_MAX_OBJECT_BYTES = 16 * 1024 * 1024 + 64;
export const SYNC_DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

/** Next bucket: 1 KiB, doubling to 64 KiB, then 64 KiB multiples. */
export function paddedLength(length) {
  const needed = length + 4;
  if (needed <= 64 * 1024) { let size = 1024; while (size < needed) size *= 2; return size; }
  return Math.ceil(needed / (64 * 1024)) * 64 * 1024;
}
function pad(plain) {
  const out = new Uint8Array(paddedLength(plain.length));
  new DataView(out.buffer).setUint32(0, plain.length);
  out.set(plain, 4);
  return out;
}
function unpad(padded) {
  if (padded.length < 4) throw Error('sync-object-structure');
  const length = new DataView(padded.buffer, padded.byteOffset).getUint32(0);
  if (length > padded.length - 4 || paddedLength(length) !== padded.length) throw Error('sync-object-structure');
  return padded.subarray(4, 4 + length);
}
const objectAad = (vaultId, cls, objectId) => utf8(canonical({v: 1, vaultId, cls, objectId}));

async function sealBytes(keys, cls, objectId, plain) {
  const iv = randomBytes(12), padded = pad(plain);
  try {
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: objectAad(keys.vaultId, cls, objectId)}, keys.objectKey, padded));
    const body = new Uint8Array(12 + encrypted.length); body.set(iv); body.set(encrypted, 12);
    return {objectId, cls, ciphertext: b64u(body), sha256: await sha256Hex(body), bytes: body.length};
  } finally { padded.fill(0); }
}
async function openBytes(keys, ref, stored) {
  if (!stored || stored.objectId !== ref.id || stored.cls !== ref.cls) throw Error('sync-object-missing');
  const body = fromB64u(stored.ciphertext, SYNC_MAX_OBJECT_BYTES);
  if (body.length !== ref.bytes || await sha256Hex(body) !== ref.sha256) throw Error('sync-object-hash');
  let padded;
  try { padded = new Uint8Array(await crypto.subtle.decrypt({name: 'AES-GCM', iv: body.subarray(0, 12), additionalData: objectAad(keys.vaultId, ref.cls, ref.id)}, keys.objectKey, body.subarray(12))); }
  catch { throw Error('sync-object-auth'); }
  return unpad(padded).slice();
}

/** Seals a JSON class object. Returns {upload, ref}: upload goes to the server, ref goes into the manifest. */
export async function sealObject(keys, cls, value) {
  if (!SYNC_CLASSES.includes(cls) || cls === 'scan-cache') throw Error('sync-object-class');
  const plain = utf8(JSON.stringify(value));
  if (plain.length > SYNC_MAX_OBJECT_BYTES - 64) throw Error('sync-object-size');
  try {
    const upload = await sealBytes(keys, cls, randomId(16), plain);
    return {upload, ref: {cls, id: upload.objectId, sha256: upload.sha256, bytes: upload.bytes}};
  } finally { plain.fill(0); }
}
export async function openObject(keys, ref, stored) {
  const plain = await openBytes(keys, ref, stored);
  try { return JSON.parse(fromUtf8(plain)); } catch { throw Error('sync-object-parse'); } finally { plain.fill(0); }
}

/** Content id of a plaintext chunk: HMAC under a vault key, so equal chunks deduplicate but the server cannot
 * test a guessed plaintext. */
async function chunkId(keys, chunk) {
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', keys.contentIdKey, chunk))).slice(0, 32);
}

/** Splits the scan cache into content-addressed encrypted chunks. `known` is the set of chunk ids the server
 * already holds; those chunks are not sealed or uploaded again. */
export async function sealScanCache(keys, cache, {chunkBytes = SYNC_DEFAULT_CHUNK_BYTES, known = new Set()} = {}) {
  const plain = utf8(JSON.stringify(cache.data));
  const chunks = [], uploads = [], sealedHere = new Map();
  try {
    for (let offset = 0; offset < plain.length || offset === 0; offset += chunkBytes) {
      const part = plain.subarray(offset, offset + chunkBytes), id = await chunkId(keys, part);
      // A chunk repeated inside this cache reuses the ciphertext sealed a moment ago; one already on the server
      // is resolved against the previous manifest in scanCacheRef.
      if (sealedHere.has(id)) chunks.push(sealedHere.get(id));
      else if (known.has(id)) chunks.push({id, known: true});
      else {
        const upload = await sealBytes(keys, 'scan-chunk', id, part), ref = {id, sha256: upload.sha256, bytes: upload.bytes};
        uploads.push(upload); known.add(id); sealedHere.set(id, ref);
        chunks.push(ref);
      }
      if (!plain.length) break;
    }
    return {uploads, chunks, plainBytes: plain.length};
  } finally { plain.fill(0); }
}
/** `previous` supplies sha256/bytes for chunks the server already had. */
export function scanCacheRef(sealed, scannedHeight, previous = null) {
  const prior = new Map((previous?.chunks ?? []).map((chunk) => [chunk.id, chunk]));
  const chunks = sealed.chunks.map((chunk) => {
    if (!chunk.known) return chunk;
    const old = prior.get(chunk.id);
    if (!old) throw Error('sync-chunk-unknown');
    return {id: old.id, sha256: old.sha256, bytes: old.bytes};
  });
  return {cls: 'scan-cache', plainBytes: sealed.plainBytes, scannedHeight, chunks};
}
export async function openScanCache(keys, ref, fetchChunk) {
  if (!Number.isSafeInteger(ref?.plainBytes) || !Array.isArray(ref.chunks) || !ref.chunks.length) throw Error('sync-object-structure');
  const out = new Uint8Array(ref.plainBytes);
  let offset = 0;
  try {
    for (const chunk of ref.chunks) {
      const part = await openBytes(keys, {cls: 'scan-chunk', id: chunk.id, sha256: chunk.sha256, bytes: chunk.bytes}, await fetchChunk(chunk.id));
      if (await chunkId(keys, part) !== chunk.id || offset + part.length > out.length) throw Error('sync-chunk-order');
      out.set(part, offset); offset += part.length; part.fill(0);
    }
    if (offset !== out.length) throw Error('sync-chunk-missing');
    return JSON.parse(fromUtf8(out));
  } finally { out.fill(0); }
}
