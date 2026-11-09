import test from 'node:test';import assert from 'node:assert/strict';
import {openZecResearch} from '../lib/silo/zec-adapter.mjs';
async function session({upgradeAfterSigning=false}={}){
 let supported=true,signed=0,sent=0;
 const core={async call(op){switch(op){
  case 'chainCheck':return {chainMatches:true,branchMatches:supported,tip:100};
  case 'open':case 'close':return true;
  case 'info':return {account:0,birthday:1,address:'fixture orchard'};
  case 'address':return 'fixture orchard';
  case 'propose':return {fee:'10000',steps:1};
  case 'authorize':signed++;if(upgradeAfterSigning)supported=false;return new Uint8Array(32).fill(1);
  case 'expiries':return [140];case 'bytes':return Uint8Array.of(3);
  case 'send':sent++;return undefined;
  case 'sync':return undefined;
  case 'summary':return {chainTip:100,fullyScanned:100,orchard:{total:'100000000',spendable:'100000000'},ironwood:{total:'0',spendable:'0'}};
  case 'history':return [];
  default:throw Error(op);
 }},terminate(){}};
 const wallet=await openZecResearch({sdk:{open:async()=>core},node:'https://fixture.invalid',cache:{
  seed:'public test placeholder',height:1,account:0,engine:'lrz-sqlite-0.22',database:'Aw=='}});
 return {wallet,upgrade:()=>{supported=false;},recoverNode:()=>{supported=true;},counts:()=>({signed,sent})};
}
test('an upgrade during an unlocked session prevents receive, sync and preparation and latches recovery-only',async()=>{
 const s=await session();s.upgrade();await assert.rejects(s.wallet.sync(),/engine-outdated/);
 await assert.rejects(s.wallet.receive(),/engine-outdated/);
 await assert.rejects(s.wallet.prepare({address:'fixture orchard',amount:'1'}),/engine-outdated/);
 assert.equal(s.wallet.engine.outdated,true);assert.equal((await s.wallet.balance()).status,'not checked');
 s.recoverNode();await assert.rejects(s.wallet.sync(),/engine-outdated/,'reopening is required');
 assert.deepEqual(s.counts(),{signed:0,sent:0});assert.equal((await s.wallet.backup()).seed,'public test placeholder');await s.wallet.close();
});
test('an upgrade between review and confirmation prevents signing and transport',async()=>{
 const s=await session(),draft=await s.wallet.prepare({address:'fixture orchard',amount:'1'});s.upgrade();let saved=0;
 await assert.rejects(draft.submit(draft.consent,async()=>saved++),/engine-outdated/);
 assert.deepEqual(s.counts(),{signed:0,sent:0});assert.equal(saved,0);assert.equal(s.wallet.pending(),null);await s.wallet.close();
});
test('an upgrade during proving blocks transport while preserving the exact durable signed payment',async()=>{
 const s=await session({upgradeAfterSigning:true}),draft=await s.wallet.prepare({address:'fixture orchard',amount:'1'});let snapshot=null;
 await assert.rejects(draft.submit(draft.consent,async()=>{snapshot=await s.wallet.backup();}),/engine-outdated/);
 assert.deepEqual(s.counts(),{signed:1,sent:0});assert.ok(snapshot.pending.authorized);
 assert.deepEqual((await s.wallet.backup()).pending,snapshot.pending);
 await assert.rejects(s.wallet.reconcile(async()=>assert.fail('must not clear')),/engine-outdated/);
 assert.ok(s.wallet.pending());await s.wallet.close();
});
