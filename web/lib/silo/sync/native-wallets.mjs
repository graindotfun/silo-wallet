// Experimental sync bridge. No account route, signing permission or cloud activation.
// Validation only, with no wallet engine or signing code, so packaged surfaces can vendor it; the web wallet's restore of a
// synced native wallet lives in native-wallet-restore.mjs.
const NAMES=['scope','version','chain','network','address','kdf','iterations','cipher','salt','iv','ciphertext'];
/** `network` is the vault profile's native network: 'mainnet' (default, product) or 'devnet' (test-network profile, Solana only). */
export function assertNativeSyncBackup(value,{network='mainnet'}={}) {
 if(!['mainnet','devnet'].includes(network))throw Error('Unsupported native sync network.');
 const copy=structuredClone(value);
 if(!copy||Object.keys(copy).length!==2||copy.schema!=='silo-sync-native-public-v1'||!Array.isArray(copy.wallets)||copy.wallets.length<1||copy.wallets.length>2)throw Error('Invalid native sync recovery payload.');
 const chains=new Set();
 for(const e of copy.wallets){
  if(!e||Object.keys(e).length!==NAMES.length||NAMES.some(k=>!Object.hasOwn(e,k))||e.scope!=='silo-native-keyring-v1'||e.version!==1||!['solana','evm'].includes(e.chain)||chains.has(e.chain)||e.network!==network||network==='devnet'&&e.chain!=='solana'||e.kdf!=='PBKDF2-SHA256'||e.iterations!==600000||e.cipher!=='AES-256-GCM'||typeof e.address!=='string'||!e.address||e.address.length>64||! /^[0-9a-f]{32}$/.test(e.salt)||! /^[0-9a-f]{24}$/.test(e.iv)||! /^[0-9a-f]{96}$/.test(e.ciphertext))throw Error('Only native encrypted backups may enter this sync bridge.');
  chains.add(e.chain);
 }
 return copy;
}
export function nativeSyncBackup(sessions){return assertNativeSyncBackup({schema:'silo-sync-native-public-v1',wallets:sessions.map(session=>session.exportBackup())});}
