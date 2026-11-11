// SOL -> XMR, the user's flow: registration is accepted only when self-consistent, the steps build exactly the layouts the
// keyring signs, and the sweep keys open the joint address only with the maker's revealed a.
import test from 'node:test';import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {randomScalar,pub,toLE,hex,unhex,proveShare,addPoints,moneroAddress} from '../lib/silo/atomic-swap/keys.mjs';
import {newReverseRecord,reverseRegisterRequest,acceptMakerRegistration,signingExpectation,buildStepTx,sweepKeys,nextReverseAction} from '../lib/silo/atomic-swap/bob-flow.mjs';
import {verifySiloAtomicRefunderTx,atomicSwapPda} from '../lib/silo/atomic-swap/refunder-tx.mjs';
import {REV_T0_LEAD,REV_CLAIM_WINDOW} from '../lib/silo/atomic-swap/reverse-core.mjs';

const owner=Keypair.generate().publicKey.toBase58(),maker=Keypair.generate().publicKey.toBase58(),blockhash=Keypair.generate().publicKey.toBase58();
const swapId=hex(globalThis.crypto.getRandomValues(new Uint8Array(32))),a=randomScalar(),A=hex(pub(a));
const quote={direction:'sol-xmr',quoteId:'q',swapId,xmrAtomic:'50000000000',lamports:345_000_000,A,proofA:proveShare(a,unhex(swapId),0),claimer:maker,expiresAt:Math.floor(Date.now()/1000)+120};
const now=Math.floor(Date.now()/1000);
const answer=r=>({swapId,claimer:maker,claimPoint:A,lamports:quote.lamports,xmrAtomic:quote.xmrAtomic,t0:now+REV_T0_LEAD,t1:now+REV_T0_LEAD+REV_CLAIM_WINDOW,
 jointAddress:moneroAddress(addPoints(unhex(A),unhex(r.B)),unhex(r.V),'stagenet'),pda:atomicSwapPda(owner,unhex(swapId)).toBase58()});

test('the request never carries b; a consistent registration is accepted',()=>{
 const r=newReverseRecord({owner,quote,network:'devnet'}),req=reverseRegisterRequest(r);
 assert.ok(!JSON.stringify(req).includes(r.b));
 const ok=acceptMakerRegistration(r,answer(r),now);assert.equal(ok.status,'registered');assert.equal(ok.claimer,maker);
});
test('a registration that differs anywhere is refused',()=>{
 const r=newReverseRecord({owner,quote,network:'devnet'}),m=answer(r);
 for(const [over,why] of [[{lamports:m.lamports+1},/terms-mismatch/],[{claimer:owner},/terms-mismatch/],[{t0:now+3600,t1:now+3600+REV_CLAIM_WINDOW},/timelocks/],[{t1:m.t1+1},/timelocks/],[{jointAddress:m.jointAddress.slice(0,-1)+(m.jointAddress.endsWith('A')?'B':'A')},/joint-address/],[{pda:maker},/pda-mismatch/],[{claimPoint:hex(pub(randomScalar()))},/terms-mismatch/]])
  assert.throws(()=>acceptMakerRegistration(r,{...m,...over},now),why,JSON.stringify(over));
 const forged={...r,quote:{...quote,proofA:proveShare(randomScalar(),unhex(swapId),0)}};
 assert.throws(()=>acceptMakerRegistration(forged,m,now),/maker-share-proof-invalid/);
});
test('lock, ready and refund verify against their own expectation',()=>{
 const r0=newReverseRecord({owner,quote,network:'devnet'}),r=acceptMakerRegistration(r0,answer(r0),now);
 for(const kind of ['lock','ready','refund'])assert.ok(verifySiloAtomicRefunderTx(buildStepTx(kind,r,blockhash),signingExpectation(kind,r),{address:owner,now}),kind);
});
test('sweep keys open the joint address only with the maker\'s real a',()=>{
 const r0=newReverseRecord({owner,quote,network:'devnet'}),r=acceptMakerRegistration(r0,answer(r0),now);
 assert.equal(sweepKeys(r,hex(toLE(a))).primaryAddress,r.jointAddress);
 assert.throws(()=>sweepKeys(r,hex(toLE(randomScalar()))),/does-not-open-A/);
});
test('the first action on a registered record is to lock; never twice',()=>{
 const r0=newReverseRecord({owner,quote,network:'devnet'}),r=acceptMakerRegistration(r0,answer(r0),now),chain={now,pda:null,outcome:null};
 assert.equal(nextReverseAction(r,chain,null).action,'lock-sol');
 assert.equal(nextReverseAction({...r,lockAttemptAt:Date.now()},chain,null).action,'wait');
});
