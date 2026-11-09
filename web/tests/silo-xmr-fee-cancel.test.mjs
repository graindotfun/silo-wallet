import test from 'node:test';import assert from 'node:assert/strict';
import {openXmrResearch,SILO_XMR_MAX_FEE_PICONERO} from '../lib/silo/xmr-adapter.mjs';
// Injected synthetic SDK only. No real wallet, signing, daemon or relay.
const KI_A='a'.repeat(64),KI_B='b'.repeat(64),ORIGINAL='1'.repeat(64),CANCEL='2'.repeat(64),OWN='own primary';
const inputs=images=>()=>images.map(hex=>({getKeyImage:()=>({getHex:()=>hex})}));
function fixture({fee=2n,original=null,cancel=null,sweepFails=[]}={}){
 const state={relayed:[],original,cancel,sweeps:[]};
 const wallet={getSubaddresses:async()=>[],getPrimaryAddress:async()=>OWN,getData:async()=>[Uint8Array.of(1),Uint8Array.of(2)],getSeed:async()=>'synthetic recovery fixture',
  createTx:async params=>({getFee:()=>fee,getOutgoingTransfer:()=>({getDestinations:()=>[{getAddress:()=>params.address,getAmount:()=>params.amount}]}),getMetadata:()=>'signed payment',getHash:()=>ORIGINAL,getInputs:inputs([KI_A,KI_B])}),
  sweepOutput:async config=>{state.sweeps.push(config);if(sweepFails.includes(config.keyImage))throw Error('locked');assert.equal(config.relay,false);assert.equal(config.address,OWN);return {getFee:()=>3n,getOutgoingTransfer:()=>({getDestinations:()=>[{getAddress:()=>OWN,getAmount:()=>1n}]}),getMetadata:()=>'signed cancel',getHash:()=>CANCEL,getInputs:inputs([config.keyImage])};},
  relayTx:async metadata=>{state.relayed.push(metadata);return metadata==='signed cancel'?CANCEL:ORIGINAL;},
  sync:async()=>{},isSynced:async()=>true,getTx:async hash=>hash===ORIGINAL?state.original:hash===CANCEL?state.cancel:null,close:async()=>{}};
 const sdk={LibraryUtils:{setLogLevel:async()=>{}},MoneroNetworkType:{STAGENET:2},MoneroUtils:{validateAddress:async()=>{}},createWalletFull:async()=>wallet,openWalletFull:async()=>wallet,shutdown:async()=>{}};
 return {state,open:()=>openXmrResearch({sdk,node:'https://synthetic.example',cache:{seed:'synthetic recovery fixture',height:0,keysData:'AQ==',cacheData:'Ag=='},fetcher:async()=>new Response(JSON.stringify({stagenet:true,mainnet:false,testnet:false}))})};
}
const row=(confirmed,confirmations,failed=false)=>({getIsConfirmed:()=>confirmed,getNumConfirmations:()=>confirmations,getIsFailed:()=>failed});

test('XMR payments refuse a zero fee and a fee above the 0.01 XMR safety limit',async()=>{
 assert.equal(SILO_XMR_MAX_FEE_PICONERO,10_000_000_000n);
 for(const [fee,pattern] of [[0n,/fee is zero/],[SILO_XMR_MAX_FEE_PICONERO+1n,/safety limit/],[-1n,/fee is zero/]]){const active=await fixture({fee}).open();await assert.rejects(active.prepare({address:'recipient',amount:'0.000000000001'}),pattern);await active.close();}
 const ok=await fixture({fee:SILO_XMR_MAX_FEE_PICONERO}).open();const draft=await ok.prepare({address:'recipient',amount:'0.000000000001'});assert.equal(draft.review.fee,'0.01');await ok.close();
});

test('a failed XMR payment is cancelled by spending its own input back to the wallet, and released only once that is 10 deep',async()=>{
 const f=fixture({sweepFails:[KI_A]}),active=await f.open();let saved=0;const persist=async()=>{saved++;};
 const draft=await active.prepare({address:'recipient',amount:'0.000000000001'});await draft.submit(draft.consent,persist);
 assert.deepEqual((await active.backup()).pending.authorized.keyImages,[KI_A,KI_B]);
 // Still in the network: no cancelling.
 f.state.original=row(false,0,false);await assert.rejects(active.cancelByConflict(persist),/still waiting/);
 f.state.original=row(true,3);await assert.rejects(active.cancelByConflict(persist),/already in a block/);
 // The wallet reports it failed: the first spendable input is swept to the wallet's own address, recorded, then relayed.
 f.state.original=row(false,0,true);
 assert.equal(await active.cancelByConflict(persist),CANCEL);
 assert.deepEqual(f.state.sweeps.map(s=>s.keyImage),[KI_A,KI_B]);
 assert.equal((await active.backup()).pending.conflict.keyImage,KI_B);assert.equal(f.state.relayed.at(-1),'signed cancel');
 // A retry relays the same recorded cancel bytes; no second sweep.
 assert.equal(await active.cancelByConflict(persist),CANCEL);assert.equal(f.state.sweeps.length,2);
 // Not released while the cancel is shallow; failed (provable) once it is 10 deep and the original is not in a block.
 f.state.cancel=row(true,9);assert.equal(await active.reconcile(persist),'reported-failed');await assert.rejects(active.release(persist),/provably/);
 f.state.cancel=row(true,10);assert.equal(await active.reconcile(persist),'failed');
 assert.equal(await active.release(persist),true);assert.equal(active.pending(),null);
 await active.close();
});

test('if the original payment confirms first, it clears normally and the cancel never releases anything',async()=>{
 const f=fixture(),active=await f.open(),persist=async()=>{};
 const draft=await active.prepare({address:'recipient',amount:'0.000000000001'});await draft.submit(draft.consent,persist);
 f.state.original=null;assert.equal(await active.cancelByConflict(persist),CANCEL);
 f.state.original=row(true,10);f.state.cancel=null;assert.equal(await active.reconcile(persist),'confirmed');assert.equal(active.pending(),null);
 await active.close();
});

test('a mainnet seed restore asks for a restore height instead of scanning from 0',async()=>{
 const source=await (await import('node:fs/promises')).readFile(new URL('../components/silo-native-zone.tsx',import.meta.url),'utf8');
 assert.match(source,/network==='mainnet'&&!restore&&seed\.trim\(\)&&!\(Number\(height\)>0\)/);
 // Cancelling runs through the account gate (lib/silo/xmr-account-actions.mjs → cancelByConflict) with the same save.
 assert.match(source,/xmrActions\(active\)\.cancel\(\(\)=>save\(active,operation\)\)/);
});
