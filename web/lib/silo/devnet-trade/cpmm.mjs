/** Test-network memecoin trading through Raydium's CPMM program (V1 test-network stage, 19 October 2026).
 *
 * Jupiter, the V1 trading route, runs on mainnet only. On devnet (and on a local validator that clones the devnet program)
 * Silo trades a Silo test memecoin against SOL through one pinned CPMM pool. This module is devnet/local only: it refuses
 * any other network, and it shares no code or gate with the Jupiter execution path.
 *
 * Shape follows the native transfer (solana-transfer.mjs): typed terms → one deterministic transaction layout → an inspector
 * that rebuilds the layout from the decoded terms and accepts only identical message bytes. Nothing here signs or submits.
 * Quotes use the program's own integer rules: trade fee rounded up, output rounded down, reserves net of accrued fees. */
import '../../browser-buffer.mjs';
import {PublicKey,SystemProgram,ComputeBudgetProgram,TransactionMessage,VersionedTransaction,TransactionInstruction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,NATIVE_MINT,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createSyncNativeInstruction,createCloseAccountInstruction} from '@solana/spl-token';
import {Buffer} from 'buffer';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const refusal=message=>Object.assign(Error(message),{siloRefusal:true});
const key=value=>{let k;try{k=new PublicKey(value);}catch{throw refusal('Invalid Solana address.');}if(k.toBase58()!==value)throw refusal('Invalid Solana address.');return k;};
const eq=(a,b)=>Buffer.from(a).equals(Buffer.from(b));
const u64=value=>{if(typeof value!=='string'||!/^(0|[1-9]\d{0,19})$/.test(value)||BigInt(value)>18446744073709551615n)throw refusal('Invalid amount.');return BigInt(value);};

/** Devnet genesis, and the local validator's, which differs per run and is passed in explicitly by tests and scripts. */
export const SILO_DEVNET_GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const SILO_CPMM_PROGRAM_ID='DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb';
/** PDA of the program with seed "vault_and_lp_mint_auth_seed" (checked in tests). */
export const SILO_CPMM_AUTHORITY='CXniRufdq5xL8t8jZAPxsPZDpuudwuJSPWnbcD5Y5Nxq';
const SWAP_BASE_INPUT=Uint8Array.from([143,190,90,218,196,30,51,222]);
const POOL_DISCRIMINATOR=Uint8Array.from([247,237,227,245,215,195,222,70]);
const CONFIG_DISCRIMINATOR=Uint8Array.from([218,244,33,104,203,203,43,111]);
const FEE_DENOMINATOR=1000000n;
/** Compute budget: fixed limit, zero priority price on test networks. */
export const SILO_DEVNET_TRADE_COMPUTE_UNITS=300000;
export const SILO_DEVNET_TRADE_MAX_SLIPPAGE_BPS=500;

/** Pinned routes. A route names one pool and every account the swap touches; anything else is refused. Entries are added by
 * the pool script (scripts/silo/devnet-trade-pool.mjs) after a pool is created and checked; the local-validator route is
 * created per test run and passed in explicitly, never added here. */
export const SILO_DEVNET_TRADE_ROUTES=Object.freeze([
 // Created on devnet 19 October 2026 (create signature 4vS62YZ1G44hJhdErYpuwzgm3zJdmNLuGfo7t5ns5tTdrESKrZSN7R4NACykYp8MWAFhUDwc69k4uA7C57CQcvwL).
 // Mint checked after creation: no mint authority, no freeze authority, 6 decimals, supply 1,000,000,000.
 Object.freeze({id:'devnet-silotest-sol',network:'devnet',label:'Silo test memecoin (test network only)',symbol:'SILOTEST',decimals:6,
  pool:'C668WaCBWutxmnSgi8E1Sufr6AwDDkEnJJxNjn3R6cQp',config:'5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy',
  vaultA:'FPVF89GyE2pExyeJMbkWXZwdL22V1iF5FRCrkkF3smha',vaultB:'Bubkkv8urRzb94vJ8CdoPne4gVhnfAKp1gKomm7XDFJZ',
  mintA:'So11111111111111111111111111111111111111112',mintB:'21LkdPSMD7iwqRjT2RzY1BeVv5BUQcSLYE2QnRMCWiwR',
  observation:'7uvJ5hvafvnzYrH72pmEWRPGeKNw4pcnkash7wjEiYRd',lpMint:'2ba1aJcasXu2Zb2AtskboaLv6ukbHWijsLSyNnYucsby'}),
]);

function routeOf(route){
 const fields=['id','network','label','symbol','decimals','pool','config','vaultA','vaultB','mintA','mintB','observation','lpMint'];
 if(!route||Object.keys(route).some(k=>!fields.includes(k))||fields.some(k=>route[k]===undefined))throw refusal('Unknown trading route.');
 if(!['devnet','local'].includes(route.network)||!/^[a-z0-9-]{3,40}$/.test(route.id)||typeof route.label!=='string'||!/^[A-Z0-9]{2,10}$/.test(route.symbol)||!Number.isInteger(route.decimals)||route.decimals<0||route.decimals>9)throw refusal('Unknown trading route.');
 const r={...route};for(const k of ['pool','config','vaultA','vaultB','mintA','mintB','observation','lpMint'])r[k]=key(route[k]).toBase58();
 // A pool orders its two mints by key; exactly one of them is wrapped SOL.
 if(Buffer.compare(key(r.mintA).toBuffer(),key(r.mintB).toBuffer())>=0||[r.mintA,r.mintB].filter(m=>m===NATIVE_MINT.toBase58()).length!==1)throw refusal('Unknown trading route.');
 return Object.freeze(r);
}
/** The test memecoin of a route (the side that is not wrapped SOL). */
export const memeMintOf=route=>routeOf(route).mintA===NATIVE_MINT.toBase58()?route.mintB:route.mintA;

/** @param {any} input @param {{routes?: any[]}} [options] */
export function siloDevnetTradeTerms(input,{routes=SILO_DEVNET_TRADE_ROUTES}={}){
 const fields=['network','owner','route','side','amountIn','minAmountOut'];
 if(!input||Object.keys(input).some(k=>!fields.includes(k))||fields.some(k=>input[k]===undefined))throw refusal('Unexpected trade fields.');
 if(!['devnet','local'].includes(input.network))throw refusal('Test-network trading is available on devnet only.');
 const route=routes.find(r=>r.id===input.route);if(!route)throw refusal('Silo cannot trade this token.');
 const r=routeOf(route);if(r.network!==input.network)throw refusal('This route belongs to another network.');
 const owner=key(input.owner);if(!PublicKey.isOnCurve(owner.toBytes()))throw refusal('Invalid owner.');
 if(!['buy','sell'].includes(input.side))throw refusal('Choose buy or sell.');
 if(u64(input.amountIn)<1n)throw refusal('Enter an amount.');
 if(u64(input.minAmountOut)<1n)throw refusal('The minimum received must be above zero.');
 return Object.freeze({network:input.network,owner:owner.toBase58(),route:r.id,side:input.side,amountIn:input.amountIn,minAmountOut:input.minAmountOut});
}

/** buy: SOL → memecoin; sell: memecoin → SOL. Every account and instruction is fixed by the terms and the route.
 * @param {any} input @param {string} blockhash @param {{routes?: any[]}} [options] */
export function buildSiloDevnetTrade(input,blockhash,{routes=SILO_DEVNET_TRADE_ROUTES}={}){
 const t=siloDevnetTradeTerms(input,{routes}),r=routeOf(routes.find(x=>x.id===t.route)),owner=key(t.owner);key(blockhash);
 const sol=NATIVE_MINT,meme=key(memeMintOf(r)),wsolAta=getAssociatedTokenAddressSync(sol,owner,false,TOKEN_PROGRAM_ID),memeAta=getAssociatedTokenAddressSync(meme,owner,false,TOKEN_PROGRAM_ID);
 const solIsA=r.mintA===sol.toBase58(),solVault=key(solIsA?r.vaultA:r.vaultB),memeVault=key(solIsA?r.vaultB:r.vaultA);
 const buy=t.side==='buy',amountIn=BigInt(t.amountIn),minOut=BigInt(t.minAmountOut);
 const ix=[ComputeBudgetProgram.setComputeUnitLimit({units:SILO_DEVNET_TRADE_COMPUTE_UNITS}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:0}),
  createAssociatedTokenAccountIdempotentInstruction(owner,wsolAta,owner,sol,TOKEN_PROGRAM_ID)];
 if(buy)ix.push(SystemProgram.transfer({fromPubkey:owner,toPubkey:wsolAta,lamports:amountIn}),createSyncNativeInstruction(wsolAta,TOKEN_PROGRAM_ID),createAssociatedTokenAccountIdempotentInstruction(owner,memeAta,owner,meme,TOKEN_PROGRAM_ID));
 const data=Buffer.alloc(24);Buffer.from(SWAP_BASE_INPUT).copy(data,0);data.writeBigUInt64LE(amountIn,8);data.writeBigUInt64LE(minOut,16);
 const [inAta,outAta,inVault,outVault,inMint,outMint]=buy?[wsolAta,memeAta,solVault,memeVault,sol,meme]:[memeAta,wsolAta,memeVault,solVault,meme,sol];
 ix.push(new TransactionInstruction({programId:key(SILO_CPMM_PROGRAM_ID),data,keys:[
  {pubkey:owner,isSigner:true,isWritable:false},{pubkey:key(SILO_CPMM_AUTHORITY),isSigner:false,isWritable:false},{pubkey:key(r.config),isSigner:false,isWritable:false},
  {pubkey:key(r.pool),isSigner:false,isWritable:true},{pubkey:inAta,isSigner:false,isWritable:true},{pubkey:outAta,isSigner:false,isWritable:true},
  {pubkey:inVault,isSigner:false,isWritable:true},{pubkey:outVault,isSigner:false,isWritable:true},{pubkey:TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},
  {pubkey:TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},{pubkey:inMint,isSigner:false,isWritable:false},{pubkey:outMint,isSigner:false,isWritable:false},
  {pubkey:key(r.observation),isSigner:false,isWritable:true}]}));
 // The temporary wrapped-SOL account is closed in the same transaction; its lamports return to the owner.
 ix.push(createCloseAccountInstruction(wsolAta,owner,owner,[],TOKEN_PROGRAM_ID));
 return new VersionedTransaction(new TransactionMessage({payerKey:owner,recentBlockhash:blockhash,instructions:ix}).compileToV0Message());
}

/** Decodes the terms back out of a transaction and accepts it only if rebuilding them gives identical message bytes.
 * @param {any} transaction @param {{network?: string, signed?: boolean, routes?: any[]}} [options] */
export function inspectSiloDevnetTrade(transaction,{network,signed=false,routes=SILO_DEVNET_TRADE_ROUTES}={}){
 const m=transaction?.message;
 if(m?.version!==0||m.addressTableLookups.length||m.header.numRequiredSignatures!==1||transaction.serialize().length>1232)throw refusal('Unsupported trade message.');
 const owner=m.staticAccountKeys[0].toBase58(),ix=TransactionMessage.decompile(m).instructions,swap=ix.find(i=>i.programId.toBase58()===SILO_CPMM_PROGRAM_ID);
 if(!swap||swap.data.length!==24||!eq(swap.data.subarray(0,8),SWAP_BASE_INPUT)||swap.keys.length!==13)throw refusal('Only the pinned test-network swap is supported.');
 const pool=swap.keys[3].pubkey.toBase58(),route=routes.find(r=>r.pool===pool);if(!route)throw refusal('Silo cannot trade this token.');
 const side=swap.keys[10].pubkey.equals(NATIVE_MINT)?'buy':'sell';
 const terms=siloDevnetTradeTerms({network,owner,route:route.id,side,amountIn:swap.data.readBigUInt64LE(8).toString(),minAmountOut:swap.data.readBigUInt64LE(16).toString()},{routes});
 if(!eq(buildSiloDevnetTrade(terms,m.recentBlockhash,{routes}).message.serialize(),m.serialize()))throw refusal('Trade differs from the approved layout.');
 if(transaction.signatures.length!==1||transaction.signatures[0].length!==64)throw refusal('Invalid signature layout.');
 const signature=transaction.signatures[0];
 if(signed?!nacl.sign.detached.verify(m.serialize(),signature,key(owner).toBytes()):signature.some(Boolean))throw refusal('Unexpected or invalid signature.');
 return {terms,blockhash:m.recentBlockhash,signature:signed?bs58.encode(signature):null};
}

// ---- Account decoding and the quote -------------------------------------------------------------------------------
const pk=(data,offset)=>new PublicKey(data.subarray(offset,offset+32)).toBase58();
/** AmmConfig (236 bytes). Only the fee rates are read. */
export function decodeCpmmConfig(bytes){
 const d=Buffer.from(bytes);if(d.length!==236||!eq(d.subarray(0,8),CONFIG_DISCRIMINATOR))throw refusal('Unexpected pool fee settings.');
 const rate=o=>{const v=d.readBigUInt64LE(o);if(v>=FEE_DENOMINATOR)throw refusal('Unexpected pool fee settings.');return v;};
 return Object.freeze({tradeFeeRate:rate(12),protocolFeeRate:rate(20),fundFeeRate:rate(28),creatorFeeRate:rate(108)});
}
/** PoolState (637 bytes). */
export function decodeCpmmPool(bytes){
 const d=Buffer.from(bytes);if(d.length!==637||!eq(d.subarray(0,8),POOL_DISCRIMINATOR))throw refusal('Unexpected pool account.');
 return Object.freeze({config:pk(d,8),vaultA:pk(d,72),vaultB:pk(d,104),lpMint:pk(d,136),mintA:pk(d,168),mintB:pk(d,200),programA:pk(d,232),programB:pk(d,264),observation:pk(d,296),
  status:d[329],decimalsA:d[331],decimalsB:d[332],protocolFeesA:d.readBigUInt64LE(341),protocolFeesB:d.readBigUInt64LE(349),fundFeesA:d.readBigUInt64LE(357),fundFeesB:d.readBigUInt64LE(365),
  openTime:d.readBigUInt64LE(373),enableCreatorFee:d[390]!==0,creatorFeesA:d.readBigUInt64LE(397),creatorFeesB:d.readBigUInt64LE(405)});
}
/** The pool's state must match the route exactly; a pool with creator fees or a paused swap is refused. */
export function checkCpmmPool(route,pool){
 const r=routeOf(route);
 for(const k of ['config','vaultA','vaultB','mintA','mintB','observation','lpMint'])if(pool[k]!==r[k])throw refusal('The pool no longer matches its pinned route.');
 if(pool.programA!==TOKEN_PROGRAM_ID.toBase58()||pool.programB!==TOKEN_PROGRAM_ID.toBase58())throw refusal('Unsupported token program in the pool.');
 if(pool.enableCreatorFee)throw refusal('Pools with creator fees are not supported.');
 // Status bit 2 (value 4) disables swapping.
 if((pool.status&4)!==0)throw refusal('Swapping is paused in this pool.');
 const memeDecimals=r.mintA===NATIVE_MINT.toBase58()?pool.decimalsB:pool.decimalsA;if(memeDecimals!==r.decimals)throw refusal('The pool no longer matches its pinned route.');
 return pool;
}
const ceilDiv=(a,b)=>(a+b-1n)/b;
/** Exact-input quote with the program's integer rules. Reserves are vault balances net of accrued protocol and fund fees. */
export function quoteCpmmExactIn({route,pool,config,vaultBalanceA,vaultBalanceB,side,amountIn,slippageBps=100,chainTime}){
 const r=routeOf(route);checkCpmmPool(r,pool);
 // A pool trades only once the cluster's clock passes its open time (the program answers "NotApproved" before that).
 if(!Number.isSafeInteger(chainTime)||chainTime<0)throw refusal('The network time was not checked.');
 if(BigInt(chainTime)<=pool.openTime)throw refusal('This pool is not open for trading yet.');
 if(!Number.isInteger(slippageBps)||slippageBps<0||slippageBps>SILO_DEVNET_TRADE_MAX_SLIPPAGE_BPS)throw refusal('Slippage is outside the allowed range.');
 const a=u64(String(vaultBalanceA))-pool.protocolFeesA-pool.fundFeesA,b=u64(String(vaultBalanceB))-pool.protocolFeesB-pool.fundFeesB;
 if(a<=0n||b<=0n)throw refusal('The pool has no liquidity.');
 const solIsA=r.mintA===NATIVE_MINT.toBase58(),buy=side==='buy';if(!['buy','sell'].includes(side))throw refusal('Choose buy or sell.');
 const inputIsA=buy===solIsA,reserveIn=inputIsA?a:b,reserveOut=inputIsA?b:a,amount=u64(amountIn);if(amount<1n)throw refusal('Enter an amount.');
 const tradeFee=ceilDiv(amount*config.tradeFeeRate,FEE_DENOMINATOR),net=amount-tradeFee;
 const amountOut=net*reserveOut/(reserveIn+net);if(amountOut<1n)throw refusal('This amount is too small to trade.');
 if(amountOut>=reserveOut)throw refusal('Not enough liquidity for this amount.');
 const minAmountOut=amountOut*BigInt(10000-slippageBps)/10000n;if(minAmountOut<1n)throw refusal('This amount is too small to trade.');
 // Price impact against the pool's spot price before the trade, in basis points (rounded up, never shown as zero by rounding).
 const impactBps=Number(ceilDiv((reserveOut*net-amountOut*reserveIn)*10000n,reserveOut*net));
 return Object.freeze({side,amountIn:amount.toString(),tradeFee:tradeFee.toString(),amountOut:amountOut.toString(),minAmountOut:minAmountOut.toString(),slippageBps,impactBps,reserveIn:reserveIn.toString(),reserveOut:reserveOut.toString()});
}
