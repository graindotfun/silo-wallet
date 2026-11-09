import test from 'node:test';import assert from 'node:assert/strict';
import {openXmrResearch} from '../lib/silo/xmr-adapter.mjs';import {openZecResearch} from '../lib/silo/zec-adapter.mjs';
// Injected synthetic SDKs only. No real wallet, key generation, signing, daemon or relay.
test('XMR cache opening and exact fee review persist authorization before same-metadata retries',async()=>{
 let created=0,opened=0,relayed=0,persisted=0;const wallet={getSubaddresses:async()=>[],getPrimaryAddress:async()=> 'synthetic recipient',getData:async()=>[Uint8Array.of(1),Uint8Array.of(2)],getSeed:async()=> 'synthetic recovery fixture',createTx:async params=>{assert.equal(params.amount,1n);assert.equal(params.relay,false);return {getFee:()=>2n,getOutgoingTransfer:()=>({getDestinations:()=>[{getAddress:()=>params.address,getAmount:()=>params.amount}]}),getMetadata:()=> 'signed fixture',getHash:()=> 'a'.repeat(64)};},relayTx:async metadata=>{assert.ok(persisted);assert.equal(metadata,'signed fixture');if(++relayed===1)throw Error('ambiguous');return 'a'.repeat(64);},sync:async()=>{},isSynced:async()=>true,getTx:async()=>({getIsConfirmed:()=>true,getNumConfirmations:()=>10}),close:async()=>{}};
 const sdk={LibraryUtils:{setLogLevel:async()=>{}},MoneroNetworkType:{STAGENET:2},MoneroUtils:{validateAddress:async()=>{}},createWalletFull:async()=>{created++;return wallet;},openWalletFull:async config=>{opened++;assert.equal(config.password,'');assert.deepEqual(config.keysData,Uint8Array.of(1));assert.equal(config.restoreHeight,undefined);return wallet;},shutdown:async()=>{}};
 const active=await openXmrResearch({sdk,node:'https://synthetic.example',cache:{seed:'synthetic recovery fixture',height:0,keysData:'AQ==',cacheData:'Ag=='},fetcher:async()=>new Response(JSON.stringify({stagenet:true,mainnet:false,testnet:false}))});assert.equal(created,0);assert.equal(opened,1);
 const draft=await active.prepare({address:'synthetic recipient',amount:'0.000000000001'});assert.equal(draft.review.fee,'0.000000000002');assert.equal(relayed,0);
 const persist=async()=>{assert.equal((await active.backup()).pending.authorized.metadata,'signed fixture');persisted++;};await assert.rejects(draft.submit(draft.consent,persist));await assert.rejects(active.prepare({address:'synthetic',amount:'1'}));
 await draft.submit(draft.consent,persist);assert.equal(relayed,2);assert.equal(await active.reconcile(async()=>{}),'confirmed');assert.equal(active.pending(),null);await active.close();
});
test('ZEC proposal signs only after consent; durable IDs survive ambiguous relay and exact local confirmations clear',async()=>{
 let authorized=0,relayed=0,saved=0,confirmed=false;const txid='01'.repeat(32);
 const core={async call(op,args={}){switch(op){
  case 'chainCheck':return {chainMatches:true,branchMatches:true,tip:100};case 'open':assert.deepEqual([...args.database],[3]);return 'synthetic orchard';
  case 'create':case 'generate':return assert.fail('cached account must not be recreated');case 'info':return {account:0,birthday:0,address:'synthetic orchard'};
  case 'address':if(args.address!=='synthetic orchard')throw Error('invalid');return args.address;case 'bytes':return Uint8Array.of(3);
  case 'sync':return undefined;case 'summary':return {chainTip:100,fullyScanned:100,orchard:{total:'100000000',spendable:'100000000'},ironwood:{total:'0',spendable:'0'}};
  case 'propose':assert.equal(BigInt(args.amount),100000000n);return {fee:'10000',steps:1};case 'authorize':authorized++;return new Uint8Array(32).fill(1);case 'expiries':return [140];
  case 'send':assert.ok(saved);assert.equal(args.ids.length,32);if(++relayed===1)throw Error('ambiguous');return undefined;
  case 'history':return [{txid,minedHeight:confirmed?98:99,expiryHeight:140,expiredUnmined:false}];case 'close':return true;default:throw Error(op);}},terminate(){}};
 const sdk={open:async()=>core};
 const active=await openZecResearch({sdk,node:'https://synthetic.example',cache:{seed:'synthetic fixture',height:0,account:0,engine:'lrz-sqlite-0.22',database:'Aw=='}});
 const draft=await active.prepare({address:'synthetic orchard',amount:'1'});assert.equal(draft.review.fee,'0.0001');assert.equal(authorized,0);
 await assert.rejects(draft.submit('wrong',async()=>{}));assert.equal(authorized,0);
 const persist=async()=>{assert.ok((await active.backup()).pending.authorized);saved++;};await assert.rejects(draft.submit(draft.consent,persist));assert.equal(authorized,1);await draft.submit(draft.consent,persist);assert.equal(authorized,1);assert.equal(relayed,2);
 assert.equal(await active.reconcile(async()=>{}),false);confirmed=true;assert.equal(await active.reconcile(async()=>{}),'confirmed');assert.equal(active.pending(),null);await active.close();
});
