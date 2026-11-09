import {PublicKey} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,unpackAccount} from '@solana/spl-token';
import {siloJupiterTokenPolicy} from './jupiter-route-policy.mjs';
import * as sdk from '@raydium-io/raydium-sdk-v2';
const key=x=>new PublicKey(x),PROGRAM=String(sdk.CLMM_PROGRAM_ID),JUP='JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',EVENT='D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf';
// Historical pools can store pre-PDA observation accounts. These exact primary
// pool→observation identities are fixture-reviewed only; pool/data owner and
// decoded observation poolId are still checked below. No arbitrary fallback.
const LEGACY_OBSERVATIONS=Object.freeze({'8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj':'3MsJXVvievxAbsMsaT6TS4i6oMitD9jazucuq3X234tC','BJ3MC7VXog1Ggirq1zmzfY6VEWLgtPE9uZJfM7BvUKGe':'9fj4nX4mbU3P8EBbxec6f1FMkhKGdLh5FSoq3xnNXGqx'});
const fail=()=>{throw Error('Raydium CLMM route account evidence differs.');};
/** Single classic-SPL CLMM leg. Exact SDK-derived pool/config/vault/observation,
 * extension bitmap and bounded ordered tick PDAs, no dynamic fees or Token2022.
 * Does not treat a provider label as pool ownership or settlement evidence. */
export async function inspectSiloClmmAccounts({swap,leg,terms,feeAccount,source,destination,noCollectionBuild,connection}){
 if(swap.keys.length<23||swap.keys.length>29||leg.swapInfo?.label!=='Raydium CLMM'||String(swap.keys[10].pubkey)!==PROGRAM)fail();
 const pool=swap.keys[13].pubkey,info=await connection.getAccountInfo(pool,'confirmed');
 if(!info||String(info.owner)!==PROGRAM||info.executable||info.data.length!==sdk.PoolInfoLayout.span||String(pool)!==leg.swapInfo.ammKey)fail();
 const p=sdk.PoolInfoLayout.decode(info.data),program=key(PROGRAM),isA=String(p.mintA)===terms.inputMint;
 if(p.mintDecimalsA!==siloJupiterTokenPolicy(String(p.mintA)).decimals||p.mintDecimalsB!==siloJupiterTokenPolicy(String(p.mintB)).decimals)fail();
 if((isA?String(p.mintB):String(p.mintA))!==terms.outputMint||p.status!==0||p.feeOn!==0||!p.dynamicFeeInfo||Object.values(p.dynamicFeeInfo).some(v=>BigInt(v.toString())!==0n)||p.liquidity.isZero()||p.sqrtPriceX64.isZero()||p.tickSpacing<1)fail();
 const derived=sdk.getPdaPoolId(program,p.configId,p.mintA,p.mintB);
 if(!derived.publicKey.equals(pool)||derived.nonce!==p.bump||!sdk.getPdaPoolVaultId(program,pool,p.mintA).publicKey.equals(p.vaultA)||!sdk.getPdaPoolVaultId(program,pool,p.mintB).publicKey.equals(p.vaultB)||(!sdk.getPdaObservationAccount(program,pool).publicKey.equals(p.observationId)&&LEGACY_OBSERVATIONS[String(pool)]!==String(p.observationId)))fail();
 const ci=await connection.getAccountInfo(p.configId,'confirmed');if(!ci||String(ci.owner)!==PROGRAM||ci.executable||ci.data.length!==sdk.ClmmConfigLayout.span)fail();const c=sdk.ClmmConfigLayout.decode(ci.data);
 if(!sdk.getPdaAmmConfigId(program,c.index).publicKey.equals(p.configId)||c.tickSpacing!==p.tickSpacing||c.tradeFeeRate>10000)fail();
 const oi=await connection.getAccountInfo(p.observationId,'confirmed');if(!oi||String(oi.owner)!==PROGRAM||oi.executable||oi.data.length!==sdk.ObservationLayout.span||String(sdk.ObservationLayout.decode(oi.data).poolId)!==String(pool))fail();
 const vin=isA?p.vaultA:p.vaultB,vout=isA?p.vaultB:p.vaultA;
 for(const [address,mint]of [[vin,terms.inputMint],[vout,terms.outputMint]]){const ai=await connection.getAccountInfo(address,'confirmed'),account=ai&&unpackAccount(address,ai,TOKEN_PROGRAM_ID);if(!account||!account.owner.equals(pool)||String(account.mint)!==mint||!account.isInitialized||account.isFrozen||account.delegate||account.closeAuthority)fail();}
 const bitmap=sdk.getPdaExBitmapAccount(program,pool).publicKey,bi=await connection.getAccountInfo(bitmap,'confirmed');if(!bi||String(bi.owner)!==PROGRAM||bi.executable||bi.data.length!==sdk.TickArrayBitmapExtensionLayout.span||String(sdk.TickArrayBitmapExtensionLayout.decode(bi.data).poolId)!==String(pool))fail();
 const tickKeys=[swap.keys[20],...swap.keys.slice(22,-1)].map(x=>x.pubkey);if(tickKeys.length<1||tickKeys.length>7||String(swap.keys[21].pubkey)!==String(bitmap)||String(swap.keys.at(-1).pubkey)!==JUP)fail();
 const starts=[];for(const address of tickKeys){const ai=await connection.getAccountInfo(address,'confirmed');if(!ai||String(ai.owner)!==PROGRAM||ai.executable||ai.data.length!==sdk.TickArrayLayout.span)fail();const tick=sdk.TickArrayLayout.decode(ai.data);if(String(tick.poolId)!==String(pool)||!sdk.getPdaTickArrayAddress(program,pool,tick.startTickIndex).publicKey.equals(address)||tick.startTickIndex%(p.tickSpacing*sdk.TICK_ARRAY_SIZE)!==0)fail();starts.push(tick.startTickIndex);}
 if(new Set(starts).size!==starts.length||starts.some((start,i)=>i>0&&(isA?start>=starts[i-1]:start<=starts[i-1])))fail();
 const current=sdk.TickArrayUtil.getTickArrayStartIndex(p.tickCurrent,p.tickSpacing);if(isA?starts[0]>current:starts[0]<current)fail();
 const expected=[terms.owner,String(source),String(destination),terms.inputMint,terms.outputMint,String(TOKEN_PROGRAM_ID),String(TOKEN_PROGRAM_ID),feeAccount.address,EVENT,JUP,PROGRAM,terms.owner,String(p.configId),String(pool),String(source),String(destination),String(vin),String(vout),String(p.observationId),String(TOKEN_PROGRAM_ID),String(tickKeys[0]),String(bitmap),...tickKeys.slice(1).map(String),JUP];
 const writable=new Set([0,1,2,...(noCollectionBuild?[]:[7]),11,13,14,15,16,17,18,...tickKeys.map((_,i)=>i===0?20:21+i),21]);
 if(swap.keys.some((entry,i)=>String(entry.pubkey)!==expected[i]||entry.isSigner!==(i===0||i===11)||entry.isWritable!==writable.has(i)))fail();
 return {pool:String(pool),route:'single Raydium CLMM / classic SPL',tickArrays:tickKeys.length};
}
