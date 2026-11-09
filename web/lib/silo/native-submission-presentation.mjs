/** Display facts only. This never reconciles/releases a journal or requests a network action.
 * An identifier is a historical return value, not node-seen or block evidence. */
/** @param {{attempted?:boolean,returnedIdentifier?:string|null,failed?:boolean,submissionEvidence?:{attempted:boolean,returnedIdentifier:string|null}}|null} draft
 * @param {{fresh?:boolean,status?:{confirmations:number|null,target:number,status:string}|null}} options */
export function siloNativeSubmissionPresentation(draft,{fresh=false,status=null}={}){
 const evidence=draft?.submissionEvidence;
 const attempted=evidence!==undefined?evidence?.attempted===true:draft?.attempted===true;
 const returned=evidence!==undefined?evidence?.returnedIdentifier:draft?.returnedIdentifier;
 const identifier=attempted&&typeof returned==='string'&&returned.trim().length>0&&returned.length<=4096&&!/[\u0000-\u001f\u007f-\u009f]/.test(returned)?returned:null;
 const checked=attempted&&fresh===true&&draft?.failed!==true&&Boolean(status&&['pending','confirmed'].includes(status.status)&&Number.isSafeInteger(status.target)&&status.target>=1&&status.target<=100&&Number.isSafeInteger(status.confirmations)&&status.confirmations>=0);
 const confirmations=checked?Math.min(status.confirmations,status.target):null;
 const inclusion=checked&&confirmations>0;
 const fullyConfirmed=inclusion&&status.status==='confirmed'&&confirmations>=status.target;
 const title=fullyConfirmed?'Local confirmation target reached':inclusion?'Included in a block · still confirming':identifier?'Submission returned an identifier':attempted?'Payment outcome unknown':'Review before sending';
 const text=identifier?'Submission returned an identifier. Block inclusion is not checked yet. The payment remains held.':attempted?'A signed payment attempt is retained. No returned identifier was captured; its outcome is unknown. The payment remains held.':'Review the recipient, amount, network and fee before sending.';
 return Object.freeze({identifier,attempted,confirmations,target:checked?status.target:null,checkedInclusion:inclusion,fullyConfirmed,title,text:inclusion?`A fresh local scan reports ${confirmations}/${status.target} confirmations. ${fullyConfirmed?'The local confirmation target was reached.':'The payment remains held while confirmations accumulate.'}`:text,confirmationLabel:inclusion?(fullyConfirmed?'Local confirmation target reached':'Included in a block · waiting for confirmations'):status?.status==='reported-failed'?'Reported failed · outcome unresolved':'Block inclusion not checked'});
}
