/** Test-network memecoin trading flow (V1 test-network stage): prepare an exact review, sign it with a durable recovery record,
 * submit, and settle the outcome from the chain. Devnet and local only (cpmm.mjs refuses anything else).
 *
 * One trade at a time per browser: a record is written before the wallet prompt and kept until the chain gives a final
 * answer (finalized, failed, or expired and absent from history). While it exists no new trade is prepared. Submission
 * resends only the exact signed bytes. The receipt comes from the finalized transaction's balance changes, not the quote. */
import '../../browser-buffer.mjs';
import {PublicKey,VersionedTransaction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,NATIVE_MINT,getAssociatedTokenAddressSync,ACCOUNT_SIZE} from '@solana/spl-token';
import {Buffer} from 'buffer';
import {SILO_DEVNET_GENESIS,SILO_DEVNET_TRADE_ROUTES,siloDevnetTradeTerms,buildSiloDevnetTrade,inspectSiloDevnetTrade,decodeCpmmPool,decodeCpmmConfig,quoteCpmmExactIn,memeMintOf} from './cpmm.mjs';

export const SILO_DEVNET_TRADE_JOURNAL_KEY='grain-silo-devnet-trade-pending-v1';
const MAX_RECORD_BYTES=4096,REVIEW_TTL_MS=30000,MAX_FEE_LAMPORTS=10000000n;
const refusal=message=>Object.assign(Error(message),{siloRefusal:true});
const eq=(a,b)=>Buffer.from(a).equals(Buffer.from(b));
const lamports=value=>{if(!Number.isSafeInteger(value)||value<0)throw refusal('Invalid balance or fee.');return BigInt(value);};
const routeOf=(routes,id)=>{const r=routes.find(x=>x.id===id);if(!r)throw refusal('Silo cannot trade this token.');return r;};

/** Everything a quote needs, read in one place; the network is checked first. `genesis` is devnet's unless a local
 * validator's is passed explicitly by a test or script. */
export async function readSiloDevnetTradeState(route,connection,{genesis=SILO_DEVNET_GENESIS}={}){
 if(await connection.getGenesisHash()!==genesis)throw refusal('Solana network verification failed.');
 const [p,c]=await connection.getMultipleAccountsInfo([new PublicKey(route.pool),new PublicKey(route.config)],'confirmed');
 if(!p||!c||p.owner.toBase58()!=='DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb'||c.owner.toBase58()!=='DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb')throw refusal('The pool was not found.');
 const pool=decodeCpmmPool(p.data),config=decodeCpmmConfig(c.data);
 const [a,b]=await Promise.all([pool.vaultA,pool.vaultB].map(v=>connection.getTokenAccountBalance(new PublicKey(v),'confirmed')));
 const slot=await connection.getSlot('confirmed'),chainTime=await connection.getBlockTime(slot);
 return {pool,config,vaultBalanceA:a.value.amount,vaultBalanceB:b.value.amount,chainTime};
}
async function tokenBalance(connection,account){try{return BigInt((await connection.getTokenAccountBalance(account,'confirmed')).value.amount);}catch{return null;}}

/** Builds and checks a review. Input: {network, owner, route, side, amountIn, slippageBps}.
 * @param {any} input @param {{connection: any, routes?: any[], genesis?: string, now?: () => number}} options */
export async function prepareSiloDevnetTrade(input,{connection,routes=SILO_DEVNET_TRADE_ROUTES,genesis,now=()=>Date.now()}={}){
 if(!input||Object.keys(input).some(k=>!['network','owner','route','side','amountIn','slippageBps'].includes(k)))throw refusal('Unexpected trade fields.');
 const route=routeOf(routes,input.route),state=await readSiloDevnetTradeState(route,connection,{genesis});
 const quote=quoteCpmmExactIn({route,...state,side:input.side,amountIn:input.amountIn,slippageBps:input.slippageBps??100});
 const terms=siloDevnetTradeTerms({network:input.network,owner:input.owner,route:route.id,side:input.side,amountIn:quote.amountIn,minAmountOut:quote.minAmountOut},{routes});
 const owner=new PublicKey(terms.owner),meme=new PublicKey(memeMintOf(route)),memeAta=getAssociatedTokenAddressSync(meme,owner,false,TOKEN_PROGRAM_ID),wsolAta=getAssociatedTokenAddressSync(NATIVE_MINT,owner,false,TOKEN_PROGRAM_ID);
 // A pre-existing wrapped-SOL account would be closed by the trade, unwrapping its balance too; that is refused instead.
 if(await connection.getAccountInfo(wsolAta,'confirmed'))throw refusal('Close your wrapped SOL account before trading on this test route.');
 const sol=lamports(await connection.getBalance(owner,'confirmed')),memeBefore=await tokenBalance(connection,memeAta);
 const accountRent=lamports(await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE,'confirmed'));
 const latest=await connection.getLatestBlockhash('confirmed');if(!Number.isSafeInteger(latest.lastValidBlockHeight)||latest.lastValidBlockHeight<1)throw refusal('Missing expiry.');
 const transaction=buildSiloDevnetTrade(terms,latest.blockhash,{routes});inspectSiloDevnetTrade(transaction,{network:terms.network,routes});
 const fee=lamports((await connection.getFeeForMessage(transaction.message,'confirmed')).value);if(fee>MAX_FEE_LAMPORTS)throw refusal('Network fee exceeds limit.');
 // SOL needed during the transaction: the network fee, the temporary wrapped-SOL account (returned at its close), a new
 // memecoin account's rent when buying into a first account, and for a buy the amount itself.
 const newMemeAccount=memeBefore===null,rentKept=terms.side==='buy'&&newMemeAccount?accountRent:0n,needed=fee+accountRent+rentKept+(terms.side==='buy'?BigInt(terms.amountIn):0n);
 if(needed>sol)throw refusal('Insufficient SOL for the amount, the network fee and account rent.');
 if(terms.side==='sell'&&(memeBefore??0n)<BigInt(terms.amountIn))throw refusal(`Insufficient ${route.symbol} for this amount.`);
 const simulation=await connection.simulateTransaction(transaction,{sigVerify:false,commitment:'confirmed'});
 if(simulation.value.err)throw refusal('Trade simulation failed.');
 const checkedAt=now();
 return Object.freeze({terms,route:Object.freeze({id:route.id,symbol:route.symbol,label:route.label,decimals:route.decimals}),quote,networkFeeRaw:fee.toString(),accountRentRaw:accountRent.toString(),
  rentKeptRaw:rentKept.toString(),solBeforeRaw:sol.toString(),memeBeforeRaw:memeBefore?.toString()??'0',transactionBase64:Buffer.from(transaction.serialize()).toString('base64'),
  lastValidBlockHeight:latest.lastValidBlockHeight,checkedAt,expiresAt:checkedAt+REVIEW_TTL_MS});
}

// ---- The recovery record ----------------------------------------------------------------------------------------
function validRecord(row,routes){
 if(!row||row.version!==1||!['signing','signed'].includes(row.state)||typeof row.wire!=='string'||row.wire.length>1644||!Number.isSafeInteger(row.lastValidBlockHeight)||!Number.isSafeInteger(row.createdAt)||typeof row.promptStarted!=='boolean')throw Error('Saved trade record differs.');
 const bytes=Buffer.from(row.wire,'base64');if(bytes.toString('base64')!==row.wire)throw Error('Saved trade record differs.');
 const checked=inspectSiloDevnetTrade(VersionedTransaction.deserialize(bytes),{network:row.network,signed:row.state==='signed',routes});
 if(checked.terms.owner!==row.owner||JSON.stringify(checked.terms)!==JSON.stringify(row.terms)||(row.state==='signed'?checked.signature!==row.signature:row.signature!==null))throw Error('Saved trade record differs.');
 return row;
}
/** @param {any} storage @param {{routes?: any[]}} [options] */
export function readSiloDevnetTradeJournal(storage,{routes=SILO_DEVNET_TRADE_ROUTES}={}){
 const text=storage.getItem(SILO_DEVNET_TRADE_JOURNAL_KEY);if(text===null)return null;
 if(new TextEncoder().encode(text).length>MAX_RECORD_BYTES)throw Error('Saved trade record exceeds its bound.');
 return validRecord(JSON.parse(text),routes);
}
const persist=(storage,row,routes)=>{validRecord(row,routes);const text=JSON.stringify(row);if(new TextEncoder().encode(text).length>MAX_RECORD_BYTES)throw Error('Saved trade record exceeds its bound.');storage.setItem(SILO_DEVNET_TRADE_JOURNAL_KEY,text);return row;};

/** Signs the exact reviewed bytes. The record is written before the wallet prompt; the returned signature is checked against
 * the approved message before it is kept. Caller holds the exclusive payment lock.
 * @param {any} review @param {{storage: any, wallet: any, connection: any, routes?: any[], now?: () => number, assertCurrent?: () => void}} options */
export async function signSiloDevnetTrade(review,{storage,wallet,connection,routes=SILO_DEVNET_TRADE_ROUTES,now=()=>Date.now(),assertCurrent=()=>{}}={}){
 assertCurrent();if(readSiloDevnetTradeJournal(storage,{routes}))throw refusal('Resolve the saved trade before another one.');
 if(!review||!Number.isSafeInteger(review.expiresAt)||now()>=review.expiresAt)throw refusal('Trade review expired.');
 const original=VersionedTransaction.deserialize(Buffer.from(review.transactionBase64,'base64')),checked=inspectSiloDevnetTrade(original,{network:review.terms.network,routes});
 if(JSON.stringify(checked.terms)!==JSON.stringify(review.terms)||wallet.publicKey?.toBase58()!==checked.terms.owner)throw refusal('Wallet or trade terms changed.');
 if(await connection.getBlockHeight('confirmed')>review.lastValidBlockHeight)throw refusal('Trade review expired.');
 assertCurrent();
 const base={version:1,network:review.terms.network,owner:review.terms.owner,terms:review.terms,lastValidBlockHeight:review.lastValidBlockHeight,createdAt:now()};
 persist(storage,{...base,state:'signing',promptStarted:false,signature:null,wire:review.transactionBase64},routes);
 persist(storage,{...base,state:'signing',promptStarted:true,signature:null,wire:review.transactionBase64},routes);
 const signed=await wallet.signTransaction(VersionedTransaction.deserialize(Buffer.from(review.transactionBase64,'base64')));
 if(!signed?.message||!eq(original.message.serialize(),signed.message.serialize()))throw refusal('Wallet changed the trade. Silo did not submit the changed bytes.');
 const result=inspectSiloDevnetTrade(signed,{network:review.terms.network,signed:true,routes});
 return persist(storage,{...base,state:'signed',promptStarted:true,signature:result.signature,wire:Buffer.from(signed.serialize()).toString('base64')},routes);
}
/** A reservation whose wallet prompt never started can be cancelled; any other record stays until settled. */
/** @param {any} storage @param {{routes?: any[]}} [options] */
export function cancelUnpromptedSiloDevnetTrade(storage,{routes=SILO_DEVNET_TRADE_ROUTES}={}){
 const row=readSiloDevnetTradeJournal(storage,{routes});if(row?.state!=='signing'||row.promptStarted!==false)throw refusal('A wallet prompt may have started; this trade record cannot be cancelled.');
 storage.removeItem(SILO_DEVNET_TRADE_JOURNAL_KEY);
}
/** Sends the exact saved bytes. Safe to repeat: the same signature can land at most once.
 * @param {any} storage @param {any} connection @param {{routes?: any[]}} [options] */
export async function submitSiloDevnetTrade(storage,connection,{routes=SILO_DEVNET_TRADE_ROUTES}={}){
 const row=readSiloDevnetTradeJournal(storage,{routes});if(row?.state!=='signed')throw refusal('No signed trade is waiting.');
 if(await connection.getBlockHeight('confirmed')>row.lastValidBlockHeight)throw refusal('This trade expired before submission. Check its outcome.');
 const signature=await connection.sendRawTransaction(Buffer.from(row.wire,'base64'),{skipPreflight:false,maxRetries:0,preflightCommitment:'confirmed'});
 if(signature!==row.signature)throw Error('The network returned a different signature.');
 return row.signature;
}

/** Settles the saved trade from the chain. Finalized and failed trades return their receipt from the transaction itself; an
 * expired trade is released only when its blockhash can no longer land and history search finds no record of it.
 * @param {any} storage @param {any} connection @param {{routes?: any[]}} [options] @returns {Promise<{state: string, receipt?: any}>} */
export async function reconcileSiloDevnetTrade(storage,connection,{routes=SILO_DEVNET_TRADE_ROUTES}={}){
 const row=readSiloDevnetTradeJournal(storage,{routes});if(!row)return {state:'none'};
 if(row.state==='signing')return {state:row.promptStarted?'prompt-unresolved':'reserved'};
 const status=(await connection.getSignatureStatuses([row.signature],{searchTransactionHistory:true})).value[0];
 if(status?.confirmationStatus==='finalized'){
  const tx=await connection.getTransaction(row.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(!tx?.meta)return {state:'finalized-unread'};
  const receipt=receiptOf(row,tx,routes);storage.removeItem(SILO_DEVNET_TRADE_JOURNAL_KEY);return {state:tx.meta.err?'failed':'finalized',receipt};
 }
 if(status)return {state:status.err?'failed-unfinalized':(status.confirmationStatus??'processed')};
 const height=await connection.getBlockHeight('finalized');
 if(height>row.lastValidBlockHeight){
  // The blockhash expired at finalized height; a second history lookup after that still finds nothing.
  const again=(await connection.getSignatureStatuses([row.signature],{searchTransactionHistory:true})).value[0];
  if(!again){storage.removeItem(SILO_DEVNET_TRADE_JOURNAL_KEY);return {state:'expired-unlanded'};}
  return {state:again.confirmationStatus??'processed'};
 }
 return {state:'unknown'};
}
/** Actual balance changes for the owner, from the finalized transaction (not from the quote). */
export function receiptOf(row,tx,routes=SILO_DEVNET_TRADE_ROUTES){
 const route=routeOf(routes,row.terms.route),meme=memeMintOf(route),keys=tx.transaction.message.staticAccountKeys??tx.transaction.message.accountKeys,ownerIndex=keys.findIndex(k=>k.toBase58()===row.owner);
 if(ownerIndex!==0)throw Error('Unexpected fee payer in the saved trade.');
 const token=list=>BigInt((list??[]).find(b=>b.owner===row.owner&&b.mint===meme)?.uiTokenAmount.amount??'0');
 const memeDelta=token(tx.meta.postTokenBalances)-token(tx.meta.preTokenBalances),solDelta=BigInt(tx.meta.postBalances[0])-BigInt(tx.meta.preBalances[0]);
 return Object.freeze({signature:row.signature,side:row.terms.side,failed:tx.meta.err!==null,networkFeeRaw:String(tx.meta.fee),memeDeltaRaw:memeDelta.toString(),solDeltaRaw:solDelta.toString(),
  minAmountOutRaw:row.terms.minAmountOut,amountInRaw:row.terms.amountIn});
}
