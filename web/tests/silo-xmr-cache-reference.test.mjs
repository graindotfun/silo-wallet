import test from 'node:test';
import assert from 'node:assert/strict';
import {openXmrResearch} from '../lib/silo/xmr-adapter.mjs';
import {transactionConsent} from '../lib/silo/amounts.mjs';
// Injected synthetic SDK only. No actual SDK wallet, relay, private backup or network.
const callerCache=()=>Object.freeze({seed:'public synthetic recovery fixture',height:9,keysData:'AQ==',cacheData:'Ag==',subaddresses:1,ordinaryReceiveIndex:1});
function fixture(){
 const state={config:null,input:null,owned:null,gate:null,openError:null,initError:null,dataError:null,closes:0,shutdowns:0,syncs:0,prepared:0,validated:[]};
 const subaddress={getIndex:()=>1,getAddress:()=> 'fixture subaddress',getIsUsed:()=>false};
 const wallet={
  getSubaddresses:async()=>{if(state.initError)throw state.initError;return [subaddress];},
  getRestoreHeight:async()=>9,getSeed:async()=> 'public synthetic recovery fixture',getPrimaryAddress:async()=> 'fixture primary address',
  getData:async()=>{if(state.dataError)throw state.dataError;return [Uint8Array.of(3),Uint8Array.of(4)];},
  sync:async()=>{state.syncs++;},isSynced:async()=>true,getBalance:async()=>5n,getUnlockedBalance:async()=>5n,
  createTx:async params=>{state.prepared++;assert.equal(params.relay,false);return {getFee:()=>1000n,getOutgoingTransfer:()=>({getDestinations:()=>[{getAddress:()=>params.address,getAmount:()=>params.amount}]}),getMetadata:()=> 'public synthetic unsigned test marker',getHash:()=> 'a'.repeat(64),getInputs:()=>[]};},
  relayTx:async()=>assert.fail('No test may relay'),close:async()=>{state.closes++;},
 };
 const sdk={LibraryUtils:{setLogLevel:async()=>{}},MoneroNetworkType:{STAGENET:2,MAINNET:0,TESTNET:1},MoneroUtils:{validateAddress:async(address,network)=>{state.validated.push({address,network});}},
  openWalletFull:async config=>{state.config=config;state.input={keys:config.keysData,cache:config.cacheData};state.owned={keys:Uint8Array.from(config.keysData),cache:Uint8Array.from(config.cacheData)};if(state.gate)await state.gate;if(state.openError)throw state.openError;return wallet;},
  createWalletFull:async()=>assert.fail('Cached wallet must not be created again'),shutdown:async()=>{state.shutdowns++;},
 };
 const open=(cache=callerCache())=>openXmrResearch({sdk,node:'https://fixture.invalid',cache,fetcher:async()=>new Response(JSON.stringify({stagenet:true,mainnet:false,testnet:false}))});
 return {state,open};
}
function assertDetached(state){
 assert.equal(Object.hasOwn(state.config,'keysData'),false);assert.equal(Object.hasOwn(state.config,'cacheData'),false);
 assert.equal(state.config.networkType,2);assert.equal(state.config.proxyToWorker,true);assert.equal(state.config.isTrustedDaemon,false);
 assert.deepEqual([...state.input.keys],[1]);assert.deepEqual([...state.input.cache],[2]);assert.equal(state.input.keys.buffer.byteLength,1);assert.equal(state.input.cache.buffer.byteLength,1);
 assert.deepEqual([...state.owned.keys],[1]);assert.deepEqual([...state.owned.cache],[2]);
}
test('XMR removes only adapter references after awaited SDK open; input buffers remain intact',async()=>{
 const {state,open}=fixture(),cache=callerCache(),before=JSON.stringify(cache);let release;state.gate=new Promise(resolve=>{release=resolve;});
 const opening=open(cache);for(let turn=0;state.config===null&&turn<100;turn++)await new Promise(resolve=>setImmediate(resolve));assert.ok(state.config,'SDK open was reached');
 assert.equal(Object.hasOwn(state.config,'keysData'),true);assert.equal(Object.hasOwn(state.config,'cacheData'),true);
 release();const active=await opening;try{assertDetached(state);assert.equal(JSON.stringify(cache),before);assert.equal(await active.receive(),'fixture subaddress');}finally{await active.close();}
 assert.equal(state.closes,1);assert.equal(state.shutdowns,1);assertDetached(state);
});
test('XMR failed SDK open leaves input references intact and caller cache unchanged',async()=>{
 const {state,open}=fixture(),original=Error('synthetic SDK open failure');state.openError=original;const cache=callerCache(),before=JSON.stringify(cache);
 await assert.rejects(open(cache),error=>error===original);assert.equal(state.config.keysData,state.input.keys);assert.equal(state.config.cacheData,state.input.cache);assert.deepEqual([...state.input.cache],[2]);assert.equal(JSON.stringify(cache),before);assert.equal(state.closes,0);assert.equal(state.shutdowns,0);
});
test('XMR post-open initialization failure cleans up wallet without modifying SDK-owned bytes',async()=>{
 const {state,open}=fixture(),original=Error('synthetic account initialization failure');state.initError=original;
 await assert.rejects(open(),error=>error===original);assertDetached(state);assert.equal(state.closes,1);assert.equal(state.shutdowns,1);
});
test('XMR sync, backup failure/retry, prepare, reopen and idempotent close preserve state',async()=>{
 const {state,open}=fixture(),cache=callerCache(),before=JSON.stringify(cache),active=await open(cache);let backup;
 try{assertDetached(state);await active.sync();assert.equal(state.syncs,1);state.dataError=Error('synthetic getData failure');await assert.rejects(active.backup(),/getData failure/);state.dataError=null;
  backup=await active.backup();assert.equal(backup.keysData,'Aw==');assert.equal(backup.cacheData,'BA==');assert.equal(backup.seed,cache.seed);assert.equal(backup.height,9);assert.equal(backup.subaddresses,1);assert.equal(backup.ordinaryReceiveIndex,1);
  const review=await active.prepare({address:'fixture recipient',amount:'1'});assert.equal(review.review.amount,'1.0');assert.equal(review.review.fee,'0.000000001');assert.deepEqual(state.validated,[{address:'fixture recipient',network:2}]);review.cancel();assert.equal(state.prepared,1);assert.equal(JSON.stringify(cache),before);
 }finally{await active.close();}
 await active.close();assert.equal(state.closes,1);assert.equal(state.shutdowns,1);await assert.rejects(active.backup(),/locked/);
 const again=fixture(),reopened=await again.open(Object.freeze(backup));try{assert.equal(Object.hasOwn(again.state.config,'cacheData'),false);assert.deepEqual([...again.state.input.keys],[3]);assert.deepEqual([...again.state.input.cache],[4]);assert.equal(await reopened.receive(),'fixture subaddress');assert.deepEqual(await reopened.backup(),backup);}finally{await reopened.close();}
});
test('XMR pending payment remains preserved and blocks new preparation after reference removal',async()=>{
 const {state,open}=fixture(),review={network:'stagenet',asset:'XMR',address:'fixture recipient',amount:'1',fee:'0.000000001'};
 const pending={review,consent:transactionConsent(review),authorized:{metadata:'public synthetic pending marker',hash:'a'.repeat(64)},status:'submitted-unconfirmed'};
 const cache=Object.freeze({...callerCache(),pending}),before=JSON.stringify(cache),active=await open(cache);
 try{assertDetached(state);assert.deepEqual((await active.backup()).pending,pending);assert.ok(active.pending());await assert.rejects(active.prepare({address:'fixture recipient',amount:'2'}),/reconciliation/);assert.equal(state.prepared,0);assert.equal(JSON.stringify(cache),before);}finally{await active.close();}
});
