import {canonicalTokenWebsite,TOKEN_WEBSITE_ORIGIN} from './token-website.mjs';
import {canonicalLaunchTweet} from './launch-post-link.mjs';

// This profile is intentionally unchanged until Gate 0 owner review. Selecting IPFS
// also requires two configured persistence service bindings; there is no fallback.
export const METADATA_STORAGE_PROFILE = 'http-mirror-v1';
export const RAW_BLOCK_LIMIT = 1_048_576;
const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';

export async function contentHash(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}

/** CIDv1, raw codec (0x55), SHA2-256 (0x12), 32-byte digest. No UnixFS wrapping. */
export function rawCid(hash) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw Error('Invalid content hash.');
  const bytes = [1, 0x55, 0x12, 32, ...hash.match(/../g).map(byte => parseInt(byte, 16))];
  let result = 'b', bits = 0, value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; result += alphabet[(value >>> bits) & 31]; }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}

export function rawCidHash(cid) {
  if (typeof cid !== 'string' || !/^b[a-z2-7]{58}$/.test(cid)) throw Error('Unsupported metadata CID.');
  let bits = 0, value = 0; const bytes = [];
  for (const char of cid.slice(1)) {
    value = (value << 5) | alphabet.indexOf(char); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
  }
  if (bytes.length !== 36 || bytes[0] !== 1 || bytes[1] !== 0x55 || bytes[2] !== 0x12 || bytes[3] !== 32) throw Error('Unsupported metadata CID.');
  const hash = bytes.slice(4).map(b => b.toString(16).padStart(2, '0')).join('');
  if (rawCid(hash) !== cid) throw Error('Noncanonical metadata CID.');
  return hash;
}

/** Only app-produced HTTP hashes or the reviewed raw-CID profile; never fetch a URI. */
export function metadataHashFromUri(uri, origin) {
  const prefix = origin + '/api/assets/';
  if (typeof uri === 'string' && uri.startsWith(prefix) && /^[a-f0-9]{64}$/.test(uri.slice(prefix.length))) return uri.slice(prefix.length);
  if (typeof uri === 'string' && uri.startsWith('ipfs://')) return rawCidHash(uri.slice(7));
  throw Error('Unsupported metadata architecture; coverage remains partial.');
}

/** Deterministic bytes shared by the signing client, publisher and offline export. */
export async function buildMetadataPublication(draft, imageBytes, origin, profile = METADATA_STORAGE_PROFILE) {
  // Publication URLs never inherit a preview or Worker hostname.
  origin=TOKEN_WEBSITE_ORIGIN;
  if (!['http-mirror-v1', 'ipfs-raw-v1'].includes(profile)) throw Error('Unsupported metadata storage profile.');
  if (!(imageBytes instanceof Uint8Array) || !imageBytes.length || imageBytes.length > 2_000_000) throw Error('Invalid image bytes.');
  if (profile === 'ipfs-raw-v1' && imageBytes.length > RAW_BLOCK_LIMIT) throw Error('The IPFS raw-block profile requires an image at most 1 MiB. Resize the image before signing.');
  if(draft.launchMode!==undefined&&(draft.launchMode!=='classic-sol-v1'||draft.quoteAsset!=='SOL'||draft.creatorBuy!==undefined||draft.declaredCreatorBuy!==undefined))throw Error('Classic SOL metadata must have no transfer tax or rewards purchase intent.');
  const imageHash = await contentHash(imageBytes), imageCid = rawCid(imageHash);
  const imageUri = profile === 'ipfs-raw-v1' ? 'ipfs://' + imageCid : `${origin}/api/assets/${imageHash}`;
  const website=draft.declaredCreatorBuy?.quote==='wXMR'?canonicalTokenWebsite(draft.mint,{official:true}):canonicalTokenWebsite(draft.mint);
  if(draft.website!==undefined&&draft.website!==''&&draft.website!==website)throw Error('Token website cannot be overridden.');
  if(draft.creatorBuy!==undefined){
    // Metadata/hash readers must not eagerly evaluate the Solana SDK. Initialize
    // its browser prerequisite before loading the optional purchase validator.
    await import('./browser-buffer.mjs');
    const {assertPublicCreatorBuyIntent}=await import('./public-creator-buy.mjs');
    assertPublicCreatorBuyIntent(draft.creatorBuy);
  }
  const launchTweet=canonicalLaunchTweet(draft.launchTweet);
  const links = { website, ...(draft.twitter ? { twitter: draft.twitter } : {}), ...(draft.telegram ? { telegram: draft.telegram } : {}), ...(launchTweet?{launchTweet}:{}) };
  const metadata = {
    grainpad: {mint:draft.mint,...(draft.launchMode!==undefined?{launchMode:draft.launchMode,quoteAsset:draft.quoteAsset,transferTaxBps:0,holderRewards:false}:{}),...(draft.creatorBuy!==undefined?{creatorBuy:draft.creatorBuy}:{}),...(draft.declaredCreatorBuy !== undefined ? {declaredCreatorBuy: draft.declaredCreatorBuy, quoteAsset: draft.quoteAsset} : {})},
    name: draft.name.trim(), symbol: draft.symbol.trim(), description: draft.description.trim(), image: imageUri,
    external_url: website, ...links,
    ...(Object.keys(links).length ? { extensions: links } : {}),
    properties: { category: 'image', files: [{ uri: imageUri, type: draft.imageType }] },
  };
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const metadataHash = await contentHash(metadataBytes), metadataCid = rawCid(metadataHash);
  const uri = profile === 'ipfs-raw-v1' ? 'ipfs://' + metadataCid : `${origin}/api/assets/${metadataHash}`;
  return { profile, uri, imageUri, imageHash, metadataHash, metadata, blocks: [
    { kind: 'image', cid: imageCid, hash: imageHash, type: draft.imageType, bytes: imageBytes },
    { kind: 'metadata', cid: metadataCid, hash: metadataHash, type: 'application/json', bytes: metadataBytes },
  ] };
}

export function assertPublicationBinding(draft, publication) {
  if (publication.profile === 'ipfs-raw-v1' || draft.storageProfile !== undefined) {
    if (draft.storageProfile !== publication.profile || draft.metadataUri !== publication.uri || draft.imageUri !== publication.imageUri) throw Error('Signed metadata storage profile or URI changed. Sign a fresh draft.');
  }
}

/** Registration rechecks stored bytes against the actual on-chain URI. Legacy HTTP
 * claims remain readable; accepting IPFS requires a bound publication and replicas.
 */
export async function assertMetadataClaim(claim, hash, uri, origin) {
  if (metadataHashFromUri(uri, origin) !== hash || await contentHash(new TextEncoder().encode(JSON.stringify(claim.metadata))) !== hash) throw Error('Stored metadata bytes do not match the on-chain URI.');
  if ((claim.uri || `${origin}/api/assets/${hash}`) !== uri) throw Error('On-chain metadata URI does not match this signed upload.');
  if (uri.startsWith('ipfs://')) {
    const imageHash = metadataHashFromUri(claim.metadata.image, origin);
    if (claim.metadata.image !== 'ipfs://' + rawCid(imageHash)) throw Error('Permanent metadata must also address its image independently of the Grainpad domain.');
    const proof = claim.persistence, providers = proof?.observations;
    if (claim.profile !== 'ipfs-raw-v1' || claim.imageHash !== imageHash || !/^[a-f0-9]{64}$/.test(claim.signedPayloadHash || '') || proof?.uri !== uri || proof.status !== 'retrieved-and-hash-verified' || !Array.isArray(providers) || providers.length !== 2 || new Set(providers.map(p => p.provider)).size !== 2) throw Error('Content-addressed publication lacks its signed persistence proof.');
    for (const provider of providers) {
      for (const required of [hash, imageHash]) {
        if (!provider.blocks?.some(b => b.sha256 === required && b.cid === rawCid(required) && b.provider === provider.provider && Number.isFinite(Date.parse(b.verifiedAt)) && typeof b.retention === 'string' && b.retention.trim())) throw Error('Metadata persistence proof is incomplete.');
      }
    }
  }
  return claim.metadata;
}
