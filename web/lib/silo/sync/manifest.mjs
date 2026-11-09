/** Authenticated vault manifests.
 *
 * A manifest names the exact ciphertext of every class at one revision, the previous manifest's hash, the writing
 * device, the lease epoch it wrote under and whether the write was an "action" (may add a new operation or change
 * keys/slots; requires the writer lease) or "evidence" (may only advance operations that already exist).
 * It is MACed with an HMAC key derived from the vault key, so the server cannot forge or edit one. The server can
 * still replay or withhold old manifests: freshness comes from the hash chain plus each device's local high-water
 * mark (see client.mjs), not from the server's revision number alone. */
import {canonical, sameText, sha256Hex, b64u, utf8, fromB64u} from './codec.mjs';
import {SYNC_CLASSES} from './objects.mjs';

const KINDS = ['genesis', 'action', 'evidence'];

export async function slotsHash(slots) {
  return sha256Hex(canonical([...slots].map((slot) => ({...slot})).sort((a, b) => a.slotId < b.slotId ? -1 : 1)));
}

export async function signManifest(keys, body) {
  if (!KINDS.includes(body.kind) || body.vaultId !== keys.vaultId) throw Error('sync-manifest-kind');
  for (const cls of SYNC_CLASSES) if (!(cls in body.objects)) throw Error('sync-manifest-objects');
  const mac = b64u(new Uint8Array(await crypto.subtle.sign('HMAC', keys.manifestKey, utf8(canonical(body)))));
  return {body, mac, hash: await sha256Hex(canonical(body) + '.' + mac)};
}

/** Verifies MAC, hash, vault binding and (when given) chain continuity from `parent`. */
export async function verifyManifest(keys, manifest, {parent} = {}) {
  const {body, mac, hash} = manifest ?? {};
  if (!body || body.vaultId !== keys.vaultId || !KINDS.includes(body.kind) || !Number.isSafeInteger(body.revision) || body.revision < 0) throw Error('sync-manifest-structure');
  let ok = false;
  try { ok = await crypto.subtle.verify('HMAC', keys.manifestKey, fromB64u(mac, 64), utf8(canonical(body))); } catch { ok = false; }
  if (!ok) throw Error('sync-manifest-auth');
  if (!sameText(hash, await sha256Hex(canonical(body) + '.' + mac))) throw Error('sync-manifest-hash');
  if (parent !== undefined) {
    if (parent === null ? (body.revision !== 0 || body.parent !== null) : (body.revision !== parent.body.revision + 1 || body.parent !== parent.hash)) throw Error('sync-manifest-chain');
  }
  return manifest;
}

/** Short comparison code for the head a device sees. Two devices showing the same code see the same vault state. */
export function safetyCode(manifestHash) {
  return manifestHash.slice(0, 20).toUpperCase().match(/.{5}/g).join(' ');
}
