import {bindSiloHistoricalJupiterTerms} from './jupiter-historical-terms.mjs';
import {SILO_SWAP_FEE_BPS} from './swap-policy.mjs';
/** Separate bounded swap journal. Signed bytes are origin-readable, matching the existing
 * external-wallet send journal model. UI must explicitly accept/document this privacy policy
 * before constructing the store; no password or encryption policy is silently invented. */
import {decodeSiloJupiterTransaction,siloJupiterExecutionTerms} from './jupiter-execution.mjs';
import {checkSiloJupiterOutcome} from './jupiter-execution-service.mjs';
import {SILO_JUPITER_BODY_MAX_BYTES,siloJupiterSerializedBytes} from './jupiter-bounds.mjs';
import {exactRecoveredWire} from './positive-history-recovery.mjs';
import {Buffer} from 'buffer';import bs58 from 'bs58';import {sha256} from '@noble/hashes/sha256';
export const SILO_JUPITER_JOURNAL_KEY='grain-silo-jupiter-pending-v1';
const MAX=SILO_JUPITER_BODY_MAX_BYTES;
function reservation(review){
 const terms=siloJupiterExecutionTerms(review?.terms);
 const build=review.executionMode==='no-collection-build';const possible={kind:build?'silo-jupiter-build-signed-v1':'silo-jupiter-signed-v1',...(build?{packet:review.packet,executionMode:'no-collection-build'}:{}),network:'mainnet-beta',owner:terms.owner,requestId:review.requestId,signedTransaction:review.transactionBase64,signature:'1'.repeat(88),blockhash:decodeSiloJupiterTransaction(review.transactionBase64).message.recentBlockhash,lastValidBlockHeight:review.lastValidBlockHeight,messageHash:review.messageHash,createdAt:Number.MAX_SAFE_INTEGER,terms,order:review.order,submissionApproved:false};
 if(siloJupiterSerializedBytes(possible)>MAX)throw Error('Swap packet cannot fit the API and durable recovery budget. Nothing was signed.');
 if(typeof review.messageHash!=='string'||!/^([a-f0-9]{64})$/.test(review.messageHash)||!Number.isSafeInteger(review.expiresAt)||typeof review.requestId!=='string')throw Error('Invalid swap signing reservation.');
 const transaction=decodeSiloJupiterTransaction(review.transactionBase64);if(String(transaction.message.staticAccountKeys[0])!==terms.owner||Buffer.from(sha256(transaction.message.serialize())).toString('hex')!==review.messageHash)throw Error('Reservation transaction differs.');
 return {kind:'silo-jupiter-signing-v1',network:'mainnet-beta',owner:terms.owner,terms,messageHash:review.messageHash,requestId:review.requestId,transactionBase64:review.transactionBase64,blockhash:transaction.message.recentBlockhash,lastValidBlockHeight:review.lastValidBlockHeight,promptStarted:false,createdAt:Date.now(),recoveryContext:{order:review.order,...(build?{packet:review.packet,executionMode:'no-collection-build'}:{})}};
}
function validateRecord(row){if(row?.kind==='silo-jupiter-signing-v1'){siloJupiterExecutionTerms(row.terms);if(row.network!=='mainnet-beta'||row.owner!==row.terms.owner||!Number.isSafeInteger(row.createdAt)||typeof row.requestId!=='string'||!/^([a-f0-9]{64})$/.test(row.messageHash))throw Error('Invalid swap signing reservation.');const tx=decodeSiloJupiterTransaction(row.transactionBase64);if(String(tx.message.staticAccountKeys[0])!==row.owner||row.blockhash!==tx.message.recentBlockhash||Buffer.from(sha256(tx.message.serialize())).toString('hex')!==row.messageHash||(!Number.isSafeInteger(row.lastValidBlockHeight)||row.lastValidBlockHeight<1)||typeof row.promptStarted!=='boolean')throw Error('Reservation recovery identity differs.');if(row.recoveryContext){const order=row.recoveryContext.order,original=decodeSiloJupiterTransaction(order?.transaction);if(order.requestId!==row.requestId||!Buffer.from(original.message.serialize()).equals(Buffer.from(tx.message.serialize())))throw Error('Reservation context differs.');bindSiloHistoricalJupiterTerms(tx,order,row.terms,{feeBps:row.recoveryContext.executionMode==='no-collection-build'?0:SILO_SWAP_FEE_BPS});if(row.recoveryContext.executionMode==='no-collection-build'&&(!row.recoveryContext.packet||order.feeBps!==0))throw Error('Reservation build context differs.');}return row;}return validate(row);}
function save(storage,row){const text=JSON.stringify(row);if(new TextEncoder().encode(text).length>MAX)throw Error('Swap recovery record exceeds bound.');storage.setItem(SILO_JUPITER_JOURNAL_KEY,text);if(storage.getItem(SILO_JUPITER_JOURNAL_KEY)!==text)throw Error('Swap could not be saved. Nothing was sent.');}

function validate(row){
 if(!row||!['silo-jupiter-signed-v1','silo-jupiter-build-signed-v1'].includes(row.kind)||row.network!=='mainnet-beta'||!Number.isSafeInteger(row.createdAt)||row.createdAt<0||!Number.isSafeInteger(row.lastValidBlockHeight)||row.lastValidBlockHeight<1)throw Error('Swap recovery record invalid; new swaps are held.');
 if(row.kind==='silo-jupiter-build-signed-v1'&&(!row.packet||row.executionMode!=='no-collection-build'||row.order?.feeBps!==0))throw Error('No-collection recovery identity differs.');
 const terms=siloJupiterExecutionTerms(row.terms),tx=decodeSiloJupiterTransaction(row.signedTransaction,{signed:true}),original=decodeSiloJupiterTransaction(row.order?.transaction);
 if(row.owner!==terms.owner||row.owner!==String(tx.message.staticAccountKeys[0])||row.signature!==bs58.encode(tx.signatures[0])||row.blockhash!==tx.message.recentBlockhash||row.messageHash!==Buffer.from(sha256(tx.message.serialize())).toString('hex')||row.requestId!==row.order?.requestId||!Buffer.from(original.message.serialize()).equals(Buffer.from(tx.message.serialize())))throw Error('Swap recovery identity differs; new swaps are held.');
 bindSiloHistoricalJupiterTerms(tx,row.order,terms,{feeBps:row.kind==='silo-jupiter-build-signed-v1'?0:SILO_SWAP_FEE_BPS});
 return row;
}
export function readSiloJupiterJournal(storage){const text=storage.getItem(SILO_JUPITER_JOURNAL_KEY);if(text===null)return null;if(new TextEncoder().encode(text).length>MAX)throw Error('Swap recovery record exceeds bound.');let row;try{row=JSON.parse(text);}catch{throw Error('Swap recovery record cannot be read; new swaps are held.');}return validateRecord(row);}
export function readSiloJupiterReceipt(storage){const text=storage.getItem(SILO_JUPITER_JOURNAL_KEY+'-receipt');if(text===null)return null;if(new TextEncoder().encode(text).length>MAX*2)throw Error('Saved swap receipt exceeds bound.');const row=JSON.parse(text);validate(row.journal);if(row.outcome?.signature!==row.journal.signature||!['finalized','failed'].includes(row.outcome?.status)||row.outcome.status==='finalized'&&row.outcome.minimumReceivedVerified!==true)throw Error('Saved swap receipt identity differs.');return row;}
/** navigator.locks is mandatory; no unsafe fallback or origin-global delete exists. */
export function createSiloJupiterJournalStore(storage,locks,{storagePolicyAccepted=false,selectedNetwork=''}={}){
 if(storagePolicyAccepted!==true||!locks||typeof locks.request!=='function')throw Error('Swap storage policy and exclusive browser locks are required.');
 const exclusive=callback=>locks.request('grain-silo-jupiter-payment-v1',{mode:'exclusive'},callback);
 return {
  read:async()=>readSiloJupiterJournal(storage),
  recoverSigning:async check=>exclusive(async()=>{
   const row=readSiloJupiterJournal(storage);if(row?.kind!=='silo-jupiter-signing-v1'||selectedNetwork!==row.network||row.promptStarted!==true)return {status:'unknown',reason:'reservation-not-recoverable'};
   const original=JSON.stringify(row),result=await check(row);if(result?.status!=='found')return result;
   const signature=exactRecoveredWire(row.transactionBase64,result.signedTransaction,row.owner);if(signature!==result.signature||!Number.isSafeInteger(result.slot)||result.slot<1||!['finalized','failed'].includes(result.transactionStatus))throw Error('Recovered proof differs.');
   if(JSON.stringify(readSiloJupiterJournal(storage))!==original)throw Error('Reservation changed during recovery.');
   if(!row.recoveryContext)return {...result,status:'found-context-missing'};
   const context=row.recoveryContext,build=context.executionMode==='no-collection-build';
   const adopted={kind:build?'silo-jupiter-build-signed-v1':'silo-jupiter-signed-v1',...(build?{packet:context.packet,executionMode:'no-collection-build'}:{}),network:row.network,owner:row.owner,terms:row.terms,requestId:row.requestId,order:context.order,signedTransaction:result.signedTransaction,signature,blockhash:row.blockhash,lastValidBlockHeight:row.lastValidBlockHeight,messageHash:row.messageHash,createdAt:row.createdAt,submissionApproved:false};
   validate(adopted);save(storage,adopted);return {...result,status:'adopted',journal:adopted};
  }),
  cancelUnprompted:async()=>exclusive(async()=>{const row=readSiloJupiterJournal(storage);if(row?.kind!=='silo-jupiter-signing-v1'||row.promptStarted!==false)throw Error('Wallet prompt may have started. Recovery remains held.');storage.removeItem(SILO_JUPITER_JOURNAL_KEY);if(storage.getItem(SILO_JUPITER_JOURNAL_KEY)!==null)throw Error('Unsigned reservation could not be retired.');return {status:'cancelled-before-wallet'};}),
  reserveAndSign:async(review,sign)=>exclusive(async()=>{
   if(selectedNetwork!=='mainnet-beta'||readSiloJupiterJournal(storage))throw Error('Resolve the existing swap before signing another.');
   let reserved=reservation(review);const snapshot=JSON.parse(JSON.stringify(review));let captured=null;save(storage,reserved);
   // A reservation survives reload, interruption and wallet errors. It is never automatically
   // discarded: no second wallet prompt is safe while a previous callback is unresolved.
   let row;try{row=await sign(()=>{if(JSON.stringify(readSiloJupiterJournal(storage))!==JSON.stringify(reserved))throw Error('Reservation changed before wallet prompt.');reserved={...reserved,promptStarted:true};save(storage,reserved);},encoded=>{
    if(!reserved.promptStarted||JSON.stringify(readSiloJupiterJournal(storage))!==JSON.stringify(captured??reserved))throw Error('Wallet capture reservation differs.');
    const tx=decodeSiloJupiterTransaction(encoded,{signed:true}),original=decodeSiloJupiterTransaction(snapshot.transactionBase64);
    if(!Buffer.from(original.message.serialize()).equals(Buffer.from(tx.message.serialize())))throw Error('Returned signed message differs.');
    const build=snapshot.executionMode==='no-collection-build';
    const recovery={kind:build?'silo-jupiter-build-signed-v1':'silo-jupiter-signed-v1',...(build?{packet:snapshot.packet,executionMode:'no-collection-build'}:{}),network:'mainnet-beta',owner:reserved.owner,requestId:reserved.requestId,signedTransaction:encoded,signature:bs58.encode(tx.signatures[0]),blockhash:tx.message.recentBlockhash,lastValidBlockHeight:snapshot.lastValidBlockHeight,messageHash:reserved.messageHash,createdAt:Date.now(),terms:snapshot.terms,order:snapshot.order,submissionApproved:false};
    validate(recovery);save(storage,recovery);captured=recovery;return recovery;
   });}catch(error){
    if(!reserved.promptStarted&&JSON.stringify(readSiloJupiterJournal(storage))===JSON.stringify(reserved)){storage.removeItem(SILO_JUPITER_JOURNAL_KEY);if(storage.getItem(SILO_JUPITER_JOURNAL_KEY)!==null)throw Error('Unsigned reservation could not be retired.');}
    throw error;
   }validate(row);
   if(row.owner!==reserved.owner||row.messageHash!==reserved.messageHash||row.requestId!==reserved.requestId||JSON.stringify(readSiloJupiterJournal(storage))!==JSON.stringify(captured??reserved)||captured&&row.signedTransaction!==captured.signedTransaction)throw Error('Signing reservation changed. Nothing was transported.');
   const approved={...row,submissionApproved:true};save(storage,approved);return approved;
  }),
  reconcileRemote:async(check)=>exclusive(async()=>{
   const row=readSiloJupiterJournal(storage);if(!row)return {status:'empty'};
   if(!['silo-jupiter-signed-v1','silo-jupiter-build-signed-v1'].includes(row.kind))return {status:'held-signing'};
   if(selectedNetwork!==row.network)return {status:'held-other-network'};
   const result=await check(row);if(result.signature!==row.signature||!['unknown','finalized','failed'].includes(result.status))throw Error('Swap outcome identity differs.');
   if(result.status==='finalized'&&result.minimumReceivedVerified!==true)throw Error('Swap receive amount has not been verified.');
   // Preserve the exact journal and terminal receipt; transport is refused after terminality.
   if(['finalized','failed'].includes(result.status)){
    if(JSON.stringify(readSiloJupiterJournal(storage))!==JSON.stringify(row))throw Error('Swap record changed.');
    const receipt=JSON.stringify({journal:row,outcome:result});if(new TextEncoder().encode(receipt).length>MAX*2)throw Error('Receipt bound exceeded.');storage.setItem(SILO_JUPITER_JOURNAL_KEY+'-receipt',receipt);if(storage.getItem(SILO_JUPITER_JOURNAL_KEY+'-receipt')!==receipt)throw Error('Receipt could not be saved.');
    storage.removeItem(SILO_JUPITER_JOURNAL_KEY);if(storage.getItem(SILO_JUPITER_JOURNAL_KEY)!==null)throw Error('Swap recovery record could not be cleared.');
   }return result;
  }),
  write:async row=>exclusive(async()=>{
   if(selectedNetwork!=='mainnet-beta'||row.network!==selectedNetwork)throw Error('Select the saved swap network.');
   validate(row);const existing=readSiloJupiterJournal(storage);
   if(existing&&JSON.stringify(existing)!==JSON.stringify(row))throw Error('Resolve the existing swap before signing another.');
   const text=JSON.stringify(row);if(new TextEncoder().encode(text).length>MAX)throw Error('Swap recovery record exceeds bound.');
   storage.setItem(SILO_JUPITER_JOURNAL_KEY,text);if(storage.getItem(SILO_JUPITER_JOURNAL_KEY)!==text)throw Error('Swap could not be saved. Nothing was sent.');
  }),
  checkOutcome:async connection=>exclusive(async()=>{
   const row=readSiloJupiterJournal(storage);if(!row)return {status:'empty'};
   if(selectedNetwork!==row.network)return {status:'held-other-network',signature:row.signature};
   const result=await checkSiloJupiterOutcome(row,{connection});
   if(['finalized','failed'].includes(result.status)){
    const current=readSiloJupiterJournal(storage);if(JSON.stringify(current)!==JSON.stringify(row))throw Error('Swap recovery record changed.');
    storage.removeItem(SILO_JUPITER_JOURNAL_KEY);if(storage.getItem(SILO_JUPITER_JOURNAL_KEY)!==null)throw Error('Swap recovery record could not be cleared.');
   }
   return result;
  }),
 };
}
