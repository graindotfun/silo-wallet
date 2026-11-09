/** Verified SOL route admission for any registered Grainpad wXMR launch.
 * Read-only chain checks; never builds, signs or sends. A route is admitted only through the
 * launch's own canonical pool: its LaunchLab curve, or after migration its derived Raydium CPMM pool. */
import {Buffer} from 'buffer';
import {PublicKey} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,unpackMint} from '@solana/spl-token';
import * as sdk from '@raydium-io/raydium-sdk-v2';
import {QUOTES} from './quote-assets.mjs';
import {CPMM_CONFIG} from './launch-instructions.mjs';
export const SOL_ROUTE_SCOPE_VERSION=1;
/** Official router venue labels. The wXMR leg is always SOL/wXMR on Raydium CLMM. */
export const SOL_ROUTE_VENUES=Object.freeze({curve:'Raydium Launchlab',cpmm:'Raydium CP'});
export const SOL_INTERMEDIATE_VENUE='Raydium CLMM';
/** The recorded, live SOL/wXMR Raydium CLMM pool used by both buy and sell routes. */
export const SOL_WXMR_CLMM_POOL='CgHuN3ajFijPidxiWStiDBUBkchWGNb8tVTGaNgYx9UJ';
const LAUNCHPAD=String(sdk.LAUNCHPAD_PROGRAM),CPMM=String(sdk.CREATE_CPMM_POOL_PROGRAM),WXMR=QUOTES.wXMR;
// LaunchLab mintProgramFlag for each supported base token program.
const BASE_PROGRAMS=Object.freeze({[String(TOKEN_PROGRAM_ID)]:0,[String(TOKEN_2022_PROGRAM_ID)]:1});
const CPMM_SWAP_DISABLED=1<<2;
/** Classified, user-readable refusal. Raised before any router request or wallet prompt. */
export function solRouteUnavailable(code,message){return Object.assign(Error(message),{code,solRouteUnavailable:true});}
const canonical=value=>{try{return typeof value==='string'&&new PublicKey(value).toBase58()===value;}catch{return false;}};
export function launchPoolAddress(mint){return sdk.getPdaLaunchpadPoolId(sdk.LAUNCHPAD_PROGRAM,new PublicKey(mint),new PublicKey(WXMR.mint)).publicKey.toBase58();}
export function migratedPoolAddress(mint,cpConfig=CPMM_CONFIG){const pair=[new PublicKey(mint),new PublicKey(WXMR.mint)].sort((a,b)=>Buffer.compare(a.toBuffer(),b.toBuffer()));return sdk.getCpmmPdaPoolId(sdk.CREATE_CPMM_POOL_PROGRAM,new PublicKey(cpConfig),...pair).publicKey.toBase58();}
/** Index-record admission only; resolveSolRouteScope adds the on-chain checks. */
export function assertSolRouteLaunch(row,{mint,platformId}){
 if(!canonical(mint))throw solRouteUnavailable('invalid-mint','Enter a valid token mint.');
 if(!canonical(platformId))throw Error('SOL route platform configuration is invalid.');
 if(!row||typeof row!=='object')throw solRouteUnavailable('not-registered','SOL trading is available only for registered Grainpad launches.');
 if(row.mint!==mint||row.network!=='mainnet-beta'||row.verification!=='confirmed-on-chain'||row.platformId!==platformId)throw solRouteUnavailable('not-verified','This launch is not a confirmed Grainpad mainnet launch, so SOL routing is unavailable.');
 if((row.quoteAsset??row.quoteSymbol)!=='wXMR'||row.quoteMint!==WXMR.mint)throw solRouteUnavailable('not-wxmr','SOL routing is available only for wXMR-paired Grainpad launches.');
 if(!Object.hasOwn(BASE_PROGRAMS,row.tokenProgram)||row.decimals!==6)throw solRouteUnavailable('unsupported-token','SOL routing does not support this token program or decimals.');
 if(!canonical(row.pool)||row.pool!==launchPoolAddress(mint))throw solRouteUnavailable('pool-mismatch','The registered pool is not the canonical Grainpad pool for this token.');
 return row;
}
async function accounts(connection,keys,minContextSlot){
 let snapshot;try{snapshot=await connection.getMultipleAccountsInfoAndContext(keys.map(k=>new PublicKey(k)),{commitment:'confirmed',...(minContextSlot?{minContextSlot}:{})});}catch{throw solRouteUnavailable('chain-unavailable','The pool could not be read from chain right now. Nothing was prepared; try again shortly.');}
 const slot=snapshot?.context?.slot;
 if(!Number.isSafeInteger(slot)||slot<(minContextSlot||1)||!Array.isArray(snapshot?.value)||snapshot.value.length!==keys.length)throw solRouteUnavailable('chain-unavailable','The pool could not be read from chain right now. Nothing was prepared; try again shortly.');
 return {slot,value:snapshot.value};
}
const decode=(layout,info)=>{try{return layout.decode(Buffer.from(info.data));}catch{return null;}};
/** Current verified route through the registered launch's own pool. */
export async function resolveSolRouteScope(connection,row,{mint,platformId,now=Date.now}){
 assertSolRouteLaunch(row,{mint,platformId});
 const {slot,value:[poolInfo,mintInfo]}=await accounts(connection,[row.pool,mint]);
 if(!poolInfo||String(poolInfo.owner)!==LAUNCHPAD)throw solRouteUnavailable('pool-missing','The registered LaunchLab pool is not on chain.');
 const pool=decode(sdk.LaunchpadPool,poolInfo);
 if(!pool||String(pool.mintA)!==mint||String(pool.mintB)!==WXMR.mint||String(pool.platformId)!==platformId||String(pool.configId)!==WXMR.config||pool.mintDecimalsA!==6||pool.mintDecimalsB!==WXMR.decimals||pool.mintProgramFlag!==BASE_PROGRAMS[row.tokenProgram])throw solRouteUnavailable('pool-mismatch','The on-chain pool does not match the registered Grainpad launch.');
 if(!mintInfo||String(mintInfo.owner)!==row.tokenProgram)throw solRouteUnavailable('unsupported-token','The token mint is not owned by its registered token program.');
 let token;try{token=unpackMint(new PublicKey(mint),{...mintInfo,owner:new PublicKey(row.tokenProgram),data:Buffer.from(mintInfo.data)},new PublicKey(row.tokenProgram));}catch{token=null;}
 if(!token?.isInitialized||token.decimals!==6)throw solRouteUnavailable('unsupported-token','The token mint state does not match the registered launch.');
 const common={version:SOL_ROUTE_SCOPE_VERSION,mint,launchPool:row.pool,tokenProgram:row.tokenProgram,quoteMint:WXMR.mint};
 // Accounts the approved route step must consume, read from the verified pool state.
 if(pool.status===0)return Object.freeze({...common,stage:'curve',venue:SOL_ROUTE_VENUES.curve,pool:row.pool,program:LAUNCHPAD,configId:String(pool.configId),poolAccounts:Object.freeze({vaultA:String(pool.vaultA),vaultB:String(pool.vaultB),creator:String(pool.creator)}),slot});
 if(pool.status===1)throw solRouteUnavailable('migrating','This token is migrating from its LaunchLab curve to Raydium. SOL and wXMR trading resume when the Raydium pool is live.');
 if(pool.status!==2)throw solRouteUnavailable('unsupported-state','This pool is in an unsupported state for SOL routing.');
 const cpmm=migratedPoolAddress(mint),{slot:cpSlot,value:[platformInfo,cpInfo]}=await accounts(connection,[platformId,cpmm],slot);
 const platform=platformInfo&&String(platformInfo.owner)===LAUNCHPAD?decode(sdk.PlatformConfig,platformInfo):null;
 if(!platform||String(platform.cpConfigId)!==CPMM_CONFIG)throw solRouteUnavailable('pool-mismatch','The Grainpad platform migration configuration changed. SOL routing is paused for this token.');
 if(!cpInfo||String(cpInfo.owner)!==CPMM)throw solRouteUnavailable('cpmm-unavailable','The migrated Raydium pool is not live yet. Try again shortly.');
 const cp=decode(sdk.CpmmPoolInfoLayout,cpInfo),pair=[mint,WXMR.mint].sort((a,b)=>Buffer.compare(new PublicKey(a).toBuffer(),new PublicKey(b).toBuffer())),baseIsA=pair[0]===mint;
 if(!cp||String(cp.configId)!==CPMM_CONFIG||String(cp.mintA)!==pair[0]||String(cp.mintB)!==pair[1]||String(baseIsA?cp.mintProgramA:cp.mintProgramB)!==row.tokenProgram||String(baseIsA?cp.mintProgramB:cp.mintProgramA)!==String(TOKEN_PROGRAM_ID))throw solRouteUnavailable('pool-mismatch','The migrated Raydium pool does not match the registered Grainpad launch.');
 if((Number(cp.status)&CPMM_SWAP_DISABLED)!==0)throw solRouteUnavailable('swap-disabled','Swaps are disabled on the migrated Raydium pool.');
 const seconds=Math.floor(now()/1000);if(!Number.isSafeInteger(seconds)||BigInt(String(cp.openTime))>BigInt(seconds))throw solRouteUnavailable('cpmm-unavailable','The migrated Raydium pool is not open for trading yet.');
 return Object.freeze({...common,stage:'cpmm',venue:SOL_ROUTE_VENUES.cpmm,pool:cpmm,program:CPMM,configId:CPMM_CONFIG,poolAccounts:Object.freeze({vaultA:String(cp.vaultA),vaultB:String(cp.vaultB),observation:String(cp.observationId),mintA:String(cp.mintA)}),slot:cpSlot});
}
/** A stored review is executable only while it still names the current verified route. */
export function assertSolRouteScopeUnchanged(review,scope){
 if(review?.routeScopeVersion!==SOL_ROUTE_SCOPE_VERSION)throw solRouteUnavailable('review-outdated','This SOL review predates the current route checks. Prepare a fresh review.');
 if(review.mint!==scope.mint||review.pool!==scope.pool||review.launchPool!==scope.launchPool||review.routeStage!==scope.stage||review.routeVenue!==scope.venue||review.tokenProgram!==scope.tokenProgram)throw solRouteUnavailable('route-changed',scope.stage!==review.routeStage?'This token moved to its Raydium pool after your review. Prepare a fresh review.':'The verified pool for this token changed after your review. Prepare a fresh review.');
 return scope;
}
