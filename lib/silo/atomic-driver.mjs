// SPDX-License-Identifier: AGPL-3.0-only
// Client driver for "Swap XMR to SOL, no bridge (beta)". All decisions come from alice-flow/swap-core; this module only orders the
// side effects and keeps the rule that a swap record is encrypted and saved BEFORE anything that depends on it is sent.
// It never touches the user's Solana wallet key: the only transaction is the claim, signed by the throwaway fee payer in the record.
import {LOCK_WAIT} from './atomic-swap/swap-core.mjs';
export const ATOMIC_POLL_MS=20000;
export const MAKER_CALL_TIMEOUT_MS=15000;
export const CLAIM_RETRY_MS=60000;
export const XMR_TARGET_CONFIRMATIONS=10;
/** The Monero depth the maker announced for this swap (quote.confirmations, 1..10); anything else is 10. Display only: in this
 * direction the depth is the maker's own risk, the user's claim waits for the maker's on-chain ready (or t0). */
export function atomicTargetConfirmations(record){
 const n=record?.quote?.confirmations;
 return Number.isSafeInteger(n)&&n>=1&&n<=XMR_TARGET_CONFIRMATIONS?n:XMR_TARGET_CONFIRMATIONS;
}
export const UNSENT_GRACE_S=86400;   // after this, recovery of an attempted but unseen payment slows down; it never stops (H6)
export const SLOW_RECOVERY_MS=3600_000;
// Independent of Silo's own servers and reachable from a browser: api.mainnet-beta.solana.com answers 403 to any request with an Origin.
export const SILO_ATOMIC_MAINNET_PUBLIC_RPC='https://solana-rpc.publicnode.com';
export const PUBLIC_RPC={mainnet:SILO_ATOMIC_MAINNET_PUBLIC_RPC,devnet:'https://api.devnet.solana.com'};
const FINAL=new Set(['done','rejected']);
export const atomicRecordActive=record=>record?.kind==='silo-atomic-xmr-sol-v1'&&!FINAL.has(record.status);
const message=error=>error instanceof Error?error.message:'unknown';
const withTimeout=(promise,ms)=>Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('timeout')),ms))]);

/** The phase to show for a swap when this tick decides nothing new (or before the first tick after a reload): derived from
 * the record, so a swap whose SOL the maker already locked never reads "Waiting for the maker to lock the SOL" next to a
 * ticked "Locked" step. */
export function atomicIdlePhase(record){
 if(record?.xmrLockTxid||record?.fundingAttempted)return 'confirming';
 return record?.refunder?'checking-lock':'waiting-maker';
}
/** "Send by", in unix seconds: the maker cancels on its own when no XMR is seen LOCK_WAIT after its SOL lock. The user's
 * acceptance comes a few seconds after that lock, so five minutes are kept back; null before the maker locked. */
export function atomicSendBy(record){
 return Number.isSafeInteger(record?.acceptedAt)&&record?.refunder?record.acceptedAt+LOCK_WAIT-300:null;
}
/** A rate for display: at most 4 decimals, trailing zeros dropped (6.866738544474393 -> "6.8667"). */
export function atomicRateText(value){
 const n=Number(value);if(!Number.isFinite(n)||n<=0)return '-';
 return n.toFixed(4).replace(/\.?0+$/,'');
}

/** The three progress steps shown to the user, from a record and the last observation. */
/** @param {any} record @param {{confirmations?:number|null}} [observation] */
export function atomicProgress(record,{confirmations=null}={}){
 const result=record?.result??null;
 const refunded=result==='xmr-recovered'||result==='cancelled'||record?.refundSeen===true;
 const locked=Boolean(record?.refunder)&&record?.status!=='quoted'&&record?.status!=='rejected';
 const target=atomicTargetConfirmations(record);
 const confirming=Math.max(0,Math.min(target,Number.isFinite(confirmations)?confirmations:(record?.xmrConfirmations??0)));
 return {
  steps:[{id:'locked',label:'Locked',done:locked},{id:'confirming',label:`Confirming ${confirming}/${target}`,done:Boolean(record?.xmrLockTxid)&&confirming>=target||result==='sol-received'},{id:'received',label:'Received',done:result==='sol-received'}],
  refunded,
 };
}

/**
 * @param {{flow:any,post:(action:string,body:unknown)=>Promise<any>,bridge:any,network:'mainnet'|'devnet',now?:()=>number,fetcher?:typeof fetch,publicRpc?:string}} deps
 * flow = alice-flow.mjs; bridge = { saveRecord(record), lockStatus({address,amountAtomic}), prepareLock({address,amountAtomic,swapId,expiresAt}),
 *   daemonHeight(), sweepRecovery(keys) }.
 */
export function createAtomicDriver({flow,post,bridge,network,now=()=>Date.now(),fetcher=(...args)=>fetch(...args),publicRpc=PUBLIC_RPC[network]}){
 const staged=new Set();
 const save=async record=>{await bridge.saveRecord(record);return record;};

 /** Persist first, then talk to the maker; accept only a self-consistent answer, and never send XMR otherwise. */
 async function start({quote,claimer}){
  const record=flow.newSwapRecord({claimer,quote,network});
  await save(record);                                  // 1. encrypted and saved BEFORE the swap call
  const answer=await withTimeout(post('swap',flow.swapRequest(record)),MAKER_CALL_TIMEOUT_MS);   // a failure leaves it 'quoted'; the resume loop expires it, nothing was sent
  let accepted;
  try{accepted=flow.acceptMakerLock(record,answer,Math.floor(now()/1000));}
  catch(error){await save({...record,status:'rejected',result:'maker-answer-rejected',rejectedReason:message(error)});throw Object.assign(new Error('The swap offer did not check out, so nothing was sent. '+message(error)),{userFacing:true});}
  await save(accepted);
  return accepted;
 }

 async function publicRpcCall(method,params){
  const response=await fetcher(publicRpc,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000)});
  const json=await response.json();if(json.error)throw Error(String(json.error.message??'rpc-error'));return json.result;
 }
 async function directBroadcast(base64){
  try{await fetcher(publicRpc,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'sendTransaction',params:[base64,{encoding:'base64',preflightCommitment:'confirmed'}]}),signal:AbortSignal.timeout(15000)});return true;}
  catch{return false;}                                 // best effort: a blocked or failed fallback never changes the outcome
 }

 /** One pass of the loop. Returns the (possibly updated) record and a view for the panel. */
 async function tick(record){
  if(!atomicRecordActive(record))return {record,phase:'final',confirmations:record.xmrConfirmations??null};
  let r=record;
  if(!r.refunder){                                      // the swap call never returned: nothing was locked for us as far as we know
   if(Math.floor(now()/1000)>r.quote.expiresAt){r=await save({...r,status:'done',result:'quote-expired'});return {record:r,phase:'final',confirmations:null};}
   return {record:r,phase:'waiting-maker',confirmations:null};
  }
  // Money-moving decisions use ONLY an independent public RPC view (H1, H2, H7): never the Silo server,
  // which the swap operator runs alongside the maker. If that view is unavailable, nothing moves this tick.
  let chain;
  try{chain=await flow.readChainIndependent(r,publicRpcCall);}
  catch{return {record:r,phase:atomicIdlePhase(r),confirmations:r.xmrConfirmations??null,notice:'Checking the Solana network. Silo retries while it is open and unlocked.',reason:'public-rpc-unreachable'};}
  let confirmations=r.xmrConfirmations??null,update={};
  // Where the paged history scan stopped, so the next tick continues from there instead of the newest row (H7).
  if((chain.historyCursor??null)!==(r.historyCursor??null))update.historyCursor=chain.historyCursor??null;
  // Our own XMR payment, recognised from the wallet (also after a reload): never pay twice.
  // lockScanned: this tick's own-wallet scan answered. A swap is never retired on an unanswered scan (H6).
  let lock=null,lockScanned=false;
  if(r.status!=='done'){
   try{lock=await bridge.lockStatus({address:r.jointAddress,amountAtomic:r.quote.xmrAtomic});lockScanned=true;}catch{/* wallet busy or not synced: keep the last values */}
   if(lock?.found){
    confirmations=lock.confirmations??0;
    if(!r.xmrLockTxid){update.xmrLockTxid=lock.txid;update.xmrLockHeight=lock.height??await bridge.daemonHeight().catch(()=>null)??0;}
    else if(!r.xmrLockHeight&&lock.height)update.xmrLockHeight=lock.height;
    if(confirmations!==(r.xmrConfirmations??null))update.xmrConfirmations=confirmations;
   }
  }
  if(chain.outcome?.kind==='refunded')update.refundSeen=true;
  if(Object.keys(update).length){r={...r,...update};await save(r);}
  const next=flow.nextAction(r,chain);
  if(next.action==='lock-xmr'){
   const key=r.swapId;
   if(!staged.has(key)){
    staged.add(key);
    // The staged payment is bound to this swap and to its funding deadline; the wallet re-checks both at the moment of sending (H6).
    try{await bridge.prepareLock({address:r.jointAddress,amountAtomic:r.quote.xmrAtomic,swapId:r.swapId,expiresAt:(r.t0-flow.LOCK_MIN_LEAD)*1000});}
    catch(error){staged.delete(key);return {record:r,phase:'awaiting-xmr',confirmations,notice:message(error)};}
   }
   return {record:r,phase:'awaiting-xmr',confirmations};
  }
  if(next.action==='claim'){
   const t=now(),last=r.claimAttemptAt??0;
   if(t-last>=CLAIM_RETRY_MS){
    // Inputs (blockhash, fee-payer balance) come from the independent view, not the server (H2).
    const wire=flow.buildClaimTx(r,{blockhash:chain.blockhash,feePayerLamports:chain.feePayerLamports});
    r={...r,claimTx:wire,claimAttemptAt:t};
    await save(r);                                      // the signed bytes are on disk before they are sent
    // Fresh check after the awaited save: own clock and the independent chain clock, whichever is later (H2).
    const elapsed=Math.max(0,Math.floor((now()-t)/1000));
    if(!flow.claimStillSafe(r,Math.max(Math.floor(now()/1000),chain.now+elapsed)))return {record:r,phase:'claiming',confirmations,reason:'claim-window-closing'};
    // Independent broadcast FIRST and on every retry; the Silo server copy is best effort, time-bounded and
    // never awaited for any decision (H1). Landing is judged only from the independent view on later ticks.
    await directBroadcast(wire);
    void withTimeout(post('claim',{tx:wire}),MAKER_CALL_TIMEOUT_MS).catch(()=>{});
   }
   return {record:r,phase:'claiming',confirmations};
  }
  if(next.action==='recover-xmr'){
   const keys=flow.recoveryKeys(r,next.secret);
   // A swap whose payment may have gone out is NEVER closed automatically (H6, round 3): an unsynced or failed wallet
   // scan proves nothing, so recovery stays active across reloads until a sweep succeeds. After a day without a
   // finding it only slows to one attempt per hour; the keys are shown the whole time.
   if(!r.xmrLockTxid&&now()>=(r.t0-flow.LOCK_MIN_LEAD+UNSENT_GRACE_S)*1000&&now()-(r.recoveryAttemptAt??0)<SLOW_RECOVERY_MS)
    return {record:r,phase:'recovering',confirmations,recoveryKeys:keys,notice:'Still watching for your XMR. Silo retries while it is open and unlocked; the keys below always work.'};
   if(!r.xmrLockTxid&&now()>=(r.t0-flow.LOCK_MIN_LEAD+UNSENT_GRACE_S)*1000)r=await save({...r,recoveryAttemptAt:now()});
   try{
    const hashes=await bridge.sweepRecovery(keys);
    if(Array.isArray(hashes)&&hashes.length){r=await save({...r,xmrRecoveredTxids:hashes});return {record:r,phase:'recovering',confirmations,recoveryKeys:keys};}
    return {record:r,phase:'recovering',confirmations,recoveryKeys:keys,notice:'Your XMR is not spendable yet. Silo retries while it is open and unlocked.'};
   }catch(error){return {record:r,phase:'recovering',confirmations,recoveryKeys:keys,notice:'Automatic recovery did not finish. Silo retries while it is open and unlocked; the keys below always work.'};}
  }
  if(next.action==='done'){
   // A refund before any payment: keep watching until the funding deadline (+1 h for an in-flight relay) has
   // passed, so a payment that still went out is recovered rather than forgotten (H6).
   if(next.result==='cancelled'&&(!lockScanned||r.fundingAttempted||now()<(r.t0-flow.LOCK_MIN_LEAD+3600)*1000)){
    if(r.status!=='watching')r=await save({...r,status:'watching'});
    return {record:r,phase:'stopped',confirmations,reason:'watching-for-late-payment'};
   }
   r=await save({...r,status:'done',result:next.result});
   return {record:r,phase:r.result==='sol-received'?'received':r.result==='xmr-recovered'?'refunded':'stopped',confirmations};
  }
  // The claim window closed with the XMR sent: only the maker's refund (from t1) moves it now. Never "Waiting for confirmations".
  if(next.reason==='claim-window-closed-await-maker-refund')return {record:r,phase:'awaiting-refund',confirmations,reason:next.reason,refundFrom:r.t1??null};
  return {record:r,phase:atomicIdlePhase(r),confirmations,reason:next.reason};
 }
 return Object.freeze({start,tick});
}
