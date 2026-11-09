import {SILO_SOL_MINT,SILO_USDC_MINT} from './swap-referral.mjs';
import {TOKEN_PROGRAM_ID} from '@solana/spl-token';
/** Immutable release admission, not token discovery. No memecoin is accepted merely
 * because Jupiter returns a quote. Each added mint requires reviewed on-chain
 * authority/extension facts, exact pool decoding and both-direction receipts. */
export const SILO_WIF_CLMM_POOL='BJ3MC7VXog1Ggirq1zmzfY6VEWLgtPE9uZJfM7BvUKGe';
export const SILO_WIF_MINT='EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
export const SILO_JUPITER_ROUTE_POLICY=Object.freeze({version:1,network:'solana:mainnet-beta',transactionCount:1,program:String(TOKEN_PROGRAM_ID),router:'Metis',dexes:Object.freeze(['Raydium CP','Raydium CLMM']),actualReadOnlyEvidence:Object.freeze({solUsdcClmm:true,solUsdcCpProviderRouteFound:false}),tokens:Object.freeze([
 Object.freeze({mint:SILO_SOL_MINT,decimals:9,kind:'wrapped-native',releaseAccepted:false,status:'fixture-reviewed'}),
 Object.freeze({mint:SILO_USDC_MINT,decimals:6,kind:'stablecoin',releaseAccepted:false,status:'fixture-reviewed'}),
 Object.freeze({mint:SILO_WIF_MINT,decimals:6,kind:'memecoin',status:'readonly-candidate',releaseAccepted:false,authorityPolicy:'revoked-mint-and-freeze',primaryMintSlot:455697818,mintAccountDataSha256:'d2ec7035e6d852fec8e2b369233fe269d447668076ba5c68153abbcd400c1da8',identitySource:'https://dogwifcoin.org/',candidatePools:Object.freeze([SILO_WIF_CLMM_POOL])}),
]),memecoins:Object.freeze([SILO_WIF_MINT]),candidateRoutes:Object.freeze(['SOL↔USDC / classic SPL / single Raydium CP or CLMM','SOL↔WIF / classic SPL / single Raydium CLMM']),releaseAccepted:false});
export function assertSiloAdmittedJupiterPair(input){
 const supported=SILO_JUPITER_ROUTE_POLICY.tokens.map(x=>x.mint);
 if([input?.inputMint,input?.outputMint].includes(SILO_WIF_MINT)&&![input?.inputMint,input?.outputMint].includes(SILO_SOL_MINT))throw Error('WIF requires the reviewed SOL-anchored single-leg route.');
 if(input?.network!==SILO_JUPITER_ROUTE_POLICY.network||input.inputMint===input.outputMint||!supported.includes(input.inputMint)||!supported.includes(input.outputMint))throw Error('This token pair has not been independently admitted.');
 return SILO_JUPITER_ROUTE_POLICY;
}
export function siloJupiterTokenPolicy(mint){const entry=SILO_JUPITER_ROUTE_POLICY.tokens.find(x=>x.mint===mint);if(!entry)throw Error('Mint is outside the source-controlled candidate registry.');return entry;}
/** A checklist is not an acceptance capability. This describes the evidence a
 * future source-controlled registry entry must carry; request data never adds it. */
export function checkSiloTokenAdmissionEvidence(entry){
 const reasons=[];
 if(!entry||entry.program!==String(TOKEN_PROGRAM_ID)||entry.extensions?.length!==0)reasons.push('classic SPL with no extensions required');
 if(entry?.mintAuthority!==null||entry?.freezeAuthority!==null)reasons.push('unprivileged mint/freeze policy required for memecoins');
 for(const name of ['mintAccountHash','routeSourceHash','forwardReceiptHash','reverseReceiptHash','independentReviewHash'])if(!/^[a-f0-9]{64}$/.test(entry?.[name]??''))reasons.push(name+' missing');
 if(!Number.isSafeInteger(entry?.decimals)||entry.decimals<0||entry.decimals>9)reasons.push('bounded decimals required');
 return {eligible:reasons.length===0,accepted:false,reasons};
}
/** Proposed thresholds are deliberately not activated. Metrics use fresh,
 * independently read reserves bound to a primary slot; provider labels are not
 * liquidity evidence. Effective output shortfall includes all quote deductions. */
export function siloJupiterWarningMetrics({poolKind,inputRaw,outputRaw,inputReserveRaw,outputReserveRaw,observedAt,now=Date.now(),slot,quoteSlot}={}){
 const policy={version:1,approved:false,priceImpactThresholdBps:300,inputReserveThresholdBps:100,maxAgeMs:15000};
 if(poolKind!=='cpmm')return {policy,status:'unknown',warningsAccepted:false,reason:'Reserve-ratio metrics are for verified constant-product pools only; CLMM requires tick/liquidity replay.'};
 const raw=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x);
 if(![inputRaw,outputRaw,inputReserveRaw,outputReserveRaw].every(raw)||!Number.isSafeInteger(observedAt)||observedAt>now||now-observedAt>policy.maxAgeMs||!Number.isSafeInteger(slot)||slot<1||quoteSlot!==slot)return {policy,status:'unknown',warningsAccepted:false,reason:'Fresh same-slot reserve and quote evidence is required.'};
 const i=BigInt(inputRaw),o=BigInt(outputRaw),ri=BigInt(inputReserveRaw),ro=BigInt(outputReserveRaw),spotNumerator=i*ro,actualNumerator=o*ri;
 const effectiveOutputShortfallBps=Number(spotNumerator>actualNumerator?(spotNumerator-actualNumerator)*10000n/spotNumerator:0n),inputReserveConsumptionBps=Number(i*10000n/ri);
 return {policy,status:'measured',warningsAccepted:false,effectiveOutputShortfallBps,inputReserveConsumptionBps,proposedHighPriceImpact:effectiveOutputShortfallBps>=300,proposedLowLiquidity:inputReserveConsumptionBps>=100,description:'Output shortfall from pre-trade reserve ratio includes pool and provider fees; this is not a price oracle or release acceptance.'};
}
/** Runtime changes hold new wallet/provider actions but must not erase bounded
 * chain recovery reads. Session/origin checks and request budgets remain in the
 * server adapter; readonly reads additionally prove the primary genesis. */
export function siloUnsignedOnlyExecutionHeld(env){return env?.SILO_SWAP_PREVIEW_UNSIGNED_ONLY!=='false';}
export function siloJupiterTransportGate({action,config,env,requestOrigin}){
 if(!['order','execute','simulate','outcome','rpc'].includes(action))throw Error('Unknown swap action.');
 const readOnly=action==='outcome'||action==='rpc';
 if(!config?.flags?.silo||env?.SILO_ORIGIN!==requestOrigin||!/^https:\/\//.test(requestOrigin??'')||env?.SILO_SOLANA_NETWORK!=='mainnet-beta')throw Error('Isolated mainnet recovery origin required.');
 if(!readOnly&&(siloUnsignedOnlyExecutionHeld(env)||!(config?.release?.ready||config?.trialRelease?.ready)||!config?.swap?.executionEnabled))throw Error('Exact release and swap runtime acceptance required.');
 return {readOnly};
}
/** Runtime admission is distinct from structural candidate decoding. A later
 * SOL/USDC acceptance cannot implicitly activate the WIF candidate. */
export function assertSiloRuntimeJupiterPair(input,{policy=SILO_JUPITER_ROUTE_POLICY}={}){
 assertSiloAdmittedJupiterPair(input);
 if(policy.releaseAccepted!==true||![input.inputMint,input.outputMint].every(m=>policy.tokens.find(x=>x.mint===m)?.releaseAccepted===true))throw Error('This exact mint pair still requires independent release acceptance.');
 return policy;
}
