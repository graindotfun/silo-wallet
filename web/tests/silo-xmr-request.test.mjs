import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak_256} from '@noble/hashes/sha3';
import {openXmrResearch,SILO_XMR_SUBADDRESS_GAP} from '../lib/silo/xmr-adapter.mjs';
import {moneroSubaddressNetwork,parseRequestInput,buildMoneroUri,parseMoneroUri,buildRequestLink,parseRequestFragment,encodeRequestLabel,decodeRequestLabel,requestStatus,requestStatusText,buildReceipt,requestAmountText} from '../lib/silo/xmr-request.mjs';

const ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SIZES=[0,2,3,5,6,7,9,10,11];
// Independent encoder so the tests do not depend on the decoder under test.
function encode(bytes){let out='';for(let at=0;at<bytes.length;at+=8){const block=bytes.slice(at,at+8);let v=0n;for(const b of block)v=(v<<8n)|BigInt(b);let s='';while(v>0n){s=ALPHABET[Number(v%58n)]+s;v/=58n;}out+=s.padStart(SIZES[block.length],'1');}return out;}
function address(prefix,seed){const body=new Uint8Array(65);body[0]=prefix;for(let i=1;i<65;i++)body[i]=(seed*31+i*7)&255;const sum=keccak_256(body).slice(0,4);return encode(Uint8Array.from([...body,...sum]));}
const SUB=address(36,1),SUB2=address(36,2),MAIN_SUB=address(42,3),STANDARD=address(24,4);
const HASH='a'.repeat(64);
const PROOF='InProofV2'+'3'.repeat(100);

test('addresses: only checksum-valid subaddresses are accepted, network from the prefix',()=>{
 assert.equal(moneroSubaddressNetwork(SUB),'stagenet');assert.equal(moneroSubaddressNetwork(MAIN_SUB),'mainnet');
 assert.equal(SUB[0],'7');assert.equal(MAIN_SUB[0],'8');
 assert.equal(moneroSubaddressNetwork(STANDARD),null);
 assert.equal(moneroSubaddressNetwork(SUB.slice(0,-1)+(SUB.endsWith('1')?'2':'1')),null);
 assert.equal(moneroSubaddressNetwork('x'),null);assert.equal(moneroSubaddressNetwork(null),null);
});

test('input: amount and note are validated, amount is exact',()=>{
 assert.deepEqual(parseRequestInput({}),{amountAtomic:null,note:null});
 assert.equal(parseRequestInput({amount:'0.123456789012'}).amountAtomic,123456789012n);
 for(const bad of ['0','-1','1e3','1.1234567890123','abc','.5'])assert.throws(()=>parseRequestInput({amount:bad}));
 assert.equal(parseRequestInput({note:'  hi\nthere '}).note,'hi there');
 assert.throws(()=>parseRequestInput({note:'x'.repeat(141)}));
});

test('URI: monero: scheme with tx_amount and tx_description, round trip',()=>{
 assert.equal(buildMoneroUri({address:SUB}),`monero:${SUB}`);
 assert.equal(buildMoneroUri({address:SUB,amountAtomic:1500000000000n,note:'Lunch & drinks'}),`monero:${SUB}?tx_amount=1.5&tx_description=Lunch%20%26%20drinks`);
 assert.equal(requestAmountText(1n),'0.000000000001');assert.equal(requestAmountText(2000000000000n),'2');
 const parsed=parseMoneroUri(buildMoneroUri({address:SUB,amountAtomic:1n,note:'a=b&c'}));
 assert.deepEqual(parsed,{address:SUB,network:'stagenet',amountAtomic:1n,note:'a=b&c'});
 assert.throws(()=>buildMoneroUri({address:STANDARD}));assert.throws(()=>buildMoneroUri({address:SUB,amountAtomic:0n}));
 assert.equal(parseMoneroUri('bitcoin:abc'),null);assert.equal(parseMoneroUri(`monero:${SUB}?tx_amount=0`),null);
});

test('share link: whole request in the fragment, nothing identifying, tamper-safe',()=>{
 const link=buildRequestLink('https://pay.silo.trading/',{address:SUB,amountAtomic:250000000000n,note:'Invoice 7 ✓'});
 const url=new URL(link);
 assert.equal(url.origin,'https://pay.silo.trading');assert.equal(url.search,'');assert.ok(url.hash.startsWith('#v1.'));
 assert.ok(!url.pathname.includes(SUB)&&!url.search.includes(SUB),'address must stay in the fragment');
 assert.deepEqual(parseRequestFragment(url.hash),{address:SUB,network:'stagenet',amountAtomic:250000000000n,note:'Invoice 7 ✓'});
 assert.deepEqual(parseRequestFragment(buildRequestLink('https://pay.silo.trading/',{address:SUB}).split('#')[1]),{address:SUB,network:'stagenet',amountAtomic:null,note:null});
 for(const bad of ['','#','#v2.abc','#v1.','#v1.!!!','#v1.'+Buffer.from('[1,2]').toString('base64url'),'#v1.'+Buffer.from(JSON.stringify([SUB,'abc',null])).toString('base64url'),'#v1.'+Buffer.from(JSON.stringify([STANDARD,null,null])).toString('base64url')])assert.equal(parseRequestFragment(bad),null,bad);
 assert.throws(()=>buildRequestLink('http://example.com/',{address:SUB}));
});

test('label: request metadata survives a round trip and rejects junk',()=>{
 const label=encodeRequestLabel({amountAtomic:5n,note:'n',createdAt:1700000000000});
 assert.deepEqual(decodeRequestLabel(label),{createdAt:1700000000000,amountAtomic:5n,note:'n'});
 assert.equal(decodeRequestLabel('Savings'),null);assert.equal(decodeRequestLabel('silo-request-v1:{'),null);
});

test('status: pending, confirming n/10, paid, partial; other payments never counted',()=>{
 assert.equal(requestStatus([]).state,'waiting');
 assert.equal(requestStatus([{hash:HASH,amountAtomic:'5',confirmed:false}]).state,'pending');
 const mid=requestStatus([{hash:HASH,amountAtomic:'5',confirmed:true,confirmations:3}]);
 assert.equal(requestStatusText(mid),'Confirming 3/10');
 assert.equal(requestStatus([{hash:HASH,amountAtomic:'5',confirmed:true,confirmations:10}]).state,'paid');
 assert.equal(requestStatus([{hash:HASH,amountAtomic:'5',confirmed:true,confirmations:40}]).confirmations,10);
 assert.equal(requestStatus([{hash:HASH,amountAtomic:'4',confirmed:true,confirmations:12}],{amountAtomic:5n}).state,'partial');
 assert.equal(requestStatus([{hash:HASH,amountAtomic:'4',confirmed:true,confirmations:12},{hash:'b'.repeat(64),amountAtomic:'1',confirmed:true,confirmations:11}],{amountAtomic:5n}).state,'paid');
 assert.equal(requestStatus([{hash:HASH,amountAtomic:'5',confirmed:true,confirmations:12,failed:true}]).state,'waiting');
});

test('receipt: one transaction, amount, date, txid and proof; no other payments or primary address',()=>{
 const text=buildReceipt({network:'stagenet',address:SUB,payment:{hash:HASH,amountAtomic:'1500000000000'},proof:PROOF,paidAt:Date.UTC(2026,10,4,12,30),note:'Lunch',requestedAtomic:1500000000000n});
 for(const part of ['1.5 XMR','2026-11-04 12:30 UTC',HASH,PROOF,SUB,'Lunch'])assert.ok(text.includes(part),part);
 assert.ok(!text.includes(SUB2));assert.ok(!/balance/i.test(text));
 assert.throws(()=>buildReceipt({network:'stagenet',address:SUB,payment:{hash:'zz',amountAtomic:'1'},proof:PROOF,paidAt:1}));
 assert.throws(()=>buildReceipt({network:'stagenet',address:SUB,payment:{hash:HASH,amountAtomic:'1'},proof:'not a proof',paidAt:1}));
});

// Wallet adapter with a synthetic SDK: subaddress uniqueness, labels, per-request payment filtering.
const nodeInfo=async()=>new Response(JSON.stringify({stagenet:true,mainnet:false,testnet:false}),{headers:{'content-type':'application/json'}});
function fixture(){
 const rows=[{index:0,label:''}],used=new Set(),txs=[];
 const sub=r=>({getIndex:()=>r.index,getAddress:()=>address(36,100+r.index),getIsUsed:()=>used.has(r.index),getLabel:()=>r.label});
 const wallet={getSubaddresses:async()=>rows.map(sub),getSubaddress:async(a,i)=>sub(rows[i]),createSubaddress:async()=>{const r={index:rows.length,label:''};rows.push(r);return sub(r);},
  setSubaddressLabel:async(a,i,l)=>{rows[i].label=l;},getAddressIndex:async addr=>{const r=rows.find(x=>address(36,100+x.index)===addr);if(!r)throw Error('not mine');return {getAccountIndex:()=>0,getIndex:()=>r.index};},
  getTxs:async()=>txs,isSynced:async()=>true,getPrimaryAddress:async()=>address(24,9),getRestoreHeight:async()=>1,getData:async()=>[Uint8Array.of(1),Uint8Array.of(2)],getSeed:async()=>'words',sync:async()=>{},
  getTxProof:async(h,a)=>PROOF,close:async()=>{}};
 const tx=(hash,transfers,confirmed=true,confirmations=12)=>({getHash:()=>hash,getIsConfirmed:()=>confirmed,getNumConfirmations:()=>confirmations,getIsFailed:()=>false,getBlock:()=>({getTimestamp:()=>1793000000}),getIncomingTransfers:()=>transfers.map(([i,amount])=>({getAccountIndex:()=>0,getSubaddressIndex:()=>i,getAmount:()=>BigInt(amount),getAddress:()=>address(36,100+i)}))});
 return {rows,used,txs,tx,sdk:{LibraryUtils:{setLogLevel:async()=>{}},MoneroNetworkType:{STAGENET:2},MoneroUtils:{validateAddress:async()=>{}},createWalletFull:async()=>wallet,openWalletFull:async()=>wallet,shutdown:async()=>{}}};
}
const open=sdk=>openXmrResearch({sdk,node:'https://synthetic.example',fetcher:nodeInfo});
const open0=(sdk,options)=>openXmrResearch({sdk,node:'https://synthetic.example',fetcher:nodeInfo,...options});
const openCached=(sdk,cache)=>openXmrResearch({sdk,node:'https://synthetic.example',fetcher:nodeInfo,cache});

test('adapter: every request gets a new subaddress, never the ordinary Receive one, and is listed from its label',async()=>{
 const f=fixture(),w=await open(f.sdk);
 const ordinary=await w.receive();
 const a=await w.createRequest({amountAtomic:7n,note:'one'}),b=await w.createRequest({});await w.commitRequest(a.index);await w.commitRequest(b.index);
 assert.notEqual(a.address,b.address);assert.notEqual(a.address,ordinary);assert.notEqual(b.address,ordinary);
 assert.equal(new Set([ordinary,a.address,b.address]).size,3);
 assert.equal(await w.receive(),ordinary,'ordinary Receive must not jump to a request address');
 const list=await w.listRequests();
 assert.deepEqual(list.map(r=>[r.address,r.amountAtomic,r.note]),[[b.address,null,null],[a.address,7n,'one']]);
 await assert.rejects(async()=>{for(let i=0;i<SILO_XMR_SUBADDRESS_GAP+2;i++){const r=await w.createRequest({});await w.commitRequest(r.index);}},/subaddress-gap/);
});

test('adapter: request payments see only their own subaddress; proof is per transaction and address',async()=>{
 const f=fixture(),w=await open(f.sdk);
 await w.receive();const a=await w.createRequest({amountAtomic:5n}),b=await w.createRequest({});await w.commitRequest(a.index);await w.commitRequest(b.index);
 f.txs.push(f.tx('c'.repeat(64),[[a.index,'5']]),f.tx('d'.repeat(64),[[b.index,'9'],[1,'4']],true,3));
 assert.deepEqual((await w.requestPayments(a.address)).map(p=>[p.hash,p.amountAtomic]),[['c'.repeat(64),'5']]);
 assert.deepEqual((await w.requestPayments(b.address)).map(p=>[p.hash,p.amountAtomic,p.confirmations]),[['d'.repeat(64),'9',3]]);
 await assert.rejects(w.requestPayments(address(36,555)));
 assert.equal(await w.requestProof('c'.repeat(64),a.address),PROOF);
 await assert.rejects(w.requestProof('xx',a.address));
});

test('adapter: overview groups payments per request in one pass and reports unknown when not synced',async()=>{
 const f=fixture(),w=await open(f.sdk);
 await w.receive();const a=await w.createRequest({amountAtomic:5n}),b=await w.createRequest({});await w.commitRequest(a.index);await w.commitRequest(b.index);
 f.txs.push(f.tx('c'.repeat(64),[[a.index,'5'],[1,'2']]),f.tx('d'.repeat(64),[[b.index,'9']],false,0),f.tx('e'.repeat(64),[[1,'7']]));
 const view=await w.requestsOverview();
 assert.deepEqual(view.map(r=>[r.address,r.payments.map(p=>[p.hash,p.amountAtomic,p.confirmed])]),[[b.address,[['d'.repeat(64),'9',false]]],[a.address,[['c'.repeat(64),'5',true]]]]);
 assert.ok(!JSON.stringify(view,(k,v)=>typeof v==='bigint'?String(v):v).includes('e'.repeat(64)),'a payment to the ordinary address must not appear');
});

test('R1-01: an unsaved request is hidden everywhere until committed, and a failed save leaves nothing to show',async()=>{
 const f=fixture(),w=await open(f.sdk);
 await w.receive();
 const made=await w.createRequest({amountAtomic:5n,note:'secret'});
 // Between creation and a successful save (delayed or failing save, parent re-renders, overview refresh) it is not listed or readable.
 assert.deepEqual(await w.requestsOverview(),[]);assert.deepEqual(await w.listRequests(),[]);
 await assert.rejects(w.requestPayments(made.address));
 // Save failed: discard clears the label, so even after a later successful wallet save it never shows up as a request.
 await w.discardRequest(made.index);
 assert.deepEqual(await w.requestsOverview(),[]);assert.deepEqual(await w.listRequests(),[]);assert.equal(f.rows[made.index].label,'');
 // A request whose save succeeded is committed and shown.
 const ok=await w.createRequest({});assert.deepEqual(await w.listRequests(),[]);await w.commitRequest(ok.index);
 assert.deepEqual((await w.listRequests()).map(r=>r.address),[ok.address]);
});

test('R1-02: requests are switched off after a recovery from the phrase alone, and stay off on later full-backup reopens',async()=>{
 // Normal wallet: on.
 assert.equal((await open(fixture().sdk)).requestsGated(),false);
 // Restored from the phrase alone: off, creation refused, and the marker is written into the wallet's own data.
 const f=fixture(),w=await open0(f.sdk,{seed:'fixture words',height:5});
 assert.equal(w.requestsGated(),true);await assert.rejects(w.createRequest({}),/requests-gated/);
 assert.ok(f.rows[0].label.startsWith('silo-recovered'));
 assert.equal(f.rows.length,1,'refusal must not create a subaddress');
 // Reopened later from the full encrypted backup (marker still in the cache): still off.
 const again=await openCached(f.sdk,{seed:'fixture words',height:5,subaddresses:0,keysData:'AQ==',cacheData:'Ag=='});
 assert.equal(again.requestsGated(),true);await assert.rejects(again.createRequest({}),/requests-gated/);
 // Reopened from recovery material only (labels gone): off.
 const reduced=await openCached(fixture().sdk,{seed:'fixture words',height:5,subaddresses:7,cacheOmitted:true});
 assert.equal(reduced.requestsGated(),true);await assert.rejects(reduced.createRequest({}),/requests-gated/);
 // A normal full-backup reopen without the marker is on.
 const normal=await openCached(fixture().sdk,{seed:'fixture words',height:5,subaddresses:0,keysData:'AQ==',cacheData:'Ag=='});
 assert.equal(normal.requestsGated(),false);
 // Ordinary receive keeps working in a gated wallet.
 assert.ok((await w.receive()).length>0);
});

test('R2: a failed label clear keeps a failed-save request hidden; gated wallets also refuse new receive addresses and keep the gate across a recovery-material reopen',async()=>{
 const f=fixture(),w=await open(f.sdk);await w.receive();
 const made=await w.createRequest({amountAtomic:5n,note:'secret'});
 // Save failed AND clearing the label fails: it must stay hidden (listing, overview, payments).
 const real=f.rows[made.index];let fail=true;
 const sdkWallet=await f.sdk.createWalletFull();const set=sdkWallet.setSubaddressLabel;sdkWallet.setSubaddressLabel=async(a,i,l)=>{if(fail&&l==='')throw Error('label store failed');return set(a,i,l);};
 await assert.rejects(w.discardRequest(made.index));
 assert.deepEqual(await w.listRequests(),[]);assert.deepEqual(await w.requestsOverview(),[]);await assert.rejects(w.requestPayments(made.address));
 assert.ok(real.label.startsWith('silo-request-v1:'),'label still present, request still hidden');
 fail=false;await w.discardRequest(made.index);assert.equal(real.label,'');
 // Phrase restore: new receive addresses are refused, the current one works.
 const g=await open0(fixture().sdk,{seed:'fixture words',height:5});
 await assert.rejects(g.newReceive(),/requests-gated/);assert.ok((await g.receive()).length>0);
 // Recovery-material reopen writes the marker, so a later full-cache reopen stays gated.
 const f2=fixture();const reduced=await openCached(f2.sdk,{seed:'fixture words',height:5,subaddresses:2,cacheOmitted:true});
 assert.equal(reduced.requestsGated(),true);assert.ok(f2.rows[0].label.startsWith('silo-request-labels-lost'));
 const full=await openCached(f2.sdk,{seed:'fixture words',height:5,subaddresses:2,keysData:'AQ==',cacheData:'Ag=='});
 assert.equal(full.requestsGated(),true);assert.ok((await full.newReceive()).length>0,'recovery material keeps the address count, so new receive addresses stay allowed');
 // Phrase-only marker survives a full-cache reopen and keeps new receive refused.
 const f3=fixture();await open0(f3.sdk,{seed:'fixture words',height:5});const again=await openCached(f3.sdk,{seed:'fixture words',height:5,subaddresses:0,keysData:'AQ==',cacheData:'Ag=='});
 await assert.rejects(again.newReceive(),/requests-gated/);
 // A normal wallet still gets new receive addresses.
 const n=await open(fixture().sdk);await n.receive();assert.ok((await n.newReceive()).length>0);
});

test('round 3: a phrase-restored wallet refuses a new exchange (Cash out) address; ordinary and recovery-material wallets still get one',async()=>{
 const g=await open0(fixture().sdk,{seed:'fixture words',height:5});
 await assert.rejects(g.newExchangeReceive(),/Cash out to XMR is off/);
 const f=fixture();await open0(f.sdk,{seed:'fixture words',height:5});
 const reopened=await openCached(f.sdk,{seed:'fixture words',height:5,subaddresses:0,keysData:'AQ==',cacheData:'Ag=='});
 await assert.rejects(reopened.newExchangeReceive(),/Cash out to XMR is off/);
 const n=await open(fixture().sdk);await n.receive();assert.ok((await n.newExchangeReceive()).length>0);
 const reduced=await openCached(fixture().sdk,{seed:'fixture words',height:5,subaddresses:2,cacheOmitted:true});
 assert.ok((await reduced.newExchangeReceive()).length>0);
});
