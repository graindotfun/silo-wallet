import './browser-buffer.mjs';
/** Public create + optional exact-input creator buy. Unsigned; never requests a wallet or sends. */
import {Buffer} from 'buffer';
import {PublicKey,TransactionMessage,VersionedTransaction,ComputeBudgetProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,createAssociatedTokenAccountIdempotentInstruction,getAssociatedTokenAddressSync,unpackAccount} from '@solana/spl-token';
import * as sdk from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import {buildRewardsLaunch,rewardsAddresses} from './rewards-launch.mjs';
import {quoteInitialOfficialCreatorBuy} from './official-creator-buy-quote.mjs';
import {isLaunchTaxBps} from './rewards-policy.mjs';
import {QUOTES} from './quote-assets.mjs';
import {grainpadPlatformId} from './platform-policy.mjs';
import {GRAINPAD_SOL_LOOKUP_TABLE,assertGrainpadLookupTable,preCreationLookupAddresses} from './sol-route-lookup.mjs';
import {OFFICIAL_LOOKUP_EXTENSION_ADDRESSES} from './official-launch-policy.mjs';
import {assertSolCreatorBuyIntent,assertSolCreatorBuyFresh,buildSolCreatorBuyInstructions,solCreatorBuyClmmAccounts,readSolCreatorBuyFunding,solCreatorBuySimulationAddresses,assertSolCreatorBuySimulation} from './public-sol-creator-buy.mjs';
export function publicCreatorBuyRaw(amount=''){
 if(typeof amount!=='string'||! /^(?:|(?:0|[1-9]\d{0,11})(?:\.\d{1,12})?)$/.test(amount))throw Error('Enter a wXMR creator buy with up to 12 decimal places.');
 const [whole='0',fraction='']=amount.split('.'),raw=BigInt(whole||'0')*1000000000000n+BigInt(fraction.padEnd(12,'0'));
 if(raw>(1n<<64n)-1n)throw Error('Creator buy amount is too large.');
 return String(raw);
}
/** @param {{amount?:string,taxBps:number}} input */
export function buildPublicCreatorBuyIntent({amount='',taxBps}){
 const amountIn=publicCreatorBuyRaw(amount);if(amountIn==='0')return null;
 if(!isLaunchTaxBps(taxBps))throw Error('Creator buy requires the selected launch tax.');
 const quote=quoteInitialOfficialCreatorBuy({amountIn,taxBps,slippageBps:100});
 return {quote:'wXMR',amountIn,minOut:quote.minOut,taxBps,slippageBps:100};
}
export function assertPublicCreatorBuyIntent(intent,taxBps=intent?.taxBps){
 if(intent===undefined||intent===null)return null;
 // SOL-funded intents carry a live-quoted net minimum; historical wXMR approvals keep their exact checks below.
 if(intent&&typeof intent==='object'&&intent.quote==='SOL')return assertSolCreatorBuyIntent(intent,taxBps);
 if(!intent||typeof intent!=='object'||Array.isArray(intent)||Object.keys(intent).sort().join(',')!=='amountIn,minOut,quote,slippageBps,taxBps'||intent.quote!=='wXMR'||!isLaunchTaxBps(taxBps)||intent.taxBps!==taxBps||intent.slippageBps!==100)throw Error('Creator buy differs from the signed atomic purchase intent.');
 const quote=quoteInitialOfficialCreatorBuy({amountIn:intent.amountIn,taxBps,slippageBps:100});
 if(intent.minOut!==quote.minOut)throw Error('Creator buy minimum does not match its net-of-tax quote.');
 return quote;
}
/** New public writes/creation only. Historical metadata remains readable; a declaration never grants spending permission.
 * A SOL intent is also refused once its signed quote expired. */
export function assertPublicCreatorBuyCompatibility(fields,taxBps=fields?.creatorBuy?.taxBps,{now=Date.now()}={}){
 const quote=assertPublicCreatorBuyIntent(fields?.creatorBuy,taxBps),declared=fields?.declaredCreatorBuy;
 if(quote?.quote==='SOL')assertSolCreatorBuyFresh(quote,{now,upload:true});
 if(declared===undefined)return quote;
 const refuse=()=>{throw Error('Use the updated launch form to review and authorize an atomic creator buy. A declaration alone cannot execute a purchase.');};
 if(typeof declared!=='string'||!/^\d{1,12}(?:\.\d{1,12})?$/.test(declared))return refuse();
 const [whole,fraction='']=declared.split('.'),raw=BigInt(whole)*1000000000000n+BigInt(fraction.padEnd(12,'0'));
 if(raw>0n&&(!quote||fields.quoteAsset!=='wXMR'||quote.amountIn!==String(raw)))return refuse();
 return quote;
}
/** @param {*} input SOL buys also need input.solRoute {ticks,wsolExists,wxmrExists}: verified tick arrays and the owner's account state. */
export function buildPublicRewardsLaunch(input){
 const launch=buildRewardsLaunch(input),creatorBuy=assertPublicCreatorBuyIntent(input.creatorBuy,input.taxBps);
 if(!creatorBuy)return {...launch,creatorBuy:null};
 if(creatorBuy.quote==='SOL'){
  const r=input.solRoute,buy=buildSolCreatorBuyInstructions({owner:input.owner,mint:input.mint,platform:input.platform,pool:launch.pool,intent:input.creatorBuy,ticks:r?.ticks,wsolExists:r?.wsolExists,wxmrExists:r?.wxmrExists});
  return {...launch,creatorBuy:{...creatorBuy,quoteDecimals:9,tokenDecimals:6},creatorAta:buy.creatorAta,wxmrAta:buy.wxmrAta,wsolAta:buy.wsolAta,solRoute:{ticks:buy.ticks,wsolExists:buy.wsolExists,wxmrExists:buy.wxmrExists},instructions:[...launch.instructions,...buy.instructions]};
 }
 const {owner,mint,platform}=input,quote=new PublicKey(QUOTES.wXMR.mint),a=rewardsAddresses(platform);
 const creatorAta=getAssociatedTokenAddressSync(mint,owner,false,TOKEN_2022_PROGRAM_ID),wxmrAta=getAssociatedTokenAddressSync(quote,owner,false,TOKEN_PROGRAM_ID);
 const buy=sdk.buyExactInInstruction(sdk.LAUNCHPAD_PROGRAM,owner,sdk.getPdaLaunchpadAuth(sdk.LAUNCHPAD_PROGRAM).publicKey,a.config,platform,launch.pool,creatorAta,wxmrAta,sdk.getPdaLaunchpadVaultId(sdk.LAUNCHPAD_PROGRAM,launch.pool,mint).publicKey,sdk.getPdaLaunchpadVaultId(sdk.LAUNCHPAD_PROGRAM,launch.pool,quote).publicKey,mint,quote,TOKEN_2022_PROGRAM_ID,TOKEN_PROGRAM_ID,sdk.getPdaPlatformVault(sdk.LAUNCHPAD_PROGRAM,platform,quote).publicKey,sdk.getPdaCreatorVault(sdk.LAUNCHPAD_PROGRAM,owner,quote).publicKey,new BN(creatorBuy.amountIn),new BN(creatorBuy.minOut),new BN(0));
 return {...launch,creatorBuy,creatorAta,wxmrAta,instructions:[...launch.instructions,createAssociatedTokenAccountIdempotentInstruction(owner,creatorAta,owner,mint,TOKEN_2022_PROGRAM_ID),buy]};
}
/** Lookup entries a SOL-funded launch requires: the 24 pre-creation route addresses and the four public launch
 * extension accounts (wXMR config, allow and curve rule, LaunchLab event authority). */
export function solCreatorBuyLookupAddresses(){return [...preCreationLookupAddresses(solCreatorBuyClmmAccounts()),...OFFICIAL_LOOKUP_EXTENSION_ADDRESSES.slice(0,4)];}
const SIGNATURE_BYTES=64;
/** Exact wire size without relying on serialize(), which throws past the packet buffer. */
const compact=n=>n<0x80?1:n<0x4000?2:3;
export function launchPacketBytes(transaction){
 const m=transaction.message,n=m.header.numRequiredSignatures;
 let bytes=compact(n)+n*SIGNATURE_BYTES+1+3+compact(m.staticAccountKeys.length)+32*m.staticAccountKeys.length+32+compact(m.compiledInstructions.length);
 for(const ix of m.compiledInstructions)bytes+=1+compact(ix.accountKeyIndexes.length)+ix.accountKeyIndexes.length+compact(ix.data.length)+ix.data.length;
 bytes+=compact(m.addressTableLookups.length);
 for(const l of m.addressTableLookups)bytes+=32+compact(l.writableIndexes.length)+l.writableIndexes.length+compact(l.readonlyIndexes.length)+l.readonlyIndexes.length;
 return bytes;
}
/** @param {*} plan @param {{owner:PublicKey,blockhash:string,lookupTables?:import("@solana/web3.js").AddressLookupTableAccount[],walletFormat?:"compact"|"static"}} options */
export function compilePublicRewardsLaunch(plan,{owner,blockhash,lookupTables=[],walletFormat="compact"}){
 if(!["compact","static"].includes(walletFormat))throw Error("Unsupported launch wallet format.");
 if(walletFormat==="static"&&lookupTables.length)throw Error("Static launch format cannot use lookup tables.");
 const sol=plan.creatorBuy?.quote==='SOL';
 if(sol&&walletFormat!=="compact")throw Error('A SOL creator buy needs the compact launch format. Choose wXMR for the static format.');
 if(plan.creatorBuy&&walletFormat==="compact"){if(lookupTables.length!==1||String(lookupTables[0].key)!==GRAINPAD_SOL_LOOKUP_TABLE)throw Error('Creator buy requires the verified Grainpad lookup table.');assertGrainpadLookupTable({tableAddress:GRAINPAD_SOL_LOOKUP_TABLE,table:lookupTables[0],required:sol?solCreatorBuyLookupAddresses():[]});}
 else if(lookupTables.length)throw Error('Creation without a buy does not use a lookup table.');
 const transaction=new VersionedTransaction(new TransactionMessage({payerKey:owner,recentBlockhash:blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:600000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:10000}),...plan.instructions]}).compileToV0Message(lookupTables));
 if(sol){const bytes=launchPacketBytes(transaction);if(transaction.message.header.numRequiredSignatures!==2||bytes>1232)throw Object.assign(Error(`This SOL creator buy makes the launch ${bytes.toLocaleString('en-US')} bytes, above Solana's 1,232-byte limit. Nothing was split or sent. Reduce the SOL amount or the token name, or pay with wXMR.`),{code:'packet-limit',bytes});}
 if(transaction.message.header.numRequiredSignatures!==2||transaction.serialize().length>1232)throw Error('Atomic launch exceeds the approved signer or packet limit.');
 return transaction;
}
function token(account,address,owner,mint,program){
 if(!account)throw Error('Creator token account is unavailable.');
 const info={...account,owner:new PublicKey(account.owner),data:Array.isArray(account.data)?Buffer.from(account.data[0],'base64'):Buffer.from(account.data)};
 const decoded=unpackAccount(address,info,program);
 if(!decoded.owner.equals(owner)||!decoded.mint.equals(mint)||!decoded.isInitialized||decoded.isFrozen)throw Error('Creator token account identity or spendability changed.');
 return decoded.amount;
}
export function publicCreatorBuyAccounts(p){
 const owner=new PublicKey(p.owner),mint=new PublicKey(p.mint),quote=new PublicKey(QUOTES.wXMR.mint);
 return {owner,mint,quote,creatorAta:getAssociatedTokenAddressSync(mint,owner,false,TOKEN_2022_PROGRAM_ID),wxmrAta:getAssociatedTokenAddressSync(quote,owner,false,TOKEN_PROGRAM_ID)};
}
export async function readPublicCreatorBuyBalance(connection,p,{minContextSlot=1}={}){
 if(!p.creatorBuy)return null;
 if(p.creatorBuy.quote==='SOL'){assertSolCreatorBuyFresh(p.creatorBuy);return readSolCreatorBuyFunding(connection,p,{minContextSlot});}
 const a=publicCreatorBuyAccounts(p),read=await connection.getMultipleAccountsInfoAndContext([a.wxmrAta,a.creatorAta],{commitment:'confirmed',minContextSlot});
 if(!Number.isSafeInteger(read?.context?.slot)||read.context.slot<minContextSlot||read.value?.length!==2||read.value[1])throw Error('Fresh creator funding and unused token account proof required.');
 if(!read.value[0])throw Error('Creator buy requires wXMR in this wallet. Choose SOL, add wXMR, or set Creator buy to 0 to launch without a purchase. No launch was submitted.');
 const balance=token(read.value[0],a.wxmrAta,a.owner,a.quote,TOKEN_PROGRAM_ID);
 if(balance<BigInt(p.creatorBuy.amountIn))throw Error('Creator wXMR balance is below the chosen buy. No launch was submitted.');
 return {balanceBeforeRaw:String(balance),slot:read.context.slot};
}
export function publicCreatorBuySimulationAddresses(p){if(!p.creatorBuy)return [p.owner];if(p.creatorBuy.quote==='SOL')return solCreatorBuySimulationAddresses(p);const a=publicCreatorBuyAccounts(p);return [p.owner,p.pool,String(a.creatorAta),String(a.wxmrAta)];}
export function assertPublicCreatorBuySimulation(p,proof,before){
 if(!p.creatorBuy)return null;
 if(p.creatorBuy.quote==='SOL'){
  const checked=assertSolCreatorBuySimulation(p,proof,before),pool=sdk.LaunchpadPool.decode(Array.isArray(proof.accounts[1].data)?Buffer.from(proof.accounts[1].data[0],'base64'):Buffer.from(proof.accounts[1].data));
  if(String(pool.platformId)!==String(grainpadPlatformId()))throw Error('Atomic creator-buy pool identity changed.');
  return {...p.creatorBuy,...checked,balanceBeforeRaw:String(before.ownerLamportsBefore)};
 }
 const a=publicCreatorBuyAccounts(p),pool=proof.accounts?.[1];
 if(!before||!pool||String(pool.owner)!==String(sdk.LAUNCHPAD_PROGRAM))throw Error('Atomic creator-buy simulation proof unavailable.');
 const poolData=Array.isArray(pool.data)?Buffer.from(pool.data[0],'base64'):Buffer.from(pool.data),decoded=sdk.LaunchpadPool.decode(poolData);
 if(String(decoded.creator)!==p.owner||String(decoded.mintA)!==p.mint||String(decoded.mintB)!==QUOTES.wXMR.mint||String(decoded.platformId)!==String(grainpadPlatformId()))throw Error('Atomic creator-buy pool identity changed.');
 const net=token(proof.accounts[2],a.creatorAta,a.owner,a.mint,TOKEN_2022_PROGRAM_ID),remaining=token(proof.accounts[3],a.wxmrAta,a.owner,a.quote,TOKEN_PROGRAM_ID);
 if(BigInt(before.balanceBeforeRaw)-remaining!==BigInt(p.creatorBuy.amountIn)||net<BigInt(p.creatorBuy.minOut))throw Error('Simulation did not execute the exact creator buy and minimum net receipt. Nothing was sent.');
 return {...p.creatorBuy,balanceBeforeRaw:before.balanceBeforeRaw,simulatedNetOutputRaw:String(net)};
}
