import './browser-buffer.mjs';
/** SOL-funded creator buy for a NEW wXMR-paired public launch. Unsigned; never requests a wallet or sends.
 * One atomic transaction creates the token, then one Jupiter route_v2 instruction swaps exactly the approved
 * lamports through the pinned SOL/wXMR CLMM pool and spends the wXMR that actually lands in the new LaunchLab
 * pool. The pair stays wXMR. Nothing is split into a separate swap: an oversized packet is refused.
 *
 * Existing balances: the owner's wXMR ATA is only an intermediate (route_v2 forwards the actual CLMM output),
 * so its balance is unchanged. A wSOL ATA that already exists is topped up by exactly the input, spent by exactly
 * the input and never closed. When either ATA is absent it is created with the NON-idempotent instruction, so a
 * variant built for an absent account fails on chain instead of touching an account created in the meantime.
 * Only a wSOL ATA created by this transaction is closed. */
import {Buffer} from 'buffer';
import {PublicKey,SystemProgram,TransactionInstruction} from '@solana/web3.js';
import {NATIVE_MINT,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,createAssociatedTokenAccountInstruction,createAssociatedTokenAccountIdempotentInstruction,createSyncNativeInstruction,createCloseAccountInstruction,getAssociatedTokenAddressSync,unpackAccount} from '@solana/spl-token';
import * as sdk from '@raydium-io/raydium-sdk-v2';
import {QUOTES} from './quote-assets.mjs';
import {quoteInitialOfficialCreatorBuy} from './official-creator-buy-quote.mjs';
import {isLaunchTaxBps} from './rewards-policy.mjs';
import {SOL_WXMR_CLMM_POOL,SOL_ROUTE_VENUES} from './sol-route-scope.mjs';
import {clmmSlice,launchSlice,encodeDirectRouteV2,clmmQuote,CLMM_PROGRAM_ID} from './sol-direct-route.mjs';
import {inspectRouteV2,JUPITER_ROUTE_V2_DISCRIMINATOR} from './jupiter-route-v2.mjs';
import {netTokenMinimumGuard} from './sol-token-net-guard.mjs';
export const SOL_CREATOR_BUY_SLIPPAGE_BPS=100;
/** A signed SOL quote is executable for 15 minutes; metadata uploads expire sooner. */
export const SOL_CREATOR_BUY_QUOTE_TTL_SECONDS=900;
export const SOL_CREATOR_BUY_RESERVE_LAMPORTS=5000000;
/** Recorded accounts of the pinned SOL/wXMR CLMM pool (tests/fixtures/sol-clmm-packet.json). They are
 * pre-creation entries of the Grainpad SOL lookup table; a live pool that disagrees is refused. */
export const SOL_WXMR_CLMM_ACCOUNTS=Object.freeze({configId:'9WjDVMHWCirG9jkchbetHTnSzdXbAPnD9bsoGRcz1xUw',vaultA:'5CJ4ycoanPimfwHZRRbu7mrKruhHBX98Hz6Se2GKbLD5',vaultB:'8LFqeBuXNsbLuRacHnoi4pn79un4RnLMwe6sM1yEoVmV',observationId:'BBnKtS1RdtqdbaS9MunJPNjastfzYbt1ywMV1NEdeosK',bitmap:'HiVn3maJNsdtY6JLvva1y8FLZiKsU3Ankov1Jif3ic8A'});
/** route_v2 CLMM slices hold at most 20 accounts: 11 fixed, the bitmap and up to 8 tick arrays. */
export const SOL_CREATOR_BUY_MAX_TICK_ARRAYS=8;
const JUPITER='JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',EVENT='D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf';
const SELL='793100000000000';
const meta=(pubkey,isWritable=false,isSigner=false)=>({pubkey:new PublicKey(pubkey),isSigner,isWritable});
const stale=message=>Object.assign(Error(message),{code:'sol-quote-stale'});
/** Exact lamports from decimal SOL text. Empty or zero is no buy. */
export function solCreatorBuyLamports(amount=''){
 if(typeof amount!=='string'||!/^(?:|(?:0|[1-9]\d{0,8})(?:\.\d{1,9})?)$/.test(amount))throw Error('Enter a SOL creator buy with up to 9 decimal places.');
 const [whole='0',fraction='']=amount.split('.'),raw=BigInt(whole||'0')*1000000000n+BigInt(fraction.padEnd(9,'0'));
 if(raw>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Creator buy amount is too large.');
 return String(raw);
}
/** Signed intent: currency, exact lamports, slippage, minimum NET tokens after transfer tax and quote expiry. */
export function buildSolCreatorBuyIntent({amountIn,expectedNetOutputRaw,taxBps,now=Date.now()}){
 if(typeof expectedNetOutputRaw!=='string'||!/^[1-9]\d*$/.test(expectedNetOutputRaw))throw Error('A positive net-of-tax SOL creator-buy quote is required.');
 const minOut=BigInt(expectedNetOutputRaw)*BigInt(10000-SOL_CREATOR_BUY_SLIPPAGE_BPS)/10000n;
 if(minOut<1n)throw Error('Creator buy minimum output rounds to zero.');
 const intent={quote:'SOL',amountIn,minOut:String(minOut),taxBps,slippageBps:SOL_CREATOR_BUY_SLIPPAGE_BPS,quoteExpiresAt:Math.floor(now/1000)+SOL_CREATOR_BUY_QUOTE_TTL_SECONDS};
 assertSolCreatorBuyIntent(intent,taxBps);return intent;
}
export function assertSolCreatorBuyIntent(intent,taxBps=intent?.taxBps){
 const refuse=()=>{throw Error('Creator buy differs from the signed atomic purchase intent.');};
 if(!intent||typeof intent!=='object'||Array.isArray(intent)||Object.keys(intent).sort().join(',')!=='amountIn,minOut,quote,quoteExpiresAt,slippageBps,taxBps'||intent.quote!=='SOL'||!isLaunchTaxBps(taxBps)||intent.taxBps!==taxBps||intent.slippageBps!==SOL_CREATOR_BUY_SLIPPAGE_BPS)return refuse();
 if(typeof intent.amountIn!=='string'||!/^[1-9]\d{0,15}$/.test(intent.amountIn)||BigInt(intent.amountIn)>BigInt(Number.MAX_SAFE_INTEGER))return refuse();
 if(typeof intent.minOut!=='string'||!/^[1-9]\d{0,14}$/.test(intent.minOut)||BigInt(intent.minOut)>BigInt(SELL))return refuse();
 if(!Number.isSafeInteger(intent.quoteExpiresAt)||intent.quoteExpiresAt<1)return refuse();
 // Keep the signed schema canonical: preparation validates this result again.
 // Display-only fields belong on the review, never on the signed intent.
 return {...intent};
}
/** A signed SOL quote is only executable before its expiry, and an upload cannot pre-date a longer window. */
export function assertSolCreatorBuyFresh(intent,{now=Date.now(),upload=false}={}){
 const seconds=Math.floor(now/1000);
 if(seconds>=intent.quoteExpiresAt)throw stale('The SOL creator-buy quote expired. Review and sign a fresh draft. No launch was submitted.');
 if(upload&&intent.quoteExpiresAt>seconds+SOL_CREATOR_BUY_QUOTE_TTL_SECONDS)throw Error('SOL creator-buy quote expiry is outside the reviewed window.');
 return intent;
}
/** Live SOL→wXMR→token estimate. The CLMM leg reads the pinned pool; the LaunchLab leg is the exact initial curve
 * because the pool is created earlier in the same transaction. A quote is not a simulation. */
export async function quoteSolCreatorBuy(connection,{amountIn,taxBps}){
 if(typeof amountIn!=='string'||!/^[1-9]\d*$/.test(amountIn))throw Error('Positive SOL creator-buy lamports required.');
 const clmm=await clmmQuote(connection,QUOTES.SOL.mint,BigInt(amountIn),{includeExtraTickArrays:false});
 if(!clmm)throw Error('The SOL/wXMR pool could not be read. Nothing was prepared.');
 assertPinnedClmm({configId:clmm.decoded.configId,vaultA:clmm.decoded.vaultA,vaultB:clmm.decoded.vaultB,observationId:clmm.decoded.observationId,bitmap:clmm.bitmap,inputVault:clmm.inputVault,outputVault:clmm.outputVault});
 const ticks=clmm.ticks.map(String);
 if(ticks.length<1||ticks.length>SOL_CREATOR_BUY_MAX_TICK_ARRAYS)throw Error('This SOL amount crosses too many SOL/wXMR tick arrays for one launch transaction. Reduce the amount or pay with wXMR.');
 const curve=quoteInitialOfficialCreatorBuy({amountIn:String(clmm.amountOut),taxBps,slippageBps:SOL_CREATOR_BUY_SLIPPAGE_BPS});
 return {quote:'SOL',amountIn,wxmrQuotedRaw:String(clmm.amountOut),ticks,grossOutputRaw:curve.grossOutputRaw,transferFeeRaw:curve.transferFeeRaw,expectedNetOutputRaw:curve.expectedNetOutputRaw,curveFeesRaw:curve.curveFeesRaw,totalCurveFeeRaw:curve.totalCurveFeeRaw,curvePrincipalRaw:curve.curvePrincipalRaw,quoteDecimals:9,wxmrDecimals:12,tokenDecimals:6,taxBps,slippageBps:SOL_CREATOR_BUY_SLIPPAGE_BPS};
}
/** A live quote below the signed minimum means the signed quote is stale; never lower the minimum silently. */
export function assertSolQuoteMeetsIntent(quote,intent){
 if(quote?.amountIn!==intent.amountIn||quote.taxBps!==intent.taxBps)throw Error('Creator buy differs from the signed atomic purchase intent.');
 if(BigInt(quote.expectedNetOutputRaw)<BigInt(intent.minOut))throw stale('The SOL price moved: the live quote is below your signed minimum tokens. Review and sign a fresh draft. No launch was submitted.');
 return quote;
}
function assertPinnedClmm(c){
 const p=SOL_WXMR_CLMM_ACCOUNTS;
 if(String(c.configId)!==p.configId||String(c.vaultA)!==p.vaultA||String(c.vaultB)!==p.vaultB||String(c.observationId)!==p.observationId||String(c.bitmap)!==p.bitmap||String(c.inputVault)!==p.vaultA||String(c.outputVault)!==p.vaultB)throw Error('Pinned SOL/wXMR pool accounts changed. SOL creator buys are paused.');
}
/** Lookup entries the compact SOL launch requires (all pre-creation addresses of the Grainpad table). */
export function solCreatorBuyClmmAccounts(){return {configId:new PublicKey(SOL_WXMR_CLMM_ACCOUNTS.configId),vaultA:new PublicKey(SOL_WXMR_CLMM_ACCOUNTS.vaultA),vaultB:new PublicKey(SOL_WXMR_CLMM_ACCOUNTS.vaultB),observationId:new PublicKey(SOL_WXMR_CLMM_ACCOUNTS.observationId)};}
export function solCreatorBuyAccounts({owner,mint}){
 const o=new PublicKey(owner),m=new PublicKey(mint),wxmr=new PublicKey(QUOTES.wXMR.mint);
 return {owner:o,mint:m,quote:wxmr,creatorAta:getAssociatedTokenAddressSync(m,o,false,TOKEN_2022_PROGRAM_ID),wxmrAta:getAssociatedTokenAddressSync(wxmr,o,false,TOKEN_PROGRAM_ID),wsolAta:getAssociatedTokenAddressSync(NATIVE_MINT,o,false,TOKEN_PROGRAM_ID)};
}
function assertTicks(ticks){
 if(!Array.isArray(ticks)||ticks.length<1||ticks.length>SOL_CREATOR_BUY_MAX_TICK_ARRAYS||new Set(ticks.map(String)).size!==ticks.length)throw Error('SOL/wXMR tick arrays do not fit the reviewed route.');
 const forbidden=new Set([SOL_WXMR_CLMM_ACCOUNTS.bitmap,SOL_WXMR_CLMM_POOL,CLMM_PROGRAM_ID]);
 for(const t of ticks)if(forbidden.has(String(new PublicKey(t))))throw Error('SOL/wXMR tick arrays do not fit the reviewed route.');
 return ticks.map(t=>new PublicKey(t));
}
/** Exact creator-buy instructions appended after token initialization. Every value comes from the signed intent,
 * the derived launch accounts, the pinned pool and the verified tick arrays. */
export function buildSolCreatorBuyInstructions({owner,mint,platform,pool,intent,ticks,wsolExists,wxmrExists}){
 const buy=assertSolCreatorBuyIntent(intent);
 if(typeof wsolExists!=='boolean'||typeof wxmrExists!=='boolean')throw Error('Creator token-account state is required.');
 const a=solCreatorBuyAccounts({owner,mint}),O=a.owner,P=new PublicKey(pool),platformId=new PublicKey(platform),tickKeys=assertTicks(ticks);
 const L=sdk.LAUNCHPAD_PROGRAM,vaultA=sdk.getPdaLaunchpadVaultId(L,P,a.mint).publicKey,vaultB=sdk.getPdaLaunchpadVaultId(L,P,a.quote).publicKey;
 const p=SOL_WXMR_CLMM_ACCOUNTS;
 const fixed=[meta(O,false,true),meta(a.wsolAta,true),meta(a.creatorAta,true),meta(NATIVE_MINT),meta(a.mint),meta(TOKEN_PROGRAM_ID),meta(TOKEN_2022_PROGRAM_ID),meta(JUPITER),meta(EVENT),meta(JUPITER)];
 const clmm=clmmSlice({owner:O,config:p.configId,pool:SOL_WXMR_CLMM_POOL,inputAta:a.wsolAta,outputAta:a.wxmrAta,inputVault:p.vaultA,outputVault:p.vaultB,observation:p.observationId,ticks:tickKeys,bitmap:p.bitmap});
 const curve=launchSlice({owner:O,platformId:String(platformId),pool:{poolId:P,configId:QUOTES.wXMR.config},baseAta:a.creatorAta,quoteAta:a.wxmrAta,vaultA,vaultB,mint:String(a.mint),tokenProgram:TOKEN_2022_PROGRAM_ID,creator:O});
 // quoted out = signed net minimum and zero slippage: the router's on-chain floor is exactly the approved minimum.
 const swap=new TransactionInstruction({programId:new PublicKey(JUPITER),keys:[...fixed,...clmm,...curve],data:encodeDirectRouteV2({amountIn:buy.amountIn,amountOut:buy.minOut,slippageBps:0,steps:[{tag:26,input:0,output:1},{tag:81,extra:8,input:1,output:2}]})});
 const scope={venue:SOL_ROUTE_VENUES.curve,pool:String(P),launchPool:String(P),configId:QUOTES.wXMR.config,mint:String(a.mint),tokenProgram:String(TOKEN_2022_PROGRAM_ID),quoteMint:QUOTES.wXMR.mint,poolAccounts:{vaultA:String(vaultA),vaultB:String(vaultB),creator:String(O)}};
 const failed=inspectRouteV2(swap,{side:'buy',scope,owner:String(O),platformId:String(platformId),baseAta:String(a.creatorAta),wsolAta:String(a.wsolAta),quoteAta:String(a.wxmrAta)});
 if(failed.length)throw Error('SOL creator-buy route failed its own account check: '+failed.join(', '));
 const instructions=[createAssociatedTokenAccountIdempotentInstruction(O,a.creatorAta,O,a.mint,TOKEN_2022_PROGRAM_ID)];
 if(!wxmrExists)instructions.push(createAssociatedTokenAccountInstruction(O,a.wxmrAta,O,a.quote,TOKEN_PROGRAM_ID));
 if(!wsolExists)instructions.push(createAssociatedTokenAccountInstruction(O,a.wsolAta,O,NATIVE_MINT,TOKEN_PROGRAM_ID));
 instructions.push(SystemProgram.transfer({fromPubkey:O,toPubkey:a.wsolAta,lamports:BigInt(buy.amountIn)}),createSyncNativeInstruction(a.wsolAta),swap,netTokenMinimumGuard(a.creatorAta,buy.minOut));
 if(!wsolExists)instructions.push(createCloseAccountInstruction(a.wsolAta,O,O));
 return {...a,instructions,swap,wsolExists,wxmrExists,ticks:tickKeys.map(String)};
}
/** Recover the variant and tick arrays a submitted launch claims, for exact reconstruction. Nothing here is trusted:
 * the caller rebuilds every instruction from the signed intent and compares the whole message. */
export function solCreatorBuyShape(view,{owner,mint}){
 const a=solCreatorBuyAccounts({owner,mint}),ata=String(ASSOCIATED_TOKEN_PROGRAM_ID);
 const routes=view.instructions.filter(ix=>ix.programId===JUPITER&&ix.dataHex.startsWith(JUPITER_ROUTE_V2_DISCRIMINATOR));
 if(routes.length!==1)throw Error('One SOL creator-buy route is required.');
 const keys=routes[0].accounts.map(k=>k.key),end=keys.indexOf(String(sdk.LAUNCHPAD_PROGRAM),11);
 if(keys[10]!==CLMM_PROGRAM_ID||end<0||keys[end-1]!==JUPITER||keys[end-2]!==SOL_WXMR_CLMM_ACCOUNTS.bitmap)throw Error('SOL creator-buy route shape is not reviewed.');
 const created=k=>view.instructions.some(ix=>ix.programId===ata&&ix.dataHex===''&&ix.accounts[1]?.key===String(k));
 return {ticks:keys.slice(20,end-2),wsolExists:!created(a.wsolAta),wxmrExists:!created(a.wxmrAta)};
}
/** Tick arrays must be CLMM-owned accounts of the pinned pool at their own canonical PDA, strictly descending
 * (SOL is mint A, so a SOL input moves the price down). Accepts RPC base64 or Buffer account data. */
export function assertSolTickArrays(ticks,accounts){
 const keys=assertTicks(ticks);
 if(!Array.isArray(accounts)||accounts.length!==keys.length)throw Error('SOL/wXMR tick arrays are unavailable.');
 let previous=null;
 keys.forEach((k,i)=>{
  const info=accounts[i];if(!info||String(info.owner)!==CLMM_PROGRAM_ID)throw Error('A SOL/wXMR tick array is missing or foreign.');
  const data=Array.isArray(info.data)?Buffer.from(info.data[0],'base64'):Buffer.from(info.data);
  if(data.length!==sdk.TickArrayLayout.span)throw Error('A SOL/wXMR tick array is malformed.');
  const decoded=sdk.TickArrayLayout.decode(data),start=decoded.startTickIndex;
  if(String(decoded.poolId)!==SOL_WXMR_CLMM_POOL||!sdk.getPdaTickArrayAddress(new PublicKey(CLMM_PROGRAM_ID),new PublicKey(SOL_WXMR_CLMM_POOL),start).publicKey.equals(k))throw Error('A tick array does not belong to the pinned SOL/wXMR pool.');
  if(previous!==null&&start>=previous)throw Error('SOL/wXMR tick arrays are not in swap order.');
  previous=start;
 });
 return keys.map(String);
}
function tokenAmount(info,address,owner,mint){
 const decoded=unpackAccount(address,{...info,owner:new PublicKey(info.owner),data:Array.isArray(info.data)?Buffer.from(info.data[0],'base64'):Buffer.from(info.data)},TOKEN_PROGRAM_ID);
 if(!decoded.owner.equals(owner)||!decoded.mint.equals(mint)||!decoded.isInitialized||decoded.isFrozen)throw Error('Creator token account identity or spendability changed.');
 return decoded.amount;
}
/** Fresh owner SOL, wXMR/wSOL ATA state and an unused creator token account. */
export async function readSolCreatorBuyFunding(connection,p,{minContextSlot=1}={}){
 const a=solCreatorBuyAccounts(p),read=await connection.getMultipleAccountsInfoAndContext([a.owner,a.wxmrAta,a.wsolAta,a.creatorAta],{commitment:'confirmed',minContextSlot});
 if(!Number.isSafeInteger(read?.context?.slot)||read.context.slot<minContextSlot||read.value?.length!==4||read.value[3])throw Error('Fresh creator funding and unused token account proof required.');
 const [ownerInfo,wxmr,wsol]=read.value,lamports=ownerInfo?.lamports??0;
 if(!Number.isSafeInteger(lamports))throw Error('Creator SOL balance is unavailable.');
 const wxmrBefore=wxmr?tokenAmount(wxmr,a.wxmrAta,a.owner,a.quote):null,wsolBefore=wsol?tokenAmount(wsol,a.wsolAta,a.owner,NATIVE_MINT):null;
 if(BigInt(lamports)<BigInt(p.creatorBuy.amountIn)+BigInt(SOL_CREATOR_BUY_RESERVE_LAMPORTS))throw Error('Creator SOL balance is below the chosen buy plus the 0.005 SOL reserve. No launch was submitted.');
 if(p.creatorBuy.wsolExists!==undefined&&(p.creatorBuy.wsolExists!==(wsolBefore!==null)||p.creatorBuy.wxmrExists!==(wxmrBefore!==null)))throw Error('Creator wSOL or wXMR accounts changed after review. Prepare again.');
 return {slot:read.context.slot,ownerLamportsBefore:lamports,wxmrExists:wxmrBefore!==null,wsolExists:wsolBefore!==null,wxmrBeforeRaw:wxmrBefore===null?null:String(wxmrBefore),wsolBeforeRaw:wsolBefore===null?null:String(wsolBefore)};
}
export function solCreatorBuySimulationAddresses(p){const a=solCreatorBuyAccounts(p);return [p.owner,p.pool,String(a.creatorAta),String(a.wxmrAta),String(a.wsolAta)];}
/** Net tokens after transfer tax, untouched wXMR and wSOL balances, a closed temporary wSOL account and the exact
 * SOL input inside the payer debit. */
export function assertSolCreatorBuySimulation(p,proof,before){
 const a=solCreatorBuyAccounts(p),[poolInfo,creator,wxmr,wsol]=proof.accounts?.slice(1)||[];
 if(!before||!poolInfo||String(poolInfo.owner)!==String(sdk.LAUNCHPAD_PROGRAM))throw Error('Atomic creator-buy simulation proof unavailable.');
 const decoded=sdk.LaunchpadPool.decode(Array.isArray(poolInfo.data)?Buffer.from(poolInfo.data[0],'base64'):Buffer.from(poolInfo.data));
 if(String(decoded.creator)!==p.owner||String(decoded.mintA)!==p.mint||String(decoded.mintB)!==QUOTES.wXMR.mint)throw Error('Atomic creator-buy pool identity changed.');
 if(!creator)throw Error('Simulation did not create the creator token account. Nothing was sent.');
 const net=unpackAccount(a.creatorAta,{...creator,owner:new PublicKey(creator.owner),data:Array.isArray(creator.data)?Buffer.from(creator.data[0],'base64'):Buffer.from(creator.data)},TOKEN_2022_PROGRAM_ID);
 if(!net.owner.equals(a.owner)||!net.mint.equals(a.mint)||net.amount<BigInt(p.creatorBuy.minOut))throw Error('Simulation did not deliver the minimum net tokens after transfer tax. Nothing was sent.');
 if(!wxmr||tokenAmount(wxmr,a.wxmrAta,a.owner,a.quote)!==BigInt(before.wxmrBeforeRaw??'0'))throw Error('Simulation changed your existing wXMR balance. Nothing was sent.');
 if(before.wsolExists){if(!wsol||tokenAmount(wsol,a.wsolAta,a.owner,NATIVE_MINT)!==BigInt(before.wsolBeforeRaw))throw Error('Simulation changed your existing wSOL balance. Nothing was sent.');}
 else if(wsol&&wsol.lamports!==0)throw Error('Simulation left the temporary wSOL account open. Nothing was sent.');
 if(!Number.isSafeInteger(proof.debit)||BigInt(proof.debit)<BigInt(p.creatorBuy.amountIn))throw Error('Simulation did not debit the exact SOL creator buy. Nothing was sent.');
 return {simulatedNetOutputRaw:String(net.amount),launchDebitLamports:String(BigInt(proof.debit)-BigInt(p.creatorBuy.amountIn)),wxmrBeforeRaw:before.wxmrBeforeRaw,wsolBeforeRaw:before.wsolBeforeRaw,wxmrExists:before.wxmrExists,wsolExists:before.wsolExists};
}
