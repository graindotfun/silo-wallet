/** Versioned recovery payload. Native envelopes retain their original ciphertext;
 * XMR plaintext exists only in the client until split into encrypted sync classes.
 * This validates recovery shape, not Monero mnemonic/SDK or mainnet acceptance. */
import {assertNativeSyncBackup} from './native-wallets.mjs';
import {canonical} from './codec.mjs';
import {SILO_MAX_XMR_PLAINTEXT_BYTES} from '../local-envelope.mjs';
import {VAULT_NETWORK_PROFILES,profileOfKeys} from './network-profile.mjs';
/** `profile` is a vault network profile (network-profile.mjs); the default is the product mainnet profile. */
export function assertCombinedWalletBackup(value,profile=VAULT_NETWORK_PROFILES.mainnet){
 const copy=structuredClone(value);
 if(!copy||Object.keys(copy).sort().join(',')!=='schema,wallets,xmr'||copy.schema!=='silo-sync-combined-wallets-v1'||!Array.isArray(copy.wallets)||copy.wallets.length>2||!copy.wallets.length&&!copy.xmr)throw Error('Invalid combined recovery payload.');
 if(copy.wallets.length)copy.wallets=assertNativeSyncBackup({schema:'silo-sync-native-public-v1',wallets:copy.wallets},{network:profile.native}).wallets;
 if(copy.xmr!==null){
  const x=copy.xmr;
  if(!x||typeof x!=='object'||Array.isArray(x)||typeof x.seed!=='string'||!x.seed.length||x.seed.length>4096||x.engine!==undefined&&x.engine!=='monero-ts'||['height','account','subaddresses','scannedSubaddresses','ordinaryReceiveIndex'].some(k=>x[k]!==undefined&&(!Number.isSafeInteger(x[k])||x[k]<0))||['keysData','cacheData'].some(k=>x[k]!==undefined&&x[k]!==null&&typeof x[k]!=='string')||new TextEncoder().encode(JSON.stringify(x)).length>SILO_MAX_XMR_PLAINTEXT_BYTES)throw Error('Invalid bounded XMR recovery payload.');
 }
 return copy;
}
export function walletKeySegments(keys){
 const profile=profileOfKeys(keys);if(!profile)throw Error('Unsupported combined recovery key format.');
 if(keys?.zone==='native-public')return {native:assertNativeSyncBackup(keys.payload,{network:profile.native}),xmr:null};
 if(keys?.zone==='xmr')return {native:null,xmr:keys};
 if(keys?.schema!=='silo-sync-keys-v2'||keys.zone!=='combined'||Object.keys(keys).sort().join(',')!=='native,network,schema,xmr,zone')throw Error('Unsupported combined recovery key format.');
 const native=keys.native===null?null:assertNativeSyncBackup(keys.native,{network:profile.native}),xmr=keys.xmr;
 if(xmr!==null&&(xmr?.zone!=='xmr'||xmr.schema!=='silo-sync-keys-v1'||xmr.network!==profile.xmr||typeof xmr.seed!=='string'||!xmr.seed))throw Error('Invalid combined XMR recovery keys.');
 if(!native&&!xmr)throw Error('Empty combined recovery keys.');return {native,xmr};
}
/** Existing wallet identity and ORIGINAL encrypted bytes never change on an addition.
 * Another encryption of the same key is still a different historical recovery copy. */
export function assertWalletKeyGrowth(previous,next){
 if(canonical(previous)===canonical(next))return;
 const before=walletKeySegments(previous),after=walletKeySegments(next);
 if(before.xmr&&canonical(before.xmr)!==canonical(after.xmr))throw Error('Existing XMR recovery keys cannot be replaced.');
 for(const e of before.native?.wallets??[]){const n=after.native?.wallets.find(row=>row.chain===e.chain);if(!n||canonical(n)!==canonical(e))throw Error('Existing native recovery backup cannot be replaced.');}
}
export function appendWalletKeys(previous,incoming){
 const profile=profileOfKeys(previous);if(!profile||profileOfKeys(incoming)!==profile)throw Error('Recovery for a different network profile cannot be added.');
 const before=walletKeySegments(previous),add=walletKeySegments(incoming),wallets=[...(before.native?.wallets??[])];
 for(const envelope of add.native?.wallets??[]){const current=wallets.find(row=>row.chain===envelope.chain);if(current&&canonical(current)!==canonical(envelope))throw Error('A different wallet or encrypted backup already occupies this chain.');if(!current)wallets.push(envelope);}
 if(before.xmr&&add.xmr&&canonical(before.xmr)!==canonical(add.xmr))throw Error('A different XMR wallet already occupies this account.');
 const next={schema:'silo-sync-keys-v2',zone:'combined',network:profile.label,native:wallets.length?assertNativeSyncBackup({schema:'silo-sync-native-public-v1',wallets},{network:profile.native}):null,xmr:before.xmr??add.xmr};
 walletKeySegments(next);assertWalletKeyGrowth(previous,next);return next;
}
