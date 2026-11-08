// SPDX-License-Identifier: AGPL-3.0-only
/** The ORIGINAL sealed wallet copies kept after a "switch to one passphrase", until the person deletes them. Ciphertext only (what was already
 * stored at rest), small (Solana and EVM; Monero uses its own archive in the local store), write-once, read back before anything is replaced.
 * `storage` is injected (localStorage in the browser); any failure to keep a copy throws, and the caller then replaces nothing. */
const PREFIX='silo-legacy-envelope:';
const fail=(message,reason)=>Object.assign(Error(message),{siloLegacy:reason});
/** @param {Storage} storage @param {{zone:string,envelope:any,proof?:string|null}} row */
export function archiveLegacyEnvelope(storage,{zone,envelope,proof=null}){
 if(!['solana','evm'].includes(zone)||!envelope||typeof envelope.ciphertext!=='string'||typeof envelope.address!=='string')throw fail('Only a sealed Solana or EVM wallet copy can be kept.','shape');
 const key=`${PREFIX}${zone}:${envelope.ciphertext.slice(0,32)}`,text=JSON.stringify({version:1,zone,savedAt:Date.now(),envelope,proof});
 if(text.length>4096)throw fail('The original copy is too large to keep.','size');
 try{
  const existing=storage.getItem(key);if(existing!==null&&existing!==undefined){if(JSON.parse(existing).envelope?.ciphertext===envelope.ciphertext)return key;throw fail('A different original copy already uses this slot.','slot');}
  storage.setItem(key,text);if(storage.getItem(key)!==text)throw fail('The original copy could not be saved.','storage');
 }catch(error){if(error?.siloLegacy)throw error;throw fail('This browser cannot keep the original copy, so nothing was changed.','storage');}
 return key;
}
export function listLegacyEnvelopes(storage){
 const rows=[];try{for(let i=0;i<storage.length;i++){const key=storage.key(i);if(typeof key!=='string'||!key.startsWith(PREFIX))continue;try{const row=JSON.parse(storage.getItem(key));if(row&&row.version===1&&['solana','evm'].includes(row.zone))rows.push({key,zone:row.zone,savedAt:row.savedAt,envelope:row.envelope,proof:row.proof??null});}catch{/* an unreadable row is left alone and listed as nothing */}}}catch{/* storage unavailable: nothing to list */}
 return rows;
}
export function removeLegacyEnvelopes(storage,keys){let removed=0;for(const key of keys){if(typeof key==='string'&&key.startsWith(PREFIX)){try{storage.removeItem(key);removed++;}catch{/* kept: the safe direction */}}}return removed;}
