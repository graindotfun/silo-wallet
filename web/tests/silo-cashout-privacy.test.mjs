import test from 'node:test';
import assert from 'node:assert/strict';
import {siloCashoutPrivacy as check} from '../lib/silo/cashout-privacy.mjs';
import {siloConversionDisclosure} from '../lib/silo/disclosures.mjs';
const now=Date.parse('2026-10-14T08:00:00Z'),owner='11111111111111111111111111111111';
const row={status:'finalized',partialReasons:[],nativeNetRaw:'1000000000',signature:'5'.repeat(88),blockTime:now/1000-3600};
const page={owner,network:'mainnet-beta',observedAt:new Date(now).toISOString(),rows:[row]};
const run=(amount,overrides={})=>check({amount,owner,page,now,...overrides});
test('amount correlation uses exact integer math at both inclusive 1% boundaries',()=>{
 for(const amount of ['0.99','1','1.01'])assert.equal(run(amount).matches.length,1);
 for(const amount of ['0.989999999','1.010000001'])assert.equal(run(amount).matches.length,0);
 const maximum='18446744073709551615';assert.equal(run('18446744073.709551615',{page:{...page,rows:[{...row,nativeNetRaw:maximum}]}}).matches.length,1);
});
test('missing, mismatched, expired or future history never represents checked history',()=>{
 for(const changed of [null,{...page,owner:'other'},{...page,network:'devnet'}])assert.equal(run('1',{page:changed}).state,'not-checked');
 for(const observedAt of ['invalid',new Date(now+1).toISOString(),new Date(now-300001).toISOString()])assert.equal(run('1',{page:{...page,observedAt}}).state,'stale');
 assert.equal(run('1',{page:{...page,observedAt:new Date(now-300000).toISOString()}}).state,'partial');
 assert.equal(run('1',{page:{...page,rows:[]}}).state,'partial');
});
test('unknown/failed/outgoing/incomplete observations cannot support an incoming match',()=>{
 for(const changed of [{status:'failed'},{status:'unknown'},{nativeNetRaw:null},{nativeNetRaw:'-1000000000'},{nativeNetRaw:'0'},{nativeNetRaw:'1e9'},{partialReasons:['unknown-effects']},{nativeNetRaw:'18446744073709551616'}])assert.equal(run('1',{page:{...page,rows:[{...row,...changed}]}}).matches.length,0);
 assert.equal(run('1',{page:{...page,rows:[{...row,blockTime:now/1000+1}]}}).matches[0].blockTime,null);
});
test('roundness is local even with no history; invalid amounts do not produce warnings',()=>{
 for(const amount of ['1','1.00','0.01','12.34'])assert.equal(run(amount,{page:null}).round,true);
 for(const amount of ['1.001','0.000000001'])assert.equal(run(amount,{page:null}).round,false);
 for(const amount of ['0','-1','1e9','NaN','1.0000000001','18446744073.709551616'])assert.equal(run(amount).state,'invalid-amount');
});
test('bounded match list and both route disclosures preserve the conversion boundary',()=>{
 assert.equal(run('1',{page:{...page,rows:Array.from({length:100},(_,index)=>({...row,signature:String(index)}))}}).matches.length,3);
 assert.equal(run('1',{page:{...page,rows:Array(101).fill(row)}}).state,'not-checked');
 assert.match(siloConversionDisclosure('sol-to-xmr').remaining,/public deposit remain visible/);
 assert.match(siloConversionDisclosure('xmr-to-sol').remaining,/SOL payout becomes public/);
 assert.match(siloConversionDisclosure('usdc-to-xmr').remaining,/public deposit remain visible/);
 assert.match(siloConversionDisclosure('usdc-to-xmr').visible,/SPL token transfer/);
 assert.match(siloConversionDisclosure('xmr-to-usdc').remaining,/USDC payout becomes public/);
 assert.throws(()=>siloConversionDisclosure('unknown'));
});
