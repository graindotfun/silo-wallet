// SPDX-License-Identifier: AGPL-3.0-only
/** Device unlock (Face ID, fingerprint, Windows Hello or the device PIN) instead of typing the passphrase every time. A passkey with the WebAuthn PRF extension
 * releases a 32-byte secret only after the device check; that secret (through HKDF) is the key that encrypts the wallet passphrase, and the encrypted passphrase is
 * kept ON THIS DEVICE ONLY. The passphrase stays the root of recovery and the only way in on a new device: nothing here changes a wallet, a backup or any key.
 *
 * Stored (ciphertext only): {version, state, credentialId, rpId, salt, iv, ciphertext, createdAt}. TWO-PHASE: an enrolment first stores the blob as state 'pending' (never usable: it is reported off and
 * unlock refuses it), then ACTIVATES it as the very last step, only while authority is still current, inside the storage transaction. Any failure or lock before activation leaves at most a pending
 * (unusable) record, so no combination of cleanup failures can leave a usable capability behind. Never stored in plain form: the passphrase, the PRF output, the derived key (the passphrase is stored only as ciphertext under the derived key).
 * Nothing goes to a server, a URL, a log or analytics.
 *
 * Support is never decided by user agent. Setup performs a REAL create and then a real get() twice with the same salt and requires the same 32 bytes both times;
 * anything else (no PRF, a different value, an error, a cancelled prompt) stores nothing and reports "not available". All platform access is injected, so every path
 * is tested. Unlocking checks `isCurrent()` after the device ceremony: a result that arrives after a lock is discarded and its passphrase never returned. */
const VERSION=1,INFO='silo-device-unlock-v1',SALT_PREFIX='silo-device-unlock-salt-v1:';
export const SILO_DEVICE_UNLOCK_ERRORS=Object.freeze({unavailable:'unavailable',cancelled:'cancelled',mismatch:'mismatch',stale:'stale',missing:'missing',corrupt:'corrupt',failed:'failed'});
const fail=(message,reason,cause)=>Object.assign(Error(message),{siloDeviceUnlock:reason,cause});
const b64=bytes=>{let raw='';const view=new Uint8Array(bytes);for(let i=0;i<view.length;i+=8192)raw+=String.fromCharCode(...view.subarray(i,i+8192));return btoa(raw);};
const unb64=text=>{if(typeof text!=='string'||text.length>4096)throw fail('Device unlock data is damaged.','corrupt');try{const raw=atob(text),out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out;}catch{throw fail('Device unlock data is damaged.','corrupt');}};
const encoder=new TextEncoder(),decoder=new TextDecoder();
/** The ACTIVATION RECEIPT: written SYNCHRONOUSLY in the same JavaScript task as the final authority check, so no lock can land between the check and the receipt. An active record is
 * usable only together with the receipt that names it. An activation whose receipt was never written (a lock landed after the in-transaction checks, or storage refused it) is therefore
 * unusable on its own, whatever happens to cleanup. */
const RECEIPT='silo-device-unlock-receipt-v1';
const receiptId=blob=>`${blob.createdAt}:${String(blob.credentialId).slice(0,16)}`;
export function defaultReceipt(scope=globalThis){
 return {
  set(blob){try{scope.localStorage.setItem(RECEIPT,receiptId(blob));return scope.localStorage.getItem(RECEIPT)===receiptId(blob);}catch{return false;}},
  clear(){try{scope.localStorage.removeItem(RECEIPT);}catch{/* a leftover receipt names a record that no longer exists: harmless */}},
  matches(blob){try{return Boolean(blob)&&scope.localStorage.getItem(RECEIPT)===receiptId(blob);}catch{return false;}},
 };
}
/** A synchronous, independent REVOCATION MARKER (a different storage mechanism from the blob's IndexedDB). It is set before any compensating deletion and cleared only when the
 * deletion is confirmed: while it is set, device unlock is reported off and the stored blob is never used, so a deletion that fails can never leave a usable capability. */
const REVOKED='silo-device-unlock-revoked-v1';
export function defaultRevocation(scope=globalThis){
 return {
  mark(){try{scope.localStorage.setItem(REVOKED,'1');return scope.localStorage.getItem(REVOKED)==='1';}catch{return false;}},
  clear(){try{scope.localStorage.removeItem(REVOKED);}catch{/* the marker stays; device unlock stays off, which is the safe direction */}},
  marked(){try{return scope.localStorage.getItem(REVOKED)==='1';}catch{return false;}},
 };
}
const equal=(a,b)=>{if(a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;};
/** Quick, non-decisive check used only to decide whether to show an offer at all. The real test is enrolDeviceUnlock. */
export function siloDeviceUnlockMaybeSupported(scope=globalThis){return Boolean(scope?.PublicKeyCredential&&scope?.navigator?.credentials?.create&&scope?.navigator?.credentials?.get&&scope?.isSecureContext!==false&&scope?.crypto?.subtle);}
async function deriveKey(prf,usage){
 const material=await crypto.subtle.importKey('raw',prf,'HKDF',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:new Uint8Array(0),info:encoder.encode(INFO)},material,{name:'AES-GCM',length:256},false,usage);
}
const aad=header=>encoder.encode(JSON.stringify({version:header.version,credentialId:header.credentialId,rpId:header.rpId,salt:header.salt}));
/** The 32-byte PRF output carried by a create() or get() result, or null when absent or the wrong size. */
function readPrf(credential){
 const result=credential?.getClientExtensionResults?.()?.prf?.results?.first;
 if(!result)return null;
 const out=new Uint8Array(result instanceof ArrayBuffer?result:result.buffer?result.buffer.slice(result.byteOffset,result.byteOffset+result.byteLength):result);
 if(out.length===32)return out;
 out.fill(0);return null; // a wrong-size output is wiped, never kept
}
/** One get() with the PRF salt; returns the 32-byte output or throws a typed error. */
async function evaluate(credentials,{credentialId,salt,rpId,challenge,signal}){
 let assertion;
 try{assertion=await credentials.get({publicKey:{challenge,rpId,allowCredentials:[{type:'public-key',id:credentialId}],userVerification:'required',timeout:60000,extensions:{prf:{eval:{first:salt}}}},signal});}
 catch(error){throw fail(error?.name==='NotAllowedError'||error?.name==='AbortError'?'The device check was cancelled.':'Device unlock is not available here.',error?.name==='NotAllowedError'||error?.name==='AbortError'?'cancelled':'unavailable',error);}
 const result=assertion?.getClientExtensionResults?.()?.prf?.results?.first;
 if(!result)throw fail('Device unlock is not available here.','unavailable');
 const out=new Uint8Array(result instanceof ArrayBuffer?result:result.buffer?result.buffer.slice(result.byteOffset,result.byteOffset+result.byteLength):result);
 if(out.length!==32)throw fail('Device unlock is not available here.','unavailable');
 return out;
}
/** Setup. Creates a passkey, proves PRF works (the same 32 bytes twice), encrypts `passphrase` and stores the blob only after a successful round trip. */
/** @param {{passphrase:string,rpId:string,credentials?:any,store:any,isCurrent?:()=>boolean,signal?:AbortSignal,revocation?:any,receipt?:any,random?:(b:Uint8Array)=>Uint8Array,now?:()=>number}} options */
export async function enrolDeviceUnlock({passphrase,rpId,credentials=globalThis.navigator?.credentials,store,isCurrent=()=>true,signal=undefined,revocation=defaultRevocation(),receipt=defaultReceipt(),random=bytes=>crypto.getRandomValues(bytes),now=Date.now}){
 const stale=()=>fail('The wallets were locked meanwhile. Device unlock was not turned on.','stale');
 if(typeof passphrase!=='string'||passphrase.length<12)throw fail('Enter your passphrase first.','failed');
 if(!credentials?.create||!credentials?.get||!store||typeof rpId!=='string'||!rpId)throw fail('Device unlock is not available here.','unavailable');
 if(revocation.marked()){try{await removeDeviceUnlock(store,{revocation});}catch(error){throw Object.assign(fail('A previous device unlock could not be removed yet. Turn it off in Settings first.','failed',error),{stuck:true});}}
 const salt=random(new Uint8Array(32)),userId=random(new Uint8Array(16)),challenge=random(new Uint8Array(32));
 let created;
 try{created=await credentials.create({publicKey:{challenge,rp:{id:rpId,name:'Silo'},user:{id:userId,name:'silo-device-unlock',displayName:'Silo device unlock'},pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-257}],authenticatorSelection:{userVerification:'required',residentKey:'preferred'},timeout:60000,attestation:'none',extensions:{prf:{eval:{first:salt}}}},signal});}
 catch(error){throw fail(error?.name==='NotAllowedError'||error?.name==='AbortError'?'The device check was cancelled.':'Device unlock is not available here.',error?.name==='NotAllowedError'||error?.name==='AbortError'?'cancelled':'unavailable',error);}
 if(!created?.rawId)throw fail('Device unlock is not available here.','unavailable');
 const credentialId=new Uint8Array(created.rawId);
 // Read (and so own) the PRF output from create() BEFORE the freshness check, so a stale ceremony wipes it instead of leaving it behind.
 const fromCreate=readPrf(created);
 if(!isCurrent()){fromCreate?.fill(0);throw stale();}
 // The decisive test: the same 32 bytes from two separate assertions with the same salt.
 // Fewer prompts: when create() already returned the PRF output for this salt, it is the first sample and only ONE more person check is needed (2 prompts in all instead of 3).
 const first=fromCreate||await evaluate(credentials,{credentialId,salt,rpId,challenge:random(new Uint8Array(32)),signal});
 let second;try{second=await evaluate(credentials,{credentialId,salt,rpId,challenge:random(new Uint8Array(32)),signal});}catch(error){first.fill(0);throw error;}
 if(!equal(first,second)){first.fill(0);second.fill(0);throw fail('Device unlock is not available here.','mismatch');}
 second.fill(0);
 if(!isCurrent()){first.fill(0);throw stale();}
 const header={version:VERSION,credentialId:b64(credentialId),rpId,salt:b64(salt)},iv=random(new Uint8Array(12));
 const plain=encoder.encode(passphrase);
 let blob;
 try{
  const key=await deriveKey(first,['encrypt','decrypt']);
  const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(header)},key,plain));
  blob={...header,state:'pending',iv:b64(iv),ciphertext:b64(ciphertext),createdAt:now()};
  const back=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad(header)},key,ciphertext));
  const ok=equal(back,plain);back.fill(0);if(!ok)throw fail('Device unlock could not be set up.','failed');
 }catch(error){if(error?.siloDeviceUnlock)throw error;throw fail('Device unlock could not be set up.','failed',error);}
 finally{plain.fill(0);first.fill(0);}
 // Phase 1: durably store the blob as PENDING (unusable). If this fails the enrolment is refused: nothing exists. The write is guarded INSIDE the storage transaction.
 const dropPending=async()=>{try{await removeDeviceUnlock(store,{revocation});}catch{/* a pending record is never usable: reported off, refused by unlock, overwritten by the next enrolment */}};
 if(!isCurrent())throw stale();
 try{await store.write(blob,{isCurrent});}
 catch(error){if(error?.siloDeviceUnlock==='stale')throw stale();throw error;}
 if(!isCurrent()){await dropPending();throw stale();}
 // Phase 2, the LAST step: activate, with the authority checked INSIDE the activation transaction twice (when the pending record is read and again when the active write completes; either failing
 // aborts it). Then the SYNCHRONOUS commit point: the final check and the activation receipt are written in the same task, so no lock can land between them. Without the receipt the active
 // record is unusable, whatever happens next to cleanup.
 try{await store.activate({isCurrent});}
 catch(error){await dropPending();if(error?.siloDeviceUnlock==='stale')throw stale();throw error instanceof Error&&error.siloDeviceUnlock?error:fail('Device unlock could not be turned on.','failed',error);}
 if(!isCurrent()){await dropPending();throw stale();}
 if(!receipt.set(blob)){await dropPending();throw fail('Device unlock could not be turned on.','failed');}
 return {enabled:true,createdAt:blob.createdAt};
}
/** Unlock. Returns the passphrase only if the device check passed AND `isCurrent()` is still true when the ceremony ends (a lock since then discards it). */
/** @param {{credentials?:any,store:any,isCurrent?:()=>boolean,revocation?:any,receipt?:any,random?:(b:Uint8Array)=>Uint8Array,signal?:AbortSignal}} options */
export async function unlockWithDevice({credentials=globalThis.navigator?.credentials,store,isCurrent=()=>true,revocation=defaultRevocation(),receipt=defaultReceipt(),random=bytes=>crypto.getRandomValues(bytes),signal}){
 if(revocation.marked())throw fail('Device unlock is not set up.','missing');
 const blob=await store.read();
 if(!blob)throw fail('Device unlock is not set up.','missing');
 if(blob.version!==VERSION||typeof blob.rpId!=='string')throw fail('Device unlock data is damaged.','corrupt');
 if(blob.state!=='active'||!receipt.matches(blob))throw fail('Device unlock is not set up.','missing');
 const credentialId=unb64(blob.credentialId),salt=unb64(blob.salt),iv=unb64(blob.iv),ciphertext=unb64(blob.ciphertext);
 if(salt.length!==32||iv.length!==12||ciphertext.length<17||ciphertext.length>1024)throw fail('Device unlock data is damaged.','corrupt');
 const prf=await evaluate(credentials,{credentialId,salt,rpId:blob.rpId,challenge:random(new Uint8Array(32)),signal});
 let plain=null;
 try{
  if(!isCurrent())throw fail('The wallets were locked meanwhile.','stale');
  const key=await deriveKey(prf,['decrypt']);
  try{plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad(blob)},key,ciphertext));}
  catch{throw fail('Device unlock stopped working.','corrupt');}
  if(!isCurrent())throw fail('The wallets were locked meanwhile.','stale');
  return decoder.decode(plain);
 }finally{prf.fill(0);plain?.fill(0);}
}
/** Resolves only after the stored data is CONFIRMED gone (the delete committed and a read finds nothing). Anything else throws: the caller must not report "off". */
export async function removeDeviceUnlock(store,{revocation=defaultRevocation(),receipt=defaultReceipt()}={}){
 await store.remove();
 let remaining;try{remaining=await store.read();}catch(error){throw fail('Device unlock could not be confirmed off.','failed',error);}
 if(remaining)throw fail('Device unlock could not be turned off.','failed');
 receipt.clear();revocation.clear();
}
export async function deviceUnlockEnabled(store,{revocation=defaultRevocation(),receipt=defaultReceipt()}={}){if(revocation.marked())return false;try{const blob=await store.read();return Boolean(blob&&blob.version===VERSION&&blob.state==='active'&&receipt.matches(blob));}catch{return false;}}
/** IndexedDB blob store (one record). Injected in tests. */
export function openDeviceUnlockStore(factory=globalThis.indexedDB){
 const open=()=>new Promise((resolve,reject)=>{if(!factory){reject(fail('Device unlock is not available here.','unavailable'));return;}const request=factory.open('silo-device-unlock-v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('blob');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(fail('Device unlock storage is unavailable.','unavailable'));});
 const run=async(mode,action)=>{const db=await open();try{return await new Promise((resolve,reject)=>{const tx=db.transaction('blob',mode);let result,guarded=false;const request=action(tx.objectStore('blob'),{tx,markStale(){guarded=true;}});request.onsuccess=()=>{result=request.result;};tx.oncomplete=()=>resolve(result);tx.onabort=tx.onerror=()=>reject(guarded?fail('The wallets were locked meanwhile.','stale'):fail('Device unlock storage failed.','failed'));});}finally{db.close();}};
 return {activate:({isCurrent}={})=>run('readwrite',(s,{tx,markStale})=>{const get=s.get('device');get.addEventListener('success',()=>{const record=get.result;if(!record||record.state!=='pending'||(typeof isCurrent==='function'&&!isCurrent())){if(typeof isCurrent==='function'&&!isCurrent())markStale();tx.abort();return;}const put=s.put({...record,state:'active'},'device');if(typeof isCurrent==='function')put.addEventListener('success',()=>{if(!isCurrent()){markStale();tx.abort();}});});return get;}),read:()=>run('readonly',s=>s.get('device')).then(v=>v??null),write:(blob,{isCurrent}={})=>run('readwrite',(s,{tx,markStale})=>{const request=s.put(blob,'device');if(typeof isCurrent==='function')request.addEventListener('success',()=>{if(!isCurrent()){markStale();tx.abort();}});return request;}),remove:()=>run('readwrite',s=>s.delete('device'))};
}
