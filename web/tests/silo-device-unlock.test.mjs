import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {enrolDeviceUnlock,unlockWithDevice,removeDeviceUnlock,deviceUnlockEnabled,siloDeviceUnlockMaybeSupported,defaultReceipt} from '../lib/silo/device-unlock.mjs';

const PASS='marble orchid tundra compass 905';
// The default marker and receipt use localStorage: give Node a Storage (the module only writes its two flags there, never the passphrase).
const storageMap=new Map();globalThis.localStorage={getItem:k=>storageMap.has(k)?storageMap.get(k):null,setItem:(k,v)=>void storageMap.set(k,String(v)),removeItem:k=>void storageMap.delete(k)};
const memory=()=>{let blob=null;return {reads:0,writes:0,async read(){this.reads++;return blob?structuredClone(blob):null;},
 // Like the real IndexedDB store: the authority guard runs INSIDE the write and a stale guard aborts it (nothing is stored).
 async write(b,{isCurrent}={}){if(isCurrent&&!isCurrent())throw Object.assign(Error('aborted'),{siloDeviceUnlock:'stale'});this.writes++;blob=structuredClone(b);},
 // Activation is a compare-and-set inside the store: only a PENDING record, only while the authority guard still holds.
 async activate({isCurrent}={}){if(!blob||blob.state!=='pending')throw Object.assign(Error('nothing to activate'),{siloDeviceUnlock:'failed'});if(isCurrent&&!isCurrent())throw Object.assign(Error('aborted'),{siloDeviceUnlock:'stale'});const next={...blob,state:'active'};if(isCurrent&&!isCurrent())throw Object.assign(Error('aborted at put completion'),{siloDeviceUnlock:'stale'});blob=next;},async remove(){blob=null;},peek:()=>blob};};
const marker=()=>{let on=false;return {mark(){on=true;return true;},clear(){on=false;},marked:()=>on,isOn:()=>on};};
const noMarker=()=>({mark:()=>false,clear(){},marked:()=>false});
/** A stand-in authenticator: PRF(secret, salt) is deterministic per credential like a real one. */
function authenticator({prf='deterministic',createError=null,getError=null,onGet=null}={}){
 const secrets=new Map();let n=0;
 const hmac=async(secret,salt)=>{const key=await crypto.subtle.importKey('raw',secret,{name:'HMAC',hash:'SHA-256'},false,['sign']);return new Uint8Array(await crypto.subtle.sign('HMAC',key,salt));};
 return {
  async create(){if(createError)throw Object.assign(Error('x'),{name:createError});const id=new Uint8Array(16).fill(++n);secrets.set(id.join(','),crypto.getRandomValues(new Uint8Array(32)));return {rawId:id.buffer,getClientExtensionResults:()=>({prf:{enabled:prf!=='none'}})};},
  async get({publicKey}){
   if(getError)throw Object.assign(Error('x'),{name:getError});
   await onGet?.();
   const id=new Uint8Array(publicKey.allowCredentials[0].id),secret=secrets.get(id.join(','));if(!secret)throw Object.assign(Error('no credential'),{name:'NotAllowedError'});
   const salt=publicKey.extensions.prf.eval.first;
   const out=prf==='none'?undefined:prf==='random'?crypto.getRandomValues(new Uint8Array(32)):prf==='short'?(await hmac(secret,salt)).slice(0,16):await hmac(secret,salt);
   return {getClientExtensionResults:()=>(out?{prf:{results:{first:out.buffer}}}:{})};
  },
 };
}
const enrol=(credentials,store,extra={})=>enrolDeviceUnlock({passphrase:PASS,rpId:'silo.test',credentials,store,revocation:noMarker(),...extra});
const reason=error=>error?.siloDeviceUnlock;

test('setup proves PRF with the same 32 bytes twice, stores only ciphertext, and unlock returns the passphrase',async()=>{
 const credentials=authenticator(),store=memory();
 assert.deepEqual(await enrol(credentials,store).then(r=>({enabled:r.enabled})),{enabled:true});
 const blob=store.peek();assert.deepEqual(Object.keys(blob).sort(),['ciphertext','createdAt','credentialId','iv','rpId','salt','state','version']);assert.equal(blob.state,'active');
 assert.ok(!JSON.stringify(blob).includes(PASS),'the passphrase is not in the stored blob');
 assert.equal(await unlockWithDevice({credentials,store}),PASS);assert.equal(await deviceUnlockEnabled(store),true);
});

test('setup stores NOTHING when PRF is missing, different on a second ask, short, cancelled or the browser refuses',async()=>{
 for(const [name,options] of [['no prf',{prf:'none'}],['random per call',{prf:'random'}],['short output',{prf:'short'}],['cancelled at create',{createError:'NotAllowedError'}],['unsupported at create',{createError:'NotSupportedError'}],['cancelled at get',{getError:'NotAllowedError'}],['error at get',{getError:'SecurityError'}]]){
  const store=memory();await assert.rejects(enrol(authenticator(options),store),error=>['unavailable','mismatch','cancelled'].includes(reason(error)),name);
  assert.equal(store.writes,0,name+': nothing stored');
 }
 await assert.rejects(enrolDeviceUnlock({passphrase:'short',rpId:'silo.test',credentials:authenticator(),store:memory()}),error=>reason(error)==='failed');
 await assert.rejects(enrolDeviceUnlock({passphrase:PASS,rpId:'',credentials:authenticator(),store:memory()}),error=>reason(error)==='unavailable');
 await assert.rejects(enrolDeviceUnlock({passphrase:PASS,rpId:'silo.test',credentials:undefined,store:memory()}),error=>reason(error)==='unavailable');
});

test('unlock distinguishes missing setup, a cancelled device check, a lost passkey, and damaged or tampered data',async()=>{
 const credentials=authenticator(),store=memory();
 await assert.rejects(unlockWithDevice({credentials,store}),error=>reason(error)==='missing');
 await enrol(credentials,store);
 await assert.rejects(unlockWithDevice({credentials:authenticator({getError:'NotAllowedError'}),store}),error=>reason(error)==='cancelled');
 await assert.rejects(unlockWithDevice({credentials:authenticator(),store}),error=>['cancelled','unavailable'].includes(reason(error)),'a passkey that no longer exists');
 const good=store.peek();
 const tamper=async patch=>{const bad=memory();await bad.write({...good,...patch});return unlockWithDevice({credentials,store:bad});};
 await assert.rejects(tamper({ciphertext:good.ciphertext.replace(/^../,m=>m==='AA'?'BB':'AA')}),error=>reason(error)==='corrupt','ciphertext changed');
 await assert.rejects(tamper({rpId:'other.test'}),error=>['corrupt','cancelled','unavailable'].includes(reason(error)),'rpId changed');
 await assert.rejects(tamper({salt:good.salt.replace(/^../,m=>m==='AA'?'BB':'AA')}),error=>reason(error)==='corrupt','salt changed');
 await assert.rejects(tamper({iv:'AAAA'}),error=>reason(error)==='corrupt');
 await assert.rejects(tamper({version:2}),error=>reason(error)==='corrupt');
 await assert.rejects(tamper({credentialId:'!!!'}),error=>['corrupt','missing'].includes(reason(error)),'a changed credential id no longer matches the activation receipt');
});

test('a device check that finishes AFTER a lock is discarded: the passphrase is never returned (stale ceremony)',async()=>{
 let current=true;const credentials=authenticator(),store=memory();await enrol(credentials,store);
 const late=authenticator({onGet:async()=>{current=false;}});
 // Same secrets: reuse the enrolled authenticator but flip the generation while the ceremony runs.
 const wrapped={create:credentials.create,get:async options=>{current=false;return credentials.get(options);}};
 await assert.rejects(unlockWithDevice({credentials:wrapped,store,isCurrent:()=>current}),error=>reason(error)==='stale');
 current=true;assert.equal(await unlockWithDevice({credentials,store,isCurrent:()=>current}),PASS,'still works when nothing locked');
});

test('removal deletes the blob; the passphrase and every other part of Silo are untouched',async()=>{
 const credentials=authenticator(),store=memory();await enrol(credentials,store);
 await removeDeviceUnlock(store);assert.equal(store.peek(),null);assert.equal(await deviceUnlockEnabled(store),false);
 await assert.rejects(unlockWithDevice({credentials,store}),error=>reason(error)==='missing');
});

test('the quick check is only a hint and the module never touches a server, storage of the passphrase or a log',()=>{
 assert.equal(siloDeviceUnlockMaybeSupported({}),false);
 assert.equal(siloDeviceUnlockMaybeSupported({PublicKeyCredential:class{},navigator:{credentials:{create(){},get(){}}},isSecureContext:true,crypto:{subtle:{}}}),true);
 assert.equal(siloDeviceUnlockMaybeSupported({PublicKeyCredential:class{},navigator:{credentials:{create(){},get(){}}},isSecureContext:false,crypto:{subtle:{}}}),false);
 const source=readFileSync(new URL('../lib/silo/device-unlock.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/sessionStorage|fetch\(|XMLHttpRequest|sendBeacon|console\.|userAgent/);
 assert.equal((source.match(/setItem\(/g)||[]).length,2,'the only storage writes outside IndexedDB are the revocation marker and the activation receipt (never the passphrase)');assert.match(source,/setItem\(REVOKED,'1'\)/);assert.match(source,/setItem\(RECEIPT,receiptId\(blob\)\)/);
});

const unusable=async(store,credentials,revocation=noMarker())=>{
 assert.equal(await deviceUnlockEnabled(store,{revocation}),false,'reported off');
 await assert.rejects(unlockWithDevice({credentials,store,revocation}),error=>reason(error)==='missing','and refused by unlock: it can never return the passphrase');
};

test('H2: two-phase enrolment: authority is checked at every step; a stale completion can never leave a USABLE capability, only at most a pending (unusable) record',async()=>{
 // isCurrent flips at call N: 1 after create, 2 after the two get() checks, 3 before the pending write, 4 inside the pending write's guard (aborts), 5 after the pending write committed,
 // 6 inside the activation transaction when the pending record is read, 7 when the active write completes (both abort), 8 the final synchronous check before the receipt.
 for(const flipAt of [1,2,3,4,5,6,7,8]){
  const credentials=authenticator(),store=memory();let calls=0;
  await assert.rejects(enrol(credentials,store,{isCurrent:()=>++calls<flipAt}),error=>reason(error)==='stale',`flip at ${flipAt}`);
  assert.equal(store.peek(),null,`flip at ${flipAt}: nothing left behind (the pending record was dropped)`);
  await unusable(store,credentials);
 }
 // A lock after activation is not stale authority: the enrolment completed while authority was current, so it is truthfully on.
 const credentials=authenticator(),store=memory();let calls=0;
 await enrol(credentials,store,{isCurrent:()=>++calls<9});assert.equal(await deviceUnlockEnabled(store,{revocation:noMarker()}),true);
});

test('H2 (Astra round 4): an active record WITHOUT the synchronous activation receipt is unusable: a lock landing between the activation commit and the final check cannot leave a usable capability, even when every cleanup fails',async()=>{
 const credentials=authenticator(),store=memory();store.remove=async()=>{throw new Error('delete aborted');};
 let writes=0;const write=store.write.bind(store);store.write=async(...a)=>{writes++;if(writes>1)throw new Error('no further writes');return write(...a);};
 let calls=0;
 await assert.rejects(enrol(credentials,store,{isCurrent:()=>++calls<8}),error=>reason(error)==='stale');      // flips at the final check, after the activation transaction committed
 assert.equal(store.peek().state,'active','the activation DID commit');
 assert.equal(await deviceUnlockEnabled(store),false,'but it is reported off: no receipt names it');
 await assert.rejects(unlockWithDevice({credentials,store}),error=>reason(error)==='missing','and an attempted unlock (as after a reload) does not unlock');
 // The receipt is written in the same synchronous step as the final check: a receipt that cannot be written refuses the enrolment.
 const noReceipt={set:()=>false,clear(){},matches:()=>false},s2=memory();
 await assert.rejects(enrol(authenticator(),s2,{receipt:noReceipt}),error=>reason(error)==='failed');assert.equal(s2.peek(),null);
 // A different receipt (another enrolment, or one left behind) does not make a record usable.
 const other=memory();await enrol(credentials,other);const r=defaultReceipt();storageMap.set('silo-device-unlock-receipt-v1','9:other');
 assert.equal(r.matches(other.peek()),false);await assert.rejects(unlockWithDevice({credentials,store:other}),error=>reason(error)==='missing');
});

test('H2 residual (Astra round 3): when EVERY cleanup fails (marker, deletion, tombstone) the leftover is only a PENDING record: after a reload an attempted unlock does NOT unlock',async()=>{
 for(const flipAt of [5,6]){
  const credentials=authenticator(),store=memory();
  store.remove=async()=>{throw new Error('delete aborted');};                      // the compensating deletion fails
  const noStorageMarker={mark:()=>false,clear(){},marked:()=>false};                 // the marker cannot be written
  let writes=0;const write=store.write.bind(store);store.write=async(...a)=>{writes++;if(writes>1)throw new Error('tombstone write fails');return write(...a);};
  let calls=0;
  await assert.rejects(enrol(credentials,store,{revocation:noStorageMarker,isCurrent:()=>++calls<flipAt}),error=>reason(error)==='stale');
  assert.notEqual(store.peek(),null,'the record could not be removed');assert.equal(store.peek().state,'pending','but it is only PENDING');
  // "Reload": nothing in memory survives; only what is stored. The attempted unlock must not return the passphrase.
  assert.equal(await deviceUnlockEnabled(store,{revocation:noStorageMarker}),false);
  await assert.rejects(unlockWithDevice({credentials,store,revocation:noStorageMarker}),error=>reason(error)==='missing');
 }
});

test('the pending write is REFUSED when it fails: no enrolment without a durable inactive state first',async()=>{
 const credentials=authenticator(),store=memory();store.write=async()=>{throw Object.assign(new Error('quota'),{siloDeviceUnlock:'failed'});};
 await assert.rejects(enrol(credentials,store),error=>reason(error)==='failed');assert.equal(store.peek(),null);await unusable(store,credentials);
 const failing=memory();failing.activate=async()=>{throw new Error('activation failed');};
 await assert.rejects(enrol(authenticator(),failing),error=>reason(error)==='failed');assert.equal(failing.peek(),null,'a failed activation drops the pending record');
 const stuck=memory();stuck.activate=async()=>{throw new Error('activation failed');};stuck.remove=async()=>{throw new Error('x');};
 await assert.rejects(enrol(authenticator(),stuck),error=>reason(error)==='failed');assert.equal(stuck.peek().state,'pending','if the drop also fails it stays pending, unusable');await unusable(stuck,authenticator());
});

test('a leftover revocation marker is cleaned up before a new enrolment, and an unconfirmed cleanup blocks it',async()=>{
 const store=memory(),m=marker();m.mark();
 await enrol(authenticator(),store,{revocation:m});assert.equal(m.isOn(),false);assert.notEqual(store.peek(),null);
 const broken=memory(),m2=marker();m2.mark();broken.remove=async()=>{throw new Error('x');};
 await assert.rejects(enrol(authenticator(),broken,{revocation:m2}),error=>error.stuck===true);assert.equal(broken.writes,0);
});

test('H1: removal is reported only after the stored data is confirmed gone',async()=>{
 const credentials=authenticator();
 const silent=memory();await enrol(credentials,silent);silent.remove=async()=>{};                       // a delete that "succeeds" but leaves the blob
 await assert.rejects(removeDeviceUnlock(silent,{revocation:noMarker()}),error=>reason(error)==='failed');assert.equal(await deviceUnlockEnabled(silent),true,'still on, not a lie');
 const aborted=memory();await enrol(credentials,aborted);aborted.remove=async()=>{throw new Error('transaction aborted');};
 await assert.rejects(removeDeviceUnlock(aborted));assert.equal(await deviceUnlockEnabled(aborted),true);
 const unreadable=memory();await enrol(credentials,unreadable);const read=unreadable.read.bind(unreadable);let removed=false;unreadable.remove=async()=>{removed=true;};unreadable.read=async()=>{if(removed)throw new Error('cannot read');return read();};
 await assert.rejects(removeDeviceUnlock(unreadable),error=>reason(error)==='failed','cannot confirm: not reported off');
 const good=memory();await enrol(credentials,good);await removeDeviceUnlock(good);assert.equal(good.peek(),null);
});

test('setup needs only ONE extra device check when create() already returns the PRF output, and still refuses a mismatch',async()=>{
 for(const [label,mismatch] of [['same',false],['different',true]]){
  const base=authenticator(),store=memory();let gets=0;
  const credentials={
   async create(options){const made=await base.create(options);const probe=await base.get({publicKey:{allowCredentials:[{id:made.rawId}],extensions:{prf:{eval:{first:options.publicKey.extensions.prf.eval.first}}}}});
    const first=probe.getClientExtensionResults().prf.results.first;const out=mismatch?crypto.getRandomValues(new Uint8Array(32)).buffer:first;
    return {rawId:made.rawId,getClientExtensionResults:()=>({prf:{enabled:true,results:{first:out}}})};},
   async get(options){gets++;return base.get(options);},
  };
  if(mismatch){await assert.rejects(enrol(credentials,store),error=>reason(error)==='mismatch',label);assert.equal(store.writes,0);}
  else{await enrol(credentials,store);assert.equal(gets,1,'one get after create');assert.equal(await unlockWithDevice({credentials,store}),PASS);}
 }
});

test('a stale ceremony wipes the PRF output that create() returned',async()=>{
 const base=authenticator(),store=memory();const out=crypto.getRandomValues(new Uint8Array(32));let live=true;
 const credentials={async create(options){const made=await base.create(options);live=false;return {rawId:made.rawId,getClientExtensionResults:()=>({prf:{enabled:true,results:{first:out.buffer}}})};},get:base.get.bind(base)};
 await assert.rejects(enrol(credentials,store,{isCurrent:()=>live}),error=>reason(error)==='stale');
 assert.ok(out.every(byte=>byte===0),'create() output was wiped');assert.equal(store.writes,0);
});
