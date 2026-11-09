/** Durable ciphertext and non-secret sync checkpoints only. Cookie credentials are
 * HttpOnly; IndexedDB stores a sentinel, never the bearer token. Account namespaces
 * are preserved when another account signs in. Enrollment keys are device-bound.
 * IndexedDB and non-extractable keys do not isolate secrets from malicious origin code. */
import {createSyncClient,httpTransport} from './client.mjs';
import {signedTransport} from './signed-transport.mjs';
import {canonical} from './codec.mjs';
const ID=/^[a-f0-9]{32}$/, HASH=/^[a-f0-9]{64}$/, B64=/^[A-Za-z0-9_-]+$/;
const KEYS=new Set(['session','highwater','anchor','outbox','journal-shadow','verified-outcomes','enroll','genesis-intent','recovery-code-note']);
const MAX_JSON=256*1024*1024;
// Solana history checkpoints (solana-history.mjs): public signature lists only, keyed by a hash of the reader's key.
const HISTORY_KEY=/^history:[a-f0-9]{64}$/,SIGNATURE=/^[1-9A-HJ-NP-Za-km-z]{64,90}$/,HISTORY_MAX=64*1024*1024;
const knownKey=key=>KEYS.has(key)||HISTORY_KEY.test(key);
function historyCheckpoint(value){
 if(!exact(value,['anchor','before','lastSlot','signatures','pending','done'])||!integer(value.anchor)||value.anchor<1||value.before!==null&&!SIGNATURE.test(value.before)||!integer(value.lastSlot)||!Array.isArray(value.signatures)||value.signatures.length>500000||!Array.isArray(value.pending)||value.pending.length>value.signatures.length||[...value.signatures,...value.pending].some(sig=>!SIGNATURE.test(sig)))throw Error('Invalid Solana history checkpoint.');
 if(value.done!==null&&(!value.done||typeof value.done!=='object'||!['marker','start-passed','archive-proven-end','end-unproven'].includes(value.done.reason)||value.done.coveredFrom!==undefined&&!integer(value.done.coveredFrom)))throw Error('Invalid Solana history checkpoint.');
 if(JSON.stringify(value).length>HISTORY_MAX)throw Error('Solana history checkpoint exceeds its bound. Nothing was truncated.');
 return value;
}
const exact=(value,names)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...names].sort().join(',');
const integer=value=>Number.isSafeInteger(value)&&value>=0;
// Device-signed clients persist the marker 'signed-session'; their session reference and key stay in device-key.mjs.
function sessionValue(value){if(!(exact(value,['token','accountId','deviceId'])&&['cookie-session','signed-session'].includes(value.token)||exact(value,['token','accountId','deviceId','authEpoch'])&&value.token==='cookie-session'&&ID.test(value.authEpoch))||!ID.test(value.accountId)||!ID.test(value.deviceId))throw Error('Only cookie-session or signed-session identity metadata may be persisted.');return value;}
function rejectSecrets(value,depth=0){if(depth>32)throw Error('Sync local data nesting exceeds bound.');if(value&&typeof value==='object'){for(const [key,item]of Object.entries(value)){if(['seed','passphrase','privateKey','rawKey','rawVaultKey','keysData','cacheData','recoveryCode','decrypted'].includes(key))throw Error('Plaintext wallet material cannot enter sync local storage.');rejectSecrets(item,depth+1);}}}
function encryptedUpload(value){if(!exact(value,['objectId','cls','ciphertext','sha256','bytes'])||!ID.test(value.objectId)||!['keys','journal','xmr-state','profile','devices','scan-chunk'].includes(value.cls)||!HASH.test(value.sha256)||!integer(value.bytes)||value.bytes<28||typeof value.ciphertext!=='string'||!B64.test(value.ciphertext)||value.ciphertext.length>Math.ceil(value.bytes*4/3)+4)throw Error('Encrypted sync object required.');}
function wrappedSlots(slots){
 if(!Array.isArray(slots)||slots.length>16)throw Error('Wrapped unlock slots required.');
 for(const slot of slots){const expected=['v','kind','slotId','kdf','salt','iv','wrapped',...(slot.kind==='prf'?['credentialIdHash']:[])];
  if(!exact(slot,expected)||slot.v!==1||!['passphrase','recovery','prf'].includes(slot.kind)||! /^[a-f0-9]{16}$/.test(slot.slotId)||typeof slot.salt!=='string'||!B64.test(slot.salt)||slot.salt.length!==22||typeof slot.iv!=='string'||!B64.test(slot.iv)||slot.iv.length!==16||typeof slot.wrapped!=='string'||!B64.test(slot.wrapped)||slot.wrapped.length!==64||slot.kind==='prf'&&!HASH.test(slot.credentialIdHash))throw Error('Invalid wrapped unlock slot.');
  if(slot.kind==='passphrase'?(!exact(slot.kdf,['name','iterations'])||slot.kdf.name!=='PBKDF2-SHA256'||slot.kdf.iterations!==600000):(!exact(slot.kdf,['name'])||slot.kdf.name!=='HKDF-SHA256'))throw Error('Invalid wrapped unlock KDF.');
 }
}
function objectRef(ref){if(!exact(ref,['cls','id','sha256','bytes'])||!['keys','journal','xmr-state','profile','devices'].includes(ref.cls)||!ID.test(ref.id)||!HASH.test(ref.sha256)||!integer(ref.bytes)||ref.bytes<28)throw Error('Invalid encrypted object reference.');}
function manifest(value){
 if(!exact(value,['body','mac','hash'])||!HASH.test(value.hash)||typeof value.mac!=='string'||!B64.test(value.mac)||value.mac.length!==43)throw Error('Authenticated manifest required.');
 const b=value.body;if(!exact(b,['v','vaultId','revision','parent','kind','writer','leaseEpoch','createdAt','slotsHash','objects'])||b.v!==1||!ID.test(b.vaultId)||!integer(b.revision)||b.parent!==null&&!HASH.test(b.parent)||!['genesis','action','evidence'].includes(b.kind)||!ID.test(b.writer)||b.leaseEpoch!==null&&!integer(b.leaseEpoch)||!integer(b.createdAt)||!HASH.test(b.slotsHash)||!exact(b.objects,['keys','journal','xmr-state','profile','devices','scan-cache']))throw Error('Invalid manifest metadata.');
 for(const [cls,ref]of Object.entries(b.objects)){if(cls==='scan-cache'){if(ref!==null){if(!exact(ref,['cls','plainBytes','scannedHeight','chunks'])||ref.cls!=='scan-cache'||!integer(ref.plainBytes)||!integer(ref.scannedHeight)||!Array.isArray(ref.chunks)||ref.chunks.length>1024||ref.chunks.some(c=>!exact(c,['id','sha256','bytes'])||!ID.test(c.id)||!HASH.test(c.sha256)||!integer(c.bytes)))throw Error('Invalid encrypted scan references.');}}else{objectRef(ref);if(ref.cls!==cls)throw Error('Object class mismatch.');}}
}
function validate(key,value){
 if(HISTORY_KEY.test(key))return historyCheckpoint(value);
 if(!KEYS.has(key))throw Error('Unknown sync local storage key.');
 if(key==='session')return sessionValue(value);
 if(key==='enroll'){
  if(!exact(value,['requestId','privateKey','publicKey'])||!ID.test(value.requestId)||typeof value.publicKey!=='string'||!B64.test(value.publicKey)||value.publicKey.length!==87||typeof globalThis.CryptoKey!=='function'||!(value.privateKey instanceof globalThis.CryptoKey)||value.privateKey.type!=='private'||value.privateKey.extractable!==false||value.privateKey.algorithm?.name!=='ECDH'||value.privateKey.algorithm?.namedCurve!=='P-256'||value.privateKey.usages?.length!==1||value.privateKey.usages[0]!=='deriveBits')throw Error('Non-extractable device enrollment key required.');
  return value;
 }
 rejectSecrets(value);if(JSON.stringify(value).length>MAX_JSON)throw Error('Sync local recovery bound exceeded. Nothing was truncated.');
 if(key==='highwater'&&(!exact(value,['vaultId','revision','hash','keyCheck'])||!ID.test(value.vaultId)||!integer(value.revision)||!HASH.test(value.hash)||!ID.test(value.keyCheck)))throw Error('Invalid sync high-water checkpoint.');
 if(key==='anchor'){
  const names=['vaultId','via','approvedBy','reconciled','reason','reconciledAt','accountId','deviceId','publicKeyHash','approvalCheckpoint'];
  if(!value||Object.keys(value).some(k=>!names.includes(k))||!ID.test(value.vaultId)||!['genesis','approval','recovery'].includes(value.via)||value.approvedBy!==undefined&&!ID.test(value.approvedBy)||value.reconciled!==undefined&&typeof value.reconciled!=='boolean'||value.reason!==undefined&&!['all-devices-lost','local-anchor-missing'].includes(value.reason)||value.reconciledAt!==undefined&&!integer(value.reconciledAt))throw Error('Invalid sync trust anchor.');
  // Keep legacy anchors readable for backup preservation. The client refuses
  // approval trust without the complete new identity; storage never upgrades it.
  const identity=['accountId','deviceId','publicKeyHash','approvalCheckpoint'];
  if(identity.some(k=>Object.hasOwn(value,k))&&(value.via!=='approval'||!identity.every(k=>Object.hasOwn(value,k))||!ID.test(value.accountId)||!ID.test(value.deviceId)||!HASH.test(value.publicKeyHash)||!ID.test(value.approvedBy)||!exact(value.approvalCheckpoint,['revision','hash'])||!integer(value.approvalCheckpoint.revision)||!HASH.test(value.approvalCheckpoint.hash)))throw Error('Invalid approval identity checkpoint.');
 }
 if(key==='verified-outcomes'&&(!value||typeof value!=='object'||Array.isArray(value)||Object.entries(value).some(([id,binding])=>!ID.test(id)||!(typeof binding==='string'?HASH.test(binding):exact(binding,['schema','policy','source','readerEpoch','operationHash','claimHash'])&&binding.schema==='silo-local-outcome-cache-v2'&&typeof binding.policy==='string'&&binding.policy.length>0&&binding.policy.length<=128&&typeof binding.source==='string'&&/^[a-f0-9]{40}$/.test(binding.source)&&ID.test(binding.readerEpoch)&&HASH.test(binding.operationHash)&&HASH.test(binding.claimHash)))))throw Error('Invalid local outcome fingerprints.');
 if(key==='journal-shadow'){
  if(!exact(value,['vaultId','ref','upload'])||!ID.test(value.vaultId)||!exact(value.ref,['cls','id','sha256','bytes'])||value.ref.cls!=='journal')throw Error('Encrypted journal shadow required.');
  encryptedUpload(value.upload);if(value.upload.cls!=='journal'||value.ref.id!==value.upload.objectId||value.ref.sha256!==value.upload.sha256||value.ref.bytes!==value.upload.bytes)throw Error('Encrypted shadow identity mismatch.');
 }
 // Never the code: whether its owner confirmed writing it down, or the public id of a new recovery slot whose activation is in doubt.
 if(key==='recovery-code-note'&&(!(exact(value,['schema','vaultId','state'])&&value.state==='unconfirmed'||exact(value,['schema','vaultId','state','slotId','prior'])&&value.state==='replacing'&&/^[a-f0-9]{16}$/.test(value.slotId)&&['unconfirmed','confirmed'].includes(value.prior))||value.schema!=='silo-recovery-code-note-v1'||!ID.test(value.vaultId)))throw Error('Invalid recovery code note.');
 if(key==='genesis-intent'){
  // Round 2 adds the vault's public ownership anchor and, off mainnet, the network profile, so an unfinished creation can be
  // finished (client.resumeVaultCreation). An intent written before carries neither.
  const intentKeys=['schema','accountId','deviceId','vaultId','box',...(value?.authorityPublicKey!==undefined?['authorityPublicKey']:[]),...(value?.networkProfile!==undefined?['networkProfile']:[])];
  if(!exact(value,intentKeys)||(value.authorityPublicKey!==undefined&&!/^[A-Za-z0-9_-]{43}$/.test(value.authorityPublicKey))||(value.networkProfile!==undefined&&value.networkProfile!=='test-networks')||value.schema!=='silo-sync-genesis-intent-v1'||![value.accountId,value.deviceId,value.vaultId].every(v=>ID.test(v)))throw Error('Invalid encrypted genesis intent.');
  validate('outbox',value.box);const b=value.box.request.manifest.body;
  if(b.vaultId!==value.vaultId||b.writer!==value.deviceId||b.kind!=='genesis'||b.revision!==0||b.parent!==null||b.leaseEpoch!==null||value.box.request.expectedRevision!==-1||!Array.isArray(value.box.slots)||value.box.slots.length!==2)throw Error('Genesis intent identity mismatch.');
  if(value.box.request.slots!==undefined||value.box.slots.map(s=>s.kind).sort().join(',')!=='passphrase,recovery')throw Error('Genesis intent wrapped slots differ.');
  const refs=Object.values(b.objects).flatMap(ref=>ref?.cls==='scan-cache'?ref.chunks.map(c=>({...c,cls:'scan-chunk'})):ref?[ref]:[]);
  if(refs.length!==value.box.uploads.length||new Set(value.box.uploads.map(u=>u.objectId)).size!==refs.length||refs.some(ref=>!value.box.uploads.some(u=>u.objectId===ref.id&&u.cls===ref.cls&&u.sha256===ref.sha256&&u.bytes===ref.bytes)))throw Error('Genesis encrypted references differ.');
 }
 if(key==='outbox'){
  if(!exact(value,['request','uploads','slots'])||!Array.isArray(value.uploads)||value.uploads.length>1024||!value.request?.manifest?.body||!HASH.test(value.request.manifest.hash)||typeof value.request.manifest.mac!=='string'||!B64.test(value.request.manifest.mac)||!ID.test(value.request.idempotencyKey)||!Number.isSafeInteger(value.request.expectedRevision))throw Error('Encrypted sync outbox required.');
  value.uploads.forEach(encryptedUpload);manifest(value.request.manifest);if(value.slots!==null)wrappedSlots(value.slots);if(value.request.slots!==undefined)wrappedSlots(value.request.slots);
  // Manifest authentication and wrapped-slot validation belong to the sync client.
  // Unknown payload fields cannot smuggle a clear wallet into this durable adapter.
  if(Object.keys(value.request).some(k=>!['manifest','expectedRevision','idempotencyKey','slots','expectedSlotsHash','authorityPublicKey'].includes(k))||value.request.authorityPublicKey!==undefined&&(value.request.slots===undefined||!/^[A-Za-z0-9_-]{43}$/.test(value.request.authorityPublicKey))||(value.request.slots===undefined)!==(value.request.expectedSlotsHash===undefined)||value.request.expectedSlotsHash!==undefined&&!HASH.test(value.request.expectedSlotsHash))throw Error('Unexpected sync outbox fields.');
 }
 return value;
}
function same(a,b){return canonical(a)===canonical(b);}
export async function openBrowserSyncLocal({factory=globalThis.indexedDB,eventTarget=globalThis,onIdentityChange=()=>{}}={}){
 if(!factory?.open)throw Error('Durable IndexedDB sync storage is required.');
 let database,closed=false,cancelOpen,identity=null,epoch=0;const transactions=new Set();
 const abortPending=except=>{for(const tx of transactions){if(tx===except)continue;try{tx.abort();}catch{/* Already committed or aborted. */}}};
 const hide=()=>close();
 function change(next,except){if(same(identity,next))return epoch;identity=next;const stamp=++epoch;abortPending(except);onIdentityChange(next?structuredClone(next):null,'identity-change');return stamp;}
 function close(){if(closed)return;closed=true;epoch++;abortPending();eventTarget.removeEventListener?.('pagehide',hide);cancelOpen?.(Error('Sync local store closed while opening.'));database?.close();onIdentityChange(null,'close');}
 eventTarget.addEventListener?.('pagehide',hide);
 try{
  database=await new Promise((resolve,reject)=>{cancelOpen=reject;const req=factory.open('silo-account-sync-local-v1',1);req.onupgradeneeded=()=>req.result.createObjectStore('state');req.onerror=req.onblocked=()=>reject(Error('Sync local store is unavailable.'));req.onsuccess=()=>{if(closed){req.result.close();reject(Error('Sync local store closed while opening.'));}else resolve(req.result);};});cancelOpen=undefined;if(closed){database.close();throw Error('Sync local store closed while opening.');}database.onversionchange=close;
 }catch(error){close();throw error;}
 async function operate(key,mode,value){
  if(closed||!knownKey(key))throw Error('Sync local store is closed or key is unsupported.');
  if(mode==='set')value=structuredClone(validate(key,value));
  const startingEpoch=epoch;
  return new Promise((resolve,reject)=>{
   const tx=database.transaction('state',mode==='get'?'readonly':'readwrite'),store=tx.objectStore('state');let result,failed,acceptedEpoch=startingEpoch;transactions.add(tx);
   const fail=error=>{failed=error;try{tx.abort();}catch{/* Already finished. */}};
   const root=store.get('session');root.onsuccess=()=>{
    try{
     const current=root.result??null;if(current)sessionValue(current);
     if(closed||epoch!==acceptedEpoch)throw Error('Sync local operation was invalidated.');
     const previous=identity;
     if(!same(current,identity)){const changed=change(current,tx);if(key==='session'&&mode==='get')acceptedEpoch=changed;else throw Error('Authenticated account or device changed. Unlock again.');}
     if(closed||epoch!==acceptedEpoch)throw Error('Sync local operation was invalidated.');
     if(key!=='session'&&!same(previous,current))throw Error('Authenticated account or device changed. Unlock again.');
     if(key!=='session'&&!current)throw Error('Sign in before accessing account sync storage.');
     const slot=key==='session'?'session':`${current.accountId}:${key==='enroll'?current.deviceId+':':''}${key}`;
     const request=mode==='get'?store.get(slot):mode==='delete'?store.delete(slot):store.put(value,slot);
     request.onsuccess=()=>{try{
      if(closed||epoch!==acceptedEpoch)throw Error('Sync local operation was invalidated.');
      if(mode==='get'){result=request.result??null;if(result!==null)validate(key,result);}
      else if(mode==='set'){const check=store.get(slot);check.onsuccess=()=>{if(key==='enroll'){if(!check.result||check.result.privateKey?.extractable!==false)fail(Error('Enrollment key durability check failed.'));}else if(!same(check.result,value))fail(Error('Sync local save readback failed.'));};}
      else{const check=store.get(slot);check.onsuccess=()=>{if(check.result!==undefined)fail(Error('Sync local deletion readback failed.'));};}
     }catch(error){fail(error);}};
    }catch(error){fail(error);}
   };
   tx.onabort=tx.onerror=()=>{transactions.delete(tx);reject(failed??Error('Sync local storage transaction failed.'));};tx.oncomplete=()=>{transactions.delete(tx);if(closed||epoch!==acceptedEpoch){reject(Error('Sync local operation was invalidated.'));return;}if(key==='session'&&mode!=='get'){const stamp=change(mode==='set'?value:null);if(closed||epoch!==stamp){reject(Error('Sync local operation was invalidated.'));return;}}resolve(result??null);};
  });
 }
 // Initialize the persisted identity before account-scoped operations are allowed.
 await operate('session','get');
 return {invalidate(){if(closed)return;epoch++;abortPending();onIdentityChange(null,'invalidate');},get:key=>operate(key,'get'),set:(key,value)=>operate(key,'set',value),delete:key=>operate(key,'delete'),close,get closed(){return closed;},get epoch(){return epoch;}};
}
/** Creates a cookie-authenticated client; no routes or runtime are enabled here. */
export async function openBrowserSyncClient({origin=globalThis.location?.origin,factory,eventTarget=globalThis,documentTarget=globalThis.document,transport,verifiers={},signedSession=null,networkProfile='mainnet'}={}){
 if(typeof origin!=='string'||origin!==globalThis.location?.origin)throw Error('Same-origin account sync transport required.');
 let client,operation=null;const pendingTransports=new Set();
 const abortTransports=()=>{for(const controller of pendingTransports)controller.abort();};
 const local=await openBrowserSyncLocal({factory,eventTarget,onIdentityChange:(next,cause)=>{abortTransports();client?.lock();if(cause==='identity-change'&&((next&&operation?.name==='signIn')||(!next&&operation?.name==='signOut'))&&operation.epoch===local.epoch-1)operation.epoch=local.epoch;}});
 const transportSource=transport??httpTransport(origin);
 // Lock/close invalidates the caller promptly even if a custom transport ignores
 // AbortSignal. A remote mutation already admitted may still finish: preserve
 // existing ciphertext/outbox and reauthenticate before any later operation.
 // Local cancellation (lock, hidden page, close, account change) is marked so the
 // client never reports it as an unavailable service. Nothing else changes.
 const cancelled=message=>Object.assign(Error(message),{syncCancelled:true});
 const source=async request=>{
  const controller=new AbortController();let rejectAbort;
  const stopped=new Promise((_,reject)=>{rejectAbort=()=>reject(cancelled('Account transport was cancelled.'));controller.signal.addEventListener('abort',rejectAbort,{once:true});});
  pendingTransports.add(controller);
  try{if(local.closed)throw cancelled('Sync local store is closed.');return await Promise.race([Promise.resolve().then(()=>{if(controller.signal.aborted)throw cancelled('Account transport was cancelled.');return transportSource({...request,signal:controller.signal});}),stopped]);}
  catch(error){if(controller.signal.aborted)throw cancelled('Account transport was cancelled.');throw error;}
  finally{pendingTransports.delete(controller);controller.signal.removeEventListener('abort',rejectAbort);}
 };
 client=createSyncClient({local,verifiers,networkProfile,transport:async request=>{
  if(local.closed)throw cancelled('Sync local store is closed.');const before=local.epoch;
  const unchanged=()=>{if(local.closed||before!==local.epoch||operation&&operation.epoch!==local.epoch){client.lock();throw cancelled('Account context changed during sync.');}};
  unchanged();let boundHeaders=request.headers;
  if(!request.path.startsWith('/auth/')){
   const expected=await local.get('session');unchanged();
   if(!expected){client.lock();throw Error('Account sign-in is required.');}
   if(signedSession){
    // Signed path: every request is bound to its account and device by the device signature, so there is no /me
    // pre-check. The persisted identity must still be the signed session this device key holds.
    const bound=await signedSession();unchanged();
    if(!bound||bound.accountId!==expected.accountId||bound.deviceId!==expected.deviceId||expected.token!=='signed-session'){client.lock();throw Object.assign(Error('This device is not signed in to the account.'),{syncSessionRejected:true});}
   }else{
   // Cookies can change without IndexedDB metadata changing. Authenticate the
   // current cookie before sending any vault payload under a persisted account.
   boundHeaders={...request.headers,'x-silo-account-id':expected.accountId,'x-silo-device-id':expected.deviceId,...(expected.authEpoch?{'x-silo-auth-epoch':expected.authEpoch}:{})};
   const checked=await source({method:'GET',path:'/me',headers:boundHeaders});unchanged();
   // 401: the server has no signed-in session for this device. It does not say why
   // (expired, signed out, or device removed), so neither does the client.
   if(checked.status===401){client.lock();throw Object.assign(Error('This device is not signed in to the account.'),{syncSessionRejected:true});}
   if(checked.status!==200||checked.body?.accountId!==expected.accountId||checked.body?.deviceId!==expected.deviceId||expected.authEpoch&&checked.body?.authEpoch!==expected.authEpoch){client.lock();throw Error('Authenticated account or device differs from the local checkpoint. Sign in again.');}
   if(request.path==='/me'&&request.method==='GET')return checked;
   }
  }
  const response=await source({...request,headers:boundHeaders});unchanged();return response;
 }});
 const visibility=()=>{if(documentTarget?.visibilityState==='hidden')local.invalidate();};documentTarget?.addEventListener?.('visibilitychange',visibility);
 const close=()=>{documentTarget?.removeEventListener?.('visibilitychange',visibility);client.lock();local.close();};
 const guarded=new Proxy(client,{get(target,name){
  const value=target[name];if(typeof value!=='function')return value;
  if(name==='lock')return ()=>local.invalidate();
  // Local-only calls that never reach the account: dropping a prepared recovery code is part of every lock and must work
  // while another operation is still running (a lock cancels that operation).
  if(['subscribe','walletBackup','discardRecoveryCodeReplacement'].includes(name))return (...args)=>value.apply(target,args);
  return (...args)=>{
   if(operation)throw Error('A sync operation is already pending.');
   const active={name,epoch:local.epoch};operation=active;
   let result;try{result=value.apply(target,args);}catch(error){operation=null;throw error;}
   if(!result?.then){operation=null;return result;}
   return result.then(answer=>{if(local.closed||active.epoch!==local.epoch){target.lock();throw Error('Sync operation was invalidated.');}return answer;}).finally(()=>{if(local.closed||active.epoch!==local.epoch)target.lock();if(operation===active)operation=null;});
  };
 }});
 return {client:guarded,local,close};
}
/** The same durable store, validators, cancellation and operation guard as the web client, over device-signed requests
 * (signed-transport.mjs). For packaged clients such as the Chrome extension; the web wallet keeps openBrowserSyncClient. */
export async function openSignedSyncClient({accountOrigin,deviceKeys,requestOrigin=globalThis.location?.origin,fetcher,...options}={}){
 return openBrowserSyncClient({...options,transport:signedTransport({accountOrigin,deviceKeys,requestOrigin,fetcher}),signedSession:()=>deviceKeys.session()});
}
