/** Positive inclusion only. A bounded/pruned history never establishes absence. */
import {VersionedTransaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {SILO_SOLANA_GENESIS} from './solana-transfer.mjs';
const MAX_CANDIDATES=20;
const unknown=(reason,scanned=0)=>({status:'unknown',reason,scanned,coverage:'bounded-positive-only'});
export function exactRecoveredWire(unsignedWire,signedWire,owner){
 const decode=wire=>{if(typeof wire!=='string'||wire.length>1644)throw Error('Wire exceeds bound.');const bytes=Buffer.from(wire,'base64');if(bytes.toString('base64')!==wire||bytes.length>1232)throw Error('Invalid wire.');return VersionedTransaction.deserialize(bytes);};
 const original=decode(unsignedWire),signed=decode(signedWire);
 if(original.version!==0||signed.version!==0||original.message.header.numRequiredSignatures!==1||signed.message.header.numRequiredSignatures!==1||original.signatures.length!==1||signed.signatures.length!==1||original.signatures[0].some(x=>x!==0)||String(original.message.staticAccountKeys[0])!==owner||String(signed.message.staticAccountKeys[0])!==owner||!Buffer.from(original.message.serialize()).equals(Buffer.from(signed.message.serialize()))||!nacl.sign.detached.verify(signed.message.serialize(),signed.signatures[0],signed.message.staticAccountKeys[0].toBytes()))throw Error('Exact signed identity differs.');
 return bs58.encode(signed.signatures[0]);
}
/** read is a server-created primary-only RPC closure, never a supplied URL.
 * @param {{unsignedWire:string,owner:string,network:string}} reservation
 * @param {{read:(method:string,params?:unknown[])=>Promise<any>,deadlineMs?:number,now?:()=>number}} options
 */
export async function recoverPositiveHistory({unsignedWire,owner,network},{read,deadlineMs=8000,now=()=>performance.now()}){
 let scanned=0;const start=now();let lastTime=start;
 const elapsed=()=>{const current=now();if(!Number.isFinite(current)||current<lastTime)throw Error('Recovery monotonic clock differs.');lastTime=current;return current-start;};
 try{
  if(!Object.hasOwn(SILO_SOLANA_GENESIS,network??''))throw Error('Unsupported cluster.');
  // Validate reservation before any RPC, including exactly one unsigned payer.
  const tx=VersionedTransaction.deserialize(Buffer.from(unsignedWire,'base64'));
  if(typeof unsignedWire!=='string'||unsignedWire.length>1644||Buffer.from(unsignedWire,'base64').length>1232||Buffer.from(unsignedWire,'base64').toString('base64')!==unsignedWire||tx.version!==0||tx.message.header.numRequiredSignatures!==1||tx.signatures.length!==1||tx.signatures[0].some(x=>x!==0)||String(tx.message.staticAccountKeys[0])!==owner)throw Error('Invalid unsigned identity.');
  const call=async(method,params=[])=>{if(elapsed()>deadlineMs)throw Error('Recovery deadline.');let timer;try{const result=await Promise.race([read(method,params),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Recovery deadline.')),Math.max(1,deadlineMs-elapsed()));})]);if(elapsed()>deadlineMs)throw Error('Recovery deadline.');return result;}finally{clearTimeout(timer);}};
  if(await call('getGenesisHash')!==SILO_SOLANA_GENESIS[network])throw Error('Primary genesis differs.');
  const anchor=await call('getSlot',[{commitment:'finalized'}]);if(!Number.isSafeInteger(anchor)||anchor<1)throw Error('Invalid finalized anchor.');
  const rows=await call('getSignaturesForAddress',[owner,{commitment:'finalized',minContextSlot:anchor,limit:MAX_CANDIDATES}]);
  if(!Array.isArray(rows)||rows.length>MAX_CANDIDATES)throw Error('History bound differs.');
  const matches=[];const seen=new Set();let previous=Infinity;
  for(const row of rows){
   if(typeof row?.signature!=='string'||row.signature.length>88||!Number.isSafeInteger(row.slot)||row.slot<1||row.slot>anchor||row.slot>previous||row.confirmationStatus!=='finalized'||!Object.hasOwn(row,'err')||row.err!==null&&(typeof row.err!=='string'&&typeof row.err!=='object'||Array.isArray(row.err))||seen.has(row.signature))throw Error('Malformed finalized history.');
   previous=row.slot;seen.add(row.signature);scanned++;
   const receipt=await call('getTransaction',[row.signature,{commitment:'finalized',encoding:'base64',maxSupportedTransactionVersion:0}]);
   if(receipt===null)throw Error('History was pruned or unavailable.');
   if(JSON.stringify(receipt).length>131072)throw Error('Receipt exceeds bound.');
   if(!Array.isArray(receipt.transaction)||receipt.transaction.length!==2||receipt.transaction[1]!=='base64')throw Error('Raw finalized receipt unavailable.');
   const wire=receipt.transaction[0];if(typeof wire!=='string'||wire.length>1644||Buffer.from(wire,'base64').toString('base64')!==wire||Buffer.from(wire,'base64').length>1232)throw Error('Malformed historical wire.');
   const candidate=VersionedTransaction.deserialize(Buffer.from(wire,'base64'));
   if(candidate.signatures.length!==candidate.message.header.numRequiredSignatures||candidate.signatures.length<1||candidate.signatures.some((sig,i)=>!nacl.sign.detached.verify(candidate.message.serialize(),sig,candidate.message.staticAccountKeys[i].toBytes()))||bs58.encode(candidate.signatures[0])!==row.signature||receipt.slot!==row.slot||!receipt.meta||!Object.hasOwn(receipt.meta,'err')||JSON.stringify(receipt.meta.err)!==JSON.stringify(row.err)||!Number.isSafeInteger(receipt.meta.fee)||receipt.meta.fee<0)throw Error('Malformed historical receipt.');
   if(!Buffer.from(candidate.message.serialize()).equals(Buffer.from(tx.message.serialize())))continue;
   const signature=exactRecoveredWire(unsignedWire,wire,owner);
   if(signature!==row.signature||receipt.slot!==row.slot||!receipt.meta||!Object.hasOwn(receipt.meta,'err')||JSON.stringify(receipt.meta.err)!==JSON.stringify(row.err)||!Number.isSafeInteger(receipt.meta.fee)||receipt.meta.fee<0)throw Error('Finalized receipt differs.');
   const status=await call('getSignatureStatuses',[[signature],{searchTransactionHistory:true}]);const value=status?.value?.[0];
   if(!Array.isArray(status?.value)||status.value.length!==1||value?.confirmationStatus!=='finalized'||value.slot!==row.slot||JSON.stringify(value.err)!==JSON.stringify(row.err))throw Error('Finalized status differs.');
   matches.push({status:'found',signedTransaction:receipt.transaction[0],signature,slot:row.slot,networkFeeRaw:String(receipt.meta.fee),transactionStatus:row.err===null?'finalized':'failed',scanned,coverage:'bounded-positive-only'});
  }
  if(matches.length!==1)return unknown(matches.length?'ambiguous-matches':'no-positive-match',scanned);
  return {...matches[0],scanned};
 }catch{return unknown('history-unavailable-or-invalid',scanned);}
}
