import test from 'node:test';
import assert from 'node:assert/strict';
import {conversionLimitState} from '../lib/silo/conversion-ui.mjs';
const range={min:'0.0132',max:null};
test('the provider limit state: hint before typing, below-min, balance below min, above max, and Max respects reserve and maximum',()=>{
 const hint=conversionLimitState({source:'xmr',dest:'sol',range,amountText:'',balanceAtomic:'50000000000'});
 assert.equal(hint.kind,'ok');assert.equal(hint.hint,'Minimum for XMR to SOL is about 0.0132 XMR');assert.equal(hint.message,null);assert.equal(hint.maxAmount,'0.049');
 const below=conversionLimitState({source:'xmr',dest:'sol',range,amountText:'0.01',balanceAtomic:'50000000000'});assert.equal(below.kind,'below-min');assert.match(below.message,/Minimum for XMR to SOL is about 0\.0132 XMR/);
 // The owner's wallet: 0.01324276 XMR, 0.001 kept for the fee, 0.01224276 spendable: under the minimum.
 const owner=conversionLimitState({source:'xmr',dest:'sol',range,amountText:'',balanceAtomic:'13242760000'});assert.equal(owner.kind,'balance-below-min');assert.equal(owner.maxAmount,null);assert.match(owner.message,/Your balance is below the minimum for this pair/);
 const capped=conversionLimitState({source:'sol',dest:'xmr',range:{min:'0.142',max:'50'},amountText:'',balanceAtomic:'90000000000'});assert.equal(capped.maxAmount,'50');
 const above=conversionLimitState({source:'sol',dest:'xmr',range:{min:'0.142',max:'50'},amountText:'60',balanceAtomic:'90000000000'});assert.equal(above.kind,'above-max');assert.match(above.message,/Maximum for SOL to XMR is about 50 SOL/);
 assert.equal(conversionLimitState({source:'sol',dest:'xmr',range:null,amountText:'1',balanceAtomic:'1000000000'}).kind,'unknown','no range read: nothing is guessed');
});
