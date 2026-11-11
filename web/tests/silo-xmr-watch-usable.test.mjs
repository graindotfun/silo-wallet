// SOL -> XMR, U2: the user's own view-only scan counts only unlock_time 0 outputs, and the lowest confirmation count wins.
import test from 'node:test';import assert from 'node:assert/strict';
import {siloXmrWatchUsable} from '../lib/silo/xmr-adapter.mjs';
const tx=(amount,conf,{unlock=0n,pool=false,failed=false}={})=>({getIncomingAmount:()=>BigInt(amount),getNumConfirmations:()=>conf,getUnlockTime:()=>unlock,getInTxPool:()=>pool,getIsFailed:()=>failed});
test('nothing arrived: null',()=>{assert.equal(siloXmrWatchUsable([]),null);assert.equal(siloXmrWatchUsable([tx(0,5)]),null);});
test('a time-locked output never counts toward the amount',()=>{assert.deepEqual(siloXmrWatchUsable([tx(50,20,{unlock:9_999_999n})]),{atomic:'0',confirmations:20});});
test('a pool output holds confirmations at 0',()=>{assert.deepEqual(siloXmrWatchUsable([tx(50,20),tx(1,0,{pool:true})]),{atomic:'51',confirmations:0});});
test('failed transactions are ignored; amounts add up',()=>{assert.deepEqual(siloXmrWatchUsable([tx(30,12),tx(20,10),tx(99,50,{failed:true})]),{atomic:'50',confirmations:10});});
