import test from 'node:test';import assert from 'node:assert/strict';
import {zecBalances} from '../lib/silo/zec-balances.mjs';
const summary={chainTip:100,fullyScanned:100,orchard:{total:'100000000',spendable:'80000000'},ironwood:{total:70000000,spendable:60000000}};
test('ZEC pools sum once and retain separate total and spendable amounts',()=>{
 assert.deepEqual(zecBalances(summary),{amount:'170000000',unlocked:'140000000',status:'checked',pools:{
  orchard:{amount:'100000000',unlocked:'80000000'},ironwood:{amount:'70000000',unlocked:'60000000'}}});
 assert.equal(zecBalances({...summary,fullyScanned:99}).status,'partial coverage');
});
test('missing or malformed pools never become zero or a falsely complete aggregate',()=>{
 for(const pool of [null,{}, {total:-1,spendable:0},{total:'1e8',spendable:0},{total:1.5,spendable:0},
  {total:'2100000000000001',spendable:0},{total:'5',spendable:'6'},{total:'1',spendable:null}]){
  const balance=zecBalances({...summary,orchard:pool});assert.equal(balance.amount,null);assert.equal(balance.unlocked,null);
  assert.equal(balance.status,'not checked');assert.equal(balance.pools.orchard.amount,null);
  assert.equal(balance.pools.ironwood.amount,'70000000');
 }
 assert.equal(zecBalances(null).amount,null);
 assert.equal(zecBalances({...summary,ironwood:undefined}).amount,null);
});
test('zero is displayed only when both pools explicitly report zero; invalid scan heights stay unchecked',()=>{
 const zero={...summary,orchard:{total:0,spendable:0},ironwood:{total:'0',spendable:'0'}};
 assert.equal(zecBalances(zero).amount,'0');
 for(const heights of [{chainTip:null},{fullyScanned:'100'},{fullyScanned:101},{chainTip:-1}]){
  assert.equal(zecBalances({...summary,...heights}).status,'not checked');
 }
 assert.equal(zecBalances({...summary,orchard:{total:'2100000000000000',spendable:0}}).amount,null);
});
