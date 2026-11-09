import {bindSiloHistoricalJupiterTerms} from './jupiter-historical-terms.mjs';
/** Bounded fixed-origin Jupiter V2 transports. Defaults remain fail-closed.
 * Never enables collection/buybacks or signs transactions server-side. */
import {Buffer} from 'buffer';
import {siloJson} from './bounded-json.mjs';
import {siloJupiterExecutionTerms,inspectSiloJupiterOrder,decodeSiloJupiterTransaction} from './jupiter-execution.mjs';
import {verifySiloFeeAccount} from './swap-referral.mjs';
import {SILO_SWAP_FEE_BPS} from './swap-policy.mjs';
import {assertSiloRuntimeJupiterPair} from './jupiter-route-policy.mjs';
import {inspectSiloNoCollectionBuild,submitSiloNoCollectionBuild} from './jupiter-build-execution.mjs';
import bs58 from 'bs58';
const BASE='https://api.jup.ag/swap/v2';
function configured(env,releaseApproved){const mode=env.SILO_SWAP_EXECUTION_MODE??'referral-order';if(!['referral-order','no-collection-build'].includes(mode)||releaseApproved!==true||env.SILO_SWAP_EXECUTION_ENABLED!=='true'||env.SILO_SWAP_EXECUTION_ACCEPTED!=='true'||!env.JUPITER_API_KEY||(mode==='referral-order'?(env.SILO_SWAP_FEE_COLLECTION_ENABLED!=='true'||!env.SILO_SWAP_REFERRAL_ACCOUNT):(env.SILO_SWAP_FEE_COLLECTION_ENABLED!=='false'||env.SILO_SWAP_NO_COLLECTION_POLICY_ACCEPTED!=='true')))throw Error('Jupiter execution is not configured and accepted.');return mode;}
function runtimePair(terms,{candidateOnly,fetcher,connection,mode,operation}){if(candidateOnly!==true)return assertSiloRuntimeJupiterPair(terms);if(connection?.siloOfflineFixture!==true||(operation==='prepare'||mode==='referral-order')&&fetcher===fetch)throw Error('An isolated offline fixture transport is required.');}
async function json(path,options,fetcher){const response=await fetcher(`${BASE}${path}`,{credentials:'omit',redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(8000),...options});if(!response.ok){await response.body?.cancel().catch(()=>{});throw Error('Jupiter request unavailable.');}return siloJson(response,128*1024);}
export async function prepareSiloJupiterOrder(input,{env={},beneficiary,read,connection,fetcher=fetch,now=Date.now,releaseApproved=false,candidateOnly=false}={}){
 const mode=configured(env,releaseApproved),terms=siloJupiterExecutionTerms(input);runtimePair(terms,{candidateOnly,fetcher,connection,mode,operation:'prepare'});
 if(mode==='no-collection-build'){const query=new URLSearchParams({inputMint:terms.inputMint,outputMint:terms.outputMint,amount:terms.amount,taker:terms.owner,dexes:'Raydium CLMM',platformFeeBps:'0',transactionVersion:'0',wrapAndUnwrapSol:'true'});const packet=await json(`/build?${query}`,{headers:{'x-api-key':env.JUPITER_API_KEY}},fetcher),review=await inspectSiloNoCollectionBuild(packet,terms,connection),checkedAt=now();return Object.freeze({...review,checkedAt,expiresAt:checkedAt+30000,executionMode:mode});}
 const query=new URLSearchParams({inputMint:terms.inputMint,outputMint:terms.outputMint,amount:terms.amount,taker:terms.owner,referralAccount:env.SILO_SWAP_REFERRAL_ACCOUNT,referralFee:String(SILO_SWAP_FEE_BPS),excludeRouters:'jupiterz,dflow,okx',maxSupportedTransactionVersion:'0'});
 const order=await json(`/order?${query}`,{headers:{'x-api-key':env.JUPITER_API_KEY}},fetcher);
 const fee=await verifySiloFeeAccount({referralAccount:env.SILO_SWAP_REFERRAL_ACCOUNT,beneficiary,feeMint:order.feeMint,read});
 const inspected=await inspectSiloJupiterOrder(order,terms,fee,connection),checkedAt=now();
 return Object.freeze({...inspected,checkedAt,expiresAt:checkedAt+30000,executionMode:mode});
}
/** Submit exactly the durable signed bytes. A timeout is uncertain, not a failed swap.
 * No rebuild or re-sign option exists. Provider Success is provisional until chain reconciliation. */
/** @param {any} journal @param {{env?:Record<string,string>,beneficiary?:string,read?:Function,connection?:any,fetcher?:typeof fetch,releaseApproved?:boolean,candidateOnly?:boolean,beforeDispatch?:(()=>Promise<void>)|undefined}} options */
export async function executeSiloJupiterJournal(journal,{env={},beneficiary,read,connection,fetcher=fetch,releaseApproved=false,candidateOnly=false,beforeDispatch=undefined}={}){
 if(beforeDispatch!==undefined&&typeof beforeDispatch!=='function')throw Error('Invalid swap dispatch admission.');
 const mode=configured(env,releaseApproved);runtimePair(siloJupiterExecutionTerms(journal?.terms),{candidateOnly,fetcher,connection,mode,operation:'execute'});if(journal?.submissionApproved===false)throw Error('Stale signed bytes are for reconciliation only.');
 // Sol's review, 29 Oct 2026: the no-collection path returned here, before the final admission hook below ever
 // ran -- the same immediately-before-dispatch check the referral-order path gets must also gate this path.
 // beforeDispatch is passed THROUGH, not called here -- submitSiloNoCollectionBuild runs its own deep
 // verification (re-fetches and rebuilds the exact transaction, compares bytes) before ever calling it, matching
 // where the referral-order path's own beforeDispatch runs (Opus's review, 29 Oct 2026: calling it here, before
 // that verification, could consume a one-shot admission/budget slot for a journal about to be refused anyway).
 if(mode==='no-collection-build'){if(journal?.kind!=='silo-jupiter-build-signed-v1')throw Error('Execution protocol differs.');return submitSiloNoCollectionBuild(journal,{connection,releaseApproved,noCollectionPolicyApproved:true,candidateOnly,readDurable:async()=>journal,beforeDispatch});}
 if(journal?.kind!=='silo-jupiter-signed-v1')throw Error('Execution protocol differs.');
 const tx=decodeSiloJupiterTransaction(journal?.signedTransaction,{signed:true});
 if(journal.network!=='mainnet-beta'||journal.owner!==String(tx.message.staticAccountKeys[0])||journal.signature!==bs58.encode(tx.signatures[0])||journal.blockhash!==tx.message.recentBlockhash||typeof journal.requestId!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(journal.requestId))throw Error('Invalid signed swap journal.');
 const fee=await verifySiloFeeAccount({referralAccount:env.SILO_SWAP_REFERRAL_ACCOUNT,beneficiary,feeMint:journal.order?.feeMint,read});
 const fresh=await inspectSiloJupiterOrder(journal.order,journal.terms,fee,connection);
 const original=decodeSiloJupiterTransaction(fresh.transactionBase64);
 if(journal.requestId!==fresh.requestId||!Buffer.from(original.message.serialize()).equals(Buffer.from(tx.message.serialize())))throw Error('Signed swap differs from its independently checked order.');
 // Sol's review, 29 Oct 2026: an earlier version of this staleness check compared journal.createdAt (set from
 // the signing CLIENT's own clock, in the browser) against this server's now() -- clock skew between the two
 // could make an actually-old journal look fresh (or a fresh one look stale). Checked here instead, right before
 // dispatch (after the admission/verification work above, not only at entry), against the chain's own current
 // height -- server-verified, clock-independent, and the same quantity that actually determines whether this
 // exact signed transaction can still land.
 //
 // Opus's round-5 review: this compared against journal.lastValidBlockHeight -- a raw field taken from the
 // CLIENT-supplied journal and never itself validated before use here (unlike order.lastValidBlockHeight on the
 // prepare path, which inspectSiloJupiterOrder above requires to be a safe integer >=1). A missing or
 // non-numeric journal.lastValidBlockHeight makes `height>journal.lastValidBlockHeight` evaluate to false via
 // ordinary JS NaN comparison semantics -- the exact same silent fail-open this check exists to prevent, reached
 // through a different field. Compared instead against fresh.lastValidBlockHeight, now at least guaranteed to be
 // a well-formed safe integer >=1 by inspectSiloJupiterOrder's own validation above.
 //
 // Opus's round-6 review, correcting the round-5 comment here: fresh.lastValidBlockHeight is NOT an independent
 // fresh lookup against Jupiter or the chain -- inspectSiloJupiterOrder derives it by validating journal.order,
 // which is itself the CLIENT's own submitted order data. A forged journal.order.lastValidBlockHeight therefore
 // still passes the height comparison below; it closes the type-confusion fail-open from round 5 (a malformed
 // value no longer silently passes), but the height comparison alone is not independent of the client. The
 // actual independent check is isBlockhashValid: it asks the Solana RPC directly, using this message's own
 // actual blockhash, whether it can still land -- a value the client cannot forge through the journal. Opus
 // verified this directly: a forged, far-future journal.order.lastValidBlockHeight combined with a real (false)
 // isBlockhashValid result is still refused; forcing isBlockhashValid to report true lets it reach dispatch
 // regardless of the height comparison. isBlockhashValid is therefore the real protection this check provides;
 // the height comparison is kept as a defense-in-depth fast check, not relied on alone, matching this codebase's
 // other pre-dispatch staleness checks (e.g. solana-transfer-review-service.mjs).
 const chainHeight=await connection.getBlockHeight('confirmed');
 if(!Number.isSafeInteger(chainHeight)||chainHeight<0||chainHeight>fresh.lastValidBlockHeight||(await connection.isBlockhashValid(tx.message.recentBlockhash,{commitment:'confirmed'})).value!==true)throw Error('This signed swap is too old to execute (blockhash no longer valid). Prepare and sign a fresh one; do not resend.');
 // Final admission (closed beta, round 8) immediately before the provider is asked to dispatch; a refusal keeps the signed journal.
 if(beforeDispatch)await beforeDispatch();
 try{const result=await json('/execute',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':env.JUPITER_API_KEY},body:JSON.stringify({signedTransaction:journal.signedTransaction,requestId:journal.requestId})},fetcher);
  if(result.signature&&result.signature!==journal.signature)return {status:'unknown',signature:journal.signature};
  return {status:'unknown',signature:journal.signature,providerReported:result.status==='Success'?'success':result.status==='Failed'?'failed':'unknown'};
 }catch{return {status:'unknown',signature:journal.signature};}
}
/** The supplied store must commit durably before transport. Storage failure means nothing is sent. */
export async function persistAndExecuteSiloJupiter(journal,{store,execute}){
 if(!store||typeof store.write!=='function'||typeof store.read!=='function')throw Error('Durable swap storage is required.');
 await store.write(journal);const stored=await store.read();
 if(JSON.stringify(stored)!==JSON.stringify(journal))throw Error('Signed swap storage verification failed. Nothing was sent.');
 return execute(stored);
}
export async function checkSiloJupiterOutcome(journal,{connection}){
 const tx=decodeSiloJupiterTransaction(journal?.signedTransaction,{signed:true});
 if(journal.signature!==bs58.encode(tx.signatures[0])||journal.blockhash!==tx.message.recentBlockhash||await connection.getGenesisHash()!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')throw Error('Swap identity or network differs.');
 const terms=siloJupiterExecutionTerms(journal.terms),original=decodeSiloJupiterTransaction(journal.order?.transaction);
 if(journal.order?.inputMint!==terms.inputMint||journal.order?.outputMint!==terms.outputMint||journal.order?.inAmount!==terms.amount||journal.order?.feeBps!==(journal.kind==='silo-jupiter-build-signed-v1'?0:SILO_SWAP_FEE_BPS)||journal.requestId!==journal.order?.requestId||!Buffer.from(original.message.serialize()).equals(Buffer.from(tx.message.serialize())))throw Error('Swap settlement order differs.');
 const economics=bindSiloHistoricalJupiterTerms(tx,journal.order,terms,{feeBps:journal.kind==='silo-jupiter-build-signed-v1'?0:SILO_SWAP_FEE_BPS});
 const landed=await connection.getTransaction(journal.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
 if(landed){if(!Number.isSafeInteger(landed.slot)||landed.slot<1||!landed.meta||!Object.hasOwn(landed.meta,'err')||(landed.meta.err!==null&&(typeof landed.meta.err!=='object'||Array.isArray(landed.meta.err)))||!Number.isSafeInteger(landed.meta.fee)||landed.meta.fee<0||!landed.transaction||!Array.isArray(landed.transaction.signatures)||landed.transaction.signatures.length!==1||landed.transaction.signatures[0]!==journal.signature||!landed.transaction.message||!Buffer.from(landed.transaction.message.serialize()).equals(Buffer.from(tx.message.serialize())))throw Error('Finalized swap receipt differs.');if(landed.meta.err!==null)return {status:'failed',signature:journal.signature,slot:landed.slot,swapFeeCharged:false,networkFeeRaw:Number.isSafeInteger(landed.meta.fee)&&landed.meta.fee>=0?String(landed.meta.fee):null,fundsState:'Atomic swap changes reverted; finalized network fee may remain charged.'};
  // A successful chain status is not alone proof of the reviewed receive amount.
  bindSiloHistoricalJupiterTerms(tx,journal.order,terms,{feeBps:economics.feeBps,loadedAddresses:landed.meta.loadedAddresses,requireMintIdentity:true});
  const min=BigInt(economics.minimumOutputRaw);
  if(!terms||min<1n)throw Error('Swap settlement terms missing.');
  const owner=terms.owner,delta=(rows,mint)=>rows.filter(x=>x.owner===owner&&x.mint===mint&&x.programId==='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').reduce((sum,x)=>sum+BigInt(x.uiTokenAmount.amount),0n);
  let receivedOutputRaw;
  if(terms.outputMint==='So11111111111111111111111111111111111111112'){
   if(!Number.isSafeInteger(landed.meta.preBalances?.[0])||!Number.isSafeInteger(landed.meta.postBalances?.[0])||!Number.isSafeInteger(landed.meta.fee)||BigInt(landed.meta.postBalances[0])-BigInt(landed.meta.preBalances[0])+BigInt(landed.meta.fee)<min)throw Error('Finalized SOL output is below the review.');
  receivedOutputRaw=String(BigInt(landed.meta.postBalances[0])-BigInt(landed.meta.preBalances[0])+BigInt(landed.meta.fee));
  }else{if(!Array.isArray(landed.meta.preTokenBalances)||!Array.isArray(landed.meta.postTokenBalances))throw Error('Finalized token balance unavailable.');const received=delta(landed.meta.postTokenBalances,terms.outputMint)-delta(landed.meta.preTokenBalances,terms.outputMint);if(received<min)throw Error('Finalized token output is below the review.');receivedOutputRaw=String(received);}
  return {status:'finalized',signature:journal.signature,slot:landed.slot,receivedOutputRaw,networkFeeRaw:Number.isSafeInteger(landed.meta.fee)&&landed.meta.fee>=0?String(landed.meta.fee):null,minimumReceivedVerified:true};}
 // Invalidity proves this message cannot land now, not that it never landed.
 // An RPC with pruned/incomplete history can return null for an earlier finalized payment.
 const valid=await connection.isBlockhashValid(tx.message.recentBlockhash,{commitment:'finalized'});
 if(valid?.value===false){const final=await connection.getTransaction(journal.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(final)return checkSiloJupiterOutcome(journal,{connection});return {status:'unknown',signature:journal.signature,blockhashExpired:true,retry:'held: complete historical absence proof is required'};}
 return {status:'unknown',signature:journal.signature,retry:'identical signed bytes only'};
}
