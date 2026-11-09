import test from 'node:test';import assert from 'node:assert/strict';
import {CONVERSION_ROUTES,conversionRouteId,conversionLegs,flipConversion,pickerOptions,pickConversionCoin,conversionMax,atomicToDecimal,decimalToAtomic,validConversionAmount,bestQuote,conversionProgress,conversionStateIsTerminal,createReentryGuard} from '../lib/silo/conversion-ui.mjs';
test('route ids cover exactly the six directions and same-coin sides are impossible',()=>{
 const coins=['sol','usdc','xmr'],ids=[];for(const a of coins)for(const b of coins){if(a===b)assert.throws(()=>conversionRouteId(a,b));else ids.push(conversionRouteId(a,b));}
 assert.deepEqual(ids.sort(),[...CONVERSION_ROUTES].sort());
 assert.deepEqual(conversionLegs('xmr-to-usdc'),{from:'xmr',to:'usdc'});assert.throws(()=>conversionLegs('sol-to-sol'));assert.throws(()=>conversionRouteId('sol','btc'));
});
test('flip swaps the sides and keeps a valid route; pickers exclude the other side',()=>{
 const flipped=flipConversion({from:'sol',to:'xmr'});assert.deepEqual(flipped,{from:'xmr',to:'sol'});assert.equal(conversionRouteId(flipped.from,flipped.to),'xmr-to-sol');
 assert.deepEqual(pickerOptions('xmr'),['sol','usdc']);
 assert.deepEqual(pickConversionCoin({from:'sol',to:'xmr'},'from','usdc'),{from:'usdc',to:'xmr'});
 assert.deepEqual(pickConversionCoin({from:'sol',to:'xmr'},'from','xmr'),{from:'xmr',to:'sol'},'choosing the other side swaps instead of duplicating');
 assert.deepEqual(pickConversionCoin({from:'sol',to:'xmr'},'to','sol'),{from:'xmr',to:'sol'});
});
test('Max subtracts the fee reserve and never goes negative',()=>{
 assert.equal(conversionMax('sol','1000000000'),'0.995');
 assert.equal(conversionMax('sol','5000000'),null);assert.equal(conversionMax('sol','4999999'),null);
 assert.equal(conversionMax('usdc','2500000'),'2.5');
 assert.equal(conversionMax('xmr','2000000000000'),'1.999');
 assert.equal(conversionMax('xmr',null),null);assert.equal(conversionMax('sol','abc'),null);
});
test('amount parsing is exact and rejects excess precision',()=>{
 assert.equal(decimalToAtomic('1.5',9),1500000000n);assert.equal(decimalToAtomic('0.0000001',6),null);assert.equal(decimalToAtomic('',6),null);assert.equal(decimalToAtomic('-1',6),null);
 assert.equal(atomicToDecimal('1000000',6),'1');assert.equal(atomicToDecimal('1',12),'0.000000000001');assert.equal(atomicToDecimal('0',9),'0');
 assert.equal(validConversionAmount('0','sol'),false);assert.equal(validConversionAmount('0.01','sol'),true);
});
test('best quote is the highest receive amount',()=>{
 const q=[{id:'a',amountTo:'0.4'},{id:'b',amountTo:'0.5'},{id:'c',amountTo:'0.49'}];assert.equal(bestQuote(q,12).id,'b');assert.equal(bestQuote([],12),null);
});
test('progress maps provider states; an XMR payout claim alone is not Done',()=>{
 assert.equal(conversionProgress('waiting').index,0);assert.equal(conversionProgress('provider-exchanging').index,1);assert.equal(conversionProgress('provider-sending').index,2);
 assert.equal(conversionProgress('payout-reported',{destinationIsXmr:true,receiptConfirmed:false}).index,2);
 assert.equal(conversionProgress('payout-reported',{destinationIsXmr:true,receiptConfirmed:true}).done,true);
 assert.equal(conversionProgress('settled').done,true);assert.equal(conversionProgress('provider-failed').problem,true);assert.equal(conversionProgress('provider-failed').done,false);
 assert.equal(conversionStateIsTerminal('settled'),true);assert.equal(conversionStateIsTerminal('waiting'),false);
});
test('double-tap guard admits exactly one entry until released',()=>{
 const g=createReentryGuard();assert.equal(g.enter(),true);assert.equal(g.enter(),false);assert.equal(g.held,true);g.release();assert.equal(g.enter(),true);
});
