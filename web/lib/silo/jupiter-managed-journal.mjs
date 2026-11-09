/** Managed Jupiter recovery shares the existing durable slot and exclusive lock.
 * Checksums establish byte integrity only; current policy and the authenticated
 * server review remain required before signing or transport. */
import {Buffer} from 'buffer';
import {readSiloManagedUnresolved,unresolvedSiloManagedRows,saveSiloManagedUnresolved,resolveSiloManagedUnresolved} from './managed-unresolved-journal.mjs';
import {PublicKey,VersionedTransaction} from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {validateSiloJupiterProviderCapture} from './jupiter-provider-v2.mjs';
import {assertSiloManagedExecutionAccepted} from './jupiter-managed-acceptance.mjs';
import {SILO_JUPITER_BODY_MAX_BYTES as MAX,siloJupiterSerializedBytes} from './jupiter-bounds.mjs';
export const SILO_MANAGED_JUPITER_KEY='grain-silo-jupiter-pending-v1';
const TERMINAL_HEADROOM=2048;
const LOCK='grain-silo-jupiter-payment-v1',RECEIPT=SILO_MANAGED_JUPITER_KEY+'-managed-receipt',HISTORY=RECEIPT+'-history',HISTORY_MAX_BYTES=1024*1024,HISTORY_MAX_ROWS=32;
const raw=x=>typeof x==='string'&&/^(0|[1-9]\d{0,19})$/.test(x)&&BigInt(x)<=18446744073709551615n;
const key=x=>typeof x==='string'&&String(new PublicKey(x))===x;
function wire(encoded,signed){
 if(typeof encoded!=='string'||encoded.length>1644)throw Error('Managed wire bound differs.');
 const bytes=Buffer.from(encoded,'base64');if(!bytes.length||bytes.length>1232||bytes.toString('base64')!==encoded)throw Error('Managed wire encoding differs.');
 const tx=VersionedTransaction.deserialize(bytes);
 if(!Buffer.from(tx.serialize()).equals(bytes)||tx.message.version!==0||tx.message.header.numRequiredSignatures!==1||tx.message.header.numReadonlySignedAccounts!==0||tx.signatures.length!==1||tx.signatures[0].length!==64||(signed?!nacl.sign.detached.verify(tx.message.serialize(),tx.signatures[0],tx.message.staticAccountKeys[0].toBytes()):tx.signatures[0].some(Boolean)))throw Error('Managed signature or payer identity differs.');
 return tx;
}
export function validateSiloManagedReview(review){
 if(!review||review.protocol!=='managed-v1'||siloJupiterSerializedBytes(review)>MAX)throw Error('Bounded managed review required.');
 const c=validateSiloJupiterProviderCapture(review.capture),t=c.terms,d=review.contract,tx=wire(c.originalTransaction,false);
 if(c.router!=='metis'||c.gasless||c.errorCode!==null||c.requiredSigners.length!==1||c.requiredSigners[0]!==t.taker||c.payer!==t.taker||String(tx.message.staticAccountKeys[0])!==t.taker||!d||d.owner!==t.taker||d.inputMint!==t.inputMint||d.outputMint!==t.outputMint||d.inputRaw!==t.amount||d.quotedOutputRaw!==c.outAmount||(d.providerMinimumOutputRaw===undefined?d.minimumOutputRaw!==c.otherAmountThreshold:d.providerMinimumOutputRaw!==c.otherAmountThreshold||d.minimumOutputRaw!==d.minimumOutputFloorRaw||BigInt(d.signedGuardMinimumOutputRaw)<BigInt(d.minimumOutputFloorRaw)||BigInt(d.signedGuardMinimumOutputRaw)>BigInt(d.minimumOutputFloorRaw)+1n)||!raw(d.minimumOutputRaw)||BigInt(d.minimumOutputRaw)<1n||BigInt(d.minimumOutputRaw)>BigInt(d.quotedOutputRaw)||!key(d.inputProgram)||!key(d.outputProgram))throw Error('Managed original contract differs.');
 if(!Array.isArray(review.mintFacts)||review.mintFacts.length!==2||[t.inputMint,t.outputMint].some(mint=>review.mintFacts.filter(f=>f?.mint===mint).length!==1)||review.mintFacts.some(f=>!Number.isInteger(f.decimals)||f.decimals<0||f.decimals>255||!['mintAuthority','freezeAuthority'].every(k=>f[k]===null||key(f[k]))))throw Error('Managed primary mint facts differ.');
 if(!raw(review.networkFeeRaw)||!raw(review.createdTokenAccountRentRaw)||!['runtimeFingerprint','sourceFingerprint'].every(k=>typeof review[k]==='string'&&/^[a-f0-9]{64}$/.test(review[k]))||typeof review.reviewSeal!=='string'||!review.reviewSeal.length||review.reviewSeal.length>1024||!Number.isSafeInteger(review.expiresAt)||review.expiresAt>c.expiresAt||review.expiresAt<=c.observedAt)throw Error('Managed original economics or seal differs.');
 return review;
}
export function validateSiloManagedJournal(row){
 if(!row||!['silo-jupiter-managed-signing-v1','silo-jupiter-managed-signed-v1'].includes(row.kind))throw Error('Another or unreadable swap protocol remains held.');
 const signing=row.kind==='silo-jupiter-managed-signing-v1',fields=['kind','network','review','createdAt',...(signing?['promptStarted']:['signedTransaction','signature','submissionApproved'])];
 if(Object.keys(row).sort().join('|')!==fields.sort().join('|'))throw Error('Managed journal fields differ.');
 const r=validateSiloManagedReview(row.review);if(row.network!=='mainnet-beta'||!Number.isSafeInteger(row.createdAt)||row.createdAt<r.capture.observedAt||row.createdAt>=r.expiresAt||siloJupiterSerializedBytes(row)>MAX)throw Error('Managed durable identity differs.');
 if(signing){if(typeof row.promptStarted!=='boolean')throw Error('Managed prompt state differs.');}
 else{const tx=wire(row.signedTransaction,true),original=wire(r.capture.originalTransaction,false);if(!Buffer.from(tx.message.serialize()).equals(Buffer.from(original.message.serialize()))||row.signature!==bs58.encode(tx.signatures[0])||typeof row.submissionApproved!=='boolean')throw Error('Managed exact signed recovery differs.');}
 return row;
}
export function readSiloManagedJournal(storage){const text=storage.getItem(SILO_MANAGED_JUPITER_KEY);if(text===null)return null;if(new TextEncoder().encode(text).length>MAX)throw Error('Managed recovery UTF8 bound exceeded.');let row;try{row=JSON.parse(text);}catch{throw Error('Unreadable swap recovery remains held.');}return validateSiloManagedJournal(row);}
function save(storage,row){validateSiloManagedJournal(row);const text=JSON.stringify(row);storage.setItem(SILO_MANAGED_JUPITER_KEY,text);if(storage.getItem(SILO_MANAGED_JUPITER_KEY)!==text)throw Error('Managed recovery readback failed; transport held.');}
function unchanged(storage,row){if(JSON.stringify(readSiloManagedJournal(storage))!==JSON.stringify(row))throw Error('Managed reservation changed; replacement held.');}
function terminal(row,result){
 if(!result||result.signature!==row.signature||result.reviewHash!==row.review.capture.captureHash||!['unknown','finalized','failed'].includes(result.status))throw Error('Managed outcome identity differs.');
 if(result.status==='unknown')return false;
 if(result.terminalAuthenticated!==true||!Number.isSafeInteger(result.slot)||result.slot<1||!['networkFeeRaw','createdTokenAccountRentRaw','totalSolDebitedRaw'].every(k=>raw(result[k]))||BigInt(result.networkFeeRaw)<5000n||BigInt(result.networkFeeRaw)>100000n||BigInt(result.createdTokenAccountRentRaw)>BigInt(row.review.createdTokenAccountRentRaw))throw Error('Authenticated managed terminal receipt required.');
 if(result.status==='finalized'&&(result.minimumReceivedVerified!==true||result.minimumOutputRaw!==row.review.contract.minimumOutputRaw||!raw(result.receivedOutputRaw)||BigInt(result.receivedOutputRaw)<BigInt(result.minimumOutputRaw)||!raw(result.netSolCreditedRaw)))throw Error('Managed terminal minimum or actual costs differ.');
 if(result.status==='failed'&&(result.createdTokenAccountRentRaw!=='0'||result.totalSolDebitedRaw!==result.networkFeeRaw))throw Error('Managed failed receipt costs differ.');
 if(result.status==='finalized'){
  const refund=result.nativeAccountRefundRaw??'0';if(!raw(refund))throw Error('Managed native account refund differs.');
  const sol='So11111111111111111111111111111111111111112',c=row.review.contract;
  if(c.inputMint!==sol&&c.outputMint!==sol&&refund!=='0')throw Error('Unexpected native account refund.');
  const delta=(c.outputMint===sol?BigInt(result.receivedOutputRaw):0n)+BigInt(refund)-BigInt(result.networkFeeRaw)-BigInt(result.createdTokenAccountRentRaw)-(c.inputMint===sol?BigInt(c.inputRaw):0n);
  if(BigInt(result.totalSolDebitedRaw)!==(delta<0n?-delta:0n)||BigInt(result.netSolCreditedRaw)!==(delta>0n?delta:0n))throw Error('Managed actual SOL accounting differs.');
 }
 return true;
}
/** @param {any} storage @param {any} locks @param {{storagePolicyAccepted?:boolean,selectedNetwork?:string,assertAccepted?:()=>unknown,now?:()=>number}} options */
export function createSiloManagedJournalStore(storage,locks,{storagePolicyAccepted=false,selectedNetwork='',assertAccepted=assertSiloManagedExecutionAccepted,now=Date.now}={}){
 if(storagePolicyAccepted!==true||!locks||typeof locks.request!=='function')throw Error('Documented storage consent and exclusive browser lock required.');
 const exclusive=fn=>locks.request(LOCK,{mode:'exclusive'},fn);
 const activePrompts=new WeakMap();
 return {
  read:async()=>readSiloManagedJournal(storage),
  assertPrompt:review=>{const permit=activePrompts.get(review);if(!permit)throw Error('Exact live native prompt reservation required.');permit();const row=readSiloManagedJournal(storage);if(selectedNetwork!==row?.network||row?.kind!=='silo-jupiter-managed-signing-v1'||row.promptStarted!==true||JSON.stringify(row.review)!==JSON.stringify(review))throw Error('Exact durable native prompt reservation required.');},
  unresolved:async()=>readSiloManagedUnresolved(storage,validateSiloManagedTerminalReceipt),
  /** @param {any} review @param {{beforePrompt?:(guard:()=>void)=>Promise<unknown>,walletCallback:(wire:string)=>Promise<string>,postCapture?:(row:any,guard:()=>void)=>Promise<unknown>}} callbacks */
  reserveAndSign:async(review,{beforePrompt=async()=>{},walletCallback,postCapture=async()=>{}})=>exclusive(async()=>{
   if(selectedNetwork!=='mainnet-beta'||storage.getItem(SILO_MANAGED_JUPITER_KEY)!==null)throw Error('Resolve the saved protocol before another prompt.');
   const archive=readSiloManagedUnresolved(storage,validateSiloManagedTerminalReceipt),unresolved=archive.rows.filter(r=>r.resolution===null);if(archive.rows.length>=4||unresolved.length>=2||JSON.stringify(unresolved.map(r=>r.proof.journalHash).sort())!==JSON.stringify(review.recoveryContext?.unresolvedHashes??[]))throw Error('Unresolved trial set changed or reached its breaker.');
   assertAccepted();validateSiloManagedReview(review);const snapshot=JSON.stringify(review),original=JSON.parse(snapshot),createdAt=now();
   if(!Number.isSafeInteger(createdAt)||createdAt<original.capture.observedAt||createdAt>=original.expiresAt||typeof walletCallback!=='function')throw Error('Managed exact current review required.');
   // Reserve sufficient room for the larger signed row before opening a wallet.
   if(siloJupiterSerializedBytes({kind:'silo-jupiter-managed-signed-v1',network:'mainnet-beta',review:original,createdAt,signedTransaction:original.capture.originalTransaction,signature:'1'.repeat(88),submissionApproved:false})>MAX-TERMINAL_HEADROOM)throw Error('Managed signed envelope cannot fit durable budget.');
   let reserved={kind:'silo-jupiter-managed-signing-v1',network:'mainnet-beta',review:original,createdAt,promptStarted:false};save(storage,reserved);
   const guard=()=>{assertAccepted();if(JSON.stringify(unresolvedSiloManagedRows(storage,validateSiloManagedTerminalReceipt).map(r=>r.proof.journalHash).sort())!==JSON.stringify(review.recoveryContext?.unresolvedHashes??[]))throw Error('Unresolved trial set changed.');const time=now();if(!Number.isSafeInteger(time)||time<createdAt||time>=original.expiresAt||JSON.stringify(review)!==snapshot)throw Error('Managed approved review changed or expired.');};
   try{await beforePrompt(guard);guard();unchanged(storage,reserved);reserved={...reserved,promptStarted:true};save(storage,reserved);
    activePrompts.set(review,()=>{guard();unchanged(storage,reserved);});
    const encoded=await walletCallback(original.capture.originalTransaction),tx=wire(encoded,true),unsigned=wire(original.capture.originalTransaction,false);
    if(!Buffer.from(tx.message.serialize()).equals(Buffer.from(unsigned.message.serialize())))throw Error('Wallet returned another managed message.');
    // Never await context/expiry/simulation checks between valid capture and save.
    unchanged(storage,reserved);const captured={kind:'silo-jupiter-managed-signed-v1',network:'mainnet-beta',review:original,createdAt,signedTransaction:encoded,signature:bs58.encode(tx.signatures[0]),submissionApproved:false};save(storage,captured);
    await postCapture(captured,guard);guard();unchanged(storage,captured);const approved={...captured,submissionApproved:true};save(storage,approved);return approved;
   }catch(error){if(!reserved.promptStarted&&storage.getItem(SILO_MANAGED_JUPITER_KEY)===JSON.stringify(reserved)){storage.removeItem(SILO_MANAGED_JUPITER_KEY);if(storage.getItem(SILO_MANAGED_JUPITER_KEY)!==null)throw Error('Unprompted managed cancellation readback failed.');}throw error;}finally{activePrompts.delete(review);}
  }),
  withApproved:async callback=>exclusive(async()=>{assertAccepted();const row=readSiloManagedJournal(storage);if(selectedNetwork!==row?.network||row?.kind!=='silo-jupiter-managed-signed-v1'||row.submissionApproved!==true)throw Error('Approved exact managed journal required.');const guard=()=>{assertAccepted();if(JSON.stringify(unresolvedSiloManagedRows(storage,validateSiloManagedTerminalReceipt).map(r=>r.proof.journalHash).sort())!==JSON.stringify(row.review.recoveryContext?.unresolvedHashes??[]))throw Error('Unresolved trial set changed before transport.');unchanged(storage,row);if(now()<row.createdAt||now()>=row.review.expiresAt)throw Error('Managed submission review expired.');};guard();return callback(row,guard);}),
  recoverSigning:async check=>exclusive(async()=>{const row=readSiloManagedJournal(storage);if(selectedNetwork!==row?.network||row?.kind!=='silo-jupiter-managed-signing-v1'||row.promptStarted!==true||typeof check!=='function')return {status:'unknown',held:true};const result=await check(row);unchanged(storage,row);if(result?.status!=='found')return {status:'unknown',held:true};const tx=wire(result.signedTransaction,true),original=wire(row.review.capture.originalTransaction,false);if(!Buffer.from(tx.message.serialize()).equals(Buffer.from(original.message.serialize()))||result.signature!==bs58.encode(tx.signatures[0])||result.reviewHash!==row.review.capture.captureHash)throw Error('Managed recovered exact signed identity differs.');const captured={kind:'silo-jupiter-managed-signed-v1',network:row.network,review:row.review,createdAt:row.createdAt,signedTransaction:result.signedTransaction,signature:result.signature,submissionApproved:false};save(storage,captured);return {status:'adopted',journal:captured,held:true};}),
  archiveExpiredUnknown:async(check,phaseProof=null,{acknowledged=false}={})=>exclusive(async()=>{
   const row=readSiloManagedJournal(storage);if(selectedNetwork!==row?.network||typeof check!=='function')throw Error('Current recovery network and server proof required.');const originalText=storage.getItem(SILO_MANAGED_JUPITER_KEY);const result=await check(row,phaseProof);unchanged(storage,row);
   if(result?.status!=='expired-outcome-unknown'||result.expiryAuthenticated!==true)return result;
   if(acknowledged!==true)return {...result,held:true};const time=now();if(!Number.isSafeInteger(time)||time<0)throw Error('Archive time differs.');
   saveSiloManagedUnresolved(storage,originalText,result.proof,time,validateSiloManagedTerminalReceipt);unchanged(storage,row);storage.removeItem(SILO_MANAGED_JUPITER_KEY);if(storage.getItem(SILO_MANAGED_JUPITER_KEY)!==null)throw Error('Unknown archive retirement readback failed.');return {...result,status:'archived-expired-unknown',held:false};
  }),
  reconcileUnresolved:async(journalHash,check)=>exclusive(async()=>{const a=readSiloManagedUnresolved(storage,validateSiloManagedTerminalReceipt),entry=a.rows.find(r=>r.proof.journalHash===journalHash&&r.resolution===null);if(selectedNetwork!=='mainnet-beta'||!entry||typeof check!=='function')throw Error('Saved unresolved attempt required.');const snapshot=JSON.stringify(a),receipt=await check(JSON.parse(entry.journalText));if(JSON.stringify(readSiloManagedUnresolved(storage,validateSiloManagedTerminalReceipt))!==snapshot)throw Error('Unresolved archive changed.');if(!receipt)return {status:'unknown',held:true};return resolveSiloManagedUnresolved(storage,journalHash,receipt,validateSiloManagedTerminalReceipt);}),
  cancelUnprompted:async()=>exclusive(async()=>{const row=readSiloManagedJournal(storage);if(selectedNetwork!==row?.network||row?.kind!=='silo-jupiter-managed-signing-v1'||row.promptStarted!==false)throw Error('A managed prompt may have started; hold retained.');storage.removeItem(SILO_MANAGED_JUPITER_KEY);if(storage.getItem(SILO_MANAGED_JUPITER_KEY)!==null)throw Error('Managed cancellation readback failed.');return {status:'cancelled-before-wallet'};}),
  /** @param {((row:any)=>Promise<any>)|undefined} [check] */
  outcome:async check=>exclusive(async()=>{const row=readSiloManagedJournal(storage);if(!row)return {status:'empty'};if(selectedNetwork!==row.network)return {status:'held-other-network',held:true};if(row.kind!=='silo-jupiter-managed-signed-v1'||typeof check!=='function')return {status:'unknown',signature:row.signature??null,held:true};const result=await check(row);unchanged(storage,row);if(!terminal(row,result))return {...result,held:true};const receipt={journal:row,outcome:result},text=JSON.stringify(receipt);if(siloJupiterSerializedBytes(receipt)>MAX)throw Error('Managed terminal receipt bound exceeded.');saveHistory(storage,receipt);storage.setItem(RECEIPT,text);if(storage.getItem(RECEIPT)!==text)throw Error('Managed terminal receipt readback failed.');unchanged(storage,row);storage.removeItem(SILO_MANAGED_JUPITER_KEY);if(storage.getItem(SILO_MANAGED_JUPITER_KEY)!==null)throw Error('Managed terminal retirement readback failed.');return result;}),
 };
}
export function readSiloManagedReceipt(storage){const text=storage.getItem(RECEIPT);if(text===null)return null;if(new TextEncoder().encode(text).length>MAX)throw Error('Managed receipt exceeds bound.');const receipt=JSON.parse(text);validateSiloManagedJournal(receipt.journal);if(receipt.journal.kind!=='silo-jupiter-managed-signed-v1'||!terminal(receipt.journal,receipt.outcome))throw Error('Managed terminal receipt identity differs.');return receipt;}

/** Bounded local archive, never complete on-chain history or new authority. */
export function readSiloManagedHistory(storage){const text=storage.getItem(HISTORY);if(text===null){const last=readSiloManagedReceipt(storage);return {kind:'silo-managed-history-v1',partial:true,rows:last?[last]:[]};}if(new TextEncoder().encode(text).length>HISTORY_MAX_BYTES)throw Error('Saved swap archive exceeds bound.');const archive=JSON.parse(text);if(archive?.kind!=='silo-managed-history-v1'||typeof archive.partial!=='boolean'||!Array.isArray(archive.rows)||archive.rows.length>HISTORY_MAX_ROWS)throw Error('Saved swap archive differs.');const seen=new Set();for(const receipt of archive.rows){validateSiloManagedJournal(receipt.journal);if(receipt.journal.kind!=='silo-jupiter-managed-signed-v1'||!terminal(receipt.journal,receipt.outcome)||seen.has(receipt.journal.signature))throw Error('Saved archive receipt differs.');seen.add(receipt.journal.signature);}return archive;}
function saveHistory(storage,receipt){const archive=readSiloManagedHistory(storage);let rows=[receipt,...archive.rows.filter(r=>r.journal.signature!==receipt.journal.signature)],partial=archive.partial;while(rows.length>HISTORY_MAX_ROWS||siloJupiterSerializedBytes({kind:'silo-managed-history-v1',partial,rows})>HISTORY_MAX_BYTES){if(rows.length<2)throw Error('Terminal archive cannot fit unchanged budget.');rows.pop();partial=true;}const text=JSON.stringify({kind:'silo-managed-history-v1',partial,rows});storage.setItem(HISTORY,text);if(storage.getItem(HISTORY)!==text)throw Error('Terminal archive readback failed.');}

export function validateSiloManagedTerminalReceipt(receipt){validateSiloManagedJournal(receipt?.journal);if(receipt.journal.kind!=='silo-jupiter-managed-signed-v1'||!terminal(receipt.journal,receipt.outcome))throw Error('Authenticated managed receipt required.');return receipt;}
