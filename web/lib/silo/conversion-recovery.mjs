import {encryptedCrosschainStore} from './crosschain-store.mjs';
const MAX_ATTEMPTS=64;
// No-bridge XMR to SOL swap records (alice-flow RECORD_KIND) travel in the same encrypted journal, next to the conversion handles.
const ATOMIC_ROW='silo-atomic-swap-row-v1';
// Total retained entries (active + retired) must stay within what reopen accepts (snapshot.entries.length<=MAX_ATTEMPTS).
/** Per-open-wallet encrypted journal. The surrounding native envelope is the durable commit;
 * no global cross-wallet database, plaintext storage, provider or payment operation is used. */
/** @param {{passphrase:string,snapshot?:any}} options */
export async function createSiloConversionRecovery({passphrase,snapshot=null}){
 const data=new Map(),retiredIds=[];
 // The crosschain store keys its backend by sha256(record id); the record id is itself sha256(handle).
 const sha=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');let closed=false,queue=Promise.resolve();
 const active=()=>{if(closed)throw Error('conversion-recovery-locked');};
 const store=encryptedCrosschainStore({read:async key=>data.get(key)??null,entries:async()=>[...data],compareAndSwap:async(key,revision,next)=>{if((data.get(key)?.revision??null)!==revision)return false;data.set(key,structuredClone(next));return true;},close:()=>data.clear()},passphrase);
 try{
  if(snapshot!==null){if(!Array.isArray(snapshot?.entries)||snapshot.entries.length>MAX_ATTEMPTS)throw Error('conversion-recovery-bound');await store.importEncrypted(snapshot);}
  const handles=new Set(),atomic=new Map();for(const row of await store.list()){
   if(row.kind===ATOMIC_ROW){if(typeof row.swapId!=='string'||!/^[a-f0-9]{64}$/.test(row.swapId)||row.record?.swapId!==row.swapId||row.id!==`atomic:${row.swapId}`)throw Error('conversion-recovery-record');atomic.set(row.swapId,{record:structuredClone(row.record),revision:row.revision});continue;}
   if(row.kind!=='silo-conversion-recovery-handle-v1'||typeof row.recoveryHandle!=='string'||row.recoveryHandle.length<1||row.recoveryHandle.length>2048)throw Error('conversion-recovery-record');
   if(row.state!=='retired')handles.add(row.recoveryHandle);else if(typeof row.id==='string')retiredIds.push(await sha(row.id));
  }
  return Object.freeze({
   handles:()=>{active();return [...handles];},
   remember(handle){
    const next=queue.then(async()=>{active();if(typeof handle!=='string'||handle.length<1||handle.length>2048)throw Error('conversion-recovery-handle');
    if(handles.has(handle))return;if(handles.size>=MAX_ATTEMPTS)throw Error('conversion-recovery-bound');
    const id=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(handle))),b=>b.toString(16).padStart(2,'0')).join('');active();
    // Keep the saved total reopenable: drop only the OLDEST retired entries (verified terminal, never active) to make room.
    while(data.size>=MAX_ATTEMPTS&&retiredIds.length>0){const old=retiredIds.shift();data.delete(old);}active();
    if(data.size>=MAX_ATTEMPTS)throw Error('conversion-recovery-bound');
    if(!await store.compareAndSwap(id,null,{id,revision:0,kind:'silo-conversion-recovery-handle-v1',recoveryHandle:handle,state:'creation-uncertain'}))throw Error('conversion-recovery-conflict');active();handles.add(handle);
    });queue=next.catch(()=>{});return next;
   },
   /** Retire a handle whose attempt reached a verified terminal state. The encrypted entry stays in the backup (state 'retired',
    * next revision); only the active list drops it. Callers must never retire an unverified or fund-at-risk attempt. */
   retire(handle){
    const next=queue.then(async()=>{active();if(typeof handle!=='string'||handle.length<1||handle.length>2048)throw Error('conversion-recovery-handle');
    if(!handles.has(handle))return;
    const id=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(handle))),b=>b.toString(16).padStart(2,'0')).join('');active();
    const row=await store.read(id);active();if(!row||row.recoveryHandle!==handle)throw Error('conversion-recovery-record');
    if(row.state!=='retired'&&!await store.compareAndSwap(id,row.revision,{...row,revision:row.revision+1,state:'retired'}))throw Error('conversion-recovery-conflict');active();handles.delete(handle);{const key=await sha(id);active();if(!retiredIds.includes(key))retiredIds.push(key);}
    });queue=next.catch(()=>{});return next;
   },
   /** Saved no-bridge swap records (secrets included, encrypted with the wallet backup). Copies, never the live objects. */
   atomicRecords:()=>{active();return [...atomic.values()].map(entry=>structuredClone(entry.record));},
   /** Durably stores one swap record (insert or next revision). The caller persists the wallet envelope afterwards. */
   saveAtomic(record){
    const next=queue.then(async()=>{active();
     if(!record||typeof record.swapId!=='string'||!/^[a-f0-9]{64}$/.test(record.swapId)||typeof record.kind!=='string')throw Error('conversion-recovery-record');
     const id=`atomic:${record.swapId}`,known=atomic.get(record.swapId),pinned=structuredClone(record);
     // A payment that may have gone out stays recorded whatever a later, older copy says (H6): the flag never clears.
     if(known?.record?.fundingAttempted&&!pinned.fundingAttempted)pinned.fundingAttempted=known.record.fundingAttempted;
     // SOL -> XMR: a SOL lock that may have gone out stays recorded the same way, so a stale copy can never lead to a second lock.
     if(known?.record?.lockAttemptAt&&!pinned.lockAttemptAt)pinned.lockAttemptAt=known.record.lockAttemptAt;
     if(!known&&data.size>=MAX_ATTEMPTS)throw Error('conversion-recovery-bound');
     const revision=known?known.revision+1:0;
     if(!await store.compareAndSwap(id,known?known.revision:null,{id,revision,kind:ATOMIC_ROW,swapId:record.swapId,record:pinned}))throw Error('conversion-recovery-conflict');active();
     atomic.set(record.swapId,{record:pinned,revision});
    });queue=next.catch(()=>{});return next;
   },
   async backup(){active();await queue;active();const result=await store.exportEncrypted();active();return result;},
   close(){if(closed)return;closed=true;handles.clear();atomic.clear();store.close();},
  });
 }catch(error){store.close();throw error;}
}
