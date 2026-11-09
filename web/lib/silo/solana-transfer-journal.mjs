import {validateSiloSealedTransferReview} from './solana-transfer-review-contract.mjs';
import {exactRecoveredWire} from './positive-history-recovery.mjs';
import {VersionedTransaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import {inspectSiloTransfer,signSiloTransfer,SILO_SOLANA_GENESIS} from './solana-transfer.mjs';
export const SILO_TRANSFER_JOURNAL_KEY='grain-silo-solana-pending-v1';
export const SILO_TRANSFER_JOURNAL_MAX_BYTES=4096;
const LEGACY_MAX_BYTES=4096;
const byteLength=text=>new TextEncoder().encode(text).length;
function persist(storage,row){const text=JSON.stringify(row);if(byteLength(text)>SILO_TRANSFER_JOURNAL_MAX_BYTES)throw Error('Transfer recovery record exceeds its bound.');storage.setItem(SILO_TRANSFER_JOURNAL_KEY,text);if(storage.getItem(SILO_TRANSFER_JOURNAL_KEY)!==text)throw Error('Transfer could not be saved. Nothing was sent.');return row;}
function validate(row){
 if(!row||![1,2].includes(row.version)||!Number.isSafeInteger(row.lastValidBlockHeight)||row.lastValidBlockHeight<1||!Number.isSafeInteger(row.createdAt)||row.createdAt<0||typeof row.wire!=='string'||row.wire.length>1644)throw Error('Transfer recovery record is invalid; new payments are held.');
 const bytes=Buffer.from(row.wire,'base64');if(bytes.toString('base64')!==row.wire)throw Error('Invalid saved transfer encoding.');
 if(row.state!==undefined&&!['signed','signing'].includes(row.state)||row.submissionApproved!==undefined&&typeof row.submissionApproved!=='boolean')throw Error('Saved transfer state differs.');
 if(row.version===1){if(byteLength(JSON.stringify(row))>LEGACY_MAX_BYTES||row.serverReview!==undefined)throw Error('Legacy transfer recovery bound differs.');}
 else{validateSiloSealedTransferReview(row.serverReview);const original=VersionedTransaction.deserialize(Buffer.from(row.serverReview.transactionBase64,'base64'));if(row.network!==row.serverReview.terms.network||row.owner!==row.serverReview.terms.owner||row.lastValidBlockHeight!==row.serverReview.lastValidBlockHeight||!Buffer.from(original.message.serialize()).equals(Buffer.from(VersionedTransaction.deserialize(bytes).message.serialize())))throw Error('Original server transfer review differs.');}
 const reserved=row.state==='signing';const checked=inspectSiloTransfer(VersionedTransaction.deserialize(bytes),{network:row.network,signed:!reserved});
 if(checked.terms.owner!==row.owner||(reserved?(row.signature!==undefined&&row.signature!==null||typeof row.promptStarted!=='boolean'||row.submissionApproved!==false):checked.signature!==row.signature))throw Error('Saved transfer identity differs.');
 return {...row,wire:row.wire};
}
export function readSiloTransferJournal(storage){const text=storage.getItem(SILO_TRANSFER_JOURNAL_KEY);if(text===null)return null;if(byteLength(text)>SILO_TRANSFER_JOURNAL_MAX_BYTES)throw Error('Transfer recovery record exceeds its bound.');let row;try{row=JSON.parse(text);}catch{throw Error('Transfer recovery record is invalid; new payments are held.');}return validate(row);}
export function saveSiloTransferJournal(storage,signed,now=Date.now()){
 if(readSiloTransferJournal(storage))throw Error('Resolve the saved transfer before creating another payment.');
 const row=validate({version:1,network:signed.terms.network,owner:signed.terms.owner,signature:signed.signature,wire:Buffer.from(signed.wire).toString('base64'),lastValidBlockHeight:signed.lastValidBlockHeight,createdAt:now});
 return persist(storage,row);
}
/** Caller holds the exclusive origin payment lock across the complete operation.
 * No unsafe tab-lock fallback exists in the UI. Legacy signed journals remain readable. */
export function cancelUnpromptedSiloTransfer(storage,{network}={}){
 const row=readSiloTransferJournal(storage);if(row?.state!=='signing'||row.promptStarted!==false||row.network!==network)throw Error('A wallet prompt may have started; this recovery hold cannot be cancelled.');
 storage.removeItem(SILO_TRANSFER_JOURNAL_KEY);if(storage.getItem(SILO_TRANSFER_JOURNAL_KEY)!==null)throw Error('Unsigned reservation could not be cleared.');return {state:'cancelled-before-wallet'};
}
export function assertSiloTransferSubmission(row){validate(row);if(row.state==='signing'||row.submissionApproved===false)throw Error('Submission checks did not finish. Check the saved outcome; no retry is approved.');}
/** Reserve durably before a wallet prompt and capture exact returned signed bytes immediately.
 * Later checks may approve submission, but never erase a returned valid signature on failure.
 * The caller must hold navigator.locks ownership until this promise finishes. */
/** Optional account-sync hooks (signing-gate.mjs): `beforeWalletPrompt` runs after the reservation is saved and before it is
 * marked prompted (a failure cancels the unprompted reservation as before); `afterCapture` runs after the exact signed bytes
 * are saved (a failure holds submission as before). Neither can change the transfer, its costs or the wallet request.
 * @param {any} review @param {any} options */
export async function signSiloTransferDurably(review,{storage,wallet,connection,now=Date.now,assertCurrent=()=>{},beforeWalletPrompt:accountPrompt=async()=>{},assertPrompt:accountAssertPrompt=()=>{},afterCapture=async()=>{}}={}){
 if(readSiloTransferJournal(storage))throw Error('Resolve the saved transfer before creating another payment.');
 const snapshot=JSON.parse(JSON.stringify(review));const original=VersionedTransaction.deserialize(Buffer.from(snapshot.transactionBase64,'base64')),checked=inspectSiloTransfer(original,{network:snapshot.terms.network});
 if(JSON.stringify(checked.terms)!==JSON.stringify(snapshot.terms))throw Error('Transfer reservation terms differ.');
 const reviewIdentity=snapshot.protocol==='silo-native-transfer-review-v1'?{version:2,serverReview:structuredClone(snapshot)}:{version:1};
 if(reviewIdentity.version===2)validateSiloSealedTransferReview(snapshot);
 const candidate={...reviewIdentity,state:'signed',network:checked.terms.network,owner:checked.terms.owner,signature:'1'.repeat(88),wire:snapshot.transactionBase64,lastValidBlockHeight:snapshot.lastValidBlockHeight,createdAt:Number.MAX_SAFE_INTEGER,submissionApproved:false};
 if(byteLength(JSON.stringify(candidate))>SILO_TRANSFER_JOURNAL_MAX_BYTES)throw Error('Transfer cannot fit durable recovery storage. Nothing was signed.');
 let reserved=validate({...reviewIdentity,state:'signing',network:checked.terms.network,owner:checked.terms.owner,wire:snapshot.transactionBase64,lastValidBlockHeight:snapshot.lastValidBlockHeight,createdAt:now(),promptStarted:false,submissionApproved:false}),captured=null;
 persist(storage,reserved);
 const guard=()=>{assertCurrent();if(JSON.stringify(review)!==JSON.stringify(snapshot))throw Error('Transfer review changed.');};
 const matches=row=>JSON.stringify(readSiloTransferJournal(storage))===JSON.stringify(row);
 try{
  const signed=await signSiloTransfer(review,{wallet,connection,now,assertCurrent:guard,assertPrompt:()=>{guard();if(!reserved.promptStarted||!matches(reserved))throw Error('Exact local transfer prompt permission required.');const result=accountAssertPrompt();guard();if(!matches(reserved))throw Error('Exact local transfer prompt permission changed.');return result;},beforeWalletPrompt:async()=>{guard();if(!matches(reserved))throw Error('Transfer reservation changed before wallet prompt.');await accountPrompt();guard();if(!matches(reserved))throw Error('Transfer reservation changed before wallet prompt.');reserved={...reserved,promptStarted:true};persist(storage,reserved);},captureSigned:async payment=>{
   if(!reserved.promptStarted||!matches(captured??reserved))throw Error('Transfer capture reservation differs.');
   const wire=Buffer.from(payment.wire).toString('base64'),tx=VersionedTransaction.deserialize(Buffer.from(payment.wire));
   if(!Buffer.from(original.message.serialize()).equals(Buffer.from(tx.message.serialize())))throw Error('Signed transfer message differs.');
   const row=validate({...reviewIdentity,state:'signed',network:checked.terms.network,owner:checked.terms.owner,signature:payment.signature,wire,lastValidBlockHeight:snapshot.lastValidBlockHeight,createdAt:reserved.createdAt,submissionApproved:false});persist(storage,row);captured=row;
   await afterCapture(row);
  }});
  guard();if(!captured||!matches(captured)||captured.wire!==Buffer.from(signed.wire).toString('base64')||captured.signature!==signed.signature)throw Error('Captured signed payment changed. Submission remains held.');
  return persist(storage,{...captured,submissionApproved:true});
 }catch(error){if(!reserved.promptStarted&&matches(reserved))cancelUnpromptedSiloTransfer(storage,{network:reserved.network});throw error;}
}
function transferReceipt(row,receipt){
 const saved=VersionedTransaction.deserialize(Buffer.from(row.wire,'base64'));
 if(!receipt||!Number.isSafeInteger(receipt.slot)||receipt.slot<1||!receipt.meta||!Object.hasOwn(receipt.meta,'err')||receipt.meta.err!==null&&(typeof receipt.meta.err!=='object'||Array.isArray(receipt.meta.err))||!Number.isSafeInteger(receipt.meta.fee)||receipt.meta.fee<0||!Array.isArray(receipt.transaction?.signatures)||receipt.transaction.signatures.length!==1||receipt.transaction.signatures[0]!==row.signature||typeof receipt.transaction?.message?.serialize!=='function'||!Buffer.from(receipt.transaction.message.serialize()).equals(Buffer.from(saved.message.serialize())))throw Error('Finalized transfer receipt differs from the saved signed payment.');
 return {state:receipt.meta.err!==null?'failed':'finalized',signature:row.signature,slot:receipt.slot,networkFeeRaw:String(receipt.meta.fee)};
}
/** Caller holds the exclusive origin payment lock. Reads use the verified primary only. */
/** `network` is the network the page selected, not the record's own label: the label is not covered by the signature (audit phase B,
 * FA-03). A record labelled for another network is held, never reconciled or cleared against this connection. */
export async function reconcileSiloTransferJournal(storage,connection,{network,beforeRetire}={}){
 const row=readSiloTransferJournal(storage);if(!row)return {state:'empty'};
 if(!Object.hasOwn(SILO_SOLANA_GENESIS,network??''))throw Error('Select the network to check the saved payment on.');
 if(row.network!==network)return {state:'held-other-network',signature:row.signature,row};
 if(row.state==='signing')return {state:'held-signing',row};
 const identity=JSON.stringify(row),same=()=>{if(JSON.stringify(readSiloTransferJournal(storage))!==identity)throw Error('Recovery record changed.');};
 const clear=async result=>{same();if(beforeRetire!==undefined){if(typeof beforeRetire!=='function')throw Error('Account retirement verifier required.');const guard=await beforeRetire(structuredClone(row),structuredClone(result));same();if(typeof guard!=='function')throw Error('Immediate account retirement guard required.');const allowed=guard();if(allowed===false||allowed?.then)throw Error('Synchronous account retirement guard required.');same();}storage.removeItem(SILO_TRANSFER_JOURNAL_KEY);if(storage.getItem(SILO_TRANSFER_JOURNAL_KEY)!==null)throw Error('Recovery record could not be cleared.');};
 if(await connection.getGenesisHash()!==SILO_SOLANA_GENESIS[row.network])throw Error('Recovery network differs.');
 const response=await connection.getSignatureStatuses([row.signature],{searchTransactionHistory:true});
 if(!Array.isArray(response?.value)||response.value.length!==1||response.value[0]===undefined)throw Error('Historical status unavailable.');
 const status=response.value[0];
 if(status!==null&&(typeof status!=='object'||!Number.isSafeInteger(status.slot)||status.slot<0||!Object.hasOwn(status,'err')||!['processed','confirmed','finalized'].includes(status.confirmationStatus)))throw Error('Historical status unavailable.');
 if(status?.confirmationStatus==='finalized'){const receipt=await connection.getTransaction(row.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(receipt===null)return {state:'unknown',signature:row.signature,row};const result=transferReceipt(row,receipt);if(receipt.slot!==status.slot||(status.err!==null)!==(receipt.meta.err!==null))throw Error('Finalized transfer status and receipt differ.');await clear(result);return result;}
 if(status!==null)return {state:status.err?'failed-awaiting-finality':'pending',signature:row.signature,row};
 const height=await connection.getBlockHeight('finalized');
 if(!Number.isSafeInteger(height)||height<=row.lastValidBlockHeight)return {state:'unknown',signature:row.signature,row};
 const saved=inspectSiloTransfer(VersionedTransaction.deserialize(Buffer.from(row.wire,'base64')),{network:row.network,signed:true});
 const valid=await connection.isBlockhashValid(saved.blockhash,{commitment:'finalized'});
 if(valid?.value!==false)return {state:'unknown',signature:row.signature,row};
 const transaction=await connection.getTransaction(row.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
 if(transaction!==null){const result=transferReceipt(row,transaction);await clear(result);return result;}
 const second=await connection.getSignatureStatuses([row.signature],{searchTransactionHistory:true});
 if(!Array.isArray(second?.value)||second.value.length!==1)throw Error('Historical status unavailable.');
 if(second.value[0]!==null)return {state:'pending',signature:row.signature,row};
 // RPC history can be pruned independently of blockhash validity. Keep the exact signed payment
 // until finalized inclusion/failure or an independently reviewed complete absence proof exists.
 return {state:'unknown',signature:row.signature,row,blockhashExpired:true};
}

/** Caller holds the native payment lock. Positive found bytes are reconciliation-only. */
export async function recoverSiloTransferSigning(storage,check,{network}={}){
 const row=readSiloTransferJournal(storage);if(row?.state!=='signing'||row.promptStarted!==true||row.network!==network)return {status:'unknown',reason:'reservation-not-recoverable'};
 const original=JSON.stringify(row),result=await check(row);if(result?.status!=='found')return result;
 const signature=exactRecoveredWire(row.wire,result.signedTransaction,row.owner);if(signature!==result.signature||!Number.isSafeInteger(result.slot)||result.slot<1||!['finalized','failed'].includes(result.transactionStatus))throw Error('Recovered proof differs.');
 if(JSON.stringify(readSiloTransferJournal(storage))!==original)throw Error('Reservation changed during recovery.');
 const adopted=validate({...row,state:'signed',signature,wire:result.signedTransaction,submissionApproved:false});persist(storage,adopted);return {...result,status:'adopted',journal:adopted};
}
