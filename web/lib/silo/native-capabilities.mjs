/** Capability availability only; does not prove storage permission, engine delivery or device memory. */
export function siloNativeCapabilityProblem(runtime=globalThis){
 const missing=[];
 if(runtime.isSecureContext!==true)missing.push('a secure HTTPS context');
 if(!runtime.crypto?.subtle)missing.push('browser cryptography');
 if(!runtime.indexedDB)missing.push('local encrypted wallet storage');
 if(typeof runtime.WebAssembly?.instantiate!=='function')missing.push('WebAssembly');
 if(typeof runtime.Worker!=='function')missing.push('wallet workers');
 if(typeof runtime.navigator?.locks?.request!=='function')missing.push('exclusive wallet tab ownership');
 return missing.length?`This browser cannot open a native wallet: missing ${missing.join(', ')}. Use a supported browser. Your saved backup is unchanged. Keep your exported encrypted backup and use a supported browser for recovery.`:null;
}

/** Disposable permission/quota probe. It never opens an existing wallet database.
 * Success proves one small write/read/delete here, not persistence, SDK delivery,
 * device memory, backup recovery or a physical-device acceptance test. */
export async function probeSiloNativeStorage(runtime=globalThis,{timeoutMs=3000}={}){
 const unavailable=reason=>({available:false,reason,cleanupComplete:false,scope:'disposable IndexedDB permission probe only'});
 if(!runtime.indexedDB||typeof runtime.crypto?.randomUUID!=='function')return unavailable('Encrypted wallet storage cannot be checked in this browser.');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw Error('Invalid storage probe deadline.');
 const name=`grain-silo-disposable-probe-${runtime.crypto.randomUUID()}`;
 if(!/^grain-silo-disposable-probe-[a-f0-9-]{36}$/.test(name))return unavailable('A safe disposable storage identity could not be created.');
 return new Promise(resolve=>{
  let db=null,created=false,finished=false;
  const cleanup=()=>new Promise(done=>{
   try{db?.close();}catch{/* Closing this probe only. */}
   if(!created){done(false);return;}
   const timer=setTimeout(()=>done(false),Math.min(timeoutMs,1000));
   try{const deletion=runtime.indexedDB.deleteDatabase(name);deletion.onsuccess=()=>{clearTimeout(timer);done(true);};deletion.onerror=deletion.onblocked=()=>{clearTimeout(timer);done(false);};}catch{clearTimeout(timer);done(false);}
  });
  const finish=async(ok,reason)=>{if(finished)return;finished=true;clearTimeout(deadline);const cleanupComplete=await cleanup();resolve({available:ok&&cleanupComplete,reason:ok&&cleanupComplete?null:reason??'The disposable storage check could not finish. Wallet actions remain held.',cleanupComplete,scope:'disposable IndexedDB permission probe only'});};
  const deadline=setTimeout(()=>void finish(false,'The local storage check timed out. Wallet actions remain held.'),timeoutMs);
  try{
   const opening=runtime.indexedDB.open(name,1);
   opening.onupgradeneeded=event=>{
    // A name collision must never result in modifying or deleting that database.
    if(finished||event.oldVersion!==0){opening.transaction?.abort();return;}
    created=true;opening.result.createObjectStore('probe');
   };
   opening.onerror=()=>void finish(false,'This browser refused the local storage check. Your saved wallet data was not opened.');
   opening.onblocked=()=>void finish(false,'The disposable storage check was blocked. Your saved wallet data was not opened.');
   opening.onsuccess=()=>{
    db=opening.result;
    if(finished){void cleanup();return;}
    if(!created){void finish(false,'The disposable storage identity was already in use. Nothing was changed.');return;}
    try{
     const transaction=db.transaction('probe','readwrite'),store=transaction.objectStore('probe');let matched=false;
     store.put('silo-storage-probe-v1','check');const read=store.get('check');read.onsuccess=()=>{matched=read.result==='silo-storage-probe-v1';};
     transaction.oncomplete=()=>void finish(matched,matched?null:'The local storage read did not match its write.');
     transaction.onabort=transaction.onerror=()=>void finish(false,'This browser cannot save the disposable storage check. Check local storage permissions and space.');
    }catch{void finish(false,'The local storage write could not be started. Check browser permissions.');}
   };
  }catch{void finish(false,'This browser refused access to local storage. Your saved wallet data was not opened.');}
 });
}
