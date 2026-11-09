/** Narrow, opt-in Jupiter V2 execution candidate. Not wired to a live wallet screen.
 * Only route_v2 / one Raydium CP or CLMM leg / source-controlled classic SPL pairs are decoded.
 * Unknown instructions, RFQ signatures, split routes and account layouts fail closed. */
import '../browser-buffer.mjs';
import {Buffer} from 'buffer';
import {PublicKey,VersionedTransaction,TransactionMessage,SystemProgram,ComputeBudgetProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,unpackAccount,unpackMint,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createSyncNativeInstruction,createCloseAccountInstruction,ACCOUNT_SIZE} from '@solana/spl-token';
import * as raydium from '@raydium-io/raydium-sdk-v2';
import {sha256} from '@noble/hashes/sha256';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {resolveTransactionAddresses,transactionAddressKeys} from '../transaction-addresses.mjs';
import {SILO_SOL_MINT,verifySiloFeeAccount} from './swap-referral.mjs';
import {SILO_SOLANA_GENESIS} from './solana-transfer.mjs';
import {SILO_SWAP_FEE_BPS} from './swap-policy.mjs';
import {inspectSiloClmmAccounts} from './jupiter-clmm-route.mjs';
import {assertSiloAdmittedJupiterPair,siloJupiterTokenPolicy,SILO_WIF_CLMM_POOL} from './jupiter-route-policy.mjs';
import {decodeRouteV2Steps} from '../jupiter-route-v2.mjs';
const JUP='JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',EVENT='D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf';
const CP=String(raydium.CREATE_CPMM_POOL_PROGRAM),AUTH=String(raydium.CREATE_CPMM_POOL_AUTH);
const key=x=>new PublicKey(x),eq=(a,b)=>Buffer.from(a).equals(Buffer.from(b)),hash=bytes=>Buffer.from(sha256(bytes)).toString('hex');
const raw=ix=>JSON.stringify({program:String(ix.programId),keys:ix.keys.map(k=>String(k.pubkey)),data:Buffer.from(ix.data).toString('hex')});
const fail=()=>{throw Error('This Jupiter route is not independently supported. Nothing was signed or sent.');};
// Opus's review, 29 Oct 2026: the existing 300bps slippage cap (checked on the raw swap instruction below) bounds
// how much WORSE than the quoted price a trade may execute at -- it says nothing about the quoted price itself
// being far from a fair/reference price for a thin pool. Jupiter's own order response carries price impact in
// TWO fields with different units -- confirmed live, 29 Oct 2026, on the same real order:
// priceImpactPct:"0.00011869547020482443" (a RATIO: 1.0 would mean 100%) vs priceImpact:0.011869547020482443
// (PERCENTAGE POINTS: 0.0119 means 0.0119%) -- priceImpact is exactly priceImpactPct*100. An earlier version of
// this check used priceImpactPct but treated it as already being a percentage (comparing value*100 against a
// 300-bps threshold), making the effective cap 300% instead of 3% -- caught by Opus's review, confirmed by this
// live comparison, not assumed from either field's name alone. Using priceImpact (the field this codebase's own
// jupiter-managed-review.mjs already documents as "percentage points", consistent with its own 3% threshold
// there) avoids the ambiguity entirely: compared directly against a percentage-points cap, no unit conversion.
export const SILO_JUPITER_MAX_PRICE_IMPACT_PERCENT=3;
function withinPriceImpactCap(priceImpact){
 if(typeof priceImpact!=='number'||!Number.isFinite(priceImpact))return false;
 return Math.abs(priceImpact)<=SILO_JUPITER_MAX_PRICE_IMPACT_PERCENT;
}
export function decodeSiloJupiterTransaction(encoded,{signed=false}={}){
 if(typeof encoded!=='string'||encoded.length>1644||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))fail();
 const bytes=Buffer.from(encoded,'base64');if(bytes.toString('base64')!==encoded||bytes.length>1232)fail();
 const tx=VersionedTransaction.deserialize(bytes);
 if(tx.message.version!==0||tx.message.header.numRequiredSignatures!==1||tx.signatures.length!==1||tx.signatures[0].length!==64)fail();
 if(signed?!nacl.sign.detached.verify(tx.message.serialize(),tx.signatures[0],tx.message.staticAccountKeys[0].toBytes()):tx.signatures[0].some(Boolean))fail();
 return tx;
}
export function siloJupiterExecutionTerms(input){
 assertSiloAdmittedJupiterPair(input);
 if(!input||Object.keys(input).some(k=>!['network','owner','inputMint','outputMint','amount'].includes(k))||input.network!=='solana:mainnet-beta'||new Set([input.inputMint,input.outputMint]).size!==2||typeof input.amount!=='string'||!/^[1-9]\d{0,19}$/.test(input.amount)||BigInt(input.amount)>18446744073709551615n)fail();
 const owner=key(input.owner);if(String(owner)!==input.owner||!PublicKey.isOnCurve(owner.toBytes()))fail();
 return Object.freeze({...input});
}
/** Validates actual instructions and independently read pool/vault accounts, not labels or simulation claims. */
export async function inspectSiloJupiterOrder(order,terms,feeAccount,connection,{noCollectionBuild=false}={}){
 const expectedFeeBps=noCollectionBuild?0:SILO_SWAP_FEE_BPS;
 terms=siloJupiterExecutionTerms(terms);
 if(noCollectionBuild&&(feeAccount.address!==JUP||feeAccount.referralAccount!==undefined||feeAccount.mint!==undefined||order.referralAccount!==undefined||order.feeMint!==undefined))fail();
 if(await connection.getGenesisHash()!==SILO_SOLANA_GENESIS['mainnet-beta'])fail();
 // The no-collection-build path assembles its own transaction from a /build packet, which -- unlike a real
 // /order response -- carries no priceImpactPct of its own in this codebase's current flow (no prior /quote call
 // precedes it to supply one); the check below is skipped only there, never for a real provider order, which
 // (confirmed live, 29 Oct 2026) always includes the field.
 if(!order||order.errorCode!=null||order.router!=='metis'||order.gasless!==false||order.transactionVersion!==0||order.taker!==terms.owner||order.signatureFeePayer!==terms.owner||order.inputMint!==terms.inputMint||order.outputMint!==terms.outputMint||order.inAmount!==terms.amount||order.swapMode!=='ExactIn'||order.feeBps!==expectedFeeBps||order.referralAccount!==feeAccount.referralAccount||order.feeMint!==feeAccount.mint||feeAccount.registered!==true||!/^[1-9]\d{0,19}$/.test(order.outAmount)||!/^[1-9]\d{0,19}$/.test(order.otherAmountThreshold)||BigInt(order.outAmount)>18446744073709551615n||BigInt(order.otherAmountThreshold)<1n||BigInt(order.otherAmountThreshold)>BigInt(order.outAmount)||!Array.isArray(order.routePlan)||order.routePlan.length!==1||(!noCollectionBuild&&!withinPriceImpactCap(order.priceImpact)))fail();
 const lastValidBlockHeight=typeof order.lastValidBlockHeight==='string'&&/^[1-9]\d{0,15}$/.test(order.lastValidBlockHeight)?Number(order.lastValidBlockHeight):order.lastValidBlockHeight;
 if(typeof order.requestId!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(order.requestId)||!Number.isSafeInteger(lastValidBlockHeight)||lastValidBlockHeight<1)fail();
 const tx=decodeSiloJupiterTransaction(order.transaction);
 if(String(tx.message.staticAccountKeys[0])!==terms.owner)fail();
 const context=await resolveTransactionAddresses(connection,tx,{minContextSlot:1});transactionAddressKeys(tx,context);
 // Decompile uses the same verified mapping, never provider-supplied loaded addresses.
 const instructions=TransactionMessage.decompile(tx.message,{accountKeysFromLookups:{writable:context.loadedWritable.map(key),readonly:context.loadedReadonly.map(key)}}).instructions;
 for(const mintAddress of [terms.inputMint,terms.outputMint]){const address=key(mintAddress),info=await connection.getAccountInfo(address,'confirmed');if(!info||info.executable||!info.owner.equals(TOKEN_PROGRAM_ID))fail();const mint=unpackMint(address,info,TOKEN_PROGRAM_ID);if(!mint.isInitialized||mint.decimals!==siloJupiterTokenPolicy(mintAddress).decimals||info.data.length!==82)fail();if((mintAddress===SILO_SOL_MINT||siloJupiterTokenPolicy(mintAddress).kind==='memecoin')&&(mint.mintAuthority||mint.freezeAuthority))fail();}
 const owner=key(terms.owner),input=key(terms.inputMint),output=key(terms.outputMint),source=getAssociatedTokenAddressSync(input,owner),destination=getAssociatedTokenAddressSync(output,owner),wsol=getAssociatedTokenAddressSync(key(SILO_SOL_MINT),owner);
 const swaps=instructions.filter(ix=>String(ix.programId)===JUP);if(swaps.length!==1)fail();
 const swap=swaps[0],steps=decodeRouteV2Steps(swap.data),d=Buffer.from(swap.data),leg=order.routePlan[0];
 if([terms.inputMint,terms.outputMint].some(m=>siloJupiterTokenPolicy(m).kind==='memecoin')&&(steps[0]?.tag!==26||leg.swapInfo?.ammKey!==SILO_WIF_CLMM_POOL))fail();
 if(steps.length!==1||![26,46].includes(steps[0].tag)||steps[0].bps!==10000||steps[0].input!==0||steps[0].output!==1||d.readBigUInt64LE(8)!==BigInt(terms.amount)||d.readBigUInt64LE(16)!==BigInt(order.outAmount)||d.readUInt16LE(26)!==expectedFeeBps||d.readUInt16LE(28)!==0||d.readUInt16LE(24)>300||BigInt(order.outAmount)*BigInt(10000-d.readUInt16LE(24))/10000n!==BigInt(order.otherAmountThreshold)||leg.bps!==10000||leg.swapInfo?.label!==(steps[0].tag===26?'Raydium CLMM':'Raydium CP')||leg.swapInfo.inputMint!==terms.inputMint||leg.swapInfo.outputMint!==terms.outputMint)fail();
 if(steps[0].tag===26){await inspectSiloClmmAccounts({swap,leg,terms,feeAccount,source,destination,noCollectionBuild,connection});}else{
 if(swap.keys.length!==24)fail();
 const pool=swap.keys[14].pubkey,pi=await connection.getAccountInfo(pool,'confirmed');
 if(!pi||String(pi.owner)!==CP||pi.executable||pi.data.length!==raydium.CpmmPoolInfoLayout.span||String(pool)!==leg.swapInfo.ammKey)fail();
 const p=raydium.CpmmPoolInfoLayout.decode(pi.data),a=String(p.mintA)===terms.inputMint;
 if(new Set([String(p.mintA),String(p.mintB)]).size!==2||![String(p.mintA),String(p.mintB)].every(m=>[terms.inputMint,terms.outputMint].includes(m))||String(p.mintProgramA)!==String(TOKEN_PROGRAM_ID)||String(p.mintProgramB)!==String(TOKEN_PROGRAM_ID)||p.status!==0||p.enableCreatorFee)fail();
 const program=key(CP),derived=raydium.getCpmmPdaPoolId(program,p.configId,p.mintA,p.mintB);
 if(!derived.publicKey.equals(pool)||raydium.getPdaPoolAuthority(program).nonce!==p.bump||!raydium.getPdaVault(program,pool,p.mintA).publicKey.equals(p.vaultA)||!raydium.getPdaVault(program,pool,p.mintB).publicKey.equals(p.vaultB)||!raydium.getPdaObservationId(program,pool).publicKey.equals(p.observationId))fail();
 const ci=await connection.getAccountInfo(p.configId,'confirmed'),oi=await connection.getAccountInfo(p.observationId,'confirmed');
 if(!ci||String(ci.owner)!==CP||ci.executable||ci.data.length!==raydium.CpmmConfigInfoLayout.span||!oi||String(oi.owner)!==CP||oi.executable)fail();
 const config=raydium.CpmmConfigInfoLayout.decode(ci.data);
 if(!raydium.getCpmmPdaAmmConfigId(program,config.index).publicKey.equals(p.configId)||BigInt(config.tradeFeeRate.toString())>10000n)fail();
 const vin=a?p.vaultA:p.vaultB,vout=a?p.vaultB:p.vaultA;
 const expected=[terms.owner,String(source),String(destination),terms.inputMint,terms.outputMint,String(TOKEN_PROGRAM_ID),String(TOKEN_PROGRAM_ID),feeAccount.address,EVENT,JUP,CP,terms.owner,AUTH,String(p.configId),String(pool),String(source),String(destination),String(vin),String(vout),String(TOKEN_PROGRAM_ID),String(TOKEN_PROGRAM_ID),terms.inputMint,terms.outputMint,String(p.observationId)];
 if(swap.keys.some((k,i)=>String(k.pubkey)!==expected[i]||k.isSigner!==(i===0||i===11)))fail();
 const writable=new Set([0,1,2,...(noCollectionBuild?[]:[7]),11,14,15,16,17,18,23]);if(swap.keys.some((k,i)=>k.isWritable!==writable.has(i)))fail();
 for(const [address,mint] of [[vin,input],[vout,output]]){const ai=await connection.getAccountInfo(address,'confirmed'),account=ai&&unpackAccount(address,ai,TOKEN_PROGRAM_ID);if(!account||!account.owner.equals(key(AUTH))||!account.mint.equals(mint)||account.delegate||account.closeAuthority||account.isFrozen)fail();}
 }
 // Canonical setup only: no arbitrary transfers, approvals, extra destinations or account closures.
 const allowed=[createAssociatedTokenAccountIdempotentInstruction(owner,source,owner,input),createAssociatedTokenAccountIdempotentInstruction(owner,destination,owner,output),createSyncNativeInstruction(wsol),createCloseAccountInstruction(wsol,owner,owner)];
 if(terms.inputMint===SILO_SOL_MINT)allowed.push(SystemProgram.transfer({fromPubkey:owner,toPubkey:wsol,lamports:BigInt(terms.amount)}));
 const seen=new Set();let units=false,price=false;const swapAt=instructions.indexOf(swap);
 for(let i=0;i<instructions.length;i++){const ix=instructions[i];if(ix===swap)continue;
  if(ix.programId.equals(ComputeBudgetProgram.programId)){if(i>swapAt)fail();if(ix.data.length===5&&ix.data[0]===2&&!units&&ix.data.readUInt32LE(1)<=1400000){units=true;continue;}if(ix.data.length===9&&ix.data[0]===3&&!price&&ix.data.readBigUInt64LE(1)<=100000n){price=true;continue;}fail();}
  const at=allowed.findIndex(x=>raw(x)===raw(ix));if(at<0||seen.has(at))fail();seen.add(at);
  if((at===3)!==(i>swapAt))fail();
 }
 if(!seen.has(2)||!seen.has(3)||(terms.inputMint===SILO_SOL_MINT&&!seen.has(4)))fail();
 const wi=await connection.getAccountInfo(wsol,'confirmed');if(wi)fail(); // closing an existing WSOL account is outside this narrow consent
 const networkFee=(await connection.getFeeForMessage(tx.message,'confirmed')).value;if(!Number.isSafeInteger(networkFee)||networkFee<0||networkFee>10000000)fail();
 let rent=0n;for(const [address,mint,index] of [[source,input,0],[destination,output,1]]){
  const info=await connection.getAccountInfo(address,'confirmed');
  if(!info){if(!seen.has(index)||String(mint)!==SILO_SOL_MINT&&index===0)fail();const cost=await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE,'confirmed');if(!Number.isSafeInteger(cost)||cost<1)fail();rent+=BigInt(cost);}
  else{const account=unpackAccount(address,info,TOKEN_PROGRAM_ID);if(!account.owner.equals(owner)||!account.mint.equals(mint)||account.isFrozen||account.delegate||account.closeAuthority||index===0&&account.amount<BigInt(terms.amount))fail();}
 }
 const debit=BigInt(networkFee)+rent+(terms.inputMint===SILO_SOL_MINT?BigInt(terms.amount):0n),available=await connection.getBalance(owner,'confirmed');if(!Number.isSafeInteger(available)||BigInt(available)<debit)fail();
 const sim=await connection.simulateTransaction(tx,{sigVerify:false,commitment:'confirmed'});if(sim?.value?.err!==null)fail();
 return Object.freeze({terms,transactionBase64:order.transaction,requestId:order.requestId,messageHash:hash(tx.message.serialize()),addressFingerprint:context.fingerprint,lastValidBlockHeight,expectedOutputRaw:order.outAmount,minimumOutputRaw:order.otherAmountThreshold,feeAccount:feeAccount.address,feeBps:expectedFeeBps,networkFeeRaw:String(networkFee),rentRaw:String(rent),maximumSolDebitRaw:String(debit),supportedRoute:`${siloJupiterTokenPolicy(terms.inputMint).kind}↔${siloJupiterTokenPolicy(terms.outputMint).kind} / single ${leg.swapInfo.label} / classic SPL`,order:JSON.parse(JSON.stringify(order))});
}
/** Provider order transport. Calling this can create a provider order; runtime remains unconnected until acceptance. */
export async function signSiloJupiterReview(review,{wallet,connection,read,beneficiary,referralAccount,now=Date.now,assertCurrent=()=>{}}){
 assertCurrent();if(!review||!Number.isSafeInteger(review.expiresAt)||now()>review.expiresAt||wallet.publicKey?.toBase58()!==review.terms.owner)fail();
 const build=review.executionMode==='no-collection-build';
 const fresh=build?await (await import('./jupiter-build-execution.mjs')).inspectSiloNoCollectionBuild(review.packet,review.terms,connection):await inspectSiloJupiterOrder(review.order,review.terms,await verifySiloFeeAccount({referralAccount,beneficiary,feeMint:review.order?.feeMint,read}),connection);
 if(['transactionBase64','networkFeeRaw','rentRaw','maximumSolDebitRaw','requestId','lastValidBlockHeight','expectedOutputRaw','minimumOutputRaw','feeAccount','feeBps','messageHash','addressFingerprint'].some(name=>fresh[name]!==review[name]))fail();
 const tx=decodeSiloJupiterTransaction(review.transactionBase64),message=Uint8Array.from(tx.message.serialize());if(hash(message)!==review.messageHash||await connection.getGenesisHash()!==SILO_SOLANA_GENESIS['mainnet-beta']||await connection.getBlockHeight('confirmed')>review.lastValidBlockHeight)fail();
 const ctx=await resolveTransactionAddresses(connection,tx,{minContextSlot:1});if(ctx.fingerprint!==review.addressFingerprint)fail();
 const sim=await connection.simulateTransaction(tx,{sigVerify:false,commitment:'confirmed'});if(sim?.value?.err!==null||now()>review.expiresAt)fail();
 assertCurrent();const signed=await wallet.signTransaction(tx);assertCurrent();
 if(now()>review.expiresAt||wallet.publicKey?.toBase58()!==review.terms.owner||!eq(message,signed.message.serialize())||await connection.getBlockHeight('confirmed')>review.lastValidBlockHeight)fail();
 const encoded=Buffer.from(signed.serialize()).toString('base64'),checked=decodeSiloJupiterTransaction(encoded,{signed:true});
 return {kind:build?'silo-jupiter-build-signed-v1':'silo-jupiter-signed-v1',...(build?{packet:review.packet,executionMode:'no-collection-build'}:{}),network:'mainnet-beta',owner:review.terms.owner,requestId:review.requestId,signedTransaction:encoded,signature:bs58.encode(checked.signatures[0]),blockhash:checked.message.recentBlockhash,lastValidBlockHeight:review.lastValidBlockHeight,messageHash:review.messageHash,createdAt:now(),terms:review.terms,order:review.order};
}
