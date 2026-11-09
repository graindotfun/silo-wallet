import test from 'node:test';import assert from 'node:assert/strict';
import {openZecResearch,ZEC_ENGINE,ZEC_PREVIOUS_SQLITE_ENGINE} from '../lib/silo/zec-adapter.mjs';
import {transactionConsent} from '../lib/silo/amounts.mjs';
const review={network:'testnet',asset:'ZEC',address:'synthetic orchard',amount:'1',fee:'0.0001'};
const pending={review,consent:transactionConsent(review),authorized:{ids:'AQ==',expiryHeights:[140]},attempted:true};
function fixture(matches=true){const calls=[],core={async call(op,args={}){calls.push(op);switch(op){case 'chainCheck':return {chainMatches:true,branchMatches:matches,tip:100};case 'open':assert.deepEqual([...args.database],[3]);return true;case 'info':return {account:0,birthday:37,address:review.address};case 'address':return args.address;case 'bytes':return Uint8Array.of(4);case 'close':return true;default:throw Error('Unexpected '+op);}},terminate(){}};return {sdk:{open:async()=>core},calls};}
const cache=()=>({seed:'public synthetic seed',height:37,account:0,engine:ZEC_PREVIOUS_SQLITE_ENGINE,database:'Aw==',pending});
test('previous SQLite backup opens its database, requests archive and keeps its pending journal unchanged',async()=>{
 const f=fixture(),active=await openZecResearch({sdk:f.sdk,node:'https://fixture.invalid',cache:cache()});
 assert.equal(active.migratedFrom,'sqlite-nu63');const backup=await active.backup();assert.equal(backup.engine,ZEC_ENGINE);assert.equal(backup.database,'BA==');assert.deepEqual(backup.pending,pending);assert.equal(backup.height,37);
 assert.ok(f.calls.includes('open'));assert.ok(!f.calls.some(op=>['create','generate','inspectRaw','authorize','send'].includes(op)));await active.close();
});
test('unknown consensus retains previous SQLite backup format and requests no migration archive/write',async()=>{
 const f=fixture(false),original=cache(),active=await openZecResearch({sdk:f.sdk,node:'https://fixture.invalid',cache:original});
 assert.equal(active.migratedFrom,null);assert.equal(active.engine.outdated,true);const backup=await active.backup();assert.equal(backup.engine,ZEC_PREVIOUS_SQLITE_ENGINE);assert.equal(backup.database,original.database);assert.deepEqual(backup.pending,pending);assert.ok(!f.calls.some(op=>['open','info','bytes','create','authorize','send'].includes(op)));await active.close();
});
