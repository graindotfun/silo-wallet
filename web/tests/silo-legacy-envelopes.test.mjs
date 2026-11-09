import test from 'node:test';
import assert from 'node:assert/strict';
import {archiveLegacyEnvelope,listLegacyEnvelopes,removeLegacyEnvelopes} from '../lib/silo/legacy-envelopes.mjs';
const storage=()=>{const map=new Map();return {get length(){return map.size;},key:i=>[...map.keys()][i]??null,getItem:k=>map.has(k)?map.get(k):null,setItem:(k,v)=>void map.set(k,String(v)),removeItem:k=>void map.delete(k)};};
const env=(c='a'.repeat(96),address='0xabc')=>({scope:'silo-native-keyring-v1',chain:'evm',address,salt:'b'.repeat(32),iv:'c'.repeat(24),ciphertext:c});
test('an original copy is kept write-once, read back, listed, and only removed on request',()=>{
 const s=storage(),key=archiveLegacyEnvelope(s,{zone:'evm',envelope:env(),proof:'{"v":1}'});
 assert.equal(archiveLegacyEnvelope(s,{zone:'evm',envelope:env()}),key,'archiving the same copy again is a no-op');
 const rows=listLegacyEnvelopes(s);assert.equal(rows.length,1);assert.equal(rows[0].proof,'{"v":1}');assert.deepEqual(rows[0].envelope,env());
 assert.equal(removeLegacyEnvelopes(s,['not-ours']),0,'only our own keys are ever removed');assert.equal(listLegacyEnvelopes(s).length,1);
 assert.equal(removeLegacyEnvelopes(s,[rows[0].key]),1);assert.equal(listLegacyEnvelopes(s).length,0);
});
test('no copy is kept when the browser cannot store it, and shapes and sizes are refused',()=>{
 const broken={...storage(),setItem(){throw Error('quota');}};
 assert.throws(()=>archiveLegacyEnvelope(broken,{zone:'evm',envelope:env()}),e=>e.siloLegacy==='storage');
 const lying={...storage(),setItem(){}};assert.throws(()=>archiveLegacyEnvelope(lying,{zone:'evm',envelope:env()}),e=>e.siloLegacy==='storage');
 assert.throws(()=>archiveLegacyEnvelope(storage(),{zone:'xmr',envelope:env()}),e=>e.siloLegacy==='shape');
 assert.throws(()=>archiveLegacyEnvelope(storage(),{zone:'evm',envelope:{...env(),ciphertext:'z'.repeat(5000)}}),e=>e.siloLegacy==='size');
 assert.deepEqual(listLegacyEnvelopes({get length(){throw Error('x');}}),[]);
});
