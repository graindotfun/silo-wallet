/** Exact prepared review/consent and one-use native capability. No generic
 * signing fallback. Capture and account publication stay in the durable core. */
import {Buffer} from 'buffer';
import {VersionedTransaction} from '@solana/web3.js';
import {sessionRpcFetch} from '../browser-rpc-session.mjs';
import {readBoundedRequestText} from '../bounded-request-body.mjs';
import {validateSiloSealedTransferReview} from './solana-transfer-review-contract.mjs';
import {signSiloTransferDurably,readSiloTransferJournal} from './solana-transfer-journal.mjs';
import {consumeSiloTransferAccountAdmission} from './sync/signing-gate.mjs';
import {assertSiloNativeTransferAccepted,SILO_TRANSFER_RELEASE_ORIGIN} from './solana-transfer-acceptance.mjs';
const prepared=new WeakMap(),consents=new WeakMap(),tickets=new WeakMap();
async function request(action,payload,{signal,assertCurrent}){
 signal=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(15000)]);
 const current=()=>{assertCurrent();signal.throwIfAborted();};current();
 let abort,response,fetching;
 const stopped=new Promise((_,reject)=>{abort=()=>reject(Error('Transfer review request interrupted.'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
 try{
  fetching=Promise.resolve().then(()=>{current();return sessionRpcFetch(action==='submit'?'/api/silo/solana/submit':'/api/silo/solana/review',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(action==='submit'?{record:payload}:{action,payload})},false,current);});
  response=await Promise.race([fetching,stopped]);current();
  const text=await readBoundedRequestText({body:response.body,headers:response.headers,signal},{maxBytes:16000,timeoutMs:15000});current();
  if(!response.ok)throw Error('Authoritative transfer review unavailable.');return JSON.parse(text);
 }catch(error){if(fetching)void fetching.then(r=>{if(r?.body&&!r.body.locked)void r.body.cancel().catch(()=>{});},()=>{});throw error;}
 finally{signal.removeEventListener('abort',abort);}
}
function verified(review,result){if(result?.status!=='verified'||['messageHash','reviewSeal','expiresAt','sourceFingerprint','runtimeFingerprint'].some(key=>result[key]!==review[key]))throw Error('Fresh transfer verification differs.');}
/** @param {{storage:any,wallet:any,connection:any,accountSigning:()=>any,assertCurrent?:()=>void,now?:()=>number,signal?:AbortSignal}} options */
export function createSiloTransferClientFlow({storage,wallet,connection,accountSigning,assertCurrent=()=>{},now=Date.now,signal}={}){
 const flow={
  async prepare(input){assertCurrent();if(readSiloTransferJournal(storage))throw Error('Resolve the saved transfer first.');const snapshot=JSON.stringify(input),review=await request('prepare',input,{signal,assertCurrent});validateSiloSealedTransferReview(review);if(JSON.stringify(input)!==snapshot)throw Error('Transfer request changed.');const t=review.terms,wanted=input.terms;if(['network','owner','recipient','mint','decimals'].some(key=>(wanted[key]??null)!==(t[key]??null))||!input.max&&wanted.amount!==t.amount)throw Error('Prepared transfer differs.');const result=await request('verify',review,{signal,assertCurrent});verified(review,result);prepared.set(review,{flow,snapshot:JSON.stringify(review)});return review;},
  consent(review){const cap=prepared.get(review);if(cap?.flow!==flow||cap.snapshot!==JSON.stringify(review))throw Error('Exact prepared transfer required.');const token=Object.freeze({kind:'silo-transfer-consent-v1'});consents.set(token,{review,snapshot:cap.snapshot});return token;},
  async approve(review,consent){assertSiloNativeTransferAccepted();const cap=prepared.get(review),permission=consents.get(consent);if(cap?.flow!==flow||permission?.review!==review||permission.snapshot!==cap.snapshot||JSON.stringify(review)!==cap.snapshot)throw Error('Exact prepared transfer consent required.');prepared.delete(review);consents.delete(consent);
   let time=review.checkedAt;const guard=()=>{assertSiloNativeTransferAccepted();assertCurrent();const n=now();if(signal?.aborted||JSON.stringify(review)!==cap.snapshot||!Number.isSafeInteger(n)||n<time||n>=review.expiresAt||typeof location==='undefined'||location.origin!==SILO_TRANSFER_RELEASE_ORIGIN)throw Error('Native transfer context changed.');time=n;};guard();
   if(typeof wallet?.signReviewedTransferTransaction!=='function'||typeof wallet?.transferIdentity!=='function')throw Error('Restricted native transfer wallet required.');const identity=wallet.transferIdentity(),hooks=accountSigning().transferHooks(storage);if(typeof hooks.assertPrompt!=='function')throw Error('Live account-backed transfer admission required.');
   const checkedWallet={get publicKey(){return wallet.publicKey;},signTransaction:async tx=>{guard();const admission=hooks.assertPrompt(),wire=Buffer.from(tx.serialize()).toString('base64');if(wire!==review.transactionBase64)throw Error('Native transfer wire changed.');const ticket=Object.freeze({kind:'silo-native-transfer-ticket-v1'});tickets.set(ticket,{review,snapshot:cap.snapshot,identity,admission,wire,guard,used:false});try{return await wallet.signReviewedTransferTransaction(tx,ticket);}finally{tickets.delete(ticket);}}};
   return signSiloTransferDurably(review,{storage,wallet:checkedWallet,connection,now,assertCurrent:guard,...hooks,beforeWalletPrompt:async()=>{guard();verified(review,await request('verify',review,{signal,assertCurrent:guard}));guard();await hooks.beforeWalletPrompt();guard();}});
  },
 };return Object.freeze(flow);
}
/** Synchronous entry from the native vault, directly before the primitive. */
export function consumeSiloNativeTransferTicket(ticket,info,encoded){
 assertSiloNativeTransferAccepted();const cap=tickets.get(ticket);if(!cap||cap.used)throw Error('One-use native transfer capability required.');cap.used=true;cap.guard();
 const r=cap.review;if(typeof location==='undefined'||location.origin!==SILO_TRANSFER_RELEASE_ORIGIN||info?.chain!=='solana'||info.network!=='mainnet'||info.address!==r.terms.owner||info.identity!==cap.identity||encoded!==cap.wire||encoded!==r.transactionBase64||JSON.stringify(r)!==cap.snapshot)throw Error('Native transfer identity or exact message differs.');
 validateSiloSealedTransferReview(r);const tx=VersionedTransaction.deserialize(Buffer.from(encoded,'base64'));if(!Buffer.from(tx.message.serialize()).equals(Buffer.from(validateSiloSealedTransferReview(r).tx.message.serialize())))throw Error('Native transfer message differs.');
 const account=consumeSiloTransferAccountAdmission(cap.admission,{wire:encoded,owner:r.terms.owner,network:r.terms.network});
 const guard=()=>{assertSiloNativeTransferAccepted();cap.guard();account();if(typeof location==='undefined'||location.origin!==SILO_TRANSFER_RELEASE_ORIGIN||JSON.stringify(r)!==cap.snapshot)throw Error('Native transfer capability changed.');};guard();return guard;
}

/** @param {any} row @param {{signal?:AbortSignal,assertCurrent?:()=>void}} options */
export async function verifySiloTransferBeforeSubmission(row,{signal,assertCurrent=()=>{}}={}){
 assertSiloNativeTransferAccepted();assertCurrent();if(row?.version!==2||row.state!=='signed'||row.submissionApproved!==true)throw Error('Legacy or unapproved transfer is reconciliation-only.');validateSiloSealedTransferReview(row.serverReview);verified(row.serverReview,await request('verify',row.serverReview,{signal,assertCurrent}));assertCurrent();
}
/** @param {any} row @param {{signal?:AbortSignal,assertCurrent?:()=>void}} options */
export async function submitSiloReviewedTransfer(row,{signal,assertCurrent=()=>{}}={}){
 assertSiloNativeTransferAccepted();assertCurrent();if(row?.version!==2||row.state!=='signed'||row.submissionApproved!==true)throw Error('Original reviewed transfer required.');validateSiloSealedTransferReview(row.serverReview);const snapshot=JSON.stringify(row);const current=()=>{assertCurrent();if(JSON.stringify(row)!==snapshot)throw Error('Saved transfer changed before dispatch.');};
 const result=await request('submit',row,{signal,assertCurrent:current});current();if(result?.status!=='unknown'||result.signature!==row.signature||result.forwarded!==true||typeof result.acknowledged!=='boolean')throw Error('Submission outcome is unknown. Keep the exact payment.');return result;
}
