import test from 'node:test';
import assert from 'node:assert/strict';
import {conversionRateLines,conversionRateText} from '../lib/silo/conversion-rate.mjs';
test('rate lines come from the quote, the fee policy and the existing prices',()=>{
 const lines=conversionRateLines({source:'sol',dest:'xmr',amount:'1',amountTo:'0.5',silo:0,usd:{SOL:150,XMR:300}});
 assert.deepEqual(lines,['Rate: 1 SOL = 0.5 XMR','Provider: outside provider (rate includes its fees)','Silo markup: 0%','about 0% under market']);
 const under=conversionRateLines({source:'sol',dest:'xmr',amount:'2',amountTo:'0.97',silo:0,usd:{SOL:150,XMR:300}});
 assert.equal(under.at(-1),'about 3% under market');
 const reverse=conversionRateLines({source:'xmr',dest:'sol',amount:'1',amountTo:'1.9',silo:0,usd:{SOL:150,XMR:300}});
 assert.equal(reverse.at(-1),'about 5% under market');
});
test('no market percent without both prices or on a USDC pair, no markup line without a policy',()=>{
 assert.equal(conversionRateLines({source:'sol',dest:'xmr',amount:'1',amountTo:'0.5',usd:{SOL:150,XMR:null}}).some(l=>/market/.test(l)),false);
 assert.equal(conversionRateLines({source:'sol',dest:'usdc',amount:'1',amountTo:'150',silo:0,usd:{SOL:150,XMR:300}}).some(l=>/market/.test(l)),false);
 assert.equal(conversionRateLines({source:'sol',dest:'xmr',amount:'1',amountTo:'0.5'}).some(l=>/markup/.test(l)),false);
 assert.equal(conversionRateLines({source:'sol',dest:'xmr',amount:'0',amountTo:'0.5'}),null);
 assert.equal(conversionRateText(0.00412345678),'0.00412346');
});
