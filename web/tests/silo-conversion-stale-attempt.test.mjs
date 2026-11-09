import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {conversionAttemptResolved,conversionNothingSentMessage,conversionStaleWithoutRecord,conversionStateMayHoldFunds} from '../lib/silo/conversion-ui.mjs';
import {markConversionDepositOpened,readConversionAttemptMeta,recordConversionWindow} from '../lib/silo/conversion-attempt-meta.mjs';
const memory=()=>{const m=new Map();return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>void m.set(k,String(v)),removeItem:k=>void m.delete(k)};};
test('expired or provider-failed with no funds at risk resolves; a closed waiting window resolves only with no deposit step',()=>{
 assert.equal(conversionAttemptResolved('expired',{noFundsAtRisk:true}),true);
 assert.equal(conversionAttemptResolved('expired',{noFundsAtRisk:false}),false);
 assert.equal(conversionAttemptResolved('waiting',{noFundsAtRisk:true,windowClosed:true}),true);
 assert.equal(conversionAttemptResolved('waiting',{noFundsAtRisk:true,windowClosed:false}),false);
 assert.equal(conversionAttemptResolved('waiting',{noFundsAtRisk:false,windowClosed:true}),false);
});
test('no discard is ever offered for funds-at-risk states, whatever the flags say about the window',()=>{
 for(const state of ['creation-uncertain','deposit-uncertain','deposit-signed','deposit-submitted','provider-confirming','provider-exchanging','provider-sending','payout-reported','refund-reported','wallet-retired']){
  assert.equal(conversionAttemptResolved(state,{noFundsAtRisk:true,windowClosed:true}),false,state);
  assert.equal(conversionNothingSentMessage(state,{windowClosed:true}),null,state);
 }
 assert.equal(conversionStateMayHoldFunds('deposit-uncertain'),true);
});
test('the provider answer resolves expired/provider-failed even after the deposit review opened; never any other state',()=>{
 const o={noFundsAtRisk:false,windowClosed:true,providerVerifiedClosed:true};
 assert.equal(conversionAttemptResolved('expired',o),true);assert.equal(conversionAttemptResolved('provider-failed',o),true);
 assert.equal(conversionAttemptResolved('expired',{...o,windowClosed:false}),false,'window still open');
 assert.equal(conversionAttemptResolved('expired',{...o,providerVerifiedClosed:false}),false,'no fresh provider answer');
 for(const state of ['waiting','creation-uncertain','deposit-uncertain','deposit-signed','deposit-submitted','provider-confirming','provider-exchanging','provider-verifying','provider-sending','payout-reported','refund-reported','wallet-retired'])assert.equal(conversionAttemptResolved(state,o),false,state);
});
test('the plain statement is exact',()=>{
 const text='This order expired. Nothing was sent. Your funds are still in your wallet.';
 assert.equal(conversionNothingSentMessage('expired'),text);assert.equal(conversionNothingSentMessage('waiting',{windowClosed:true}),text);assert.equal(conversionNothingSentMessage('waiting'),null);
});
test('after a reload the browser-side facts decide: deadline passed and no deposit review opened',async()=>{
 const storage=memory(),now=1_000_000;
 assert.equal(conversionStaleWithoutRecord(await readConversionAttemptMeta('h1',storage),now),false,'unknown deadline never qualifies');
 await recordConversionWindow('h1',now-1,storage);
 assert.equal(conversionStaleWithoutRecord(await readConversionAttemptMeta('h1',storage),now),true);
 assert.equal(conversionStaleWithoutRecord(await readConversionAttemptMeta('h1',storage),now-5),false,'window still open');
 assert.equal(await markConversionDepositOpened('h1',storage),true);
 assert.equal(conversionStaleWithoutRecord(await readConversionAttemptMeta('h1',storage),now),false,'deposit review opened: never discardable');
 assert.equal(conversionStaleWithoutRecord(await readConversionAttemptMeta('h2',storage),now),false,'other handle unaffected');
 assert.equal(JSON.stringify([...Object.keys(JSON.parse(storage.getItem('grain-silo-conversion-attempt-meta-v1')))]).includes('h1'),false,'handle is stored hashed only');
});
test('unreadable storage fails closed',async()=>{
 const broken={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};
 const meta=await readConversionAttemptMeta('h',broken);assert.equal(meta.readable,false);assert.equal(conversionStaleWithoutRecord(meta,Infinity),false);
 assert.equal(await markConversionDepositOpened('h',broken),false);
 const corrupt=memory();corrupt.setItem('grain-silo-conversion-attempt-meta-v1','{bad');assert.equal((await readConversionAttemptMeta('h',corrupt)).depositOpened,true);
});
test('panel wiring: marker saved before the wallet review, retire persists, new copy, review revealed',async()=>{
 const panel=await readFile(new URL('../components/silo-conversion-panel.tsx',import.meta.url),'utf8');
 assert.match(panel,/await markConversionDepositOpened\(seal\)[\s\S]*await prepare\(\{/);
 assert.match(panel,/Unlock your Solana wallet first/);assert.doesNotMatch(panel,/check back soon/);
 assert.match(panel,/Next screen: your wallet asks you to approve sending/);
 assert.match(panel,/revealDepositReview/);assert.match(panel,/retireRecoveryHandle\?\.\(handle\)/);
 const dep=await readFile(new URL('../components/silo-conversion-solana-deposit.tsx',import.meta.url),'utf8');assert.match(dep,/id="silo-conversion-deposit-review"/);
});
test('panel wiring: provider flag is in-memory only, silent returns now say something, auto review once per order',async()=>{
 const panel=await readFile(new URL('../components/silo-conversion-panel.tsx',import.meta.url),'utf8');
 assert.match(panel,/providerVerifiedClosed:providerClosed!==null&&providerClosed===recordHandle/);assert.doesNotMatch(panel,/localStorage/);
 const body=panel.slice(panel.indexOf('async function prepareDeposit('),panel.indexOf('depositing.current=true;setSawFunding(true);'));
 assert.equal((body.match(/return;/g)??[]).length,(body.match(/setError\(/g)??[]).length,'every early return sets a message');
 assert.match(body,/Time to send ran out/);assert.match(body,/Open your Solana wallet first/);
 assert.match(panel,/autoPrepared\.current\.has\(response\.order\.orderId\)/);assert.match(panel,/Time to send ran out\. Check the order, then start a new one\./);
});
