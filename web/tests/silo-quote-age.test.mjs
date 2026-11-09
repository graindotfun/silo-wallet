import test from 'node:test';import assert from 'node:assert/strict';import {siloQuoteAge} from '../lib/silo/quote-age.mjs';
test('quote expires at its deadline and a long background interval cannot preserve approval',()=>{
 const review={checkedAt:1000,expiresAt:31000};assert.equal(siloQuoteAge(review,30999).canApprove,true);assert.equal(siloQuoteAge(review,31000).canApprove,false);assert.equal(siloQuoteAge(review,900000).state,'expired');assert.equal(siloQuoteAge(review,900000).remainingSeconds,0);
});
test('unknown or inconsistent times never enable review approval',()=>{
 for(const [review,now] of [[{},1000],[{checkedAt:1000,expiresAt:31000},999],[{checkedAt:1000,expiresAt:32000},1000],[{checkedAt:1000,expiresAt:1000},1000],[{checkedAt:1000,expiresAt:31000},NaN]])assert.equal(siloQuoteAge(review,now).canApprove,false);
});
test('refreshed review has its own age rather than inheriting expired terms',()=>{
 assert.equal(siloQuoteAge({checkedAt:1000,expiresAt:31000},35000).state,'expired');assert.deepEqual(siloQuoteAge({checkedAt:35000,expiresAt:65000},35000),{state:'fresh',canApprove:true,ageSeconds:0,remainingSeconds:30});
});
