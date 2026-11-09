// Driver tests against a fake INDEPENDENT public RPC (real swap-account layout and real history format).
// Covers the round-1 review regressions H1, H2, H3, H6, H7 for the browser side.
import test from 'node:test';import assert from 'node:assert/strict';
import {Keypair,PublicKey} from '@solana/web3.js';
import bs58 from 'bs58';
import {sha256} from '@noble/hashes/sha256';
import * as flow from '../lib/silo/atomic-swap/alice-flow.mjs';
import {randomScalar,pub,addPoints,moneroAddress,proveShare,hex,unhex,toLE} from '../lib/silo/atomic-swap/keys.mjs';
import {swapPda,PROGRAM_ID,disc} from '../lib/silo/atomic-swap/sol.mjs';
import {createAtomicDriver,atomicProgress,atomicRecordActive,atomicIdlePhase,atomicRateText,CLAIM_RETRY_MS,UNSENT_GRACE_S,SLOW_RECOVERY_MS} from '../lib/silo/atomic-driver.mjs';
const NOW=1_800_000_000;
const quote=()=>({quoteId:'ab'.repeat(16),swapId:hex(crypto.getRandomValues(new Uint8Array(32))),xmrAtomic:'100000000000',lamports:5_000_000,gasLamports:10000,solPerXmr:1,spreadBps:100,expiresAt:NOW+600});
function maker(record,{tamper=false,t0=NOW+7200,t1=NOW+14400}={}){
 const b=randomScalar(),B=pub(b),refunder=Keypair.generate().publicKey,swapId=unhex(record.swapId);
 const joint=moneroAddress(addPoints(unhex(record.A),B),unhex(record.V),'stagenet');
 return {answer:{B:hex(B),proofB:proveShare(b,swapId,1),refunder:refunder.toBase58(),pda:tamper?Keypair.generate().publicKey.toBase58():swapPda(refunder,swapId).toBase58(),jointAddress:joint,xmrAtomic:record.quote.xmrAtomic,lamports:record.quote.lamports,t0,t1,lockSig:'sig'},b,B,refunder};
}
const SWAP_TAG=Buffer.from(sha256(new TextEncoder().encode('account:Swap'))).subarray(0,8);
/** Real on-chain layout: tag, refunder, claimer, claim_point, refund_point, amount, t0, t1, ready, swap_id, bump. */
function encodeSwap(p){const b=Buffer.alloc(8+186);SWAP_TAG.copy(b,0);new PublicKey(p.refunder).toBuffer().copy(b,8);new PublicKey(p.claimer).toBuffer().copy(b,40);Buffer.from(p.claimPoint,'hex').copy(b,72);Buffer.from(p.refundPoint,'hex').copy(b,104);
 b.writeBigUInt64LE(BigInt(p.lamports),136);b.writeBigInt64LE(BigInt(p.t0),144);b.writeBigInt64LE(BigInt(p.t1),152);b[160]=p.ready?1:0;return b.toString('base64');}
/** A successful transaction in getTransaction(json) shape calling `which` on `pdaKey` with `secretHex`. */
const ixTx=(r,which,secretHex,pdaKey=r.pda)=>({meta:{err:null},transaction:{message:{accountKeys:[pdaKey,r.claimer,r.refunder,PROGRAM_ID.toBase58()],instructions:[{programIdIndex:3,accounts:[0,1,2],data:bs58.encode(Buffer.concat([disc(which),Buffer.from(secretHex,'hex')]))}]}}});
function rig({tamper=false,makerTimes={},claimPost}={}){
 const log=[],saved=new Map();let mk=null,lock={found:false},lockFails=false,sweepEmpty=false,sigCalls=[],sweeps=[],direct=[],staged=[],claims=[];
 let clock=NOW*1000,onSave=null;
 // chain = independent public RPC state
 const chain={pda:null,owner:null,history:[],feePayerLamports:1_000_000,offline:false,nowOffset:0};
 const bridge={saveRecord:async r=>{log.push('save:'+r.status);saved.set(r.swapId,structuredClone(r));if(onSave)onSave(r);},lockStatus:async()=>{if(lockFails)throw Error('wallet busy');return lock;},prepareLock:async x=>{staged.push(x);},daemonHeight:async()=>3_000_000,sweepRecovery:async keys=>{sweeps.push(keys);return sweepEmpty?[]:['f'.repeat(64)];}};
 const post=async(action,body)=>{log.push('post:'+action);
  if(action==='swap'){assert.equal('a' in body,false);mk=maker(saved.get([...saved.keys()][0]),{tamper,...makerTimes});return mk.answer;}
  if(action==='claim'){claims.push(body);return claimPost?claimPost(body):{sig:'claimsig'};}
  throw Error('unexpected server action '+action);};
 const fetcher=async(url,init)=>{const body=JSON.parse(init.body);
  if(chain.offline)throw TypeError('fetch failed');
  if(body.method==='sendTransaction'){direct.push({url,body});return new Response('{"result":"sig"}');}
  let result=null;
  if(body.method==='getSlot')result=1;
  if(body.method==='getBlockTime')result=Math.floor(clock/1000)+chain.nowOffset;
  if(body.method==='getAccountInfo')result=chain.pda?{value:{owner:chain.owner??PROGRAM_ID.toBase58(),data:[encodeSwap(chain.pda),'base64']}}:chain.owner?{value:{owner:chain.owner,data:['','base64']}}:{value:null};
  if(body.method==='getSignaturesForAddress'){const before=body.params[1]?.before;sigCalls.push(before??null);const start=before?chain.history.findIndex(h=>h.signature===before)+1:0;result=chain.history.slice(start,start+1000).map(h=>({signature:h.signature,err:h.err??null}));}
  if(body.method==='getTransaction')result=chain.history.find(h=>h.signature===body.params[0])?.tx??null;
  if(body.method==='getBalance')result={value:chain.feePayerLamports};
  if(body.method==='getLatestBlockhash')result={value:{blockhash:bs58.encode(crypto.getRandomValues(new Uint8Array(32)))}};
  return new Response(JSON.stringify({result}));};
 const driver=createAtomicDriver({flow,post,bridge,network:'devnet',now:()=>clock,fetcher});
 return {driver,log,saved,chain,get mk(){return mk;},set lock(v){lock=v;},set lockFails(v){lockFails=v;},set sweepEmpty(v){sweepEmpty=v;},sigCalls,set onSave(f){onSave=f;},sweeps,direct,staged,claims,advance:ms=>{clock+=ms;}};
}
const claimerKey=()=>Keypair.generate().publicKey.toBase58();
const escrowFor=(t,r,over={})=>({ready:true,t0:t.mk.answer.t0,t1:t.mk.answer.t1,lamports:r.quote.lamports,claimPoint:r.A,refundPoint:r.B,claimer:r.claimer,refunder:r.refunder,...over});
const sendsOf=t=>t.direct.filter(d=>d.body.method==='sendTransaction');

test('the record is saved before the swap call and accepted only when the maker answer checks out',async()=>{
 const t=rig();const record=await t.driver.start({quote:quote(),claimer:claimerKey()});
 assert.deepEqual(t.log.slice(0,3),['save:quoted','post:swap','save:maker-locked']);assert.equal(record.status,'maker-locked');assert.equal(record.acceptedAt,NOW);
});
test('a maker answer that does not match is rejected, saved as rejected, and no XMR is staged',async()=>{
 const t=rig({tamper:true});
 await assert.rejects(t.driver.start({quote:quote(),claimer:claimerKey()}),/nothing was sent/);
 assert.equal([...t.saved.values()][0].status,'rejected');assert.equal(t.staged.length,0);
});
test('H3: maker timelocks far in the future or with a short claim window are refused before anything is sent',async()=>{
 for(const makerTimes of [{t0:NOW+365*86400,t1:NOW+366*86400},{t0:NOW+7200,t1:NOW+7200+600},{t0:NOW+1800,t1:NOW+9000}]){
  const t=rig({makerTimes});
  await assert.rejects(t.driver.start({quote:quote(),claimer:claimerKey()}),/timelocks-outside-bounds/);
  assert.equal(t.staged.length,0);
 }
});
test('lock step: staged once, bound to the swap and its funding deadline, and an existing payment is adopted (H6)',async()=>{
 const t=rig();let r=await t.driver.start({quote:quote(),claimer:claimerKey()});
 t.chain.pda=escrowFor(t,r,{ready:false});
 let v=await t.driver.tick(r);assert.equal(v.phase,'awaiting-xmr');assert.equal(t.staged.length,1);
 assert.equal(t.staged[0].swapId,r.swapId);assert.equal(t.staged[0].expiresAt,(r.t0-3600)*1000);assert.equal(t.staged[0].amountAtomic,'100000000000');
 await t.driver.tick(r);assert.equal(t.staged.length,1);
 t.lock={found:true,txid:'e'.repeat(64),confirmations:4,height:2_999_990};
 v=await t.driver.tick(r);assert.equal(v.record.xmrLockTxid,'e'.repeat(64));assert.equal(t.staged.length,1);
});
test('H2: a genuine escrow with a different claim point is never funded and never claimed',async()=>{
 const t=rig();let r=await t.driver.start({quote:quote(),claimer:claimerKey()});
 t.chain.pda=escrowFor(t,r,{ready:false,claimPoint:hex(pub(randomScalar()))});
 let v=await t.driver.tick(r);assert.equal(v.record.result,'bad-terms');assert.equal(t.staged.length,0);
 const t2=rig();let r2=await t2.driver.start({quote:quote(),claimer:claimerKey()});
 t2.lock={found:true,txid:'e'.repeat(64),confirmations:10,height:100};
 t2.chain.pda=escrowFor(t2,r2,{claimPoint:hex(pub(randomScalar()))});
 v=await t2.driver.tick(r2);assert.equal(sendsOf(t2).length,0);assert.equal(t2.claims.length,0);assert.equal(v.record.claimTx,undefined);
});
test('H1: the claim goes to the public RPC first and a silent or hanging server never blocks it or its retries',async()=>{
 const t=rig({claimPost:()=>new Promise(()=>{})});   // server swallows the claim and never answers
 let r=await t.driver.start({quote:quote(),claimer:claimerKey()});
 t.lock={found:true,txid:'e'.repeat(64),confirmations:10,height:100};t.chain.pda=escrowFor(t,r);
 let v=await t.driver.tick(r);r=v.record;assert.equal(v.phase,'claiming');assert.equal(sendsOf(t).length,1);assert.equal(t.direct[0].url,'https://api.devnet.solana.com');
 t.advance(30_000);await t.driver.tick(r);assert.equal(sendsOf(t).length,1);
 t.advance(CLAIM_RETRY_MS);v=await t.driver.tick(r);assert.equal(sendsOf(t).length,2,'retried without any server answer');
 // landing is judged only from the independent view
 t.chain.pda=null;t.chain.history=[{signature:'C1',tx:ixTx(r,'claim',r.a)}];
 v=await t.driver.tick(v.record);assert.equal(v.record.result,'sol-received');
});
test('H2: no secret-bearing bytes are sent if the window closed while the record was being saved',async()=>{
 const t=rig();let r=await t.driver.start({quote:quote(),claimer:claimerKey()});
 t.lock={found:true,txid:'e'.repeat(64),confirmations:10,height:100};t.chain.pda=escrowFor(t,r);
 t.onSave=rec=>{if(rec.claimTx)t.advance((rec.t1-NOW)*1000);};   // the browser stalls during the save
 const v=await t.driver.tick(r);assert.equal(v.reason,'claim-window-closing');assert.equal(sendsOf(t).length,0);assert.equal(t.claims.length,0);
});
test('nothing moves while the independent RPC is unreachable',async()=>{
 const t=rig();let r=await t.driver.start({quote:quote(),claimer:claimerKey()});
 t.lock={found:true,txid:'e'.repeat(64),confirmations:10,height:100};t.chain.pda=escrowFor(t,r);t.chain.offline=true;
 const v=await t.driver.tick(r);assert.equal(v.reason,'public-rpc-unreachable');assert.equal(t.claims.length,0);assert.equal(t.staged.length,0);
});
test('H7: unrelated claims naming this account are ignored, recreated PDA is treated as closed, history is paged',async()=>{
 const t=rig();let r=await t.driver.start({quote:quote(),claimer:claimerKey()});
 t.lock={found:true,txid:'e'.repeat(64),confirmations:10,height:5000};t.chain.pda=escrowFor(t,r,{ready:false});
 r=(await t.driver.tick(r)).record;   // adopts the payment
 // escrow refunded; address recreated as a system account; 1200 newer junk rows; an unrelated swap's claim that names this PDA
 t.chain.pda=null;t.chain.owner='11111111111111111111111111111111';
 const other=hex(toLE(randomScalar()));
 const junk=Array.from({length:1200},(_,i)=>({signature:'J'+i,tx:{meta:{err:null},transaction:{message:{accountKeys:[r.pda],instructions:[]}}}}));
 t.chain.history=[{signature:'X1',tx:ixTx(r,'claim',other,Keypair.generate().publicKey.toBase58())},{signature:'X2',tx:ixTx(r,'claim',other)},...junk,{signature:'R1',tx:ixTx(r,'refund',hex(toLE(t.mk.b)))}];
 // X1 names another swap account first; X2 names this account but its secret does not open A
 const v=await t.driver.tick(r);
 assert.equal(v.phase,'recovering');assert.equal(t.sweeps.length,1);assert.equal(t.sweeps[0].primaryAddress,r.jointAddress);
});
test('H6: after a refund with no payment the swap is watched until the funding deadline, and a late payment is recovered',async()=>{
 const t=rig();let r=await t.driver.start({quote:quote(),claimer:claimerKey()});
 t.chain.pda=null;t.chain.history=[{signature:'R1',tx:ixTx(r,'refund',hex(toLE(t.mk.b)))}];
 let v=await t.driver.tick(r);assert.equal(v.record.status,'watching');assert.equal(atomicRecordActive(v.record),true);
 t.lock={found:true,txid:'e'.repeat(64),confirmations:10,height:7000};
 v=await t.driver.tick(v.record);assert.equal(v.phase,'recovering');assert.equal(t.sweeps.length,1);
 const t2=rig();let r2=await t2.driver.start({quote:quote(),claimer:claimerKey()});
 t2.chain.pda=null;t2.chain.history=[{signature:'R1',tx:ixTx(r2,'refund',hex(toLE(t2.mk.b)))}];
 t2.advance((r2.t0-NOW)*1000);v=await t2.driver.tick(r2);assert.equal(v.record.result,'cancelled');assert.equal(atomicRecordActive(v.record),false);
});
// ---- Astra round 2 regressions ----
test('R2-H2: XMR is never staged until the fee payer can pay the claim, and an unpayable claim is never built or sent anywhere',async()=>{
 const t=rig();let r=await t.driver.start({quote:quote(),claimer:claimerKey()});
 t.chain.pda=escrowFor(t,r,{ready:false});t.chain.feePayerLamports=0;
 let v=await t.driver.tick(r);assert.equal(v.reason,'fee-payer-not-funded');assert.equal(t.staged.length,0);
 // after funding: XMR goes out; then the fee payer balance reads too low (wrong view, reorg): nothing secret-bearing leaves
 t.chain.feePayerLamports=1_000_000;v=await t.driver.tick(v.record);assert.equal(t.staged.length,1);
 t.lock={found:true,txid:'e'.repeat(64),confirmations:10,height:100};t.chain.pda=escrowFor(t,r);t.chain.feePayerLamports=4999;
 v=await t.driver.tick(v.record);assert.equal(v.reason,'fee-payer-underfunded');assert.equal(v.record.claimTx,undefined);
 assert.equal(sendsOf(t).length,0);assert.equal(t.claims.length,0);
 assert.throws(()=>flow.buildClaimTx(v.record,{blockhash:bs58.encode(new Uint8Array(32).fill(1)),feePayerLamports:0}),/fee-payer-underfunded/);
 t.chain.feePayerLamports=5000;v=await t.driver.tick(v.record);assert.equal(v.phase,'claiming');assert.equal(sendsOf(t).length,1);
});
test('R2-H6: a failed wallet scan never retires a refunded swap, and an attempted payment stays recoverable across reloads',async()=>{
 const t=rig();t.sweepEmpty=true;let r=await t.driver.start({quote:quote(),claimer:claimerKey()});
 t.chain.pda=null;t.chain.history=[{signature:'R1',tx:ixTx(r,'refund',hex(toLE(t.mk.b)))}];
 t.advance((r.t0-NOW+7200)*1000);t.lockFails=true;          // well past the funding deadline, wallet scan failing
 let v=await t.driver.tick(r);assert.equal(atomicRecordActive(v.record),true);assert.equal(v.reason,'watching-for-late-payment');
 // the payment was attempted (flag saved before sending); the scan keeps failing: recovery runs, never retirement
 const attempted={...t.saved.get(r.swapId),fundingAttempted:NOW*1000};
 for(let i=0;i<3;i++){v=await t.driver.tick(structuredClone(attempted));assert.equal(v.phase,'recovering');assert.equal(atomicRecordActive(v.record),true);}
 assert.equal(t.sweeps.length,3);
 // an unsynced wallet answers found:false; that is not proof, so even weeks later the swap is never closed (round 3)
 t.lockFails=false;t.lock={found:false};
 let elapsedDays=0;
 for(const days of [1,2,30]){t.advance((days-elapsedDays)*UNSENT_GRACE_S*1000);elapsedDays=days;v=await t.driver.tick(structuredClone(t.saved.get(r.swapId)??attempted));
  assert.equal(atomicRecordActive(v.record),true,`still active after ${days} more day(s)`);assert.equal(v.phase,'recovering');assert.ok(v.recoveryKeys);}
 // after the grace period recovery slows to once an hour, and the slow-down survives a reload
 const before=t.sweeps.length;v=await t.driver.tick(structuredClone(t.saved.get(r.swapId)));assert.equal(t.sweeps.length,before,'no second attempt within the hour');
 t.advance(SLOW_RECOVERY_MS);v=await t.driver.tick(structuredClone(t.saved.get(r.swapId)));assert.equal(t.sweeps.length,before+1);
 // the wallet finally syncs and shows the payment: adopted and recovered
 t.lock={found:true,txid:'d'.repeat(64),confirmations:30,height:8};t.sweepEmpty=false;t.advance(SLOW_RECOVERY_MS);
 v=await t.driver.tick(structuredClone(t.saved.get(r.swapId)));assert.equal(v.record.xmrLockTxid,'d'.repeat(64));assert.equal(v.phase,'recovering');assert.equal(t.sweeps.length,before+2);
 assert.deepEqual(v.record.xmrRecoveredTxids,['f'.repeat(64)]);v=await t.driver.tick(v.record);assert.equal(v.record.result,'xmr-recovered');
 // and a payment the wallet does show is recovered, whatever the time
 const t2=rig();let r2=await t2.driver.start({quote:quote(),claimer:claimerKey()});
 t2.chain.pda=null;t2.chain.history=[{signature:'R1',tx:ixTx(r2,'refund',hex(toLE(t2.mk.b)))}];
 t2.advance((r2.t0-NOW+UNSENT_GRACE_S*2)*1000);t2.lock={found:true,txid:'f'.repeat(64),confirmations:12,height:9};
 v=await t2.driver.tick({...t2.saved.get(r2.swapId),fundingAttempted:1});assert.equal(v.phase,'recovering');assert.equal(t2.sweeps.length,1);
});
test('R2-H7: history beyond 20,000 rows is resumed from the saved cursor instead of restarting from the newest row',async()=>{
 const t=rig();let r=await t.driver.start({quote:quote(),claimer:claimerKey()});
 t.lock={found:true,txid:'e'.repeat(64),confirmations:10,height:5000};t.chain.pda=escrowFor(t,r,{ready:false});
 r=(await t.driver.tick(r)).record;
 t.chain.pda=null;
 const junk=Array.from({length:25_000},(_,i)=>({signature:'J'+i,err:'spam'}));      // failed spam rows cost no getTransaction
 t.chain.history=[...junk,{signature:'R1',tx:ixTx(r,'refund',hex(toLE(t.mk.b)))}];
 let v=await t.driver.tick(r);assert.notEqual(v.phase,'recovering');assert.equal(v.record.historyCursor,'J19999');
 assert.equal(t.saved.get(r.swapId).historyCursor,'J19999','the cursor is saved, so a reload resumes too');
 t.sigCalls.length=0;
 v=await t.driver.tick(structuredClone(t.saved.get(r.swapId)));
 assert.equal(t.sigCalls[0],'J19999');assert.equal(v.phase,'recovering');assert.equal(t.sweeps.length,1);assert.equal(v.record.historyCursor??null,null);
});
test('progress shows exactly the three steps',()=>{
 const p=atomicProgress({refunder:'x',status:'maker-locked',xmrLockTxid:'t',xmrConfirmations:3},{});
 assert.deepEqual(p.steps.map(s=>s.label),['Locked','Confirming 3/10','Received']);
 assert.equal(atomicProgress({refunder:'x',status:'done',result:'sol-received',xmrLockTxid:'t'},{confirmations:10}).steps.every(s=>s.done),true);
});
// Owner acceptance test, 4 Nov 2026: a swap whose SOL the maker locked read "Waiting for the maker to lock the SOL." next to a
// ticked "Locked" step (after a reload, and on every tick the decision was a wait). The idle phase now comes from the record.
test('a locked swap never shows the waiting-for-maker phase, before the first tick or on a wait',async()=>{
 assert.equal(atomicIdlePhase({status:'quoted'}),'waiting-maker');
 assert.equal(atomicIdlePhase({status:'maker-locked',refunder:'x'}),'checking-lock');
 assert.equal(atomicIdlePhase({status:'maker-locked',refunder:'x',fundingAttempted:1}),'confirming');
 assert.equal(atomicIdlePhase({status:'maker-locked',refunder:'x',xmrLockTxid:'t'}),'confirming');
 const t=rig();const r=await t.driver.start({quote:quote(),claimer:claimerKey()});
 let v=await t.driver.tick(r);assert.equal(v.phase,'checking-lock','escrow not visible yet: the lock is being checked');
 assert.equal(atomicProgress(r).steps[0].done,true);
 t.chain.offline=true;v=await t.driver.tick(r);assert.equal(v.phase,'checking-lock');assert.equal(v.reason,'public-rpc-unreachable');
 t.chain.offline=false;t.chain.pda=escrowFor(t,r,{ready:false});t.chain.feePayerLamports=0;
 v=await t.driver.tick(r);assert.equal(v.phase,'checking-lock');assert.equal(v.reason,'fee-payer-not-funded');
});
test('the quoted rate shows at most 4 decimals',()=>{
 assert.equal(atomicRateText(6.866738544474393),'6.8667');
 assert.equal(atomicRateText(6.5),'6.5');assert.equal(atomicRateText(7),'7');assert.equal(atomicRateText(0.00004),'0');
 assert.equal(atomicRateText(NaN),'-');assert.equal(atomicRateText(-1),'-');
});
test('send-by keeps five minutes before the maker cancel; a closed claim window is its own phase, never "confirming"',async()=>{
 const {atomicSendBy}=await import('../lib/silo/atomic-driver.mjs');
 const {LOCK_WAIT}=await import('../lib/silo/atomic-swap/swap-core.mjs');
 assert.equal(atomicSendBy({acceptedAt:1000,refunder:'r'}),1000+LOCK_WAIT-300);
 assert.equal(atomicSendBy({acceptedAt:1000}),null);
 assert.equal(atomicSendBy({refunder:'r'}),null);
 const fs=await import('node:fs');const src=fs.readFileSync(new URL('../lib/silo/atomic-driver.mjs',import.meta.url),'utf8');
 assert.match(src,/if\(next\.reason==='claim-window-closed-await-maker-refund'\)return \{record:r,phase:'awaiting-refund'/);
 const panel=fs.readFileSync(new URL('../components/silo-atomic-panel.tsx',import.meta.url),'utf8');
 assert.match(panel,/case 'awaiting-refund':return \{tone:'warn',kicker:`Claim deadline passed at /);
 assert.ok(!panel.includes('comes back automatically')&&!panel.includes('close this tab'));
});
