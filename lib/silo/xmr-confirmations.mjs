// SPDX-License-Identifier: AGPL-3.0-only
/** Display-only Monero confirmation facts. Monero funds become spendable after 10 confirmations; a block takes about 2 minutes.
 * The minutes are an estimate, never a promise. Nothing here reads keys or touches the network. */
export const XMR_CONFIRMATION_TARGET=10;
export const XMR_BLOCK_MINUTES=2;
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
/** @param {{confirmations:number|null|undefined,target?:number,blockMinutes?:number}} input
 * @returns {{state:'unchecked'|'waiting'|'progress'|'ready',confirmations:number|null,target:number,remaining:number|null,etaMinutes:number|null,percent:number}} */
export function xmrConfirmationState({confirmations,target=XMR_CONFIRMATION_TARGET,blockMinutes=XMR_BLOCK_MINUTES}={}){
 const goal=Number.isSafeInteger(target)&&target>=1&&target<=100?target:XMR_CONFIRMATION_TARGET;
 const n=count(confirmations);
 if(n===null)return Object.freeze({state:'unchecked',confirmations:null,target:goal,remaining:null,etaMinutes:null,percent:0});
 const done=Math.min(n,goal),remaining=goal-done;
 return Object.freeze({state:remaining===0?'ready':n===0?'waiting':'progress',confirmations:done,target:goal,remaining,etaMinutes:remaining*blockMinutes,percent:Math.round(done*100/goal)});
}
/** Plain wording for the ETA, rounded and always approximate. */
export function xmrEtaText(minutes){
 if(!Number.isSafeInteger(minutes)||minutes<=0)return null;
 if(minutes>=60){const h=Math.floor(minutes/60),m=minutes%60;return m?`about ${h} h ${m} min`:`about ${h} h`;}
 return `about ${minutes} min`;
}
/** Locked part of the balance (arriving or change in flight). Null when either figure is unknown or malformed. */
export function xmrLockedAmount(amount,unlocked){
 try{if(amount===null||amount===undefined||unlocked===null||unlocked===undefined)return null;const rest=BigInt(amount)-BigInt(unlocked);return rest>0n?rest.toString():'0';}catch{return null;}
}
/** Result for the incoming-payment check by txid. `incoming` is the adapter's incomingOf() answer. Never says spendable early. */
export function xmrIncomingStatus(incoming,{address,minimumAtomic,target=XMR_CONFIRMATION_TARGET}={}){
 if(!incoming||incoming.failed===true||!Array.isArray(incoming.transfers))return {found:false,confirmations:null,spendable:false};
 let total=0n;try{for(const t of incoming.transfers)if(t.address===address)total+=BigInt(t.amount);if(minimumAtomic!==undefined&&total<BigInt(minimumAtomic))return {found:false,confirmations:null,spendable:false};}catch{return {found:false,confirmations:null,spendable:false};}
 if(total===0n)return {found:false,confirmations:null,spendable:false};
 const n=incoming.confirmed===true?count(incoming.confirmations):0;
 return {found:true,confirmations:n,spendable:n!==null&&n>=target};
}
/** Incoming history rows that are still locked, with their progress. Sent, self-transfer, failed and fully confirmed rows are left out. */
export function xmrPendingIncoming(rows,target=XMR_CONFIRMATION_TARGET){
 if(!Array.isArray(rows))return [];
 const out=[];
 for(const row of rows){
  if(!row||row.selfTransfer||row.status!=='pending'||row.balanceDelta!==null&&row.balanceDelta!==undefined)continue;
  if(row.outgoing!==null&&row.outgoing!==undefined&&row.outgoing!=='0')continue;
  if(row.incoming===null||row.incoming===undefined||!/^[1-9][0-9]*$/.test(String(row.incoming)))continue;
  const state=xmrConfirmationState({confirmations:row.confirmations,target});
  if(state.state==='ready'||state.state==='unchecked')continue;
  out.push({id:row.id,incoming:String(row.incoming),height:row.height??null,...state});
 }
 return out;
}
/** Soonest unlock among pending incoming rows, as minutes, or null. */
export function xmrNextUnlockMinutes(pending){
 if(!Array.isArray(pending)||!pending.length)return null;
 return Math.min(...pending.map(p=>p.etaMinutes));
}
/** Sent payments from history that are still inside the confirmation window (the live journal block disappears once cleared). */
export function xmrPendingOutgoing(rows,target=XMR_CONFIRMATION_TARGET){
 if(!Array.isArray(rows))return [];
 const out=[];
 for(const row of rows){
  if(!row||row.selfTransfer||row.status!=='pending'||row.outgoing===null||row.outgoing===undefined||!/^[1-9][0-9]*$/.test(String(row.outgoing)))continue;
  const state=xmrConfirmationState({confirmations:row.confirmations,target});
  if(state.state==='ready'||state.state==='unchecked')continue;
  out.push({id:row.id,outgoing:String(row.outgoing),height:row.height??null,...state});
 }
 return out;
}
/** Sentence for the balance line. Locked funds are never described as spendable. */
export function xmrLockedSentence(locked,minutes,formatted){
 if(locked===null||locked===undefined||locked==='0')return null;
 const eta=xmrEtaText(minutes);
 return `${formatted} XMR still confirming. It cannot be spent yet${eta?`, spendable in ${eta} (estimate)`:''}.`;
}
