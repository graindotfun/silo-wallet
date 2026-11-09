// Candidate review (21 October 2026, N4): the page's live admission runs at the Monero engine's relay boundary, immediately
// before a signed payment's bytes go to the node, for a fresh review and for a pending payment restored from the backup. A
// refusal leaves the pending record intact, so the same bytes can be relayed later; nothing is re-signed. Synthetic engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import {openXmrResearch} from '../lib/silo/xmr-adapter.mjs';

function engine(){
 let relayed=0;const wallet={getSubaddresses:async()=>[],getPrimaryAddress:async()=> 'synthetic recipient',getData:async()=>[Uint8Array.of(1),Uint8Array.of(2)],getSeed:async()=> 'synthetic recovery fixture',
  createTx:async params=>({getFee:()=>2n,getOutgoingTransfer:()=>({getDestinations:()=>[{getAddress:()=>params.address,getAmount:()=>params.amount}]}),getMetadata:()=> 'signed fixture',getHash:()=> 'a'.repeat(64)}),
  relayTx:async metadata=>{assert.equal(metadata,'signed fixture');relayed++;return 'a'.repeat(64);},sync:async()=>{},isSynced:async()=>true,getTx:async()=>({getIsConfirmed:()=>true,getNumConfirmations:()=>10}),close:async()=>{}};
 const sdk={LibraryUtils:{setLogLevel:async()=>{}},MoneroNetworkType:{STAGENET:2},MoneroUtils:{validateAddress:async()=>{}},createWalletFull:async()=>wallet,openWalletFull:async()=>wallet,shutdown:async()=>{}};
 return {sdk,relayed:()=>relayed};
}
const open=(sdk,relayGuard,cache={seed:'synthetic recovery fixture',height:0,keysData:'AQ==',cacheData:'Ag=='})=>openXmrResearch({sdk,node:'https://synthetic.example',cache,relayGuard,fetcher:async()=>new Response(JSON.stringify({stagenet:true,mainnet:false,testnet:false}))});

test('the relay guard sees the frozen review right before relay; a refusal keeps the pending payment for a later retry of the same bytes',async()=>{
 const {sdk,relayed}=engine();const seen=[];let refuse=true;
 const active=await open(sdk,review=>{seen.push({...review});if(refuse)throw Error('The beta is paused: new payments and trades are stopped.');});
 const draft=await active.prepare({address:'synthetic recipient',amount:'0.000000000001'});
 let saved=null;const persist=async()=>{saved=(await active.backup()).pending;};
 await assert.rejects(draft.submit(draft.consent,persist),/paused/);
 assert.equal(relayed(),0,'nothing reached the node');assert.deepEqual(seen,[{network:'stagenet',asset:'XMR',address:'synthetic recipient',amount:'0.000000000001',fee:'0.000000000002'}]);
 assert.equal(saved?.authorized?.metadata,'signed fixture','the signed bytes were persisted before the refusal');assert.equal(saved?.status,'unconfirmed');
 await assert.rejects(active.prepare({address:'synthetic recipient',amount:'0.000000000001'}),/replacement/,'no replacement payment while one is pending');
 refuse=false;assert.equal(await draft.submit(draft.consent,persist),'a'.repeat(64));assert.equal(relayed(),1);assert.equal(seen.length,2,'checked again on the retry');
 await active.close();
});

test('a pending payment restored from the backup relays through the same guard',async()=>{
 const first=engine();const active=await open(first.sdk,()=>{});
 const draft=await active.prepare({address:'synthetic recipient',amount:'0.000000000001'});let backup=null;
 // Persist the authorization, then fail the relay itself so the payment stays pending in the backup.
 const persist=async()=>{backup=await active.backup();};
 const wallet=await first.sdk.createWalletFull();const originalRelay=wallet.relayTx;wallet.relayTx=async()=>{throw Error('node unreachable');};
 await assert.rejects(draft.submit(draft.consent,persist),/unreachable/);assert.equal(backup?.pending?.status,'unconfirmed');wallet.relayTx=originalRelay;await active.close();
 // A second engine opens from that backup: the pending draft is the restored one, and the guard still runs before relay.
 const second=engine();const seen=[];let refuse=true;
 const restored=await open(second.sdk,review=>{seen.push(review.amount);if(refuse)throw Error('Beta limit: up to 0 XMR per payment.');},{seed:backup.seed,height:backup.height,keysData:backup.keysData,cacheData:backup.cacheData,pending:backup.pending});
 const pending=restored.pending();assert.ok(pending,'the pending payment was restored');assert.equal(pending.review.amount,'0.000000000001');
 await assert.rejects(pending.submit(pending.consent,async()=>{}),/Beta limit/);assert.equal(second.relayed(),0);
 refuse=false;assert.equal(await pending.submit(pending.consent,async()=>{}),'a'.repeat(64));assert.equal(second.relayed(),1);assert.deepEqual(seen,['0.000000000001','0.000000000001']);
 await restored.close();
});
