import test from 'node:test';
import assert from 'node:assert/strict';
import {siloNativeCapabilityProblem,probeSiloNativeStorage} from '../lib/silo/native-capabilities.mjs';
function fixture(mode='ok'){
 const calls=[],names=[],runtime={crypto:{subtle:{},randomUUID:()=> '12345678-1234-4234-8234-123456789abc'}};
 runtime.indexedDB={open(name){names.push(name);calls.push('open');if(mode==='denied')throw Error('SecurityError');const request={};if(mode==='timeout')return request;
  const db={close(){calls.push('close');},createObjectStore(){calls.push('create');},transaction(){calls.push('transaction');const tx={objectStore(){return {put(){calls.push('put');},get(){const read={};queueMicrotask(()=>{read.result=mode==='mismatch'?'wrong':'silo-storage-probe-v1';read.onsuccess?.();queueMicrotask(()=>mode==='quota'?tx.onabort?.():tx.oncomplete?.());});return read;}};}};return tx;}};
  request.result=db;request.transaction={abort(){calls.push('abort');}};
  queueMicrotask(()=>{if(mode!=='collision')request.onupgradeneeded?.({oldVersion:0});request.onsuccess?.();});return request;
 },deleteDatabase(name){names.push(name);calls.push('delete');const deletion={};queueMicrotask(()=>mode==='cleanup-blocked'?deletion.onblocked?.():deletion.onsuccess?.());return deletion;}};
 return {runtime,calls,names};
}
test('availability check distinguishes missing capabilities from permission/device evidence',()=>{
 const runtime={isSecureContext:true,crypto:{subtle:{}},indexedDB:{},WebAssembly:{instantiate(){}},Worker(){},navigator:{locks:{request(){}}}};
 assert.equal(siloNativeCapabilityProblem(runtime),null);delete runtime.Worker;assert.match(siloNativeCapabilityProblem(runtime),/wallet workers/);
});
test('probe writes/reads only a fresh disposable database and closes/deletes it',async()=>{
 const f=fixture(),result=await probeSiloNativeStorage(f.runtime);assert.equal(result.available,true);assert.equal(result.cleanupComplete,true);assert.equal(result.scope,'disposable IndexedDB permission probe only');assert.deepEqual(f.calls,['open','create','transaction','put','close','delete']);assert.equal(f.names[0],f.names[1]);assert.match(f.names[0],/^grain-silo-disposable-probe-/);
});
for(const mode of ['denied','quota','mismatch','cleanup-blocked'])test('probe refuses '+mode+' and never opens wallet storage',async()=>{
 const f=fixture(mode),result=await probeSiloNativeStorage(f.runtime,{timeoutMs:20});assert.equal(result.available,false);assert.ok(result.reason);assert.ok(f.names.every(name=>name.startsWith('grain-silo-disposable-probe-')));if(mode!=='denied')assert.ok(f.calls.includes('delete'));
});
test('name collision is closed without writing or deleting an existing database',async()=>{
 const f=fixture('collision'),result=await probeSiloNativeStorage(f.runtime);assert.equal(result.available,false);assert.deepEqual(f.calls,['open','close']);
});
test('unresponsive open is bounded and is never assumed available',async()=>{
 const f=fixture('timeout'),result=await probeSiloNativeStorage(f.runtime,{timeoutMs:5});assert.equal(result.available,false);assert.match(result.reason,/timed out/);assert.deepEqual(f.calls,['open']);
});
test('missing IDB/random identity refuses without a database call',async()=>{
 const f=fixture();delete f.runtime.crypto.randomUUID;assert.equal((await probeSiloNativeStorage(f.runtime)).available,false);assert.deepEqual(f.calls,[]);
});
test('a malformed random identity cannot select any existing database',async()=>{
 const f=fixture();f.runtime.crypto.randomUUID=()=> 'grain-silo-xmr';assert.equal((await probeSiloNativeStorage(f.runtime)).available,false);assert.deepEqual(f.calls,[]);
});
