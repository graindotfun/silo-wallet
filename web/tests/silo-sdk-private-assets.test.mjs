import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pinnedSiloAsset,pinnedSiloWasm,siloLoadCategory} from '../lib/silo/integrity.mjs';
const bytes=new Uint8Array([1,2,3,4]);
const pin={url:'/silo-sdk/fixture.js',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
test('private SDK fetch carries same-origin authentication and still verifies bytes',async()=>{
 let requested=false;
 const result=await pinnedSiloAsset(pin,async(url,options)=>{
  requested=true;assert.equal(url,pin.url);assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');assert.equal(options.referrerPolicy,'no-referrer');
  return new Response(bytes);
 });
 assert.equal(requested,true);assert.deepEqual(result,bytes);
});
test('private asset rejection, wrong bytes and external pin all fail closed',async()=>{
 await assert.rejects(pinnedSiloAsset(pin,async()=>new Response('Unauthorized',{status:401})),/SDK unavailable/);
 await assert.rejects(pinnedSiloAsset(pin,async()=>new Response(new Uint8Array([4,3,2,1]))),/integrity mismatch/);
 let called=false;await assert.rejects(pinnedSiloAsset({...pin,url:'https://other.example/fixture.js'},async()=>{called=true;}),/Invalid Silo SDK pin/);assert.equal(called,false);
});
test('load failures carry a category the wallet can explain, and still fail closed',async()=>{
 const category=async(fetcher,value=pin)=>{try{await pinnedSiloAsset(value,fetcher);}catch(error){return siloLoadCategory(error);}return 'loaded';};
 assert.equal(await category(async()=>new Response('Unauthorized',{status:401})),'session');
 assert.equal(await category(async()=>new Response('Forbidden',{status:403})),'session');
 assert.equal(await category(async()=>new Response('Unavailable',{status:503})),'unavailable');
 assert.equal(await category(async()=>{throw new TypeError('Failed to fetch');}),'unreachable');
 assert.equal(await category(async()=>new Response(new Uint8Array([4,3,2,1]))),'integrity');
 assert.equal(await category(async()=>new Response(new Uint8Array([1,2,3]))),'integrity');
 assert.equal(await category(async()=>new Response(new ReadableStream({pull(controller){controller.error(new TypeError('network'));}}))),'unreachable');
 assert.equal(await category(async()=>new Response(bytes)),'loaded');
 assert.equal(siloLoadCategory(Error('Silo SDK unavailable.')),null);
 assert.equal(siloLoadCategory({siloLoad:'anything'}),null);
 const wasm={bytes:4,sha256:'0'.repeat(64),chunks:[pin]};
 await assert.rejects(pinnedSiloWasm(wasm,async()=>new Response(bytes)),error=>siloLoadCategory(error)==='integrity');
});
