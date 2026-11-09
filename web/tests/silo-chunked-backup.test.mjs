import test from 'node:test';import assert from 'node:assert/strict';
import {sealSilo,openSilo,SILO_MAX_XMR_PLAINTEXT_BYTES} from '../lib/silo/local-envelope.mjs';
import {boundedSiloBackup} from '../lib/silo/backup-budget.mjs';
import {sameSiloEnvelope} from '../lib/silo/local-store.mjs';
const pass='disposable chunk test password';
const payload={seed:'public fixture words',height:2224456,cacheData:'q'.repeat(17*1024*1024),pending:{review:{amount:'0.001'},authorized:{hash:'a'.repeat(64),metadata:'original signed bytes'}}};
let envelope;
test('large XMR scan cache and pending journal survive authenticated chunked backup',async()=>{
 assert.equal(boundedSiloBackup('xmr',payload),payload);envelope=await sealSilo('xmr','stagenet',payload,pass);
 assert.equal(envelope.version,2);assert.equal(envelope.extraChunks.length,2);
 const restored=await openSilo(envelope,pass);assert.equal(restored.cacheData.length,payload.cacheData.length);assert.deepEqual(restored.pending,payload.pending);assert.equal(restored.height,payload.height);assert.equal(restored.seed,payload.seed);
});
test('missing, reordered, duplicated, altered and transplanted chunks never return partial recovery',async()=>{
 const changes=[e=>e.extraChunks.pop(),e=>{[e.extraChunks[0],e.extraChunks[1]]=[e.extraChunks[1],e.extraChunks[0]];},e=>{e.extraChunks[0].iv=e.iv;},e=>{e.extraChunks[0].ciphertext=(e.extraChunks[0].ciphertext[0]==='A'?'B':'A')+e.extraChunks[0].ciphertext.slice(1);},e=>{e.network='mainnet';},e=>{e.plainBytes--;},e=>{e.plainBytes=SILO_MAX_XMR_PLAINTEXT_BYTES+1;},e=>{e.extraChunks=Array(100).fill({});}];
 for(const change of changes){const tampered=structuredClone(envelope);change(tampered);await assert.rejects(openSilo(tampered,pass));assert.equal(sameSiloEnvelope(envelope,tampered),false);}
 await assert.rejects(openSilo(envelope,'incorrect fixture password'));
 const other=await sealSilo('xmr','stagenet',payload,pass);other.extraChunks[0]=envelope.extraChunks[0];await assert.rejects(openSilo(other,pass));
});
test('legacy small backups remain version one and ZEC limit remains unchanged',async()=>{
 const small={seed:'public words',height:4,cacheOmitted:true};const sealed=await sealSilo('xmr','stagenet',small,pass);assert.equal(sealed.version,1);assert.deepEqual(await openSilo(sealed,pass),small);
 assert.equal(boundedSiloBackup('zec',{seed:'public words',database:payload.cacheData}).cacheOmitted,true);
 await assert.rejects(sealSilo('zec','testnet',payload,pass),/storage bound/);
});
