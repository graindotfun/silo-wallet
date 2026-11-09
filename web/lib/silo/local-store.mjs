/** Browser-local encrypted envelopes only. No seed/cache plaintext, cookies or server backup.
 * A write resolves only after its transaction commits; an abort (quota exceeded, eviction, closing) rejects. */
export async function siloStore(factory=globalThis.indexedDB){
 const database=await new Promise((resolve,reject)=>{const request=factory.open('grain-silo-research-v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('envelopes');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('Local encrypted storage unavailable.'));request.onblocked=()=>reject(Error('Local encrypted storage is held by another tab.'));});
 database.onversionchange=()=>database.close();
 const operate=(mode,action)=>new Promise((resolve,reject)=>{let tx;try{tx=database.transaction('envelopes',mode);}catch{reject(Error('Local encrypted storage unavailable.'));return;}const request=action(tx.objectStore('envelopes'));let result;request.onsuccess=()=>{result=request.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(Error('Local encrypted storage unavailable.'));tx.onabort=()=>reject(Error('Local encrypted storage did not save. Check available storage.'));});
 return {
  read:(zone,network)=>operate('readonly',store=>store.get(`${zone}:${network}`)),
  write:(zone,envelope)=>{if(!envelope?.ciphertext||envelope.zone!==zone)throw Error('Encrypted envelope required.');return operate('readwrite',store=>store.put(envelope,`${zone}:${envelope.network}`));},
  remove:(zone,network)=>operate('readwrite',store=>store.delete(`${zone}:${network}`)),
  // Write-once copy of an envelope as it was before an engine migration. The key binds the label and the ciphertext's start, so a
  // different envelope never replaces an archived one, and archiving the same envelope again is a no-op. remove() leaves archives.
  archive:(zone,envelope,label)=>{if(!envelope?.ciphertext||envelope.zone!==zone||!/^[a-z0-9-]{1,40}$/.test(label))throw Error('Encrypted envelope required.');const key=`${zone}:${envelope.network}:archive:${label}:${envelope.ciphertext.slice(0,32)}`;return operate('readonly',store=>store.get(key)).then(existing=>existing?(sameSiloEnvelope(existing,envelope)?key:Promise.reject(Error('A different archived backup exists.'))):operate('readwrite',store=>store.add(envelope,key)).then(()=>key));},
  readArchive:key=>operate('readonly',store=>store.get(key)),
  // Archived envelopes for a zone and network, oldest key order. Only removeArchive() deletes one; remove() never does.
  archives:async(zone,network)=>{const prefix=`${zone}:${network}:archive:`,keys=(await operate('readonly',store=>store.getAllKeys())).filter(key=>typeof key==='string'&&key.startsWith(prefix));return Promise.all(keys.map(async key=>({key,envelope:await operate('readonly',store=>store.get(key))})));},
  removeArchive:key=>{if(typeof key!=='string'||!key.includes(':archive:'))throw Error('Archive key required.');return operate('readwrite',store=>store.delete(key));},
  close:()=>database.close(),
 };
}
/** True when `incoming` is the envelope already stored, so re-importing that same backup cannot replace a wallet. */
export function sameSiloEnvelope(stored,incoming){return Boolean(stored&&incoming)&&['zone','network','salt','iv','ciphertext','version','plainBytes'].every(key=>stored[key]===incoming[key])&&JSON.stringify(stored.extraChunks??null)===JSON.stringify(incoming.extraChunks??null);}
/** Creating, seed-restoring or importing writes the browser's single slot for a network. A different stored wallet is never replaced;
 * unlocking the stored wallet, or importing that same envelope, is allowed. */
export function assertSiloSlotAvailable(stored,{restore,imported}={}){if(stored&&(!restore||imported)&&!sameSiloEnvelope(stored,imported))throw Error('stored-wallet');}
