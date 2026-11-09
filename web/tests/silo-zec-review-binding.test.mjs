import test from 'node:test';
import assert from 'node:assert/strict';
import {openZecResearch,ZEC_ENGINE} from '../lib/silo/zec-adapter.mjs';
async function fixture(){
 const state={proposal:null,signed:[],sent:0,hold:null,onExpiries:async()=>{}};
 const core={async call(op,args={}){switch(op){
 case 'chainCheck':if(state.hold)await state.hold;return {chainMatches:true,branchMatches:true,tip:100};
 case 'open':case 'close':return true;
 case 'info':return {account:0,birthday:1,address:'fixture orchard'};
 case 'address':return args.address;
 case 'propose':state.proposal={to:args.to,amount:String(args.amount)};return {fee:'10000'};
 case 'authorize':state.signed.push(state.proposal);return new Uint8Array(32).fill(1);
 case 'expiries':await state.onExpiries();return [140];
 case 'send':state.sent++;return true;
 default:throw Error(op);
 }},terminate(){}};
 const wallet=await openZecResearch({sdk:{open:async()=>core},node:'https://fixture.invalid',cache:{seed:'public fixture',height:1,engine:ZEC_ENGINE,database:'Aw=='}});
 return {wallet,state};
}
test('ZEC rejects an old review after another proposal replaces the worker slot',async()=>{
 const {wallet,state}=await fixture();try{
 const first=await wallet.prepare({address:'recipient A',amount:'1'});
 const second=await wallet.prepare({address:'recipient B',amount:'2'});
 await assert.rejects(first.submit(first.consent,async()=>{}),/no longer current/);
 assert.equal(state.signed.length,0);assert.equal(state.sent,0);
 await second.submit(second.consent,async()=>{});
 assert.deepEqual(state.signed,[{to:'recipient B',amount:'200000000'}]);assert.equal(state.sent,1);
 }finally{await wallet.close();}
});
test('ZEC refuses preparation while an approved draft is entering authorization',async()=>{
 const {wallet,state}=await fixture();try{
 const draft=await wallet.prepare({address:'recipient A',amount:'1'});
 let resume;state.hold=new Promise(resolve=>{resume=resolve;});
 const sending=draft.submit(draft.consent,async()=>{});
 await assert.rejects(wallet.prepare({address:'recipient B',amount:'2'}),/preparation already/);
 state.hold=null;resume();await sending;
 assert.deepEqual(state.signed,[{to:'recipient A',amount:'100000000'}]);
 }finally{await wallet.close();}
});
test('ZEC refuses simultaneous proposal preparation and retires the prior review before awaits',async()=>{
 const {wallet,state}=await fixture();try{
 const old=await wallet.prepare({address:'recipient A',amount:'1'});
 let resume;state.hold=new Promise(resolve=>{resume=resolve;});
 const preparing=wallet.prepare({address:'recipient B',amount:'2'});
 await assert.rejects(wallet.prepare({address:'recipient C',amount:'3'}),/preparation already/);
 await assert.rejects(old.submit(old.consent,async()=>{}),/no longer current/);
 state.hold=null;resume();const next=await preparing;await next.submit(next.consent,async()=>{});
 assert.deepEqual(state.signed,[{to:'recipient B',amount:'200000000'}]);
 }finally{await wallet.close();}
});

test('ZEC lock during expiry inspection cannot complete authorization or persist a new payment',async()=>{
 const {wallet,state}=await fixture();const draft=await wallet.prepare({address:'recipient A',amount:'1'});let reached,resume,saves=0;
 const entered=new Promise(resolve=>{reached=resolve;});state.onExpiries=async()=>{reached();await new Promise(resolve=>{resume=resolve;});};
 const sending=draft.submit(draft.consent,async()=>{saves++;});await entered;await wallet.close();resume();await assert.rejects(sending,/locked/);assert.equal(saves,0);assert.equal(state.sent,0);assert.equal(wallet.pending(),null);
});
