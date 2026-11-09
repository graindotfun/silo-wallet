import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {xmrHistory,zecHistory} from '../lib/silo/native-history.mjs';
const sdk=createRequire(import.meta.url)('monero-ts');
const xmr=(id=1,patch={})=>new sdk.MoneroTxWallet({hash:id.toString(16).padStart(64,'0'),isConfirmed:true,numConfirmations:10,fee:'1000',incomingTransfers:[{amount:'5000'}],outgoingTransfer:{amount:'3000'},...patch}).setBlock(new sdk.MoneroBlock({height:id}));
const zec=(id=1,patch={})=>({txid:id.toString(16).padStart(64,'0'),minedHeight:98,expiryHeight:140,balanceDelta:-10000,fee:1000,expiredUnmined:false,...patch});
const summary={chainTip:100,fullyScanned:100};
test('real SDK model preserves separate incoming and outgoing without inventing delta',()=>{
 const row=xmrHistory([xmr()],true).rows[0];assert.equal(row.incoming,'5000');assert.equal(row.outgoing,'3000');assert.equal(row.balanceDelta,null);assert.equal(row.fee,'1000');assert.equal(row.confirmations,10);assert.equal(row.status,'confirmed');
 const partial=xmrHistory([xmr()],false);assert.equal(partial.coverage,'partial coverage');assert.equal(partial.rows[0].confirmations,null);assert.equal(partial.rows[0].status,'not checked');
});
test('histories retain newest50 and reject duplicate or invalid identifiers',()=>{
 const rows=Array.from({length:60},(_,i)=>xmr(i+1));const history=xmrHistory(rows,true);assert.equal(history.rows.length,50);assert.equal(history.rows[0].height,60);assert.equal(history.rows.at(-1).height,11);
 assert.throws(()=>xmrHistory([xmr(),xmr()],true),/identifier/);assert.throws(()=>zecHistory([zec(1,{txid:'bad'})],summary),/identifier/);
});
test('amounts reject unsafe JS values, fractions and excessive amounts',()=>{
 for(const value of [Number.MAX_SAFE_INTEGER+1,1.5,NaN,Infinity,'1e3','-0','01',true,'2100000000000001'])assert.throws(()=>zecHistory([zec(1,{balanceDelta:value})],summary));
 const tx=xmr();tx.getIncomingAmount=()=>Number.MAX_SAFE_INTEGER+1;assert.throws(()=>xmrHistory([tx],true),/amount/);
 const exact=xmr();exact.getIncomingAmount=()=>18446744073709551615n;assert.equal(xmrHistory([exact],true).rows[0].incoming,'18446744073709551615');exact.getIncomingAmount=()=>18446744073709551616n;assert.throws(()=>xmrHistory([exact],true),/amount/);
});
test('ZEC account delta does not infer transfer direction or amount',()=>{
 const row=zecHistory([zec()],summary).rows[0];assert.equal(row.balanceDelta,'-10000');assert.equal(row.incoming,null);assert.equal(row.outgoing,null);assert.equal(row.fee,'1000');assert.equal(row.confirmations,3);assert.equal(row.status,'confirmed');
 const expired=zecHistory([zec(1,{minedHeight:null,expiredUnmined:true})],summary).rows[0];assert.equal(expired.status,'expired');assert.equal(expired.confirmations,0);
});
test('ZEC requires consistent heights and never confirms a partial scan',()=>{
 const partial=zecHistory([zec()],{chainTip:100,fullyScanned:99});assert.equal(partial.coverage,'partial coverage');assert.equal(partial.rows[0].status,'not checked');assert.equal(partial.rows[0].confirmations,null);assert.equal(zecHistory([zec()],summary,101).rows[0].status,'not checked');
 for(const invalid of [{chainTip:100,fullyScanned:101},{chainTip:-1,fullyScanned:-1},{chainTip:'100',fullyScanned:100}])assert.throws(()=>zecHistory([zec()],invalid));assert.throws(()=>zecHistory([zec(1,{minedHeight:101})],summary));assert.throws(()=>zecHistory([zec(1,{expiredUnmined:'yes'})],summary));
});

test('missing mining facts never become checked rows',()=>{const missing=zec();delete missing.minedHeight;assert.throws(()=>zecHistory([missing],summary));const tx=xmr();tx.getHeight=()=>undefined;assert.throws(()=>xmrHistory([tx],true));const unknown=xmr();unknown.getIsConfirmed=()=>undefined;assert.equal(xmrHistory([unknown],true).rows[0].status,'not checked');});
