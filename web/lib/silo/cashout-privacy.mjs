import {siloSolanaAmount} from './solana-amount.mjs';

// Advisory only. Uses opt-in observations already held in memory; never performs I/O.
export const SILO_CASHOUT_HISTORY_MAX_AGE_MS = 300000;
/** @param {{amount:string,owner:string|null,page?:null|{owner:string,network:string,observedAt:string,rows:{status:string,partialReasons:string[],nativeNetRaw:string|null,signature:string,blockTime:number|null}[]},now?:number}} input */
export function siloCashoutPrivacy({amount,owner,page=null,now=Date.now()}) {
 let atomic;try{atomic=BigInt(siloSolanaAmount(amount,9));}catch{return {state:'invalid-amount',round:false,matches:[]};}
 const round=atomic%10000000n===0n;
 const empty=state=>({state,round,matches:[]});
 if(!owner||!page||page.owner!==owner||page.network!=='mainnet-beta')return empty('not-checked');
 const observed=Date.parse(page.observedAt);
 if(!Number.isFinite(now)||!Number.isFinite(observed)||observed>now||now-observed>SILO_CASHOUT_HISTORY_MAX_AGE_MS)return empty('stale');
 if(!Array.isArray(page.rows)||page.rows.length>100)return empty('not-checked');
 const matches=[];
 for(const row of page.rows){
  if(row.status!=='finalized'||row.partialReasons?.length!==0||typeof row.nativeNetRaw!=='string'||!/^[1-9]\d{0,19}$/.test(row.nativeNetRaw))continue;
  const incoming=BigInt(row.nativeNetRaw);if(incoming>18446744073709551615n)continue;
  // Integer comparison, inclusive 1% of the observed incoming SOL balance change.
  const difference=atomic>incoming?atomic-incoming:incoming-atomic;
  if(difference*100n<=incoming)matches.push({signature:row.signature,blockTime:Number.isSafeInteger(row.blockTime)&&row.blockTime>=0&&row.blockTime<=now/1000?row.blockTime:null});
  if(matches.length===3)break;
 }
 return {state:'partial',round,matches};
}
