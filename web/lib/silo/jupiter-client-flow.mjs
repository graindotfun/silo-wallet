/** Client orchestration only. No signing implementation or provider endpoint is invented here. */
import {siloJson} from './bounded-json.mjs';
import {sessionRpcFetch} from '../browser-rpc-session.mjs';
import {siloSwapRefused} from './swap-refusal.mjs';
const MAINNET='solana:mainnet-beta';
const approvals=new WeakMap();
export function createSiloJupiterConsent(review){const token=Object.freeze({network:MAINNET,owner:review.terms?.owner});approvals.set(token,{review,snapshot:JSON.stringify(review)});return token;}
export function createSiloJupiterClientFlow({store,fetcher=sessionRpcFetch,now=Date.now}){
 let dispatched=false; // these exact signed bytes were handed to the transport by this instance (round 10)
 async function post(action,body){const response=await fetcher(`/api/silo/swap/${action}`,{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const result=await siloJson(response,131072);if(response.status===409&&result?.status==='refused')throw Object.assign(Error(typeof result.error==='string'?result.error:'Refused by the beta rules.'),{siloBetaRefusal:true,preDispatchRefusal:true,code:result.refusal});if(!response.ok)throw Error('Swap service is unavailable or held. Nothing new was sent.');return result;}
 return {
  cancelUnprompted:()=>store.cancelUnprompted(),
  recoverSigning:async()=>{const row=await store.read();if(row?.kind!=='silo-jupiter-signing-v1'||row.promptStarted!==true||row.network!=='mainnet-beta')throw Error('An existing unresolved wallet prompt is required.');return store.recoverSigning(async saved=>{const result=await post('recover',{reservation:saved});if(!['found','unknown'].includes(result.status))throw Error('Recovery lookup returned an unsupported result.');return result;});},
  prepare:async terms=>{if(await store.read())throw Error('Resolve the saved swap before preparing another.');if(terms.network!==MAINNET)throw Error('Jupiter execution is mainnet only.');return post('order',terms);},
  approve:async(review,{consent,sign,assertCurrent=()=>{}})=>{
   const approved=consent&&approvals.get(consent);
   if(!approved||approved.review!==review||approved.snapshot!==JSON.stringify(review)||consent.network!==MAINNET||consent.owner!==review.terms?.owner||!Number.isSafeInteger(review.expiresAt)||now()>review.expiresAt)throw Error('Approve the exact current mainnet review first.');
   const guard=()=>{assertCurrent();if(JSON.stringify(review)!==approved.snapshot)throw Error('Approved swap review changed.');};
   return store.reserveAndSign(review,async(markPrompt,captureSigned)=>{guard();const row=await sign(review,guard,()=>{guard();const marked=markPrompt();if(marked&&typeof marked.then==='function')return marked.then(()=>guard());guard();},captureSigned);guard();return row;});
  },
  execute:async()=>{const row=await store.read();if(!['silo-jupiter-signed-v1','silo-jupiter-build-signed-v1'].includes(row?.kind))throw Error('No durable signed swap is available.');if(row.submissionApproved===false)throw Error('Signed recovery is saved, but submission checks did not finish. Check outcome only.');const earlierSubmission=dispatched;try{dispatched=true;const result=await post('execute',row);if(result.signature!==row.signature)return {status:'unknown',signature:row.signature};return result;}catch(error){if(error?.preDispatchRefusal===true){dispatched=earlierSubmission;/* a typed refusal means these bytes did not leave in this attempt */return siloSwapRefused(row,error,{phase:'submission',earlierSubmission});}/* refused before any bytes left (rounds 9–10), including a refused session renewal: the signed swap stays */return {status:'unknown',signature:row.signature};}},
  outcome:async()=>{const row=await store.read();if(!['silo-jupiter-signed-v1','silo-jupiter-build-signed-v1'].includes(row?.kind))return {status:row?'held-signing':'empty'};return store.reconcileRemote(async saved=>post('outcome',saved));},
 };
}
