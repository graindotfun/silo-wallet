import test from 'node:test';
import assert from 'node:assert/strict';
import {openXmrResearch,SILO_XMR_SUBADDRESS_GAP,SILO_XMR_SUBADDRESS_MAX,SILO_XMR_SUBADDRESS_LOOKAHEAD} from '../lib/silo/xmr-adapter.mjs';
import {sealSilo,openSilo} from '../lib/silo/local-envelope.mjs';
import {recoverSiloOffline} from '../lib/silo/offline-recovery.mjs';
import {boundedSiloBackup} from '../lib/silo/backup-budget.mjs';
import {siloNewReceiveAddress} from '../lib/silo/new-receive.mjs';

const nodeInfo=async()=>new Response(JSON.stringify({stagenet:true,mainnet:false,testnet:false}),{headers:{'content-type':'application/json'}});
// Synthetic account-0 subaddresses: index 0 is the primary address; `used` marks indexes that received funds.
function xmrSdk({used=new Set()}={}){
 const rows=[0],created=[];
 const row=index=>({getIndex:()=>index,getAddress:()=>`fixture subaddress ${index}`,getIsUsed:()=>used.has(index),getLabel:()=>''});
 const wallet={getSubaddress:async()=>row(0),setSubaddressLabel:async()=>{},getSubaddresses:async account=>{assert.equal(account,0);return rows.map(row);},createSubaddress:async account=>{assert.equal(account,0);const index=rows.length;rows.push(index);created.push(index);return row(index);},
  getPrimaryAddress:async()=> 'fixture subaddress 0',getRestoreHeight:async()=>321,getData:async()=>[Uint8Array.of(1),Uint8Array.of(2)],getSeed:async()=> 'fixture words',sync:async()=>{},isSynced:async()=>true,close:async()=>{}};
 return {rows,created,used,sdk:{LibraryUtils:{setLogLevel:async()=>{}},MoneroNetworkType:{STAGENET:2},MoneroUtils:{validateAddress:async()=>{}},createWalletFull:async()=>wallet,openWalletFull:async()=>wallet,shutdown:async()=>{}}};
}
const open=(sdk,options={})=>openXmrResearch({sdk,node:'https://synthetic.example',fetcher:nodeInfo,...options});

test('XMR receive shows a subaddress, never the primary address, and the backup records it',async()=>{
 const {sdk,created}=xmrSdk(),wallet=await open(sdk);
 assert.equal(await wallet.receive(),'fixture subaddress 1');assert.deepEqual(created,[1]);
 // Reopening the same state shows the same unused address instead of creating another.
 assert.equal(await wallet.receive(),'fixture subaddress 1');assert.deepEqual(created,[1]);
 assert.equal((await wallet.backup()).subaddresses,1);
});

test('XMR receive moves on once the shown subaddress has received funds',async()=>{
 const {sdk,used}=xmrSdk(),wallet=await open(sdk);
 assert.equal(await wallet.receive(),'fixture subaddress 1');used.add(1);
 assert.equal(await wallet.receive(),'fixture subaddress 2');assert.equal((await wallet.backup()).subaddresses,2);
});

test('XMR new receive address creates the next subaddress and stops at the unused gap',async()=>{
 const {sdk,used}=xmrSdk(),wallet=await open(sdk);
 await wallet.receive();
 for(let index=2;index<=SILO_XMR_SUBADDRESS_GAP;index++)assert.equal(await wallet.newReceive(),`fixture subaddress ${index}`);
 await assert.rejects(wallet.newReceive(),/subaddress-gap/);
 // A payment to any handed-out address reopens the window after it.
 used.add(10);assert.equal(await wallet.newReceive(),`fixture subaddress ${SILO_XMR_SUBADDRESS_GAP+1}`);
});

test('XMR seed or recovery-only reopen recreates every handed-out subaddress from the backup count',async()=>{
 for(const options of [{cache:{seed:'fixture words',height:9,subaddresses:7,cacheOmitted:true}},{cache:{seed:'fixture words',height:9,subaddresses:7,keysData:'AQ==',cacheData:'Ag=='}}]){
  const {sdk,rows}=xmrSdk(),wallet=await open(sdk,options);
  assert.equal(rows.length,8);assert.equal(await wallet.receive(),'fixture subaddress 7');assert.equal((await wallet.backup()).subaddresses,7);
 }
 // A wallet that already holds the subaddresses creates none.
 const {sdk,rows,created}=xmrSdk();rows.push(1,2,3);await open(sdk,{cache:{seed:'fixture words',height:9,subaddresses:2,keysData:'AQ==',cacheData:'Ag=='}});assert.deepEqual(created,[]);
});

test('XMR backups without a count open as before; an invalid count is refused before any address is created',async()=>{
 const {sdk,created}=xmrSdk();await open(sdk,{cache:{seed:'fixture words',height:9,keysData:'AQ==',cacheData:'Ag=='}});assert.deepEqual(created,[]);
 for(const subaddresses of [-1,1.5,'3',10001]){const fresh=xmrSdk();await assert.rejects(open(fresh.sdk,{cache:{seed:'fixture words',height:9,subaddresses,cacheOmitted:true}}),/receive address count/);assert.deepEqual(fresh.created,[]);}
});

test('XMR recovery-only backup keeps the subaddress count, and offline recovery reports it',async()=>{
 const {sdk}=xmrSdk(),wallet=await open(sdk);await wallet.receive();await wallet.newReceive();
 const full=await wallet.backup(),reduced=boundedSiloBackup('xmr',full,96);
 assert.equal(reduced.cacheOmitted,true);assert.equal(reduced.subaddresses,2);
 const envelope=await sealSilo('xmr','stagenet',full,'disposable subaddress passphrase');
 assert.equal((await recoverSiloOffline(envelope,'disposable subaddress passphrase',{zone:'xmr',network:'stagenet'})).receiveAddresses,2);
});

test('XMR subaddress calls are refused once the wallet is locked',async()=>{
 const {sdk}=xmrSdk(),wallet=await open(sdk);await wallet.close();
 await assert.rejects(wallet.receive(),/locked/);await assert.rejects(wallet.newReceive(),/locked/);
});

test('a new receive address is never returned when saving its backup fails',async()=>{
 const {sdk}=xmrSdk(),wallet=await open(sdk);await wallet.receive();
 const order=[];
 await assert.rejects(siloNewReceiveAddress(wallet,async()=>{order.push('save');throw Error('storage full');}),/storage full/);
 assert.deepEqual(order,['save']);
 // The created subaddress is recorded by the next successful save, so it is never lost even though it was not shown.
 assert.equal((await wallet.backup()).subaddresses,2);
 const shown=await siloNewReceiveAddress(wallet,async()=>{order.push('saved');});assert.equal(shown,'fixture subaddress 3');assert.deepEqual(order,['save','saved']);
 await assert.rejects(siloNewReceiveAddress({},async()=>{}),/no new receive addresses/);
});

test('XMR opening reuses the last address at the maximum even after it received funds',async()=>{
 const fixture=xmrSdk();for(let index=1;index<=SILO_XMR_SUBADDRESS_MAX;index++)fixture.rows.push(index);
 const wallet=await open(fixture.sdk);
 assert.equal(await wallet.receive(),`fixture subaddress ${SILO_XMR_SUBADDRESS_MAX}`);
 fixture.used.add(SILO_XMR_SUBADDRESS_MAX);
 assert.equal(await wallet.receive(),`fixture subaddress ${SILO_XMR_SUBADDRESS_MAX}`);
 await assert.rejects(wallet.newReceive(),/subaddress-limit/);
 assert.deepEqual(fixture.created,[]);assert.equal((await wallet.backup()).subaddresses,SILO_XMR_SUBADDRESS_MAX);
});

test('encrypted maximum-index backup reopens and can be saved without creating an invalid next index',async()=>{
 const passphrase='disposable ceiling recovery passphrase';
 const envelope=await sealSilo('xmr','stagenet',{seed:'fixture words',height:9,subaddresses:SILO_XMR_SUBADDRESS_MAX,keysData:'AQ==',cacheData:'Ag=='},passphrase);
 const cache=await openSilo(envelope,passphrase,{zone:'xmr',network:'stagenet'});
 const fixture=xmrSdk({used:new Set([SILO_XMR_SUBADDRESS_MAX])}),wallet=await open(fixture.sdk,{cache});
 assert.equal(await wallet.receive(),`fixture subaddress ${SILO_XMR_SUBADDRESS_MAX}`);
 await assert.rejects(wallet.newReceive(),/subaddress-limit/);
 const saved=await sealSilo('xmr','stagenet',await wallet.backup(),passphrase);
 assert.equal((await openSilo(saved,passphrase,{zone:'xmr',network:'stagenet'})).subaddresses,SILO_XMR_SUBADDRESS_MAX);
 assert.equal(fixture.created.length,SILO_XMR_SUBADDRESS_MAX);
});

test('XMR wallet whose scan found subaddresses beyond the maximum still opens and saves a backup that reopens',async()=>{
 // Another wallet with the same phrase handed out more addresses; scanning created them up to the one that was paid.
 const beyond=SILO_XMR_SUBADDRESS_MAX+50,fixture=xmrSdk({used:new Set([beyond])});for(let index=1;index<=beyond;index++)fixture.rows.push(index);
 const wallet=await open(fixture.sdk,{cache:{seed:'fixture words',height:9,subaddresses:SILO_XMR_SUBADDRESS_MAX,keysData:'AQ==',cacheData:'Ag=='}});
 assert.equal(await wallet.receive(),`fixture subaddress ${beyond}`);await assert.rejects(wallet.newReceive(),/subaddress-limit/);assert.deepEqual(fixture.created,[]);
 const backup=await wallet.backup();assert.equal(backup.subaddresses,SILO_XMR_SUBADDRESS_MAX);
 const reopened=await open(xmrSdk().sdk,{cache:{...backup,cacheOmitted:true}});assert.equal(await reopened.receive(),`fixture subaddress ${SILO_XMR_SUBADDRESS_MAX}`);
});

test('scanned addresses outside bounded restore lookahead retain their full cache and actual high-water mark',async()=>{
 const beyond=SILO_XMR_SUBADDRESS_MAX+SILO_XMR_SUBADDRESS_LOOKAHEAD,fixture=xmrSdk({used:new Set([beyond])});
 for(let index=1;index<=beyond;index++)fixture.rows.push(index);
 const wallet=await open(fixture.sdk),backup=await wallet.backup();
 assert.equal(await wallet.receive(),`fixture subaddress ${beyond}`);await assert.rejects(wallet.newReceive(),/subaddress-limit/);
 assert.equal(backup.subaddresses,SILO_XMR_SUBADDRESS_MAX);assert.equal(backup.scannedSubaddresses,beyond);assert.equal(backup.subaddressCacheRequired,true);
 assert.equal(boundedSiloBackup('xmr',backup),backup);assert.throws(()=>boundedSiloBackup('xmr',backup,1),/full wallet cache/);
 const envelope=await sealSilo('xmr','stagenet',backup,'disposable beyond ceiling passphrase');
 const decrypted=await openSilo(envelope,'disposable beyond ceiling passphrase',{zone:'xmr',network:'stagenet'});
 const summary=await recoverSiloOffline(envelope,'disposable beyond ceiling passphrase',{zone:'xmr',network:'stagenet'});
 assert.equal(summary.receiveAddresses,beyond);assert.equal(summary.subaddressCacheRequired,true);
 await assert.rejects(open(xmrSdk().sdk,{cache:{...decrypted,cacheOmitted:true}}),/full wallet cache/);
 const restored=await open(fixture.sdk,{cache:decrypted});assert.equal(await restored.receive(),`fixture subaddress ${beyond}`);
});

test('XMR history labels a payment to this wallet\'s own address as a transfer within the wallet',async()=>{
 const {xmrHistory}=await import('../lib/silo/native-history.mjs');
 const tx=(hash,outgoing,incoming,destinations)=>({getHash:()=>hash,getIsConfirmed:()=>true,getIsFailed:()=>false,getNumConfirmations:()=>12,getHeight:()=>100,getOutgoingAmount:()=>outgoing,getIncomingAmount:()=>incoming,getFee:()=>30n,getOutgoingTransfer:()=>destinations?{getDestinations:()=>destinations.map(address=>({getAddress:()=>address}))}:undefined});
 const own=tx('a'.repeat(64),3000n,undefined,['fixture subaddress 3']),external=tx('b'.repeat(64),3000n,undefined,['someone else']),rebuilt=tx('c'.repeat(64),0n,undefined,null),incoming=tx('d'.repeat(64),undefined,100000n,null);
 // The adapter decides which destinations belong to the wallet.
 const {sdk}=xmrSdk(),wallet=await open(sdk);
 const history=xmrHistory([own,external,rebuilt,incoming],true,new Set(['a'.repeat(64)]));
 const byId=Object.fromEntries(history.rows.map(row=>[row.id[0],row]));
 assert.equal(byId.a.selfTransfer,true);assert.equal(byId.b.selfTransfer,false);assert.equal(byId.c.selfTransfer,true,'a phrase restore reports a zero outgoing amount');assert.equal(byId.d.selfTransfer,false);
 await wallet.close();
});

test('XMR adapter history finds self transfers by asking the wallet whether each destination is its own',async()=>{
 const {sdk}=xmrSdk(),captured={};
 const original=sdk.createWalletFull;sdk.createWalletFull=async config=>{const wallet=await original(config);captured.wallet=wallet;return wallet;};
 const wallet=await open(sdk);const inner=captured.wallet;
 const tx=(hash,destination)=>({getHash:()=>hash,getIsConfirmed:()=>true,getIsFailed:()=>false,getNumConfirmations:()=>12,getHeight:()=>100,getOutgoingAmount:()=>3000n,getIncomingAmount:()=>undefined,getFee:()=>30n,getOutgoingTransfer:()=>({getDestinations:()=>[{getAddress:()=>destination}]})});
 inner.getTxs=async()=>[tx('a'.repeat(64),'fixture subaddress 3'),tx('b'.repeat(64),'someone else')];
 inner.getAddressIndex=async address=>{if(!address.startsWith('fixture subaddress'))throw Error("Address doesn't belong to the wallet");return {getIndex:()=>3};};
 const rows=Object.fromEntries((await wallet.history()).rows.map(row=>[row.id[0],row.selfTransfer]));
 assert.deepEqual(rows,{a:true,b:false});
 await wallet.close();await assert.rejects(wallet.history(),/locked/);
});

test('exchange destination never replaces ordinary Receive, including reduced-backup reopen',async()=>{
 const first=xmrSdk(),wallet=await open(first.sdk);assert.equal(await wallet.receive(),'fixture subaddress 1');
 assert.equal(await wallet.newExchangeReceive(),'fixture subaddress 2');assert.equal(await wallet.receive(),'fixture subaddress 1');
 const backup=await wallet.backup();assert.equal(backup.ordinaryReceiveIndex,1);assert.equal(backup.subaddresses,2);
 const restored=xmrSdk(),reopened=await open(restored.sdk,{cache:{...backup,keysData:undefined,cacheData:undefined,cacheOmitted:true}});
 assert.equal(await reopened.receive(),'fixture subaddress 1');assert.equal(await reopened.newExchangeReceive(),'fixture subaddress 3');
 assert.equal(await reopened.receive(),'fixture subaddress 1');assert.equal(await reopened.newReceive(),'fixture subaddress 4');assert.equal(await reopened.receive(),'fixture subaddress 4');
});
test('invalid persisted ordinary Receive index is refused',async()=>{
 for(const index of [0,-1,2,1.2,'1'])await assert.rejects(open(xmrSdk().sdk,{cache:{seed:'fixture words',height:9,subaddresses:1,ordinaryReceiveIndex:index,cacheOmitted:true}}),/ordinary receive index/);
});
