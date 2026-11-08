// SPDX-License-Identifier: AGPL-3.0-only
import {siloJson} from './bounded-json.mjs';
import {siloNodeUrl} from './disclosures.mjs';
import {assertSiloXmrNodeNetwork} from './xmr-node-network.mjs';
import {siloAmount} from './amounts.mjs';
import {siloXmrAvailableInputCount,siloXmrUnsignedFeeModel} from './xmr-unsigned-fee.mjs';
/** Only local SDK reads and generic daemon network/fork/fee reads. Recipient,
 * amount, outputs and keys are not included in the requests this module makes. No signing method,
 * transfer builder, reservation or journal write is accepted here.
 */
export function createSiloXmrUnsignedFeeEstimator({node,network,readLocal,validateRecipient,fetcher=fetch,now=Date.now,monotonic=()=>performance.now()}){
 const uri=siloNodeUrl(node);if(!['mainnet','stagenet'].includes(network)||typeof readLocal!=='function'||typeof validateRecipient!=='function')throw Error('Unsigned estimate configuration unavailable.');
 let sample=null;
 return async({address,amount,signal})=>{
  if(typeof address!=='string'||address.length>128||address.trim()!==address||typeof amount!=='string')throw Error('Unsigned estimate input unavailable.');
  siloAmount(amount,12);const started=monotonic();
  const guard=()=>{if(signal?.aborted||monotonic()-started>=8000)throw Error('Unsigned estimate stopped.');};
  // An SDK worker can ignore cancellation or never settle. Bound the await
  // itself, not merely a guard after it returns; discard all late results.
  const bounded=task=>new Promise((resolve,reject)=>{
   try{guard();}catch(error){reject(error);return;}
   let settled=false;const remaining=Math.max(1,Math.ceil(8000-(monotonic()-started)));
   const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(!error)try{guard();}catch(failure){error=failure;}if(error)reject(error);else resolve(value);};
   const abort=()=>finish(Error('Unsigned estimate stopped.'));
   const timer=setTimeout(abort,remaining);signal?.addEventListener('abort',abort,{once:true});
   if(signal?.aborted){abort();return;}
   try{Promise.resolve(task()).then(value=>finish(null,value),error=>finish(error));}catch(error){finish(error);}
  });
  guard();await bounded(()=>validateRecipient(address));const local=await bounded(()=>readLocal({signal,check:guard}));guard();
  if(local?.synced!==true)throw Error('Sync before checking the fee estimate.');
  const inputCount=siloXmrAvailableInputCount(local.outputs),priority=local.priority;
  if(!Number.isInteger(priority)||priority<0||priority>4)throw Error('Wallet fee priority unavailable.');
  const time=now(),tick=monotonic();
  if(!sample||time<sample.checkedAt||time-sample.checkedAt>=30000||tick<sample.tick||tick-sample.tick>=30000){
   const request=async(method)=>{
    guard();const remaining=Math.min(5000,Math.floor(8000-(monotonic()-started)));if(remaining<1)throw Error('Unsigned estimate stopped.');
    const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(remaining)]):AbortSignal.timeout(remaining);
    const options={cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:combined};
    const response=await bounded(()=>method==='get_info'?fetcher(uri+'/get_info',options):fetcher(uri+'/json_rpc',{...options,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'silo-unsigned-fee',method,params:method==='get_fee_estimate'?{grace_blocks:10}:{}})}));
    if(!response.ok){
     // Cleanup must not become an unbounded await on a failing peer/stream.
     try{void response.body?.cancel().catch(()=>{});}catch{/* Refuse the response regardless of cleanup. */}
     throw Error('Node fee data unavailable.');
    }
    const value=await bounded(()=>siloJson(response,16384));guard();
    if(method==='get_info')return value;
    if(value?.jsonrpc!=='2.0'||value.id!=='silo-unsigned-fee'||value.error||!value.result)throw Error('Node fee data unavailable.');
    return value.result;
   };
   const info=await request('get_info');
   // Network identity by the shared rule (flags and nettype), then this reader's own sync and trust requirements.
   try{assertSiloXmrNodeNetwork(info,network);}catch{throw Error('Synced selected Monero network unavailable.');}
   if(info.status!=='OK'||info.untrusted!==false||info.synchronized!==true)throw Error('Synced selected Monero network unavailable.');
   const fork=await request('hard_fork_info');if(fork.status!=='OK'||fork.version!==16||fork.enabled!==true||fork.untrusted!==false)throw Error('Node fee model unsupported.');
   const fees=await request('get_fee_estimate');const checkedAt=now();guard();
   // Validate the response before retaining only the nonsecret rate sample.
   siloXmrUnsignedFeeModel({inputCount,priority,feeEstimate:fees,hardFork:16,checkedAt,now:checkedAt});
   sample={checkedAt,tick:monotonic(),fees:{status:fees.status,untrusted:fees.untrusted,fees:fees.fees.slice(),quantization_mask:fees.quantization_mask}};
  }
  guard();return siloXmrUnsignedFeeModel({inputCount,priority,feeEstimate:sample.fees,hardFork:16,checkedAt:sample.checkedAt,now:now()});
 };
}
