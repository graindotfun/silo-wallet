/** Finalized chain witnesses prove only future non-executability. Neither a
 * deadline nor a bounded history search proves that a transaction never landed. */
import {Buffer} from 'buffer';
import {PublicKey,VersionedTransaction} from '@solana/web3.js';
import {validateSiloManagedReview} from './jupiter-managed-journal.mjs';
const GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const fields=['kind','phase','journalHash','owner','blockhash','messageHash','reviewHash','primarySlot','firstFinalizedSlot','firstFinalizedHeight','finalizedSlot','finalizedHeight','sourceFingerprint','runtimeFingerprint','signature','pastOutcome','terminalAuthenticated','proofSeal'];
const fail=()=>{throw Error('Authenticated chain-anchored expiry proof required.');};
export function validateSiloManagedExpiryProof(p,{complete=false}={}){
 if(!p||Object.keys(p).sort().join('|')!==[...fields].sort().join('|')||p.kind!=='silo-managed-expiry-v1'||![1,2].includes(p.phase)||complete&&p.phase!==2||p.pastOutcome!=='unknown'||p.terminalAuthenticated!==false)fail();
 for(const k of ['journalHash','messageHash','reviewHash','sourceFingerprint','runtimeFingerprint'])if(typeof p[k]!=='string'||!/^[a-f0-9]{64}$/.test(p[k]))fail();
 for(const k of ['primarySlot','firstFinalizedSlot','firstFinalizedHeight','finalizedSlot','finalizedHeight'])if(!Number.isSafeInteger(p[k])||p[k]<1)fail();
 if(p.firstFinalizedSlot<p.primarySlot||p.finalizedSlot<p.firstFinalizedSlot||p.finalizedHeight<p.firstFinalizedHeight||p.phase===1&&(p.finalizedSlot!==p.firstFinalizedSlot||p.finalizedHeight!==p.firstFinalizedHeight)||p.phase===2&&(p.finalizedSlot<=p.firstFinalizedSlot||p.finalizedHeight-p.firstFinalizedHeight<150)||typeof p.proofSeal!=='string'||!/^silo-managed-expiry-v1\.[a-f0-9]{64}$/.test(p.proofSeal)||p.signature!==null&&(typeof p.signature!=='string'||! /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(p.signature))||typeof p.owner!=='string'||typeof p.blockhash!=='string')fail();
 try{if(String(new PublicKey(p.owner))!==p.owner||String(new PublicKey(p.blockhash))!==p.blockhash)fail();}catch{fail();}
 return p;
}
export function siloManagedExpiryClaims(p){const unsigned={...p};delete unsigned.proofSeal;return JSON.stringify(['silo-managed-expiry-v1',Object.keys(unsigned).sort().map(k=>[k,unsigned[k]])]);}
/** Caller authenticates the sealed review and supplies server-owned HMAC helpers. */
export async function readSiloManagedExpiryProof(review,{read,identity,phaseProof=null,seal,verify,assertCurrent=()=>{throw Error('Current recovery authorization required.');}}={}){
 validateSiloManagedReview(review);assertCurrent();
 if(typeof read!=='function'||typeof seal!=='function'||typeof verify!=='function'||!Number.isSafeInteger(review.primarySlot)||review.primarySlot<1)throw Error('Reviewed primary anchor required.');
 const tx=VersionedTransaction.deserialize(Buffer.from(review.capture.originalTransaction,'base64'));
 if(review.contract.messageHash!==review.capture.messageHash)fail();
 for(const instruction of tx.message.compiledInstructions){const program=tx.message.staticAccountKeys[instruction.programIdIndex];if(!program)fail();if(String(program)==='11111111111111111111111111111111'&&Buffer.from(instruction.data).length>=4&&Buffer.from(instruction.data).readUInt32LE(0)===4)fail();}
 const call=async(method,params=[])=>{assertCurrent();const value=await read(method,params);assertCurrent();return value;};
 const bound={journalHash:identity.journalHash,owner:review.contract.owner,blockhash:tx.message.recentBlockhash,messageHash:review.capture.messageHash,reviewHash:review.capture.captureHash,primarySlot:review.primarySlot,sourceFingerprint:identity.sourceFingerprint,runtimeFingerprint:identity.runtimeFingerprint,signature:identity.signature};
 if(phaseProof){validateSiloManagedExpiryProof(phaseProof);if(phaseProof.phase!==1||Object.keys(bound).some(k=>phaseProof[k]!==bound[k])||!await verify(phaseProof))fail();assertCurrent();}
 if(await call('getGenesisHash')!==GENESIS)fail();
 const floor=phaseProof?phaseProof.finalizedSlot:review.primarySlot;
 const validity=await call('isBlockhashValid',[tx.message.recentBlockhash,{commitment:'finalized',minContextSlot:floor}]);
 if(typeof validity?.value!=='boolean'||!Number.isSafeInteger(validity.context?.slot)||validity.context.slot<floor)fail();
 if(validity.value===true)return {status:'pending',held:true,expiryAuthenticated:false};
 const finalizedSlot=validity.context.slot,finalizedHeight=await call('getBlockHeight',[{commitment:'finalized',minContextSlot:finalizedSlot}]);
 if(!Number.isSafeInteger(finalizedHeight)||finalizedHeight<1)fail();
 if(phaseProof&&(finalizedSlot<=phaseProof.finalizedSlot||finalizedHeight<phaseProof.finalizedHeight))fail();
 if(phaseProof&&finalizedHeight-phaseProof.firstFinalizedHeight<150)return {status:'expiry-wait',held:true,expiryAuthenticated:false,proof:phaseProof,remainingFinalizedBlocks:150-(finalizedHeight-phaseProof.firstFinalizedHeight)};
 const p={kind:'silo-managed-expiry-v1',phase:phaseProof?2:1,...bound,firstFinalizedSlot:phaseProof?.firstFinalizedSlot??finalizedSlot,firstFinalizedHeight:phaseProof?.firstFinalizedHeight??finalizedHeight,finalizedSlot,finalizedHeight,pastOutcome:'unknown',terminalAuthenticated:false};
 p.proofSeal=await seal(p);assertCurrent();validateSiloManagedExpiryProof(p);
 return {status:p.phase===2?'expired-outcome-unknown':'expiry-wait',held:true,expiryAuthenticated:p.phase===2,proof:p,remainingFinalizedBlocks:p.phase===2?0:150};
}
