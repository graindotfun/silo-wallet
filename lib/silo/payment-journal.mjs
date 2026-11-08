// SPDX-License-Identifier: AGPL-3.0-only
import {transactionConsent} from './amounts.mjs';
/** Pending signed payments are encrypted with the wallet before the first network submission.
 * A failed/ambiguous broadcast never enables a replacement payment or discards its journal.
 * A fresh locally scanned, sufficiently confirmed payment clears the hold. An adapter reports 'failed'
 * only when the old payment provably can never be included (ZEC: expired beyond the reorg limit); that
 * state is recorded and an explicit release re-checks it. 'reported-failed' is informational (for
 * example a Monero wallet flag) and changes nothing: the hold stays and the same bytes may be resent.
 * A submission identifier alone never clears anything. */
export function paymentJournal(cached=null){
 let pending=cached,busy=false,revision=0;
 const exclusive=async action=>{if(busy)throw Error('Payment operation already in progress.');busy=true;try{return await action();}finally{busy=false;}};
 return {
  snapshot:()=>pending,
  // Resolves 'confirmed', 'failed', 'reported-failed' or false. Only 'confirmed' clears; 'failed' is persisted for release.
  reconcile:(check,persist)=>exclusive(async()=>{
   if(!pending)return false;const current=pending,outcome=await check(current);if(pending!==current)throw Error('Payment journal changed.');
   if(outcome===true){pending=null;try{await persist();revision++;return 'confirmed';}catch(error){pending=current;throw error;}}
   if(outcome==='failed'){if(current.status!=='failed'){pending={...current,status:'failed'};try{await persist();}catch(error){pending=current;throw error;}}return 'failed';}
   return outcome==='reported-failed'?'reported-failed':false;
  }),
  release:(check,persist)=>exclusive(async()=>{
   const current=pending;if(!current||current.status!=='failed'||await check(current)!=='failed')throw Error('Only a payment that provably cannot be included any more can be released.');
   if(pending!==current)throw Error('Payment journal changed.');pending=null;try{await persist();revision++;return true;}catch(error){pending=current;throw error;}
  }),
  // A cancelling payment (XMR: one of this payment's own inputs sent back to the wallet) is recorded once, before it is relayed,
  // so a retry relays the same bytes. It never clears the hold: only a later 'failed' proof and an explicit release do.
  attachConflict:(conflict,persist)=>exclusive(async()=>{
   const current=pending;if(!current||current.status==='failed')throw Error('No unconfirmed payment to cancel.');
   if(current.conflict){if(current.conflict.hash!==conflict?.hash)throw Error('A cancelling payment is already recorded.');return current.conflict;}
   if(!/^[a-f0-9]{64}$/.test(conflict?.hash??'')||typeof conflict.metadata!=='string'||!conflict.metadata||!/^[a-f0-9]{64}$/.test(conflict.keyImage??''))throw Error('Invalid cancelling payment.');
   pending={...current,conflict:Object.freeze({hash:conflict.hash,metadata:conflict.metadata,keyImage:conflict.keyImage})};
   try{await persist();return pending.conflict;}catch(error){pending=current;throw error;}
  }),
  assertClear:()=>{if(pending)throw Error('A payment needs confirmation reconciliation before a replacement.');},
  draft:(review,authorize,broadcast,restored=false)=>{
   const frozen=Object.freeze({...review}),consent=transactionConsent(frozen);const draftRevision=revision;let cancelled=false,inFlight=false;
   if(restored&&(!pending||pending.consent!==consent))throw Error('Invalid pending payment review.');
   return {review:frozen,consent,get attempted(){return Boolean(pending);},get failed(){return pending?.status==='failed';},get returnedIdentifier(){const value=draftRevision===revision&&pending?.consent===consent?pending.receipt:null;return typeof value==='string'&&value.trim().length>0&&value.length<=4096&&!/[\u0000-\u001f\u007f-\u009f]/.test(value)?value:null;},get submissionEvidence(){const value=draftRevision===revision&&pending?.consent===consent?pending.receipt:null;return Object.freeze({attempted:Boolean(draftRevision===revision&&pending?.consent===consent),returnedIdentifier:typeof value==='string'&&value.trim().length>0&&value.length<=4096&&!/[\u0000-\u001f\u007f-\u009f]/.test(value)?value:null});},submit:async(confirmation,persist)=>{
    if(draftRevision!==revision)throw Error('This payment review has already been reconciled or released. Prepare a new review.');
    if(cancelled||inFlight||busy||confirmation!==consent||typeof persist!=='function')throw Error('Explicit review and durable encrypted backup required.');
    if(pending?.status==='failed')throw Error('The scanned wallet reports this payment failed. Release it instead of retrying.');
    inFlight=true;busy=true;
    try{
     if(!pending)pending={review:frozen,consent,authorized:await authorize(),status:'unconfirmed'};
     if(pending.consent!==consent)throw Error('Pending payment differs from this review.');
     await persist(); // Storage failure prevents broadcast. A retry reuses these exact authorized bytes.
     const receipt=await broadcast(pending.authorized);
     pending={...pending,receipt,status:'submitted-unconfirmed'};await persist();return receipt;
    }finally{inFlight=false;busy=false;}
   },cancel:()=>{if(pending||inFlight)throw Error('Pending payment cannot be discarded before confirmation reconciliation.');cancelled=true;}};
  },
 };
}
