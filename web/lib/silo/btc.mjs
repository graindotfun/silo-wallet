// Silo Bitcoin wallet core. Test networks (testnet, signet) work from the first release; mainnet derivation exists here but a mainnet wallet is
// reachable only through the release gate, the flags and the server relay (release-gate.mjs, config.mjs, app/api/silo/btc/route.ts).
// No cryptography is written in this file. Mnemonic, seed and key tree come from paulmillr's audited-by-use libraries
// (@scure/bip39 1.6.0, @scure/bip32 1.7.0, @scure/btc-signer 1.8.1, all MIT, on the repo's pinned @noble 1.x line).
// Key model: the sealed secret is 32 bytes of entropy (same envelope shape as the Solana and EVM keys). It is the BIP39
// entropy of a 24-word recovery phrase, so the holder can always restore the wallet in any standard wallet (no lock-in).
// Account: native segwit (BIP84, p2wpkh), path m/84'/{0 mainnet|1 test}'/0'/{0 receive|1 change}/{index}. Taproot (BIP86) is a later option.
import {HDKey} from '@scure/bip32';
import {entropyToMnemonic, mnemonicToSeedSync} from '@scure/bip39';
import {wordlist} from '@scure/bip39/wordlists/english';
import * as btc from '@scure/btc-signer';

export const SILO_BTC_TEST_NETWORKS = Object.freeze(['testnet', 'signet']);
/** Every network the core knows. Using 'mainnet' in the product is gated elsewhere: flags, release evidence, per-send cap. */
export const SILO_BTC_NETWORKS = Object.freeze(['mainnet', 'testnet', 'signet']);
export const SILO_BTC_GAP_LIMIT = 20;
/** The wallet scans at most this many addresses per chain and can sign for the first SILO_BTC_OWNED_WINDOW of them, so any coin it finds is signable. */
export const SILO_BTC_SCAN_MAX = 150;
export const SILO_BTC_OWNED_WINDOW = 200;
const TESTNET_VERSIONS = Object.freeze({private: 0x04358394, public: 0x043587cf});
const MAINNET_VERSIONS = Object.freeze({private: 0x0488ade4, public: 0x0488b21e});
export const siloBtcNetworkParams = network => {
  if (!SILO_BTC_NETWORKS.includes(network)) throw Error('Unsupported Bitcoin network.');
  return network === 'mainnet' ? btc.NETWORK : btc.TEST_NETWORK; // testnet and signet share address encoding (tb1...) and coin type 1
};
/** BIP44 coin type: 0 for mainnet, 1 for every test network, so a test wallet and a mainnet wallet can never share keys or addresses. */
export const siloBtcCoinType = network => network === 'mainnet' ? 0 : 1;
/** Plain label for screens and exports: a test network is never called just "Bitcoin". */
export const siloBtcNetworkLabel = network => network === 'mainnet' ? 'Bitcoin' : network === 'signet' ? 'Bitcoin signet (test coins)' : 'Bitcoin testnet (test coins)';
/** The network family an address string belongs to, from its prefix alone: 'mainnet' (bc1, 1, 3), 'test' (tb1, m, n, 2) or null. */
export const siloBtcAddressFamily = address => typeof address !== 'string' ? null : /^(bc1|[13])/i.test(address) ? 'mainnet' : /^(tb1|[mn2])/i.test(address) ? 'test' : null;
const guardEntropy = entropy => {
  if (!(entropy instanceof Uint8Array) || entropy.length !== 32) throw Error('Invalid Bitcoin key.');
  return entropy;
};
/** The 24-word recovery phrase. Callers must treat the returned string as a secret. */
export const siloBtcRecoveryPhrase = entropy => entropyToMnemonic(guardEntropy(entropy), wordlist);

/** BIP84 account node from a BIP39 seed. `coinType` is 0 for mainnet and 1 for testnet/signet (see siloBtcCoinType). */
export function siloBtcAccountFromSeed(seed, coinType, versions = TESTNET_VERSIONS) {
  return HDKey.fromMasterSeed(seed, versions).derive(`m/84'/${coinType}'/0'`);
}
function account(entropy, network) {
  siloBtcNetworkParams(network);
  const seed = mnemonicToSeedSync(siloBtcRecoveryPhrase(entropy));
  try { return siloBtcAccountFromSeed(seed, siloBtcCoinType(network), network === 'mainnet' ? MAINNET_VERSIONS : TESTNET_VERSIONS); } finally { seed.fill(0); }
}
const hexOf = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
/** Derives one address (and nothing secret) for chain 0 (receive) or 1 (change). */
export function siloBtcAddress(entropy, network, chain, index) {
  if (chain !== 0 && chain !== 1) throw Error('Invalid Bitcoin chain.');
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) throw Error('Invalid Bitcoin address index.');
  const node = account(entropy, network).deriveChild(chain).deriveChild(index);
  return btc.p2wpkh(node.publicKey, siloBtcNetworkParams(network)).address;
}
/** Public addresses for a range, for balance scans. Returns [{chain,index,address}]. */
export function siloBtcAddresses(entropy, network, chain, from, count) {
  const parent = account(entropy, network).deriveChild(chain), params = siloBtcNetworkParams(network), out = [];
  for (let index = from; index < from + count; index++) out.push({chain, index, address: btc.p2wpkh(parent.deriveChild(index).publicKey, params).address});
  return out;
}
/** Maps scriptPubKey hex to {chain,index} for the first `window` addresses of both chains; the signer uses this to prove an input is ours. */
export function siloBtcOwnedScripts(entropy, network, window = SILO_BTC_OWNED_WINDOW) {
  const params = siloBtcNetworkParams(network), acct = account(entropy, network), map = new Map();
  for (const chain of [0, 1]) {
    const parent = acct.deriveChild(chain);
    for (let index = 0; index < window; index++) map.set(hexOf(btc.p2wpkh(parent.deriveChild(index).publicKey, params).script), {chain, index});
  }
  return map;
}
/** Private child key for signing only. The caller must zero it. */
export function siloBtcPrivateKey(entropy, network, chain, index) {
  const node = account(entropy, network).deriveChild(chain).deriveChild(index);
  return Uint8Array.from(node.privateKey);
}
export const siloBtcValidAddress = (address, network) => {
  try { const decoded = btc.Address(siloBtcNetworkParams(network)).decode(address); return typeof address === 'string' && address.length <= 100 && Boolean(decoded); } catch { return false; }
};
/** Gap-limit scan of one chain. `lookup(addresses)` resolves to one boolean per address: has it ever been used (any transaction, confirmed
 * or not). Scans in batches until `gap` consecutive unused addresses follow the highest used index, never past `maxIndex` addresses
 * (batches are shortened at the cap, so no address at or beyond maxIndex is ever derived or asked about). Returns every used item that
 * was found, so callers never re-derive or truncate. */
export async function siloBtcScanChain({derive, lookup, gap = SILO_BTC_GAP_LIMIT, maxIndex = SILO_BTC_SCAN_MAX}) {
  let used = -1, from = 0; const usedItems = [];
  while (from < maxIndex) {
    const count = Math.min(gap, maxIndex - from), batch = derive(from, count), flags = await lookup(batch.map(item => item.address));
    if (!Array.isArray(batch) || batch.length !== count || !Array.isArray(flags) || flags.length !== batch.length) throw Error('Bitcoin provider returned an unexpected answer.');
    flags.forEach((flag, offset) => { if (flag === true) { used = Math.max(used, from + offset); usedItems.push(batch[offset]); } });
    if (used < from + batch.length - gap) break; // a full gap of unused addresses past the highest used index
    from += count;
  }
  return {highestUsed: used, firstUnused: used + 1, usedItems};
}
/** Whole-wallet scan: receive and change chains. `derive(chain, from, count)` must accept the count it is given (the wallet session allows
 * up to 100 per call; batches here are at most the gap limit). Returns all used addresses of both chains with their chain and index. */
export async function siloBtcScanWallet({derive, lookup, gap = SILO_BTC_GAP_LIMIT, maxIndex = SILO_BTC_SCAN_MAX}) {
  /** @type {{used: any[], chains: Record<number, {highestUsed: number, firstUnused: number}>}} */
  const out = {used: [], chains: {}};
  for (const chain of [0, 1]) {
    const result = await siloBtcScanChain({derive: (from, count) => derive(chain, from, count), lookup, gap, maxIndex});
    out.chains[chain] = {highestUsed: result.highestUsed, firstUnused: result.firstUnused};
    out.used.push(...result.usedItems);
  }
  return out;
}

/** Which receive (or change) index to show, from the scan and the remembered highest shown index. Pure.
 *  - `firstUnused` is the first index never used on chain, `remembered` the highest index ever shown (persisted), `pressed` the "New address" presses.
 *  - An address is never offered twice: the base is at least the remembered index, never more than one gap ahead of the first unused one.
 *  - When the scan range is used up (firstUnused at or past max) there is NO address: `exhausted` is true and `index` is null. The old code reused the last one. */
export function siloBtcNextIndex({firstUnused, remembered = 0, pressed = 0, max = SILO_BTC_SCAN_MAX, gap = SILO_BTC_GAP_LIMIT}) {
  if (!Number.isInteger(firstUnused) || firstUnused < 0 || firstUnused >= max) return {index: null, exhausted: true, canAdvance: false};
  const limit = Math.min(firstUnused + gap - 1, max - 1), base = Math.min(Math.max(firstUnused, remembered), limit), index = Math.min(base + Math.max(0, pressed), limit);
  return {index, exhausted: false, canAdvance: index < limit};
}
