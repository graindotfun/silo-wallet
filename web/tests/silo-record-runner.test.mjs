// Astra F1-H1: a stuck record's tick must not starve other records or later timer passes.
import test from 'node:test';import assert from 'node:assert/strict';
import {createRecordRunner} from '../lib/silo/record-runner.mjs';
const deferred=()=>{let resolve;const promise=new Promise(a=>{resolve=a;});return {promise,resolve};};
test('continued polling after a stuck tick: other records and later passes keep running; only the stuck record is skipped',async()=>{
 const runner=createRecordRunner(),stuck=deferred(),calls={a:0,b:0},views=[];
 const tick=async r=>{calls[r.swapId]++;if(r.swapId==='a')await stuck.promise;return r.swapId;};
 const records=[{swapId:'a'},{swapId:'b'}];
 const first=runner.runAll(records,tick,(r,v)=>views.push(v),()=>{});
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(views,['b'],'b finished while a is stuck');
 await runner.runAll(records,tick,(r,v)=>views.push(v),()=>{});
 assert.equal(calls.a,1,'a is not re-entered');assert.equal(calls.b,2,'b is polled again');
 stuck.resolve();await first;assert.equal(runner.busy('a'),false);
 await runner.runAll(records,tick,(r,v)=>views.push(v),()=>{});assert.equal(calls.a,2);
});
test('a throwing tick is reported for its record and frees it',async()=>{
 const runner=createRecordRunner(),errors=[];
 await runner.runAll([{swapId:'x'}],async()=>{throw Error('boom');},()=>{},r=>errors.push(r.swapId));
 assert.deepEqual(errors,['x']);assert.equal(runner.busy('x'),false);
});
