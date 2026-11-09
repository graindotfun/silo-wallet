/** Fixed authenticated same-origin shared dispatch. No private env/RPC URL,
 * generic simulation, legacy packet/floor, server signer or provider execute. */
import {Buffer} from 'buffer';import {VersionedTransaction} from '@solana/web3.js';
import {sessionRpcFetch} from '../browser-rpc-session.mjs';import {siloJson} from './bounded-json.mjs';
import {readSiloSharedCompactContext} from './jupiter-shared-compact-context.mjs';
import {decodeSiloSharedRawReceipt} from './jupiter-shared-receipt-broker.mjs';
import {verifySiloSharedFinalizedReceipt} from './jupiter-shared-historical.mjs';
import {SILO_JUPITER_BODY_MAX_BYTES,siloJupiterSerializedBytes} from './jupiter-bounds.mjs';
import {siloSharedEconomics,siloSharedTerminalProof} from './jupiter-shared-journal.mjs';
const GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
/** assertCurrent must bind the actual connected owner, selected mainnet and UI
 * generation. Callers cannot recover that capability from serialized hashes.
 * @param {{wallet:any,assertCurrent:()=>void,fetcher?:typeof fetch}} options */
export function createSiloSharedSameOriginAdapter({wallet,assertCurrent,fetcher=sessionRpcFetch}){
 if(typeof assertCurrent!=='function')throw Error('Current owner/network capability required.');
 async function post(action,body,guard=()=>{}){if(!['order','simulate','execute','outcome','recover','shared-receipt'].includes(action)||siloJupiterSerializedBytes(body)>SILO_JUPITER_BODY_MAX_BYTES+(action==='recover'?32:0))throw Error('Shared API request bound differs.');guard();const request={method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)};const response=await (fetcher===sessionRpcFetch?sessionRpcFetch('/api/silo/swap/'+action,request,false,guard):fetcher('/api/silo/swap/'+action,request));guard();const result=await siloJson(response,131072);guard();if(response.status===409&&result?.status==='refused')throw Object.assign(Error(typeof result.error==='string'?result.error:'Refused by the beta rules.'),{siloBetaRefusal:true,preDispatchRefusal:true,code:result.refusal});if(!response.ok)throw Error('Shared service is unavailable or held.');return result;}
 const owner=expected=>{assertCurrent();if(wallet?.publicKey?.toBase58?.()!==expected)throw Error('Connected owner differs from the shared review.');};
 const verify=async(row,guard)=>{const c=readSiloSharedCompactContext(JSON.stringify(row.context)),economics=siloSharedEconomics(row);guard();owner(c.derived.owner);const proof=await post('simulate',{protocol:'shared-serial-v1',context:c,...economics},()=>{guard();owner(c.derived.owner);});guard();owner(c.derived.owner);if(proof?.verified!==true||proof.messageHash!==c.messageHash||proof.minimumOutputRaw!==c.derived.candidateMinimumRaw||proof.runtimeFingerprint!==economics.runtimeFingerprint||proof.simulation?.networkFeeRaw!==economics.networkFeeRaw||proof.simulation?.createdTokenAccountRentRaw!==economics.createdTokenAccountRentRaw)throw Error('Shared primary revalidation economics differ.');return true;};
 return {
  prepare:async terms=>{owner(terms.owner);const review=await post('order',terms,()=>owner(terms.owner));owner(terms.owner);if(review?.kind!=='silo-jupiter-shared-review-v1'||review.protocol!=='shared-serial-v1'||review.actualFeeBps!==0||review.collectionEnabled!==false||review.buybacksEnabled!==false||review.executionMode!=='no-collection-shared-build')throw Error('Shared executable protocol differs.');return review;},
  verifyBeforePrompt:async(review,guard)=>verify(review,guard),
  walletCallback:async encoded=>{const tx=VersionedTransaction.deserialize(Buffer.from(encoded,'base64'));owner(String(tx.message.staticAccountKeys[0]));if(typeof wallet.signTransaction!=='function')throw Error('Connected signer unavailable.');const signed=await wallet.signTransaction(tx);return Buffer.from(signed.serialize()).toString('base64');},
  verifyAfterCapture:async(row,guard)=>verify(row,guard),
  execute:async(row,guard)=>{guard();owner(row.context.derived.owner);return post('execute',row,()=>{guard();owner(row.context.derived.owner);});},
  checkOutcome:async(row,guard)=>{guard();const result=await post('outcome',row,guard);guard();return result;},
  verifyFinalizedOutcome:async(row,result,guard)=>{guard();const proof=await post('shared-receipt',row,guard);guard();if(proof.runtimeFingerprint!==row.runtimeFingerprint||proof.genesisHash!==GENESIS||proof.reviewSeal!==row.reviewSeal||proof.sourceFingerprint!==row.reviewSeal.split('.')[1]||proof.reviewAuthenticated!==true)throw Error('Shared history runtime or network differs.');const checked=verifySiloSharedFinalizedReceipt(row,decodeSiloSharedRawReceipt(row,proof));if(!result||Object.keys(checked).sort().join('|')!==Object.keys(result).sort().join('|')||Object.entries(checked).some(([field,value])=>JSON.stringify(value)!==JSON.stringify(result[field])))throw Error('Shared independently read receipt differs.');return siloSharedTerminalProof(row,{verified:true,reviewSeal:proof.reviewSeal,sourceFingerprint:proof.sourceFingerprint,runtimeFingerprint:proof.runtimeFingerprint,contextHash:proof.contextHash,messageHash:proof.messageHash,signature:proof.signature});},
  recoverSigning:async row=>post('recover',{reservation:row}),
 };
}
