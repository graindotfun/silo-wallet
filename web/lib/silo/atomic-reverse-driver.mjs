// Client driver for "Swap SOL to XMR, no bridge (beta)". Decisions come from bob-flow / reverse-core (rules U1-U5); this module
// orders the side effects. Rules: the record is encrypted and saved BEFORE anything that depends on it is sent; a SOL lock is
// marked as attempted BEFORE it is broadcast, and never repeated; money-moving decisions use only the independent public RPC
// view and the user's own view-only Monero scan, never the Silo server. The user's wallet signs only through the keyring's
// reviewed swap path (native-keyring signReviewedAtomic), which re-checks each transaction against the record.
import {PUBLIC_RPC,MAKER_CALL_TIMEOUT_MS,ATOMIC_POLL_MS,XMR_TARGET_CONFIRMATIONS} from './atomic-driver.mjs';
import bs58 from 'bs58';
const toBase58=bytes=>bs58.encode(bytes);
export const REVERSE_RECORD_KIND='silo-atomic-sol-xmr-v1';
export const REVERSE_STEP_RETRY_MS=30000;
// Astra rounds 1-2 (5-6 Nov 2026). H1: once a ready may have gone out, b is never revealed before the claim window has closed on
// chain: no early refund, no proof path (RPC nodes lag independently, so a negative observation proves nothing). The refund waits
// for chain time >= t1 + REFUND_AFTER_T1_S; the margin covers a clock reading slightly ahead of the program's clock.
export const REFUND_AFTER_T1_S=300;
// H2: a lock is retired as "never landed" only on one coherent finalized view anchored at a single slot S: the block AT S is past
// the lock's lastValidBlockHeight (so the lock could only have landed before S), and at S or later there is no escrow account, no
// status for its signature and no history at the escrow address, each response proving its own context slot >= S. Anything
// missing, lagging or malformed is no proof: the swap stays active and recoverable, and no second lock is ever sent.
export const SCAN_TIMEOUT_MS=120000;   // N1: a slow Monero scan never holds a decision for long
export const BRIDGE_CALL_TIMEOUT_MS=3000;   // F1: cancelScan / releaseScan are housekeeping and never delay a decision longer than this
const FINAL=new Set(['done','rejected']);
export const reverseRecordActive=record=>record?.kind===REVERSE_RECORD_KIND&&!FINAL.has(record.status);
const message=error=>error instanceof Error?error.message:'unknown';
// The timer is cleared once the call settles, so a bounded call never keeps a timer (or a test process) alive.
const withTimeout=(promise,ms)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),ms);})]).finally(()=>clearTimeout(timer));};

/**
 * @param {{flow:any,post:(action:string,body:unknown)=>Promise<any>,bridge:any,sign:(encoded:string,expected:unknown)=>Promise<string>|string,network:'mainnet'|'devnet',now?:()=>number,fetcher?:typeof fetch,publicRpc?:string}} deps
 * flow = bob-flow.mjs; bridge = { saveRecord(record), daemonHeight(), watchJoint(keys) -> {atomic,confirmations}|null, sweepRecovery(keys) -> txids }.
 */
export function createReverseDriver({flow,post,bridge,sign,network,now=()=>Date.now(),fetcher=(...args)=>fetch(...args),publicRpc=PUBLIC_RPC[network],scanTimeoutMs=SCAN_TIMEOUT_MS,bridgeCallTimeoutMs=BRIDGE_CALL_TIMEOUT_MS}){
 // H1: branch intent is monotonic. Attempts and the chosen branch survive reloads and a stale write from an older copy of the record:
 // every save carries forward what this driver or the stored copy already knows.
 const intent=new Map();
 const merge=record=>{
  const stored=(typeof bridge.records==='function'?bridge.records():[]).find(x=>x?.swapId===record.swapId);
  const known=[intent.get(record.swapId),stored].filter(Boolean),out={...record};
  for(const k of known){
   for(const f of ['lockAttemptAt','readyAttemptAt','refundAttemptAt'])if(Number.isFinite(k[f])&&!(Number(out[f])>=k[f]))out[f]=k[f];
   for(const f of ['lockSig','lockLastValid','lockedAt'])if(out[f]==null&&k[f]!=null)out[f]=k[f];
   if(k.lockSeen)out.lockSeen=true;
   const id=x=>`${x.sig}:${x.lastValid}`,seen=new Set((out.readyAttempts??[]).map(id));out.readyAttempts=[...(out.readyAttempts??[]),...(k.readyAttempts??[]).filter(x=>!seen.has(id(x)))];
   if(k.branch==='refund'||(k.branch==='ready'&&out.branch!=='refund'))out.branch=k.branch;
  }
  if(!out.readyAttempts?.length)delete out.readyAttempts;
  intent.set(record.swapId,{lockAttemptAt:out.lockAttemptAt,readyAttemptAt:out.readyAttemptAt,refundAttemptAt:out.refundAttemptAt,lockSig:out.lockSig,lockLastValid:out.lockLastValid,lockedAt:out.lockedAt,lockSeen:out.lockSeen,readyAttempts:out.readyAttempts,branch:out.branch});
  return out;
 };
 const save=async record=>{const merged=merge(record);await bridge.saveRecord(merged);return merged;};
 /** The first signature of a signed wire transaction (base64), or null when it cannot be read. */
 const signatureOf=base64=>{try{const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));if(bytes[0]<1||bytes.length<65)return null;return toBase58(bytes.subarray(1,65));}catch{return null;}};
 /** H2: the coherent finalized proof described at the top. Returns true only when every check passes. */
 async function lockProvenDead(r){
  if(!Number.isSafeInteger(r.lockLastValid)||typeof r.lockSig!=='string'||!r.lockSig)return false;   // legacy or unreadable: keep it
  try{
   const slot=await rpc('getSlot',[{commitment:'finalized'}]);
   if(!Number.isSafeInteger(slot)||slot<=0)return false;
   const block=await rpc('getBlock',[slot,{commitment:'finalized',transactionDetails:'none',rewards:false,maxSupportedTransactionVersion:0}]);
   if(!Number.isSafeInteger(block?.blockHeight)||block.blockHeight<=r.lockLastValid)return false;
   const fresh=x=>Number.isSafeInteger(x?.context?.slot)&&x.context.slot>=slot;
   const acc=await rpc('getAccountInfo',[r.pda,{encoding:'base64',commitment:'finalized',minContextSlot:slot}]);
   if(!fresh(acc)||!Object.prototype.hasOwnProperty.call(acc,'value')||acc.value!==null)return false;
   const st=await rpc('getSignatureStatuses',[[r.lockSig],{searchTransactionHistory:true}]);
   if(!fresh(st)||!Array.isArray(st.value)||st.value.length!==1||st.value[0]!==null)return false;
   const hist=await rpc('getSignaturesForAddress',[r.pda,{limit:1,commitment:'finalized',minContextSlot:slot}]);
   return Array.isArray(hist)&&hist.length===0;
  }catch{return false;}
 }
 async function rpc(method,params){
  const response=await fetcher(publicRpc,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000)});
  const json=await response.json();if(json.error)throw Error(String(json.error.message??'rpc-error'));return json.result;
 }
 // No preflight: the public devnet endpoint is load balanced and its simulation node often has not seen the blockhash its sibling just
 // handed out (BlockhashNotFound on a fresh blockhash, stagenet + devnet run of 5 Nov); the chain read decides what happened.
 // The independent RPC only; a failed send changes nothing (the next tick re-reads the chain and decides again).
 const broadcast=async base64=>{try{await rpc('sendTransaction',[base64,{encoding:'base64',skipPreflight:true,maxRetries:3}]);return true;}catch{return false;}};

 /** Persist first, then register with the maker; accept only a self-consistent answer. Nothing is locked here. */
 async function start({quote,owner}){
  const height=await bridge.daemonHeight().catch(()=>null);
  if(!Number.isSafeInteger(height)||height<=0)throw Object.assign(new Error('Silo could not read the Monero network. Try again in a moment.'),{userFacing:true});
  const record={...flow.newReverseRecord({owner,quote,network}),restoreHeight:height};
  await save(record);
  const answer=await withTimeout(post('rev-swap',flow.reverseRegisterRequest(record)),MAKER_CALL_TIMEOUT_MS);
  let accepted;
  try{accepted=flow.acceptMakerRegistration(record,answer,Math.floor(now()/1000));}
  catch(error){await save({...record,status:'rejected',result:'maker-answer-rejected',rejectedReason:message(error)});throw Object.assign(new Error('The swap offer did not check out, so nothing was sent. '+message(error)),{userFacing:true});}
  return save(accepted);
 }

 async function step(kind,r,chain,stamp){
  const t=now();if(t-(r[stamp]??0)<REVERSE_STEP_RETRY_MS)return r;
  // A fresh blockhash for the step itself: the chain read above came before the Monero scan, which can take longer than a blockhash lives
  // (stagenet run of 5 Nov: the ready transaction failed with BlockhashNotFound on every attempt).
  const latest=(await rpc('getLatestBlockhash',[{commitment:'confirmed'}]))?.value,fresh=latest?.blockhash,lastValid=latest?.lastValidBlockHeight;
  if(typeof fresh!=='string'||!Number.isSafeInteger(lastValid))throw Error('chain-read-incomplete');
  const unsigned=flow.buildStepTx(kind,r,fresh);
  const signed=await sign(unsigned,flow.signingExpectation(kind,r));
  const sig=signatureOf(signed);
  // The attempt, its signature, its validity height and the branch are on disk before the bytes leave the device (H1, H2).
  // A lock is never repeated; once a refund (which reveals b) may have gone out, ready is never sent again.
  const extra=kind==='lock'?{lockedAt:chain.now,lockSig:sig,lockLastValid:lastValid}:kind==='ready'?{branch:'ready',readyAttempts:[...(r.readyAttempts??[]),{sig,lastValid}]}:{branch:'refund'};
  r=await save({...r,[stamp]:t,...extra});
  await broadcast(signed);
  return r;
 }

 // F1: one scan per swap at a time. If an earlier scan has not settled (a cancel that did not take effect), the next pass joins it instead of starting
 // another; when the time bound is hit the bridge is told to cancel the running sync (it keeps its progress for the next pass).
 const inflight=new Map();
 const scanOnce=r=>{
  let p=inflight.get(r.swapId);
  if(!p){const id=r.swapId;p=Promise.resolve().then(()=>bridge.watchJoint(flow.watchKeys(r)));const clear=()=>{if(inflight.get(id)===p)inflight.delete(id);};p.then(clear,clear);inflight.set(id,p);}
  return p;
 };
 // The bound itself never waits on the bridge: a timeout fires the cancel in the background (itself bounded) and returns at once.
 const background=call=>{try{void withTimeout(Promise.resolve().then(call),bridgeCallTimeoutMs).catch(()=>{});}catch{/* housekeeping only */}};
 const scanBounded=async r=>{
  try{return await withTimeout(scanOnce(r),scanTimeoutMs);}
  catch(error){
   if(message(error)==='timeout')background(()=>bridge.cancelScan?.(flow.watchKeys(r)));
   throw error;
  }
 };
 // Release is housekeeping off the decision path: never awaited. The pool keeps the wallet in a retiring state until it is closed, so nothing leaks.
 const releaseScan=r=>{background(()=>bridge.releaseScan?.(flow.watchKeys(r)));};
 /** One pass. Returns the (possibly updated) record and a view for the panel. */
 async function tick(record){
  if(!reverseRecordActive(record))return {record,phase:'final'};
  // H1: decide on the merged record, so a stale copy never forgets an attempt or the chosen branch.
  let r=merge(record);
  if(!r.pda){
   if(Math.floor(now()/1000)>r.quote.expiresAt){r=await save({...r,status:'done',result:'quote-expired'});return {record:r,phase:'final'};}
   return {record:r,phase:'waiting-maker'};
  }
  let chain;
  try{chain=await flow.readReverseChain(r,rpc);}
  catch{return {record:r,phase:idle(r),notice:'Checking the Solana network. This retries by itself.',reason:'public-rpc-unreachable'};}
  if((chain.historyCursor??null)!==(r.historyCursor??null))r=await save({...r,historyCursor:chain.historyCursor??null});
  // The user's own view-only scan (U2). A failed scan is not "nothing arrived": it only holds ready back.
  let xmr=null,scanned=false;
  // N1: after t1 the refund is open whatever the scan says, so no scan; the scan is time-bounded.
  if(chain.pda&&!chain.pda.ready&&chain.now<(chain.pda.t1??r.t1)){
   const failed={atomic:'0',confirmations:0};
   // F1: skip the scan only when NO scan result could change the decision. That is proven with the real predicates (reverse-core via bob-flow), not with
   // copied constants: the decision with the failed-scan sentinel AND the decision with the best possible result (the full amount, fully confirmed) are both
   // "refund". Inside [t0 - ABORT_LEAD, t0 - MARGIN) the best result gives set-ready, so there the scan runs with its normal bound and the result decides.
   const best={atomic:String(r.quote.xmrAtomic),confirmations:Number.MAX_SAFE_INTEGER};
   let refundDue=false;try{refundDue=flow.nextReverseAction(r,chain,failed).action==='refund'&&flow.nextReverseAction(r,chain,best).action==='refund';}catch{refundDue=false;}
   if(refundDue){xmr=failed;}
   else{
    try{xmr=await scanBounded(r);scanned=true;}catch{xmr=failed;}
    const conf=xmr?.confirmations??null;if(scanned&&conf!==(r.xmrConfirmations??null))r=await save({...r,xmrConfirmations:conf});
   }
  }else if(chain.pda)releaseScan(r);
  if(chain.outcome?.kind==='refunded'&&!r.refundSeen)r=await save({...r,refundSeen:true});
  // A lock proven unable to land (H2) that left no escrow and no history: nothing was locked. Otherwise it stays recoverable.
  if(r.lockAttemptAt&&!chain.pda&&!chain.outcome&&!r.lockSeen&&await lockProvenDead(r)){
   r=await save({...r,status:'done',result:'lock-not-landed'});return {record:r,phase:'stopped'};
  }
  if(chain.pda&&!r.lockSeen)r=await save({...r,lockSeen:true});
  const next=flow.nextReverseAction(r,chain,xmr);
  if(next.action==='lock-sol'){r=await step('lock',r,chain,'lockAttemptAt');return {record:r,phase:'locking'};}
  // H1: a refund may already have revealed b; ready after that would let the maker claim the SOL and take the XMR back.
  if(next.action==='set-ready'&&(r.branch==='refund'||r.refundAttemptAt))return {record:r,phase:'refunding',reason:'refund-branch-chosen'};
  if(next.action==='set-ready'){r=await step('ready',r,chain,'readyAttemptAt');return {record:r,phase:'confirming',confirmations:XMR_TARGET_CONFIRMATIONS};}
  if(next.action==='refund'){
   // H1: once a ready may have gone out, b stays secret until the claim window has closed (t1 + margin). No exceptions.
   const readyMayLand=r.branch==='ready'||Boolean(r.readyAttemptAt)||Boolean(r.readyAttempts?.length);
   if(readyMayLand&&!(chain.now>=r.t1+REFUND_AFTER_T1_S))return {record:r,phase:'confirming',reason:'ready-pending-hold-refund',confirmations:XMR_TARGET_CONFIRMATIONS};
   r=await step('refund',r,chain,'refundAttemptAt');return {record:r,phase:'refunding'};
  }
  if(next.action==='sweep-xmr'){
   try{
    const hashes=await bridge.sweepRecovery(flow.sweepKeys(r,next.secret));
    if(Array.isArray(hashes)&&hashes.length){r=await save({...r,xmrSweptTxids:hashes,claimSig:chain.outcome?.sig??null});return {record:r,phase:'sweeping'};}
    return {record:r,phase:'sweeping',notice:'Your XMR is not spendable yet. This retries by itself.'};
   }catch{return {record:r,phase:'sweeping',notice:'Moving your XMR did not finish. This retries by itself.'};}
  }
  if(next.action==='done'){releaseScan(r);r=await save({...r,status:'done',result:next.result});return {record:r,phase:r.result==='xmr-received'?'received':r.result==='sol-refunded'?'refunded':'stopped'};}
  if(next.reason==='await-maker-claim')return {record:r,phase:'await-claim'};
  // scanFailed: the view-only Monero check did not complete (timeout or error). The panel says so instead of showing "0 confirmations, no action needed".
  if(next.reason==='xmr-confirming')return {record:r,phase:'xmr-confirming',confirmations:xmr?.confirmations??0,scanFailed:xmr!==null&&!scanned};
  return {record:r,phase:idle(r),reason:next.reason};
 }
 const idle=r=>r.lockAttemptAt?(r.lockSeen?'awaiting-maker-xmr':'locking'):'waiting-maker';
 return Object.freeze({start,tick,pollMs:ATOMIC_POLL_MS});
}
