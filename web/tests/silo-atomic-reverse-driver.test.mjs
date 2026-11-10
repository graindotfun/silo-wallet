// SOL -> XMR driver, end to end against a simulated chain and wallet: the full path (lock -> maker XMR -> ready -> claim
// -> sweep), a lock saved before it is sent and never repeated, a failed Monero scan that never cancels the swap, a refund
// when the maker never sends, and "lock-not-landed" when the lock never reached the chain.
import test from 'node:test';import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {sha256} from '@noble/hashes/sha256';
import * as flow from '../lib/silo/atomic-swap/bob-flow.mjs';
import {createReverseDriver} from '../lib/silo/atomic-reverse-driver.mjs';
import {randomScalar,pub,toLE,hex,unhex,proveShare,addPoints,moneroAddress} from '../lib/silo/atomic-swap/keys.mjs';
import {atomicSwapPda,SILO_ATOMIC_PROGRAM_ID,verifySiloAtomicRefunderTx} from '../lib/silo/atomic-swap/refunder-tx.mjs';
import {REV_T0_LEAD,REV_CLAIM_WINDOW} from '../lib/silo/atomic-swap/reverse-core.mjs';
import {REFUND_AFTER_T1_S} from '../lib/silo/atomic-reverse-driver.mjs';

const disc=n=>Buffer.from(sha256(new TextEncoder().encode(n))).subarray(0,8);
function world({makerSends=true,scanFails=false,scanHangs=false,scanTimeoutMs,hangHousekeeping=false,bridgeCallTimeoutMs}={}){
 const owner=Keypair.generate().publicKey.toBase58(),maker=Keypair.generate().publicKey.toBase58();
 const swapId=hex(globalThis.crypto.getRandomValues(new Uint8Array(32))),a=randomScalar();
 let clock=1_900_000_000;const tNow=()=>clock;
 const quote={direction:'sol-xmr',quoteId:'ab'.repeat(16),swapId,xmrAtomic:'50000000000',lamports:345_000_000,A:hex(pub(a)),proofA:proveShare(a,unhex(swapId),0),claimer:maker,expiresAt:clock+120};
 const chain={escrow:null,history:[],sent:[]},records=[],saves=[];
 let reg=null;
 const W={
  post:async(action,body)=>{assert.equal(action,'rev-swap');const t0=clock+REV_T0_LEAD;reg={swapId,claimer:maker,claimPoint:quote.A,lamports:quote.lamports,xmrAtomic:quote.xmrAtomic,t0,t1:t0+REV_CLAIM_WINDOW,
   jointAddress:moneroAddress(addPoints(unhex(quote.A),unhex(body.B)),pub(BigInt(0)+((b=>{let x=0n;for(let i=31;i>=0;i--)x=(x<<8n)|BigInt(b[i]);return x;})(unhex(body.v)))),'stagenet'),pda:atomicSwapPda(owner,unhex(swapId)).toBase58()};return reg;},
  sign:async(encoded,expected)=>{const tx=verifySiloAtomicRefunderTx(encoded,expected,{address:owner,now:clock});W.signedBh=tx.message.recentBlockhash;
   // Real wire layout for the signature: [count=1][64-byte signature][...]; the tail carries a label for the assertions.
   const sig=globalThis.crypto.getRandomValues(new Uint8Array(64));(W.sigs??={})[expected.kind]=bs58.encode(sig);
   return Buffer.concat([Buffer.from([1]),Buffer.from(sig),Buffer.from('signed:'+expected.kind)]).toString('base64');},
  bridge:{saveRecord:async r=>{saves.push(r);records[0]=r;},records:()=>records.slice(),daemonHeight:async()=>1000,
   watchJoint:async()=>{W.scanCalls=(W.scanCalls??0)+1;if(scanHangs)return new Promise(()=>{});if(scanFails)throw Error('wallet busy');return W.xmr;},
   cancelScan:async()=>{W.cancelEntered=(W.cancelEntered??0)+1;if(hangHousekeeping)return new Promise(()=>{});W.cancels=(W.cancels??0)+1;},releaseScan:async()=>{if(hangHousekeeping)return new Promise(()=>{});W.releases=(W.releases??0)+1;},sweepRecovery:async()=>['sweep-tx']},
  xmr:null,
 };
 // Block height advances 2 per second of chain time; a blockhash is valid for 150 blocks after it was handed out.
 const height=()=>Math.floor((clock-1_900_000_000)*2);
 const account=(committed=chain.escrow?.committedAt??0,ready=chain.escrow?.ready)=>{const e=chain.escrow;const d=Buffer.alloc(8+194);disc('account:StrictSwap').copy(d,0);let o=8;
  for(const k of [owner,maker])bs58.decode(k).forEach((x,i)=>d[o+i]=x),o+=32;Buffer.from(e.A,'hex').copy(d,o);o+=32;Buffer.from(e.B,'hex').copy(d,o);o+=32;
  d.writeBigUInt64LE(BigInt(quote.lamports),o);o+=8;d.writeBigInt64LE(BigInt(reg.t0),o);o+=8;d.writeBigInt64LE(BigInt(reg.t1),o);o+=8;d[o]=ready?1:0;o+=1;Buffer.from(swapId,"hex").copy(d,o);o+=32;o+=1;d.writeBigInt64LE(BigInt(committed),o);
  return {owner:SILO_ATOMIC_PROGRAM_ID,data:[d.toString('base64'),'base64']};};
 const fetcher=async(_url,{body})=>{const {method,params}=JSON.parse(body);let result=null;
  if(method==='getSlot')result=params?.[0]?.commitment==='finalized'?height()-(W.finalizedLag??0):1;else if(method==='getBlockTime'){if(W.skippedSlots?.includes(params[0]))return {json:async()=>({error:{message:'Block not available for slot'}})};result=params[0]===1?clock:clock-Math.floor((height()-params[0])/2);}else if(method==='getLatestBlockhash')result={value:{blockhash:W.lastBh=Keypair.fromSeed(new Uint8Array(32).fill(1+(W.bhEpoch??0))).publicKey.toBase58(),lastValidBlockHeight:height()+150}};
  else if(method==='getBlock')result={blockHeight:params[0]};                     // in this simulation slot == block height
  else if(method==='getSignatureStatuses')result={context:{slot:height()-(W.statusLag??0)},value:W.statusIncomplete?[]:params[0].map(sig=>W.landedSigs?.includes(sig)?{confirmationStatus:'finalized'}:null)};
  else if(method==='getBalance')result={value:5_000_000};else if(method==='getAccountInfo'){const fin=params?.[1]?.commitment==='finalized';const ov=fin?W.finalizedOverride:undefined;result={context:{slot:height()-(fin?(W.finalizedAccountLag??W.accountLag??0):(W.accountLag??0))},value:!chain.escrow||(fin&&W.finalizedMode==='absent')?null:account(ov?ov.committedAt:(fin&&W.finalizedMode==='uncommitted'?0:undefined),ov?ov.ready:undefined)};}
  else if(method==='getSignaturesForAddress')result=chain.history.map((h,i)=>({signature:`s${i}`,err:null}));
  else if(method==='getTransaction')result=chain.history[Number(params[0].slice(1))];
  else if(method==='sendTransaction'){chain.sent.push(Buffer.from(params[0],'base64').subarray(65).toString());chain.sendOpts=params[1];result='sig';}
  return {json:async()=>({result})};};
 const driver=createReverseDriver({flow,post:W.post,bridge:W.bridge,sign:W.sign,network:'devnet',now:()=>clock*1000,fetcher,publicRpc:'http://rpc',scanTimeoutMs,bridgeCallTimeoutMs});
 const claimTx=secret=>({transaction:{message:{accountKeys:[maker,reg.pda,owner,SILO_ATOMIC_PROGRAM_ID],instructions:[{programIdIndex:3,accounts:[1,0,2],data:bs58.encode(Buffer.concat([disc('global:claim_strict'),Buffer.from(secret)]))}]}},meta:{err:null}});
 const fresh=()=>createReverseDriver({flow,post:W.post,bridge:W.bridge,sign:W.sign,network:'devnet',now:()=>clock*1000,fetcher,publicRpc:'http://rpc'});
 return {W,chain,saves,records,driver,fresh,owner,quote,a,advance:s=>{clock+=s;},goto:t=>{clock=t;},claimTx,makerSends,get reg(){return reg;}};
}

test('full path: lock once, wait for 10 confirmations, ready, then sweep after the maker claims',async()=>{
 const w=world();let r=await w.driver.start({quote:w.quote,owner:w.owner});
 assert.equal(r.status,'registered');
 let v=await w.driver.tick(r);assert.equal(v.phase,'locking');assert.deepEqual(w.chain.sent,['signed:lock']);
 assert.ok(w.saves.findIndex(s=>s.lockAttemptAt)>=0,'the attempt is saved');
 r=v.record;w.advance(40);v=await w.driver.tick(r);assert.equal(w.chain.sent.length,1,'never a second lock while the escrow is not visible yet');
 w.chain.escrow={A:w.quote.A,B:r.B,ready:false};r=v.record;w.advance(60);
 v=await w.driver.tick(r);assert.equal(v.phase,'awaiting-maker-xmr');
 w.W.xmr={atomic:'50000000000',confirmations:4};r=v.record;w.advance(600);v=await w.driver.tick(r);assert.equal(v.phase,'xmr-confirming');assert.equal(v.confirmations,4);
 w.W.xmr={atomic:'50000000000',confirmations:10};r=v.record;w.advance(600);v=await w.driver.tick(r);assert.equal(v.phase,'confirming');assert.deepEqual(w.chain.sent,['signed:lock','signed:ready']);
 w.chain.escrow.ready=true;r=v.record;w.advance(60);v=await w.driver.tick(r);assert.equal(v.phase,'await-claim');
 w.chain.escrow=null;w.chain.history=[w.claimTx(toLE(w.a))];r=v.record;w.advance(60);
 v=await w.driver.tick(r);assert.equal(v.phase,'sweeping');assert.deepEqual(v.record.xmrSweptTxids,['sweep-tx']);
 v=await w.driver.tick(v.record);assert.equal(v.phase,'received');assert.equal(v.record.result,'xmr-received');
});
test('U1: the maker never sends: an online page refunds after LOCK_WAIT; a failed Monero scan never counts as "nothing arrived"',async()=>{
 const w=world({scanFails:true});let r=await w.driver.start({quote:w.quote,owner:w.owner});
 let v=await w.driver.tick(r);r=v.record;w.chain.escrow={A:w.quote.A,B:r.B,ready:false};
 w.advance(3600);v=await w.driver.tick(r);assert.notEqual(v.phase,'refunding','scan failed: no refund on "nothing arrived"');
 const w2=world();r=await w2.driver.start({quote:w2.quote,owner:w2.owner});v=await w2.driver.tick(r);r=v.record;w2.chain.escrow={A:w2.quote.A,B:r.B,ready:false};
 w2.advance(3600);v=await w2.driver.tick(r);assert.equal(v.phase,'refunding');assert.deepEqual(w2.chain.sent,['signed:lock','signed:refund']);
});
test('a lock that never reached the chain closes as lock-not-landed, without a second lock',async()=>{
 const w=world();let r=await w.driver.start({quote:w.quote,owner:w.owner});let v=await w.driver.tick(r);
 w.advance(400);v=await w.driver.tick(v.record);assert.equal(v.record.result,'lock-not-landed');assert.equal(w.chain.sent.length,1);
});
test('a registration that does not check out is rejected and nothing is locked',async()=>{
 const w=world();const post=w.W.post;w.W.post=async(...x)=>({...await post(...x),lamports:1});
 const d=createReverseDriver({flow,post:w.W.post,bridge:w.W.bridge,sign:w.W.sign,network:'devnet',now:()=>1_900_000_000_000,fetcher:async()=>({json:async()=>({result:null})}),publicRpc:'x'});
 await assert.rejects(d.start({quote:w.quote,owner:w.owner}),/did not check out/);
 assert.equal(w.saves.at(-1).status,'rejected');assert.equal(w.chain.sent.length,0);
});

test('a step is built on a blockhash read right before it, not the one read before a slow Monero scan',async()=>{
 const w=world();let r=await w.driver.start({quote:w.quote,owner:w.owner});
 let v=await w.driver.tick(r);r=v.record;w.chain.escrow={A:w.quote.A,B:r.B,ready:false};w.advance(60);
 w.W.xmr={atomic:'50000000000',confirmations:10};w.advance(600);
 const scan=w.W.bridge.watchJoint;w.W.bridge.watchJoint=async(...x)=>{w.W.bhEpoch=(w.W.bhEpoch??0)+1;return scan(...x);}; // the chain moves on during the scan
 v=await w.driver.tick(v.record);
 assert.equal(v.phase,'confirming');assert.equal(w.W.signedBh,w.W.lastBh,'the ready transaction carries the newest blockhash');
});

test('steps are sent without preflight, so a load-balanced RPC node that has not seen the blockhash cannot refuse them',async()=>{
 const w=world();const r=await w.driver.start({quote:w.quote,owner:w.owner});await w.driver.tick(r);
 assert.equal(w.chain.sendOpts.skipPreflight,true);assert.equal(w.chain.sendOpts.preflightCommitment,undefined);
});

// ---- Astra round 1 (5 Nov 2026) ----
async function toReadySent(w){
 let r=await w.driver.start({quote:w.quote,owner:w.owner});let v=await w.driver.tick(r);r=v.record;
 w.chain.escrow={A:w.quote.A,B:r.B,ready:false};w.advance(60);v=await w.driver.tick(r);
 w.W.xmr={atomic:'50000000000',confirmations:10};w.advance(600);v=await w.driver.tick(v.record);
 assert.ok(w.chain.sent.includes('signed:ready'));return v.record;
}
test('H1: with a ready in flight and a stale view, no refund (which reveals b) goes out before t1 + margin, whatever any node says',async()=>{
 const w=world();let r=await toReadySent(w);
 assert.equal(r.branch,'ready');assert.equal(r.readyAttempts.length,1);assert.equal(r.readyAttempts[0].sig,w.W.sigs.ready,'the real signature is recorded');
 // 660 s after the lock; t0 is 3 h after it. At t0 - 200 the stale view (ready still false) makes userNext choose refund.
 w.advance(REV_T0_LEAD-200-660);let v=await w.driver.tick(r);r=v.record;
 assert.ok(['ready-pending-hold-refund','await-finalized-ready-resolution'].includes(v.reason));assert.ok(!w.chain.sent.includes('signed:refund'));
 w.advance(200+REV_CLAIM_WINDOW+100);v=await w.driver.tick(r);r=v.record;                 // t1 + 100: still inside the margin
 assert.ok(['ready-pending-hold-refund','await-finalized-ready-resolution'].includes(v.reason));assert.ok(!w.chain.sent.includes('signed:refund'),'b is never revealed before t1 + margin');
 w.advance(REFUND_AFTER_T1_S);v=await w.driver.tick(r);
 assert.equal(v.phase,'refunding');assert.ok(w.chain.sent.includes('signed:refund'),'after the claim window closed: the refund goes out');
});
test('H1: a ready attempt survives a stale write; after a refund attempt ready is never sent again',async()=>{
 const w=world();let r=await toReadySent(w);
 const stale={...r};delete stale.readyAttemptAt;delete stale.readyAttempts;delete stale.branch;
 await w.W.bridge.saveRecord(stale);                     // an older copy written by another tab
 w.advance(REV_T0_LEAD-200-660);
 let v=await w.driver.tick(stale);
 assert.ok(['ready-pending-hold-refund','await-finalized-ready-resolution'].includes(v.reason),'the merged record still knows the ready attempt');assert.ok(v.record.readyAttempts?.length>=1);
 // A record on the refund branch never sends ready, whatever a later view says.
 const w2=world();let r2=await w2.driver.start({quote:w2.quote,owner:w2.owner});let v2=await w2.driver.tick(r2);r2=v2.record;
 w2.chain.escrow={A:w2.quote.A,B:r2.B,ready:false};w2.advance(3600);v2=await w2.driver.tick(r2);assert.deepEqual(w2.chain.sent,['signed:lock','signed:refund']);
 w2.W.xmr={atomic:'50000000000',confirmations:10};w2.advance(31);v2=await w2.driver.tick(v2.record);
 assert.ok(!w2.chain.sent.includes('signed:ready'));assert.equal(v2.reason,'refund-branch-chosen');
});
test('H2: a lock is retired only on one coherent finalized view; lagging, incomplete or positive answers keep it; legacy locks are kept',async()=>{
 const fresh=async()=>{const w=world();const r=await w.driver.start({quote:w.quote,owner:w.owner});const v=await w.driver.tick(r);return {w,r:v.record};};
 let {w,r}=await fresh();assert.equal(r.lockSig,w.W.sigs.lock);assert.ok(Number.isSafeInteger(r.lockLastValid));
 w.W.finalizedLag=1e9;w.advance(400);let v=await w.driver.tick(r);
 assert.notEqual(v.record.result,'lock-not-landed','the block at the finalized slot is not past the lock validity');
 for(const lag of [{accountLag:1e9},{statusLag:1e9},{statusIncomplete:true}]){
  ({w,r}=await fresh());Object.assign(w.W,lag);w.advance(400);v=await w.driver.tick(r);
  assert.notEqual(v.record.result,'lock-not-landed',`no proof with ${JSON.stringify(lag)}`);assert.equal(w.chain.sent.filter(x=>x==='signed:lock').length,1,'never a second lock');
 }
 ({w,r}=await fresh());w.W.landedSigs=[w.W.sigs.lock];w.advance(400);v=await w.driver.tick(r);
 assert.notEqual(v.record.result,'lock-not-landed','a signature with a status is never retired');
 ({w,r}=await fresh());w.chain.history=[{transaction:{message:{accountKeys:[],instructions:[]}},meta:{err:null}}];w.advance(400);v=await w.driver.tick(r);
 assert.notEqual(v.record.result,'lock-not-landed','history at the escrow address keeps it');
 ({w,r}=await fresh());w.advance(400);v=await w.driver.tick(r);assert.equal(v.record.result,'lock-not-landed','a coherent view retires it');
 ({w,r}=await fresh());const legacy={...r};delete legacy.lockLastValid;delete legacy.lockSig;w.advance(90000);
 await w.W.bridge.saveRecord(legacy);v=await w.fresh().tick(legacy);   // legacy in storage and in a new driver's memory
 assert.notEqual(v.record.result,'lock-not-landed','a legacy lock without a validity height is kept, even after a day');
});

test('r5 D: when the Monero scan cannot complete, the refund does not come after 30 minutes but at t0 - ABORT_LEAD (almost 3 hours): the terms text says so',async()=>{
 const {ABORT_LEAD}=await import('../lib/silo/atomic-swap/swap-core.mjs');
 const w=world({scanFails:true});let r=await w.driver.start({quote:w.quote,owner:w.owner});
 let v=await w.driver.tick(r);r=v.record;w.chain.escrow={A:w.quote.A,B:r.B,ready:false};
 w.advance(3600);v=await w.driver.tick(r);r=v.record;assert.notEqual(v.phase,'refunding','one hour in, a failed scan still holds the refund');
 w.advance(REV_T0_LEAD-3600-ABORT_LEAD-60);v=await w.driver.tick(r);r=v.record;assert.notEqual(v.phase,'refunding','just before t0 - ABORT_LEAD it still holds');
 w.advance(120);v=await w.driver.tick(r);assert.equal(v.phase,'refunding','at t0 - ABORT_LEAD the refund goes out');assert.deepEqual(w.chain.sent,['signed:lock','signed:refund']);
 const {readFileSync}=await import('node:fs');const text=readFileSync(new URL('../components/silo-atomic-reverse-panel.tsx',import.meta.url),'utf8');
 assert.match(text,/If Silo cannot check Monero[^']*about 15 minutes before the confirmation deadline[^']*almost 3 hours/);
});

test('r6: a failed Monero scan is reported as scanFailed (never as "0 confirmations, no action needed"); a working scan is not',async()=>{
 const bad=world({scanFails:true});let r=await bad.driver.start({quote:bad.quote,owner:bad.owner});
 let v=await bad.driver.tick(r);r=v.record;bad.chain.escrow={A:bad.quote.A,B:r.B,ready:false};v=await bad.driver.tick(r);
 assert.equal(v.phase,'xmr-confirming');assert.equal(v.scanFailed,true);
 const good=world();let g=await good.driver.start({quote:good.quote,owner:good.owner});let gv=await good.driver.tick(g);g=gv.record;good.chain.escrow={A:good.quote.A,B:g.B,ready:false};
 good.W.xmr={atomic:'1000',confirmations:2};gv=await good.driver.tick(g);assert.equal(gv.phase,'xmr-confirming');assert.equal(!!gv.scanFailed,false);
 const {readFileSync}=await import('node:fs');const text=readFileSync(new URL('../components/silo-atomic-reverse-panel.tsx',import.meta.url),'utf8');
 assert.match(text,/if\(view\.scanFailed\)return \{tone:'warn',kicker:'Check failed',title:'Silo cannot check Monero right now'[^}]*almost 3 hours/);
 assert.ok(!/if nothing arrives within 30 minutes/i.test(text),'no unconditional 30 minute promise is left');
});

// ---- Protocol v2: the refund waits behind the maker's commit window, and is decided on a finalized view of the escrow ----
test('v2: a commit that landed just before t1 keeps the refund shut past t1 + margin; the refund goes out only after c + W + margin',async()=>{
 const w=world();let r=await toReadySent(w);
 const t1=w.reg.t1,c=t1-60;
 w.chain.escrow.ready=true;w.chain.escrow.committedAt=c;
 w.goto(t1+REFUND_AFTER_T1_S+100);                                                          // t1 + 400: the pre-v2 rule would refund here
 let v=await w.driver.tick(r);r=v.record;
 assert.equal(v.phase,'await-claim');assert.ok(!w.chain.sent.includes('signed:refund'),'b is not revealed inside the claim window');
 w.goto(c+3600-100);v=await w.driver.tick(r);r=v.record;
 assert.ok(!w.chain.sent.includes('signed:refund'),'not 100 s before the window ends');
 w.goto(c+3600+299);v=await w.driver.tick(r);r=v.record;
 assert.ok(!w.chain.sent.includes('signed:refund'),'not inside the margin after the window');
 w.goto(c+3600+300);v=await w.driver.tick(r);
 assert.equal(v.phase,'refunding');assert.ok(w.chain.sent.includes('signed:refund'),'after c + W + margin the refund goes out');
});
test('v2: the refund decision needs a finalized escrow: finalized view missing -> no refund; a commit seen at either level blocks it; no commit anywhere -> refund after t1 + margin',async()=>{
 let w=world();let r=await toReadySent(w);const t1=w.reg.t1;
 w.chain.escrow.ready=true;w.chain.escrow.committedAt=0;w.W.finalizedMode='absent';
 w.goto(t1+REFUND_AFTER_T1_S+100);let v=await w.driver.tick(r);
 assert.notEqual(v.phase,'refunding');assert.ok(!w.chain.sent.includes('signed:refund'),'finalized read missing: wait, never refund on the confirmed view alone');
 w=world();r=await toReadySent(w);const c=w.reg.t1-60;
 w.chain.escrow.ready=true;w.chain.escrow.committedAt=c;w.W.finalizedMode='uncommitted';  // confirmed shows the commit, finalized does not yet
 w.goto(c+3600-100);v=await w.driver.tick(r);
 assert.ok(!w.chain.sent.includes('signed:refund'),'the commit seen at the confirmed level still blocks the refund');
 w=world();r=await toReadySent(w);
 w.chain.escrow.ready=true;w.chain.escrow.committedAt=0;
 w.goto(w.reg.t1+REFUND_AFTER_T1_S+10);v=await w.driver.tick(r);
 assert.equal(v.phase,'refunding');assert.ok(w.chain.sent.includes('signed:refund'),'no commit anywhere: refund after t1 + margin');
});
test('v2: the panel tells the user the honest worst case, up to 3 hours, in the terms and on the waiting-for-claim screen',async()=>{
 const text=(await import('node:fs')).readFileSync(new URL('../components/silo-atomic-reverse-panel.tsx',import.meta.url),'utf8');
 assert.match(text,/If the maker does not finish[^\n]*up to 2 hours to start its claim[^\n]*up to 1 hour to finish it[^\n]*up to 3 hours/);
 assert.match(text,/case 'await-claim':[^\n]*your SOL comes back after up to 3 hours/);
});

// ---- Astra 691-H1: b leaves only on coherent finalized evidence (the account and the block time of the SAME slot) ----
test('691-H1: the exact scenario: the maker committed at t1 - 60, the clock reads t1 + 301, but the account the client sees is stale (no commit): NO refund goes out',async()=>{
 const w=world();let r=await toReadySent(w);const t1=w.reg.t1,c=t1-60;
 w.chain.escrow.ready=true;w.chain.escrow.committedAt=0;                                // the confirmed view is stale: ready, no commit yet
 w.W.finalizedOverride={ready:true,committedAt:0};w.W.finalizedAccountLag=2*(301+600);  // and the finalized read is ~10 minutes behind the clock: its slot time is before t1 + margin
 w.goto(t1+301);const v=await w.driver.tick(r);
 assert.ok(!w.chain.sent.includes('signed:refund'),'a clock newer than the account must never release b');
 assert.notEqual(v.phase,'refunding');
});
test('691-H1: a stale NOT-READY read (finalized says not ready, old slot) after a ready was sent: no refund before the snapshot itself is past t0 + margin',async()=>{
 const w=world();let r=await toReadySent(w);const t1=w.reg.t1;
 w.chain.escrow.ready=false;w.W.finalizedOverride={ready:false,committedAt:0};
 w.goto(t1+REFUND_AFTER_T1_S+600);w.W.finalizedAccountLag=2*(REV_CLAIM_WINDOW+3600+600);   // the snapshot is hours old: its time is before t0 + margin
 const v=await w.driver.tick(r);
 assert.ok(!w.chain.sent.includes('signed:refund'),'stale not-ready must not bypass the finalized recheck');
 assert.ok(['ready-pending-hold-refund','await-finalized-ready-resolution'].includes(v.reason));
});
test('691-H1: slot skew: the account is read at slot X, the decision uses the block time of X (a skipped X falls back to an earlier slot, which only delays); the clock of a newer slot is never used',async()=>{
 const w=world();let r=await toReadySent(w);const t1=w.reg.t1,c=t1-60;
 w.chain.escrow.ready=true;w.chain.escrow.committedAt=c;w.W.finalizedOverride={ready:true,committedAt:c};
 w.goto(c+3600+300+2);                                                                     // c + W + margin has just passed by the newest clock
 w.W.finalizedAccountLag=8;                                                               // finalized slot is 4 s behind: its own time is before c + W + margin
 let v=await w.driver.tick(r);
 assert.ok(!w.chain.sent.includes('signed:refund'),'the finalized slot itself is not yet past the window: wait');
 w.W.finalizedAccountLag=0;w.goto(c+3600+300+40);w.W.skippedSlots=[Math.floor((c+3600+340-1_900_000_000)*2)];   // finalized slot is a skipped slot: fall back to the previous one
 v=await w.driver.tick(v.record);
 assert.ok(w.chain.sent.includes('signed:refund'),'coherent finalized evidence past the window: the refund goes out');
});
test('691-H1: no finalized snapshot at all (RPC error, empty answer): no refund is ever decided from the confirmed view when a ready may exist',async()=>{
 const w=world();let r=await toReadySent(w);const t1=w.reg.t1;
 w.chain.escrow.ready=true;w.chain.escrow.committedAt=0;w.W.finalizedMode='absent';
 w.goto(t1+REFUND_AFTER_T1_S+3000);const v=await w.driver.tick(r);
 assert.ok(!w.chain.sent.includes('signed:refund'));
});

// ---- F1 (9 Nov rehearsal): one watch wallet per swap, cancel on timeout, a scan never holds back a due refund ----
test('F1: a scan that hits the time bound is cancelled, the pass reports scanFailed, and the next pass joins the same scan instead of starting another',async()=>{
 const w=world({scanHangs:true,scanTimeoutMs:20});let r=await w.driver.start({quote:w.quote,owner:w.owner});
 let v=await w.driver.tick(r);r=v.record;w.chain.escrow={A:w.quote.A,B:r.B,ready:false};
 v=await w.driver.tick(r);assert.equal(v.phase,'xmr-confirming');assert.equal(v.scanFailed,true);
 assert.equal(w.W.cancels,1,'the running sync is cancelled when the bound is hit');assert.equal(w.W.scanCalls,1);
 v=await w.driver.tick(v.record);assert.equal(w.W.scanCalls,1,'the earlier scan has not settled: no second scan is started');assert.equal(w.W.cancels,2);
});
test('F1: a refund that is due is not held back by a scan that never answers (no scan is started, no wait)',async()=>{
 const {MARGIN}=await import('../lib/silo/atomic-swap/swap-core.mjs');
 const w=world({scanHangs:true,scanTimeoutMs:1500});let r=await w.driver.start({quote:w.quote,owner:w.owner});
 let v=await w.driver.tick(r);r=v.record;w.chain.escrow={A:w.quote.A,B:r.B,ready:false};
 w.goto(w.reg.t0-MARGIN+5);const began=Date.now();
 v=await w.driver.tick(r);assert.equal(v.phase,'refunding');assert.deepEqual(w.chain.sent,['signed:lock','signed:refund']);
 assert.ok(Date.now()-began<5000,'the refund did not wait for the 60 s scan bound');assert.equal(w.W.scanCalls??0,0);
});
test('F1: the bridge is told to release the watch wallet once the swap no longer needs a scan (escrow ready)',async()=>{
 const w=world();let r=await w.driver.start({quote:w.quote,owner:w.owner});
 let v=await w.driver.tick(r);r=v.record;w.chain.escrow={A:w.quote.A,B:r.B,ready:true};
 v=await w.driver.tick(r);assert.ok((w.W.releases??0)>=1);
});
test('F1: a releaseScan / cancelScan that never resolves cannot delay a due refund (bounded bridge calls)',async()=>{
 const w=world({scanFails:true,hangHousekeeping:true,bridgeCallTimeoutMs:30});let r=await w.driver.start({quote:w.quote,owner:w.owner});
 let v=await w.driver.tick(r);r=v.record;w.chain.escrow={A:w.quote.A,B:r.B,ready:true};
 // ready escrow: the pass takes the release branch before the decision; the refund must still go out once it is due
 w.goto(w.reg.t1+REFUND_AFTER_T1_S+5);const began=Date.now();
 v=await w.driver.tick(r);assert.ok(Date.now()-began<3000,'the hung release was cut off by its bound');
 assert.equal(v.phase,'refunding');assert.ok(w.chain.sent.includes('signed:refund'));
});
test('F1-H1: the scan deadline is crossed mid-scan and cancelScan never answers: the pass still returns scanFailed in bounds, and a failed scan is never "nothing arrived"',async()=>{
 const w=world({scanHangs:true,hangHousekeeping:true,scanTimeoutMs:20,bridgeCallTimeoutMs:5000});let r=await w.driver.start({quote:w.quote,owner:w.owner});
 let v=await w.driver.tick(r);r=v.record;w.chain.escrow={A:w.quote.A,B:r.B,ready:false};
 const began=Date.now();v=await w.driver.tick(r);
 assert.ok(Date.now()-began<1000,'the bound does not wait for a cancel that never answers');assert.equal(v.scanFailed,true);
 w.advance(3600);v=await w.driver.tick(v.record);assert.notEqual(v.phase,'refunding','still no 30 minute refund on a failed scan');
});
test('F1-H1: a due refund with a stuck scan AND a hung cancel/release goes out at once',async()=>{
 const {MARGIN}=await import('../lib/silo/atomic-swap/swap-core.mjs');
 const w=world({scanHangs:true,hangHousekeeping:true,scanTimeoutMs:1500,bridgeCallTimeoutMs:1500});let r=await w.driver.start({quote:w.quote,owner:w.owner});
 let v=await w.driver.tick(r);r=v.record;w.chain.escrow={A:w.quote.A,B:r.B,ready:false};
 w.goto(w.reg.t0-MARGIN+5);const began=Date.now();v=await w.driver.tick(r);
 assert.equal(v.phase,'refunding');assert.ok(Date.now()-began<1000);
});
test('F1-H1: ready escrow after t1 with a release that never resolves: the refund decision is not behind the release (long bridge bound)',async()=>{
 const w=world({scanFails:true,hangHousekeeping:true,bridgeCallTimeoutMs:1500});let r=await w.driver.start({quote:w.quote,owner:w.owner});
 let v=await w.driver.tick(r);r=v.record;w.chain.escrow={A:w.quote.A,B:r.B,ready:true};
 w.goto(w.reg.t1+REFUND_AFTER_T1_S+5);const began=Date.now();v=await w.driver.tick(r);
 assert.equal(v.phase,'refunding');assert.ok(Date.now()-began<1000,'release is fire and forget');
});

// ---- Astra F1-M2: the scan is skipped only when no scan result could change the decision (real reverse-core predicates) ----
const windowWorld=async opts=>{const w=world(opts);let r=await w.driver.start({quote:w.quote,owner:w.owner});let v=await w.driver.tick(r);r=v.record;w.chain.escrow={A:w.quote.A,B:r.B,ready:false};return {w,r};};
test('F1-M2: full payment with >= 10 confirmations at t0 - 600 (inside [t0 - ABORT_LEAD, t0 - MARGIN)) still sets ready, it is not refunded',async()=>{
 const {ABORT_LEAD,MARGIN}=await import('../lib/silo/atomic-swap/swap-core.mjs');
 const {w,r}=await windowWorld();assert.ok(ABORT_LEAD>600&&600>MARGIN);
 w.W.xmr={atomic:w.quote.xmrAtomic,confirmations:10};w.goto(w.reg.t0-600);
 const v=await w.driver.tick(r);assert.equal(v.phase,'confirming');assert.ok(!w.chain.sent.includes('signed:refund'));assert.ok(w.chain.sent.includes('signed:ready'));
});
test('F1-M2: same time, failed scan: refund',async()=>{
 const {w,r}=await windowWorld({scanFails:true});w.goto(w.reg.t0-600);
 const v=await w.driver.tick(r);assert.equal(v.phase,'refunding');assert.equal(w.W.scanCalls,1,'the scan was tried first');
});
test('F1-M2: same time, a scan that never answers: refund after the scan bound, not before',async()=>{
 const {w,r}=await windowWorld({scanHangs:true,hangHousekeeping:true,scanTimeoutMs:150,bridgeCallTimeoutMs:1500});w.goto(w.reg.t0-600);
 const began=Date.now();const v=await w.driver.tick(r);const took=Date.now()-began;
 assert.ok(took>=140,'the scan bound was honoured ('+took+' ms)');assert.ok(took<2000);assert.equal(v.phase,'refunding');assert.equal(w.W.scanCalls,1);
});
test('F1-M2: at t0 - MARGIN and later nothing changed: no scan, refund',async()=>{
 const {MARGIN}=await import('../lib/silo/atomic-swap/swap-core.mjs');
 for(const at of [0,60]){
  const {w,r}=await windowWorld({scanHangs:true,scanTimeoutMs:1500});w.W.xmr={atomic:w.quote.xmrAtomic,confirmations:10};w.goto(w.reg.t0-MARGIN+at);
  const v=await w.driver.tick(r);assert.equal(v.phase,'refunding');assert.equal(w.W.scanCalls??0,0);
 }
});
test('F1-M2: the scan-timeout cancel path is entered, a hung cancel does not block, and the next pass is not blocked either',async()=>{
 const {w,r}=await windowWorld({scanHangs:true,hangHousekeeping:true,scanTimeoutMs:20,bridgeCallTimeoutMs:1500});
 let v=await w.driver.tick(r);assert.equal(v.scanFailed,true);
 await new Promise(x=>setImmediate(x));assert.equal(w.W.scanCalls,1);assert.equal(w.W.cancelEntered,1,'cancelScan was entered (and never answered)');
 v=await w.driver.tick(v.record);assert.equal(v.scanFailed,true,'the next pass joins the unsettled scan and is bounded again');assert.equal(w.W.scanCalls,1);
});
