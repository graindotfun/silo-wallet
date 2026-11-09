// Synthetic terminal records/readers only. No chain, wallet, signing or funds.
import test from 'node:test';import assert from 'node:assert/strict';
import {blockingOperations} from '../lib/silo/sync/outcome.mjs';
function fixture(){
 const entry={opId:'local-operation',kind:'jupiter-swap',network:'mainnet-beta',state:'finalized',createdBy:'local-device',binding:{owner:'synthetic-owner',messageHash:'0'.repeat(64)},signed:{signature:'synthetic-signature',messageHash:'0'.repeat(64),record:{minimumOutputRaw:'100',wire:'synthetic-only'}},claim:{status:'finalized',network:'mainnet-beta',signature:'synthetic-signature',messageHash:'0'.repeat(64)}};
 let calls=0,answer='finalized';const reader={cachePolicyVersion:'local-reviewed-policy-v1',cacheSource:'0'.repeat(40),async checkOutcome(r){calls++;return {status:answer,network:r.network,signature:r.signature,messageHash:r.messageHash};}};
 const verifiers={'jupiter-swap':reader},verified={},journal={entries:{[entry.opId]:entry}};
 return {entry,reader,verifiers,verified,journal,get calls(){return calls;},unknown(){answer='unknown';},run:()=>blockingOperations(journal,{verifiers,verified})};
}
test('cache requires identified local policy/build, complete operation identity and same reader incarnation',async()=>{
 const f=fixture();assert.deepEqual(await f.run(),[]);assert.equal(f.calls,1);assert.equal(typeof f.verified[f.entry.opId],'object');assert.deepEqual(await f.run(),[]);assert.equal(f.calls,1);
 f.verifiers['jupiter-swap']={...f.reader};f.unknown();assert.equal((await f.run())[0].reason,'outcome-unknown');assert.equal(f.calls,2);
});
for(const change of ['record','owner','cancellation','source','policy','reader-function','terminal-state','legacy-string'])test(`changed ${change} cannot reuse previous outcome acceptance`,async()=>{
 const f=fixture();assert.deepEqual(await f.run(),[]);f.unknown();
 if(change==='record')f.entry.signed.record.minimumOutputRaw='200';if(change==='owner')f.entry.binding.owner='other-owner';if(change==='cancellation')f.entry.cancellation={signature:'other-cancellation'};
 if(change==='source')f.reader.cacheSource='1'.repeat(40);if(change==='policy')f.reader.cachePolicyVersion='local-reviewed-policy-v2';if(change==='reader-function'){const original=f.reader.checkOutcome;f.reader.checkOutcome=r=>original(r);}
 if(change==='terminal-state')f.entry.state='failed-proven';if(change==='legacy-string')f.verified[f.entry.opId]=f.verified[f.entry.opId].claimHash;
 const held=await f.run();assert.equal(held.length,1);assert.ok(['outcome-unknown','claim-malformed'].includes(held[0].reason));
});
test('unidentified reader never caches and missing reader cannot reuse earlier cache',async()=>{
 const f=fixture();delete f.reader.cacheSource;assert.deepEqual(await f.run(),[]);assert.equal(f.verified[f.entry.opId],undefined);f.unknown();assert.equal((await f.run())[0].reason,'outcome-unknown');
 const g=fixture();await g.run();delete g.verifiers['jupiter-swap'];assert.equal((await g.run())[0].reason,'no-verifier');
});
test('record or reader policy mutation during verification remains held and uncached',async()=>{
 for(const change of ['record','policy']){const f=fixture();let release,entered;const started=new Promise(r=>{entered=r;}),barrier=new Promise(r=>{release=r;});const original=f.reader.checkOutcome;f.reader.checkOutcome=async r=>{entered();await barrier;return original(r);};
 const checking=f.run();await started;if(change==='record')f.entry.signed.record.minimumOutputRaw='200';else f.reader.cachePolicyVersion='changed';release();assert.equal((await checking)[0].reason,'verification-context-changed');assert.equal(f.verified[f.entry.opId],undefined);}
});
test('reader replacement during cached identity digest holds instead of accepting stale cache',async()=>{
 const f=fixture();await f.run();f.unknown();
 const subtle=globalThis.crypto.subtle,original=subtle.digest.bind(subtle);let entered,release;
 const reached=new Promise(r=>entered=r),barrier=new Promise(r=>release=r);let calls=0;
 subtle.digest=async(...args)=>{calls++;if(calls===2){entered();await barrier;}return original(...args);};
 try{const checking=f.run();await reached;f.verifiers['jupiter-swap']={...f.reader};release();assert.equal((await checking)[0].reason,'verification-context-changed');assert.equal(f.verified[f.entry.opId],undefined);assert.equal(f.calls,1);}
 finally{subtle.digest=original;release?.();}
});
test('claim mutation during cached claim digest holds instead of accepting stale cache',async()=>{
 const f=fixture();await f.run();const subtle=globalThis.crypto.subtle,original=subtle.digest.bind(subtle);let entered,release;
 const reached=new Promise(r=>entered=r),barrier=new Promise(r=>release=r);let first=true;
 subtle.digest=async(...args)=>{if(first){first=false;entered();await barrier;}return original(...args);};
 try{const checking=f.run();await reached;f.entry.claim.signature='changed-signature';release();assert.equal((await checking)[0].reason,'verification-context-changed');assert.equal(f.verified[f.entry.opId],undefined);assert.equal(f.calls,1);}
 finally{subtle.digest=original;release?.();}
});
for(const change of ['reader','source','policy'])test(`fresh proof digest ${change} mutation stays held`,async()=>{
 const f=fixture(),subtle=globalThis.crypto.subtle,original=subtle.digest.bind(subtle);let entered,release,calls=0;
 const reached=new Promise(r=>entered=r),barrier=new Promise(r=>release=r);
 subtle.digest=async(...args)=>{if(++calls===3){entered();await barrier;}return original(...args);};
 try{const checking=f.run();await reached;if(change==='reader')f.verifiers['jupiter-swap']={...f.reader};if(change==='source')f.reader.cacheSource='9'.repeat(40);if(change==='policy')f.reader.cachePolicyVersion='changed';release();assert.equal((await checking)[0].reason,'verification-context-changed');assert.equal(f.verified[f.entry.opId],undefined);}
 finally{subtle.digest=original;release?.();}
});
