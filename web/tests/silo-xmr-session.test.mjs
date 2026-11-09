import test from 'node:test';
import assert from 'node:assert/strict';
import {openXmrResearch} from '../lib/silo/xmr-adapter.mjs';
import {transactionConsent} from '../lib/silo/amounts.mjs';
async function fixture(){
 const review={network:'stagenet',asset:'XMR',address:'fixture recipient',amount:'1',fee:'0.1'};
 const pending={review,consent:transactionConsent(review),authorized:{metadata:'same fixture bytes',hash:'a'.repeat(64)},status:'submitted-unconfirmed'};
 const state={confirmations:10,syncs:0,ops:0,onSync:async()=>{},onTx:async()=>{}};
 const wallet={async getSubaddresses(){return [];},async sync(){state.ops++;state.syncs++;await state.onSync();},async isSynced(){state.ops++;return true;},async getTx(){state.ops++;await state.onTx();return {getIsConfirmed:()=>state.confirmations>0,getNumConfirmations:()=>state.confirmations,getIsFailed:()=>false};},async getPrimaryAddress(){state.ops++;return 'fixture address';},async getBalance(){state.ops++;return 1n;},async getUnlockedBalance(){state.ops++;return 1n;},async getData(){state.ops++;return [Uint8Array.of(1),Uint8Array.of(2)];},async getSeed(){state.ops++;return 'public fixture words';},async relayTx(){state.ops++;return 'a'.repeat(64);},async close(){state.ops++;}};
 const sdk={LibraryUtils:{setLogLevel:async()=>{}},MoneroNetworkType:{STAGENET:2},MoneroUtils:{validateAddress:async()=>{}},openWalletFull:async()=>wallet,shutdown:async()=>{}};
 const active=await openXmrResearch({sdk,node:'https://fixture.invalid',cache:{seed:'public fixture words',height:1,keysData:'AQ==',cacheData:'Ag==',pending},fetcher:async()=>new Response(JSON.stringify({stagenet:true,mainnet:false,testnet:false}))});
 return {active,state,pending};
}
test('XMR reconciliation freshly syncs before trusting cached confirmations',async()=>{
 const {active,state}=await fixture();try{state.onSync=async()=>{state.confirmations=1;};
 assert.equal(await active.reconcile(async()=>assert.fail('stale confirmations must not clear')),false);assert.equal(state.syncs,1);assert.ok(active.pending());
 state.onSync=async()=>{state.confirmations=10;};assert.equal(await active.reconcile(async()=>{}),'confirmed');assert.equal(active.pending(),null);
 }finally{await active.close();}
});
test('XMR failed fresh sync retains exact signed reservation',async()=>{
 const {active,state,pending}=await fixture();try{state.onSync=async()=>{throw Error('fixture offline');};await assert.rejects(active.reconcile(async()=>assert.fail('failed sync')),/fixture offline/);assert.deepEqual((await active.backup()).pending,pending);
 }finally{await active.close();}
});
test('XMR lock during awaited history read prevents journal clearing',async()=>{
 const {active,state}=await fixture();let resume,reached;const entered=new Promise(resolve=>{reached=resolve;});state.onTx=async()=>{reached();await new Promise(resolve=>{resume=resolve;});};
 const reconcile=active.reconcile(async()=>assert.fail('locked scan must not clear'));await entered;await active.close();resume();await assert.rejects(reconcile,/locked/);assert.ok(active.pending());
});
test('XMR locked session rejects every engine action before SDK access',async()=>{
 const {active,state}=await fixture();const retained=active.pending();await active.close();const ops=state.ops;
 for(const action of [()=>active.receive(),()=>active.sync(),()=>active.balance(),()=>active.backup(),()=>active.paymentStatus(),()=>active.reconcile(async()=>{}),()=>active.release(async()=>{}),()=>active.prepare({address:'fixture',amount:'1'}),()=>retained.submit(retained.consent,async()=>{})])await assert.rejects(async()=>action(),/locked/);
 await active.close();assert.equal(state.ops,ops);
});

test('XMR failed initialization closes the wallet and shuts down SDK while preserving the original error',async()=>{
 for(const cleanupFails of [false,true]){
  let closes=0,shutdowns=0;const original=Error('fixture birthday unavailable');
  const wallet={getRestoreHeight:async()=>{throw original;},close:async()=>{closes++;if(cleanupFails)throw Error('fixture close failure');}};
  const sdk={LibraryUtils:{setLogLevel:async()=>{}},MoneroNetworkType:{STAGENET:2},createWalletFull:async()=>wallet,shutdown:async()=>{shutdowns++;if(cleanupFails)throw Error('fixture shutdown failure');}};
  await assert.rejects(openXmrResearch({sdk,node:'https://fixture.invalid',fetcher:async()=>new Response(JSON.stringify({stagenet:true,mainnet:false,testnet:false}))}),error=>error===original);
  assert.equal(closes,1);assert.equal(shutdowns,1);
 }
});
