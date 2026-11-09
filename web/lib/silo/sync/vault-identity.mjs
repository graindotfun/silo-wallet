/** What a vault records at creation so a device recovered later knows exactly which histories it must read
 * (coverage.mjs) and from where:
 *   expectedSolanaOwner  the Solana wallet the vault acts for (native keyring address or the Silo Solana owner);
 *   xmrWallet            the Monero wallet's primary address (identity only — never keys);
 *   xmrBirthday          that wallet's restore height, the start of its history;
 *   solanaStartMarker    {owner, slot, signature|null}: a finalized slot when the vault was created and the owner's newest
 *                        finalized signature at that slot (null when the owner had none). Any owner row in an older slot, or
 *                        that signature, predates the vault (solana-history.mjs).
 * All are public identifiers. They are stored inside the encrypted profile, never in server metadata. Reading the marker is
 * a read-only RPC lookup; nothing is built, signed or sent. */
import {SILO_SOLANA_GENESIS} from '../solana-genesis.mjs';

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
// Monero primary addresses: mainnet '4…', stagenet '5…'; 95 base58 characters. Subaddresses ('8…', '7…') are not wallet identities.
const XMR_PRIMARY = {mainnet: /^4[1-9A-HJ-NP-Za-km-z]{94}$/, stagenet: /^5[1-9A-HJ-NP-Za-km-z]{94}$/};

export function assertSolanaStartMarker(marker, owner) {
  if (marker === null || marker === undefined) return null;
  if (!marker || typeof marker !== 'object' || Object.keys(marker).sort().join(',') !== 'owner,signature,slot' || marker.owner !== owner
    || !SOLANA_ADDRESS.test(marker.owner ?? '') || !Number.isSafeInteger(marker.slot) || marker.slot < 1
    || (marker.signature !== null && !SOLANA_SIGNATURE.test(marker.signature ?? ''))) throw Error('Solana start marker is invalid or names another owner.');
  return {owner: marker.owner, slot: marker.slot, signature: marker.signature};
}

export function assertVaultIdentity({expectedSolanaOwner = null, xmrWallet = null, xmrBirthday = null, solanaStartMarker = null, xmrNetwork = 'mainnet'} = {}) {
  if (expectedSolanaOwner !== null && !SOLANA_ADDRESS.test(expectedSolanaOwner)) throw Error('Solana owner is not an address.');
  if (xmrWallet !== null && !XMR_PRIMARY[xmrNetwork]?.test(xmrWallet)) throw Error('Monero wallet identity must be its primary address on the vault network.');
  if (xmrBirthday !== null && (!Number.isSafeInteger(xmrBirthday) || xmrBirthday < 0)) throw Error('Monero restore height is invalid.');
  if (solanaStartMarker !== null && solanaStartMarker !== undefined && expectedSolanaOwner === null) throw Error('A Solana start marker needs the Solana owner.');
  return {expectedSolanaOwner, xmrWallet, xmrBirthday, solanaStartMarker: assertSolanaStartMarker(solanaStartMarker, expectedSolanaOwner)};
}

/** Reads the start marker through the device's own reviewed RPC reader: `read(method, params)`. */
export async function readSolanaStartMarker({read, owner, network = 'mainnet-beta'}) {
  if (!SOLANA_ADDRESS.test(owner ?? '')) throw Error('Solana owner is not an address.');
  if (await read('getGenesisHash', []) !== SILO_SOLANA_GENESIS[network]) throw Error('Solana genesis differs.');
  const slot = await read('getSlot', [{commitment: 'finalized'}]);
  if (!Number.isSafeInteger(slot) || slot < 1) throw Error('Finalized slot unavailable.');
  const page = await read('getSignaturesForAddress', [owner, {commitment: 'finalized', minContextSlot: slot, limit: 1}]);
  if (!Array.isArray(page) || page.length > 1) throw Error('Malformed signature page.');
  const row = page[0];
  if (row !== undefined && (!SOLANA_SIGNATURE.test(row?.signature ?? '') || !Number.isSafeInteger(row.slot) || row.slot < 0)) throw Error('Malformed signature row.');
  // A row finalized after the anchor was read moves the marker forward with it: everything older still predates the vault.
  return assertSolanaStartMarker({owner, slot: Math.max(slot, row?.slot ?? 0), signature: row?.signature ?? null}, owner);
}

/** The same marker from the first page of the existing anchored activity read (solana-activity-read.mjs, served by the
 * same-origin activity route): its finalized anchor slot and the newest row at or below it. No extra RPC surface. */
export function solanaStartMarkerFromActivity(response, owner) {
  if (!response || response.owner !== owner || response.network !== 'mainnet-beta' || !Number.isSafeInteger(response.anchorSlot) || response.anchorSlot < 1 || !Array.isArray(response.rows)) throw Error('Activity answer does not establish a start marker.');
  const newest = response.rows[0];
  if (newest !== undefined && (!SOLANA_SIGNATURE.test(newest?.signature ?? '') || !Number.isSafeInteger(newest.slot) || newest.slot > response.anchorSlot)) throw Error('Activity answer does not establish a start marker.');
  return assertSolanaStartMarker({owner, slot: response.anchorSlot, signature: newest?.signature ?? null}, owner);
}
