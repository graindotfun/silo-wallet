// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import {sealSilo,openSilo,SILO_MAX_PLAINTEXT_BYTES} from '../lib/silo/local-envelope.mjs';
const passphrase='correct horse battery staple';
const reason=async promise=>{try{await promise;}catch(error){return error.siloDecrypt;}return 'opened';};
test('opening failures name the failed check without secrets; messages are unchanged',async()=>{
 const envelope=await sealSilo('xmr','stagenet',{seed:'fixture',height:1},passphrase);
 assert.equal(await reason(openSilo(envelope,passphrase)),'opened');
 await assert.rejects(openSilo(envelope,'a different passphrase'),/passphrase or encrypted backup is invalid/);
 assert.equal(await reason(openSilo(envelope,'a different passphrase')),'auth');
 assert.equal(await reason(openSilo(envelope,passphrase+' ')),'auth','a trailing space is a different passphrase');
 assert.equal(await reason(openSilo({...envelope,network:'mainnet'},passphrase)),'auth','authenticated metadata cannot be relabelled');
 assert.equal(await reason(openSilo({...envelope,iterations:1},passphrase)),'format');
 assert.equal(await reason(openSilo({...envelope,iv:'AAAA'},passphrase)),'structure');
 assert.equal(await reason(openSilo({...envelope,ciphertext:'%%%'},passphrase)),'structure');
 assert.equal(await reason(openSilo(envelope,'short')),'key');
});
test('chunked XMR envelopes report the same categories',async()=>{
 const envelope=await sealSilo('xmr','stagenet',{cacheData:'x'.repeat(SILO_MAX_PLAINTEXT_BYTES+1)},passphrase);
 assert.equal(envelope.version,2);
 assert.equal(await reason(openSilo(envelope,'a different passphrase')),'auth');
 assert.equal(await reason(openSilo({...envelope,extraChunks:[]},passphrase)),'format');
 assert.equal(await reason(openSilo({...envelope,iv:envelope.extraChunks[0].iv},passphrase)),'structure');
 assert.equal(await reason(openSilo(envelope,passphrase)),'opened');
});
test('the stored backup description carries no secret material',async()=>{
 const envelope=await sealSilo('xmr','stagenet',{seed:'fixture',height:1},passphrase);
 const {describeSiloEnvelope}=await import('../lib/silo/local-envelope.mjs');
 assert.equal(describeSiloEnvelope(envelope),'v1:xmr:stagenet:1:ok');
 for(const value of [envelope.salt,envelope.iv,envelope.ciphertext.slice(0,8)])assert.ok(!describeSiloEnvelope(envelope).includes(value));
 assert.equal(describeSiloEnvelope({...envelope,iterations:1}),'v1:xmr:stagenet:1:params');
 assert.equal(describeSiloEnvelope({...envelope,iv:'AAAA'}),'v1:xmr:stagenet:1:lengths');
 assert.equal(describeSiloEnvelope({...envelope,salt:'%%'}),'v1:xmr:stagenet:1:encoding');
 assert.equal(describeSiloEnvelope(null),'v?:?:?:1:params');
});
test('the device self-test known-answer envelope opens with the real openSilo and fails auth with another passphrase',async()=>{
 const {readFileSync}=await import('node:fs');
 const kat=JSON.parse(readFileSync(new URL('../scripts/silo/csp-candidate/envelope-kat.json',import.meta.url),'utf8'));
 assert.deepEqual(await openSilo(kat.envelope,kat.passphrase),kat.payload);
 assert.equal(await reason(openSilo(kat.envelope,kat.passphrase+'x')),'auth');
 assert.ok(!/[a-z]{3,} [a-z]{3,} [a-z]{3,} [a-z]{3,} [a-z]{3,} [a-z]{3,} [a-z]{3,} [a-z]{3,} [a-z]{3,} [a-z]{3,} [a-z]{3,} [a-z]{3,}/.test(kat.payload.seed),'not a mnemonic');
});
