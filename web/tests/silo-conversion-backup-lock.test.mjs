/** Encrypted local conversion journal only. Synthetic records, no wallet SDK, signing or provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {encryptedCrosschainStore} from '../lib/silo/crosschain-store.mjs';
const PASS='Synthetic conversion recovery passphrase';
const barrier=()=>{let release,enter;const reached=new Promise(r=>enter=r),wait=new Promise(r=>release=r);return {reached,release,async pause(){enter();await wait;}};};
const record=(route='sol-to-xmr')=>({id:route+'-fixture',revision:0,intent:{route},state:'creation-uncertain',deposit:null});
function fixture(data=new Map()){const hooks={};let writes=0;const backend={read:async key=>{await hooks.read?.();return data.get(key)??null;},entries:async()=>{await hooks.entries?.();return [...data];},compareAndSwap:async(key,revision,next)=>{writes++;await hooks.write?.();if((data.get(key)?.revision??null)!==revision)return false;data.set(key,structuredClone(next));return true;}};return {data,hooks,store:encryptedCrosschainStore(backend,PASS),writes:()=>writes};}
for(const action of ['read-missing','list-empty','export-empty','import-read'])test(`conversion close during ${action} rejects late result and prevents new writes`,async()=>{
 const source=fixture();await source.store.compareAndSwap('sol-to-xmr-fixture',null,record());const snapshot=await source.store.exportEncrypted();const f=fixture(),gate=barrier();
 f.hooks[action==='import-read'||action==='read-missing'?'read':'entries']=()=>gate.pause();
 const running=action==='read-missing'?f.store.read('missing'):action==='list-empty'?f.store.list():action==='export-empty'?f.store.exportEncrypted():f.store.importEncrypted(snapshot);
 await gate.reached;f.store.close();gate.release();await assert.rejects(running,/locked/);assert.equal(f.writes(),0);assert.equal(f.data.size,0);source.store.close();
});
test('conversion close after backend write starts retains durable record but refuses success',async()=>{
 const f=fixture(),gate=barrier();f.hooks.write=()=>gate.pause();const running=f.store.compareAndSwap('sol-to-xmr-fixture',null,record());await gate.reached;f.store.close();gate.release();await assert.rejects(running,/locked/);assert.equal(f.data.size,1);assert.equal(f.writes(),1);
});
test('conversion import snapshots validated encrypted entries before any caller mutation',async()=>{
 const a=fixture();await a.store.compareAndSwap('sol-to-xmr-fixture',null,record());const snapshot=await a.store.exportEncrypted(),before=structuredClone(snapshot),b=fixture(),gate=barrier();b.hooks.read=()=>gate.pause();const running=b.store.importEncrypted(snapshot);await gate.reached;snapshot.entries[0][1].envelope.ciphertext='replaced after validation';gate.release();await running;assert.deepEqual([...b.data],before.entries);assert.deepEqual(await b.store.read('sol-to-xmr-fixture'),record());a.store.close();b.store.close();
});
test('conversion write snapshots the reviewed record before asynchronous hashing',async()=>{
 const f=fixture(),original=record(),running=f.store.compareAndSwap(original.id,null,original);original.intent.route='changed-after-call';await running;assert.equal((await f.store.read(original.id)).intent.route,'sol-to-xmr');f.store.close();
});
test('conversion recovery preflights existing-order conflict before inserting any missing record',async()=>{
 const a=fixture();for(const route of ['sol-to-xmr','xmr-to-sol']){const r=record(route);await a.store.compareAndSwap(r.id,null,r);}const snapshot=await a.store.exportEncrypted(),b=fixture(),second=record('xmr-to-sol');await b.store.compareAndSwap(second.id,null,{...second,state:'newer-local-state'});const before=structuredClone([...b.data]),writes=b.writes();await assert.rejects(b.store.importEncrypted(snapshot),/existing-order/);assert.deepEqual([...b.data],before);assert.equal(b.writes(),writes);a.store.close();b.store.close();
});
test('conversion encrypted journal refuses another wallet network without modifying target',async()=>{
 const {sealSilo}=await import('../lib/silo/local-envelope.mjs');const r=record(),key=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(r.id))).toString('hex');const envelope=await sealSilo('xmr','stagenet',{schema:'silo-crosschain-order-v1',record:r},PASS),f=fixture();await assert.rejects(f.store.importEncrypted({schema:'silo-crosschain-recovery-v1',entries:[[key,{revision:0,envelope}]]}),/binding/);assert.equal(f.data.size,0);f.store.close();
});

test('close during first imported write keeps partial recovery and exact retry fills only missing rows',async()=>{
 const a=fixture();for(const route of ['sol-to-xmr','xmr-to-sol']){const r=record(route);await a.store.compareAndSwap(r.id,null,r);}const snapshot=await a.store.exportEncrypted(),b=fixture(),gate=barrier();b.hooks.write=()=>gate.pause();const running=b.store.importEncrypted(snapshot);await gate.reached;b.store.close();gate.release();await assert.rejects(running,/locked/);assert.equal(b.data.size,1);assert.equal(b.writes(),1);
 const reopened=fixture(b.data);await reopened.store.importEncrypted(snapshot);assert.equal(reopened.writes(),1);assert.deepEqual([...reopened.data],snapshot.entries);a.store.close();reopened.store.close();
});
test('a cross-tab conflict after import preflight preserves committed first row and newer conflicting row',async()=>{
 const a=fixture();for(const route of ['sol-to-xmr','xmr-to-sol']){const r=record(route);await a.store.compareAndSwap(r.id,null,r);}const snapshot=await a.store.exportEncrypted(),other=fixture(),r=record('xmr-to-sol');await other.store.compareAndSwap(r.id,null,{...r,state:'newer-other-tab'});const conflict=[...other.data][0],b=fixture();b.hooks.write=async()=>{if(b.writes()===2)b.data.set(...structuredClone(conflict));};
 await assert.rejects(b.store.importEncrypted(snapshot),/concurrent-change/);assert.deepEqual(b.data.get(snapshot.entries[0][0]),snapshot.entries[0][1]);assert.deepEqual(b.data.get(conflict[0]),conflict[1]);const writes=b.writes();await assert.rejects(b.store.importEncrypted(snapshot),/existing-order/);assert.equal(b.writes(),writes);a.store.close();other.store.close();b.store.close();
});

test('conversion close always closes backend once, even without an initial passphrase',()=>{
 for(const pass of [PASS,null]){let closes=0;const store=encryptedCrosschainStore({close:()=>closes++},pass);store.close();store.close();assert.equal(closes,1);}
});
