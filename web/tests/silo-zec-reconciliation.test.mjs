import test from 'node:test';
import assert from 'node:assert/strict';
import {openZecResearch} from '../lib/silo/zec-adapter.mjs';
import {transactionConsent} from '../lib/silo/amounts.mjs';

async function heldWallet(){
 const state={tip:300,summary:{chainTip:300,fullyScanned:300},minedHeight:null,syncFailure:false,onHistory:()=>{},syncs:0};
 const txid='01'.repeat(32),review={network:'testnet',asset:'ZEC',address:'fixture orchard',amount:'1',fee:'0.0001'};
 const pending={review,consent:transactionConsent(review),status:'failed',authorized:{ids:Buffer.alloc(32,1).toString('base64'),expiryHeights:[140]}};
 const core={async call(op){switch(op){
  case 'chainCheck':return {chainMatches:true,branchMatches:true,tip:state.tip};
  case 'open':case 'close':return true;
  case 'info':return {account:0,birthday:1,address:'fixture orchard'};
  case 'address':return 'fixture orchard';
  case 'sync':state.syncs++;if(state.syncFailure)throw Error('fixture sync unavailable');return undefined;
  case 'summary':return state.summary;
  case 'history':state.onHistory();return [{txid,minedHeight:state.minedHeight,expiredUnmined:true}];
  case 'bytes':return Uint8Array.of(3);
  default:throw Error(`Unexpected operation: ${op}`);
 }},terminate(){}};
 const wallet=await openZecResearch({sdk:{open:async()=>core},node:'https://fixture.invalid',cache:{seed:'public fixture',height:1,engine:'lrz-sqlite-0.22',database:'Aw==',pending}});
 return {state,wallet,pending};
}

test('a lower live tip cannot release or confirm a payment using the old scan',async()=>{
 const {state,wallet,pending}=await heldWallet();
 try{
  state.tip=130;
  assert.equal(await wallet.reconcile(async()=>assert.fail('must retain hold')),false);
  await assert.rejects(wallet.release(async()=>assert.fail('must retain hold')),/cannot be included/);
  state.minedHeight=298;
  assert.equal(await wallet.reconcile(async()=>assert.fail('stale confirmations')),false);
  assert.deepEqual((await wallet.backup()).pending,pending);assert.equal(state.syncs,3);
 }finally{await wallet.close();}
});

test('inconsistent scan heights and impossible mined heights keep the payment held',async()=>{
 const {state,wallet,pending}=await heldWallet();
 try{
  for(const summary of [{chainTip:300,fullyScanned:301},{chainTip:300,fullyScanned:299},{chainTip:-1,fullyScanned:-1},{chainTip:4294967296,fullyScanned:4294967296}]){
   state.summary=summary;assert.equal(await wallet.reconcile(async()=>assert.fail('invalid scan must not clear')),false);
  }
  state.summary={chainTip:300,fullyScanned:300};
  for(const height of [-1,301,'298',1.5,undefined]){state.minedHeight=height;assert.equal(await wallet.reconcile(async()=>assert.fail('invalid mining must not clear')),false);}
  assert.deepEqual((await wallet.backup()).pending,pending);
 }finally{await wallet.close();}
});

test('tip regression during history reading and failed synchronization retain the journal',async()=>{
 const {state,wallet,pending}=await heldWallet();
 try{
  state.onHistory=()=>{state.tip=130;};
  assert.equal(await wallet.reconcile(async()=>assert.fail('tip regressed')),false);
  state.syncFailure=true;
  await assert.rejects(wallet.release(async()=>assert.fail('sync failed')),/sync unavailable/);
  assert.deepEqual((await wallet.backup()).pending,pending);
 }finally{await wallet.close();}
});

test('consistent rescans still permit explicit expired release and confirmed reconciliation',async()=>{
 for(const confirmed of [false,true]){
  const {state,wallet}=await heldWallet();let saves=0;
  try{
   state.minedHeight=confirmed?298:null;
   assert.equal(await wallet.reconcile(async()=>saves++),confirmed?'confirmed':'failed');
   if(!confirmed)assert.equal(await wallet.release(async()=>saves++),true);
   assert.equal((await wallet.backup()).pending,null);assert.equal(saves,1);
  }finally{await wallet.close();}
 }
});

test('ZEC lock during history reading prevents journal clearing',async()=>{
 const {state,wallet}=await heldWallet();let closing;
 state.minedHeight=298;state.onHistory=()=>{closing=wallet.close();};
 await assert.rejects(wallet.reconcile(async()=>assert.fail('locked history must not clear')),/locked/);
 await closing;assert.ok(wallet.pending());
});
