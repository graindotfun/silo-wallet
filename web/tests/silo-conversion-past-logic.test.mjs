import test from 'node:test';import assert from 'node:assert/strict';
import {conversionCanHide,conversionCanHideUnloaded,conversionCanHideWaiting,conversionPastEntryText,conversionPastNeedsAttention} from '../lib/silo/conversion-ui.mjs';
import {recordConversionWindow,markConversionDepositOpened,setConversionAttemptHidden,readHiddenConversionAttempts,readConversionAttemptMeta} from '../lib/silo/conversion-attempt-meta.mjs';
const memory=()=>{const m=new Map();return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v))};};
test('only a waiting order past its deadline can be hidden',()=>{
 assert.equal(conversionCanHide('waiting',{windowClosed:true}),true);
 assert.equal(conversionCanHide('waiting',{windowClosed:false}),false);
 for(const s of ['deposit-submitted','provider-exchanging','payout-reported','creation-uncertain','refund-reported','expired'])assert.equal(conversionCanHide(s,{windowClosed:true}),false,s);
});
test('past wording never says nothing was sent or that funds are in the wallet unless the provider reported expired or failed',()=>{
 for(const s of [null,'waiting','creation-uncertain','deposit-submitted','provider-exchanging','refund-reported','settled']){const t=conversionPastEntryText(s);assert.doesNotMatch(t,/nothing (was|arrived)|no deposit|in your wallet|safe/i,String(s));}
 assert.match(conversionPastEntryText('waiting'),/still being tracked here/);
 assert.match(conversionPastEntryText('expired'),/no deposit received/);
 assert.doesNotMatch(conversionPastEntryText('expired')+conversionPastEntryText('provider-failed'),/[–—]/);
});
test('funded, refunded or finished past orders need the main screen; waiting, expired, failed and unknown do not',()=>{
 for(const s of ['deposit-submitted','provider-confirming','provider-exchanging','provider-sending','payout-reported','refund-reported','settled'])assert.equal(conversionPastNeedsAttention(s),true,s);
 for(const s of ['waiting','expired','provider-failed','creation-uncertain',null,undefined])assert.equal(conversionPastNeedsAttention(s),false,String(s));
});
test('hidden flag round-trips, and an unreadable store hides nothing',async()=>{
 const st=memory();await setConversionAttemptHidden('h1',true,st);
 assert.deepEqual(await readHiddenConversionAttempts(['h1','h2'],st),['h1']);
 await setConversionAttemptHidden('h1',false,st);assert.deepEqual(await readHiddenConversionAttempts(['h1'],st),[]);
 assert.deepEqual(await readHiddenConversionAttempts(['h1'],{getItem:()=>{throw Error('x');}}),[]);
});
test('meta eviction keeps rows that say a deposit review was opened or that are hidden',async()=>{
 const st=memory();await markConversionDepositOpened('opened',st);await setConversionAttemptHidden('hid',true,st);
 for(let i=0;i<80;i++)await recordConversionWindow(`plain-${i}`,Date.now()+i+1,st);
 assert.equal((await readConversionAttemptMeta('opened',st)).depositOpened,true);
 assert.deepEqual(await readHiddenConversionAttempts(['hid'],st),['hid']);
});
test('an order that cannot be loaded may be hidden only after a failed check, when journaled, with readable meta and no deposit opened',()=>{
 const now=1_000_000,clean={readable:true,depositOpened:false,windowEndsAt:null};
 assert.equal(conversionCanHideUnloaded({loadFailed:false,journaled:true,meta:clean,now}),false);
 assert.equal(conversionCanHideUnloaded({loadFailed:true,journaled:true,meta:clean,now}),true);
 assert.equal(conversionCanHideUnloaded({loadFailed:true,journaled:false,meta:clean,now}),false,'not journaled');
 assert.equal(conversionCanHideUnloaded({loadFailed:true,journaled:true,meta:null,now}),false,'meta missing');
 assert.equal(conversionCanHideUnloaded({loadFailed:true,journaled:true,meta:{readable:false,depositOpened:true,windowEndsAt:null},now}),false,'unreadable');
 assert.equal(conversionCanHideUnloaded({loadFailed:true,journaled:true,meta:{readable:true,depositOpened:true,windowEndsAt:now-1},now}),false,'deposit opened');
 assert.equal(conversionCanHideUnloaded({loadFailed:true,journaled:true,meta:{readable:true,depositOpened:false,windowEndsAt:now+60_000},now}),false,'window open');
 assert.equal(conversionCanHideUnloaded({loadFailed:true,journaled:true,meta:{readable:true,depositOpened:false,windowEndsAt:now-1},now}),true);
});
test('an expired waiting order may be hidden only with a fresh server-clocked waiting answer past the deadline, journaled, no deposit',()=>{
 const deadline=1_000_000,clean={readable:true,depositOpened:false,windowEndsAt:deadline},ok={state:'waiting',journaled:true,freshWaitingServerNow:deadline+1000,deadline,now:deadline+1000,meta:clean,sawFunding:false};
 assert.equal(conversionCanHideWaiting(ok),true);
 assert.equal(conversionCanHideWaiting({...ok,journaled:false}),false,'not journaled');
 assert.equal(conversionCanHideWaiting({...ok,freshWaitingServerNow:null}),false,'no fresh provider answer or no server clock');
 assert.equal(conversionCanHideWaiting({...ok,freshWaitingServerNow:deadline-1}),false,'server clock before deadline (fast local clock)');
 assert.equal(conversionCanHideWaiting({...ok,now:deadline-1}),false,'local clock before deadline');
 assert.equal(conversionCanHideWaiting({...ok,meta:{readable:true,depositOpened:true,windowEndsAt:deadline}}),false,'deposit review opened');
 assert.equal(conversionCanHideWaiting({...ok,meta:{readable:false,depositOpened:true,windowEndsAt:null}}),false,'meta unreadable');
 assert.equal(conversionCanHideWaiting({...ok,meta:null}),false,'meta not read');
 assert.equal(conversionCanHideWaiting({...ok,sawFunding:true}),false,'funding seen');
 for(const state of ['expired','deposit-submitted','provider-exchanging','creation-uncertain'])assert.equal(conversionCanHideWaiting({...ok,state}),false,state);
});
