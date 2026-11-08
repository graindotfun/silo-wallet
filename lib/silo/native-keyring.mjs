// SPDX-License-Identifier: AGPL-3.0-only
import {VersionedTransaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { siloPassphraseProblem } from './passphrase-strength.mjs';
import { signTestNetworkTransaction as testNetworkSign } from './native-keyring-testnet.mjs';

/* Public core: Solana send and swap signing needs the release-ticket flow, which is not part of this repository. These
 * guards refuse, so signReviewedTransfer and signReviewedManaged cannot sign here. */
const consumeSiloNativeTransferTicket=()=>{throw Error('Solana send signing is not part of the public core.');};
const consumeSiloNativeManagedTicket=()=>{throw Error('Swap signing is not part of the public core.');};

const SCOPE = 'silo-native-keyring-v1';
const ITERATIONS = 600000;
const encoder = new TextEncoder();
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const random = count => crypto.getRandomValues(new Uint8Array(count));
const chains = chain => { if (!['solana', 'evm'].includes(chain)) throw Error('Unsupported native wallet chain.'); return chain; };
/** The envelope's network label. 'mainnet' is the product default and the only value outside test mode; 'devnet' is the
 * test-network profile (product decision), Solana only. The label is authenticated data, so an envelope opens only as
 * the network it was sealed for. */
const networks = (chain, network) => { if (network !== 'mainnet' && !(network === 'devnet' && chain === 'solana')) throw Error('Unsupported native wallet network.'); return network; };
const pass = value => {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256) throw Error('Use a passphrase of 12–256 characters.');
  return value.normalize('NFC');
};
const equal = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
function identity(chain, secret) {
  chains(chain);
  if (chain === 'solana') {
    if (secret.length !== 32) throw Error('Invalid Solana key.');
    const pair = nacl.sign.keyPair.fromSeed(secret);
    try { return bs58.encode(pair.publicKey); } finally { pair.secretKey.fill(0); }
  }
  if (secret.length !== 32 || !secp256k1.utils.isValidPrivateKey(secret)) throw Error('Invalid EVM key.');
  return `0x${hex(keccak_256(secp256k1.getPublicKey(secret, false).subarray(1)).subarray(12))}`;
}
function imported(chain, value) {
  chains(chain);
  if (typeof value !== 'string') throw Error('Invalid private key.');
  if (chain === 'evm') {
    if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(value)) throw Error('Use a 32-byte hexadecimal EVM private key.');
    const bytes = Uint8Array.from(value.replace(/^0x/, '').match(/../g), part => Number.parseInt(part, 16));
    try { identity(chain, bytes); return bytes; } catch (error) { bytes.fill(0); throw error; }
  }
  let bytes;
  try {
    if (value.length < 64 || value.length > 90) throw Error();
    bytes = bs58.decode(value);
    if (bytes.length !== 64 || bs58.encode(bytes) !== value) throw Error();
    const pair = nacl.sign.keyPair.fromSeed(bytes.subarray(0, 32));
    try { if (!equal(bytes, pair.secretKey)) throw Error(); } finally { pair.secretKey.fill(0); }
    return bytes.slice(0, 32);
  } catch { throw Error('Use a valid canonical 64-byte base58 Solana private key.'); }
  finally { bytes?.fill(0); }
}
const metadata = (chain, address, network = 'mainnet') => ({ scope: SCOPE, version: 1, chain, network: networks(chain, network), address, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, cipher: 'AES-256-GCM' });
async function derive(password, salt) {
  const bytes = encoder.encode(pass(password));
  try {
    const material = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally { bytes.fill(0); }
}
async function seal(chain, secret, password, network = 'mainnet') {
  const info = metadata(chain, identity(chain, secret), network), salt = random(16), iv = random(12);
  const plain = new Uint8Array(secret);
  try {
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(JSON.stringify(info)) }, await derive(password, salt), plain));
    return { ...info, salt: hex(salt), iv: hex(iv), ciphertext: hex(ciphertext) };
  } finally { plain.fill(0); }
}
const unhex = (value, length) => {
  if (typeof value !== 'string' || value.length !== length * 2 || !/^[0-9a-f]+$/.test(value)) throw Error('Invalid encrypted native wallet.');
  return Uint8Array.from(value.match(/../g), part => Number.parseInt(part, 16));
};
async function open(envelope, password, chain, network = 'mainnet') {
  envelope = structuredClone(envelope);
  chains(chain);
  if (!envelope || JSON.stringify(Object.keys(envelope).sort()) !== JSON.stringify([...Object.keys(metadata(chain, '')), 'salt', 'iv', 'ciphertext'].sort())) throw Error('Invalid encrypted native wallet.');
  const info = metadata(chain, envelope.address, network);
  if (Object.entries(info).some(([name, value]) => envelope[name] !== value) || typeof envelope.address !== 'string' || envelope.address.length > 64) throw Error('Invalid encrypted native wallet.');
  let secret;
  try {
    secret = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(envelope.iv, 12), additionalData: encoder.encode(JSON.stringify(info)) }, await derive(password, unhex(envelope.salt, 16)), unhex(envelope.ciphertext, 48)));
    if (identity(chain, secret) !== envelope.address) throw Error();
    return secret;
  } catch { secret?.fill(0); throw Error('The passphrase or encrypted native wallet is invalid.'); }
}
function session(chain, secret, envelope, store, network = 'mainnet') {
  envelope = structuredClone(envelope);
  let closed = false, generation = 0;
  const transferIdentity=Object.freeze({});
  const assert = () => { if (closed || store.closed) throw Error('Native wallet is locked.'); };
  const address = identity(chain, secret);
  const result = {
    metadata() { assert(); return { chain, network, address }; },
    exportBackup() { assert(); return structuredClone(envelope); },
    async verifyBackup(backup, password) {
      assert(); const expected = generation; const recovered = await open(backup, password, chain, network);
      try { assert(); if (expected !== generation || !equal(secret, recovered)) throw Error('Backup belongs to a different wallet.'); return true; }
      finally { recovered.fill(0); }
    },
    /** Re-derives the stored envelope under a freshly-typed passphrase (never trusting that the session is merely open)
     * before revealing the raw signing key, in the exact canonical 64-byte base58 form `imported()`/other Solana wallets
     * (Phantom, Solflare, Backpack) accept. Product requirement, 28 October 2026: export must exist so a holder is never
     * locked into Silo. Pure local computation; nothing here ever reaches a network call, a log line or an error report
     * -- the caller is responsible for how long the returned string stays on screen. */
    async revealSecretKey(password) {
      assert(); if (chain !== 'solana') throw Error('Secret-key export is available for Solana wallets only.');
      const expected = generation, recovered = await open(envelope, password, chain, network);
      try {
        assert(); if (expected !== generation || !equal(secret, recovered)) throw Error('The passphrase or encrypted native wallet is invalid.');
        const pair = nacl.sign.keyPair.fromSeed(secret);
        try { return bs58.encode(pair.secretKey); } finally { pair.secretKey.fill(0); }
      } finally { recovered.fill(0); }
    },
    async signTransaction() { throw Error('Native signing is held pending separate release-policy review.'); },
    transferIdentity(){assert();if(chain!=='solana')throw Error('Native Solana required.');return transferIdentity;},
    signReviewedTransfer(encoded,ticket){
      assert();if(chain!=='solana')throw Error('Native Solana transfer required.');if(network!=='mainnet')throw Error('Signing is held for test-network wallets.');
      const guard=consumeSiloNativeTransferTicket(ticket,{chain,network:'mainnet',address,identity:transferIdentity},encoded);assert();guard();
      const tx=VersionedTransaction.deserialize(Buffer.from(encoded,'base64')),pair=nacl.sign.keyPair.fromSeed(secret);
      try{assert();guard();if(bs58.encode(pair.publicKey)!==address)throw Error('Native signer changed.');tx.signatures[0]=nacl.sign.detached(tx.message.serialize(),pair.secretKey);return Buffer.from(tx.serialize()).toString('base64');}
      finally{pair.secretKey.fill(0);}
    },
    signReviewedManaged(encoded,ticket) {
      assert();if(chain!=='solana')throw Error('Only reviewed native Solana transactions may sign.');if(network!=='mainnet')throw Error('Signing is held for test-network wallets.');
      const guard=consumeSiloNativeManagedTicket(ticket,{chain,network:'mainnet',address},encoded);assert();guard();
      const tx=VersionedTransaction.deserialize(Buffer.from(encoded,'base64')),pair=nacl.sign.keyPair.fromSeed(secret);
      try{assert();guard();if(bs58.encode(pair.publicKey)!==address)throw Error('Native signer changed.');tx.signatures[0]=nacl.sign.detached(tx.message.serialize(),pair.secretKey);return Buffer.from(tx.serialize()).toString('base64');}
      finally{pair.secretKey.fill(0);}
    },
    /** Test networks only: delegated to ./native-keyring-testnet.mjs, which a production build replaces by its held stand-in
     * (vite.config.ts). The passphrase-protected revealSecretKey intentionally returns raw Solana key material to its caller. Test-network signing is disabled in the public tree. */
    signTestNetworkTransaction(encoded) { assert(); return testNetworkSign({chain,network,address,secret,assert,encoded}); },
    lock() { if (!closed) { closed = true; generation++; secret.fill(0); store.close(); } },
  };
  store.onClose?.(() => result.lock());
  return Object.freeze(result);
}
async function savedSession({ chain, passphrase, store, network = 'mainnet' }, secret) {
  try {
    const envelope = await seal(chain, secret, passphrase, network);
    if (store.closed || !await store.create(envelope)) throw Error('A native wallet already exists or its store is closed.');
    if (store.closed) throw Error('Native wallet is locked.');
    return session(chain, secret, envelope, store, network);
  } catch (error) { secret.fill(0); throw error; }
}
export async function createNativeKeyring(options) {
  chains(options.chain); networks(options.chain, options.network ?? 'mainnet'); const reason = siloPassphraseProblem(pass(options.passphrase)); if (reason) throw Error(reason);
  let secret;
  for (let attempt = 0; attempt < 128; attempt++) {
    secret?.fill(0); secret = random(32);
    if (secret.some(byte => byte !== 0) && (options.chain !== 'evm' || secp256k1.utils.isValidPrivateKey(secret))) return savedSession(options, secret);
  }
  secret?.fill(0); throw Error('Secure key generation failed.');
}
export async function importNativeKeyring(options) {
  // A devnet test wallet is created fresh or restored from its own devnet backup; a key from elsewhere (possibly a mainnet
  // key) is never adopted as a devnet key (security review of the test-network stage, part 2).
  if (options.network === 'devnet') throw Error('Importing a private key is not available for a devnet test wallet.');
  const reason = siloPassphraseProblem(pass(options.passphrase)); if (reason) throw Error(reason);
  return savedSession(options, imported(options.chain, options.privateKey));
}
/** Re-seals ONE stored backup envelope under a new passphrase, in memory, for the one-passphrase migration. It opens the envelope with its
 * ORIGINAL passphrase (the same `open` every unlock uses), seals the same secret with the same `seal` creation uses (fresh salt and iv, same
 * KDF and parameters), checks the address did not move, and zeroes the secret. It never writes a store, never returns the secret, and never
 * touches the original envelope: the caller keeps the original until the user discards it. */
export async function resealNativeBackup({ chain, backup, originalPassphrase, newPassphrase, network = 'mainnet' }) {
  chains(chain); networks(chain, network);
  const reason = siloPassphraseProblem(pass(newPassphrase)); if (reason) throw Error(reason);
  const secret = await open(backup, originalPassphrase, chain, network);
  try {
    const sealed = await seal(chain, secret, newPassphrase, network);
    if (sealed.address !== backup.address) throw Error('Re-sealing changed the wallet address.');
    return sealed;
  } finally { secret.fill(0); }
}
export async function unlockNativeKeyring({ chain, passphrase, store, network = 'mainnet' }) {
  const envelope = structuredClone(await store.read()); if (!envelope) throw Error('No native wallet is stored.');
  const secret = await open(envelope, passphrase, chain, network);
  try { if (store.closed) throw Error('Native wallet is locked.'); return session(chain, secret, envelope, store, network); }
  catch (error) { secret.fill(0); throw error; }
}
export async function restoreNativeKeyring({ backup, chain = backup?.chain, passphrase, store, network = 'mainnet' }) {
  backup = structuredClone(backup);
  const secret = await open(backup, passphrase, chain, network);
  try {
    if (store.closed || !await store.create(structuredClone(backup))) throw Error('A native wallet already exists or its store is closed.');
    if (store.closed) throw Error('Native wallet is locked.');
    return session(chain, secret, backup, store, network);
  } catch (error) { secret.fill(0); throw error; }
}
/** Generic signing stays held; in this public tree the reviewed-ticket signing paths refuse as well. JS strings, GC copies, compromised origin code and extensions cannot be reliably zeroized or isolated. */

export function previewNativePrivateKey({ chain, privateKey, network = 'mainnet' }) {
  if (network === 'devnet') throw Error('Importing a private key is not available for a devnet test wallet.');
  networks(chain, network); const secret = imported(chain, privateKey);
  try { return { chain, network, address: identity(chain, secret) }; } finally { secret.fill(0); }
}
