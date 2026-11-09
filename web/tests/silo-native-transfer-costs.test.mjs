import test from 'node:test';
import assert from 'node:assert/strict';
import {siloNativeTransferCosts} from '../lib/silo/native-transfer-costs.mjs';
const review={asset:'XMR',amount:'0.001',fee:'0.00003044'};
test('native review counts fee once and treats self-transfer principal as retained',()=>{
 const input={balance:'6051420000',fresh:true};
 const external=siloNativeTransferCosts(review,{...input,selfTransfer:false});assert.equal(external.total,'0.00103044');assert.equal(external.arrival,'0.001');assert.equal(external.balanceAfter,'0.00502098');
 const own=siloNativeTransferCosts(review,{...input,selfTransfer:true});assert.equal(own.balanceAfter,'0.00602098');assert.match(own.note,/remain locked/);
 const unknown=siloNativeTransferCosts(review,input);assert.equal(unknown.balanceAfter,'0.00502098–0.00602098');assert.equal(unknown.ownership,'unknown');
});
test('stale, missing, insufficient and malformed balances never invent a remaining balance',()=>{
 for(const input of [{balance:'6051420000',fresh:false},{balance:null,fresh:true},{balance:'1',fresh:true},{balance:'1e12',fresh:true}])assert.equal(siloNativeTransferCosts(review,input).balanceAfter,'Not checked');
});
test('projection stays exact above floating-point integer precision',()=>{
 const r=siloNativeTransferCosts({asset:'XMR',amount:'9000.000000000001',fee:'0.000000000001'},{balance:'9000000000000003',fresh:true,selfTransfer:false});assert.equal(r.total,'9000.000000000002');assert.equal(r.balanceAfter,'0.000000000001');
 assert.equal(siloNativeTransferCosts({asset:'ZEC'}),null);
});
