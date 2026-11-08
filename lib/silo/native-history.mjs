// SPDX-License-Identifier: AGPL-3.0-only
const XMR_MAX=18446744073709551615n,ZEC_MAX=2100000000000000n;
function atomic(value,maximum,signed=false){
 if(value===null||value===undefined)return null;
 if(typeof value==='number'&&!Number.isSafeInteger(value))throw Error('History amount was not checked.');
 if(!['number','string','bigint'].includes(typeof value))throw Error('History amount was not checked.');
 const text=String(value);if(!(signed?/^(0|-?[1-9][0-9]{0,19})$/:/^(0|[1-9][0-9]{0,19})$/).test(text))throw Error('History amount was not checked.');
 const raw=BigInt(text);if(raw>maximum||raw<(signed?-maximum:0n))throw Error('History amount was not checked.');return raw.toString();
}
function height(value,maximum=Number.MAX_SAFE_INTEGER){
 if(value===null||value===undefined)return null;
 if(!Number.isSafeInteger(value)||value<0||value>maximum)throw Error('History height was not checked.');return value;
}
function bounded(rows,map){
 if(!Array.isArray(rows)||rows.length>100000)throw Error('History is unavailable.');
 const ids=new Set();const mapped=rows.map(row=>{const value=map(row);if(!/^[a-f0-9]{64}$/.test(value.id??'')||ids.has(value.id))throw Error('History identifier was not checked.');ids.add(value.id);return value;});
 mapped.sort((a,b)=>a.height===null&&b.height!==null?-1:b.height===null&&a.height!==null?1:(b.height??0)-(a.height??0));return mapped.slice(0,50);
}
/** SDK transfer amounts reported separately. `selfTransfers` holds the hashes of payments whose every destination belongs to this
 * wallet: their amount never left it, only the fee did. A wallet rebuilt from its phrase cannot see destinations and reports such a
 * payment with a zero outgoing amount, which is also a transfer within the wallet. */
export function xmrHistory(rows,checked=false,selfTransfers=new Set()){
 return {coverage:checked?'checked':'partial coverage',rows:bounded(rows,tx=>{
  if(!tx||typeof tx.getHash!=='function')throw Error('History transaction was not checked.');
  const confirmed=tx.getIsConfirmed?.(),failed=tx.getIsFailed?.();if((confirmed!==undefined&&typeof confirmed!=='boolean')||(failed!==undefined&&typeof failed!=='boolean'))throw Error('History status was not checked.');
  const confirmations=height(tx.getNumConfirmations?.()),mined=confirmed===true,minedHeight=height(tx.getHeight?.());if(mined&&(minedHeight===null||confirmations===null||confirmations===0))throw Error('History mining state was not checked.');
  const outgoing=atomic(tx.getOutgoingAmount?.(),XMR_MAX),selfTransfer=outgoing!==null&&(outgoing==='0'||selfTransfers.has(tx.getHash()));
  return {id:tx.getHash(),height:minedHeight,incoming:atomic(tx.getIncomingAmount?.(),XMR_MAX),outgoing,selfTransfer,fee:atomic(tx.getFee?.(),XMR_MAX),balanceDelta:null,confirmations:checked&&confirmed!==undefined?confirmations:null,status:!checked||confirmed===undefined?'not checked':failed===true?'reported-failed':mined&&confirmations!==null&&confirmations>=10?'confirmed':'pending'};
 })};
}
/** ZEC account balance change is not an inferred sent/received amount. */
export function zecHistory(rows,summary,liveTip=summary?.chainTip){
 const tip=height(summary?.chainTip,4294967295),scanned=height(summary?.fullyScanned,4294967295),live=height(liveTip,4294967295);
 if(tip===null||scanned===null||live===null||scanned>tip||tip>live)throw Error('History scan was not checked.');
 const checked=scanned===tip&&tip===live;
 return {coverage:checked?'checked':'partial coverage',rows:bounded(rows,tx=>{
  if(!tx||typeof tx!=='object'||typeof tx.expiredUnmined!=='boolean'||!('minedHeight' in tx)||!('expiryHeight' in tx))throw Error('History transaction was not checked.');
  const mined=height(tx.minedHeight,4294967295);height(tx.expiryHeight,4294967295);
  if(mined!==null&&mined>scanned)throw Error('History mining height was not checked.');
  const delta=atomic(tx.balanceDelta,ZEC_MAX,true);if(delta===null)throw Error('History amount was not checked.');
  const confirmations=checked?(mined===null?0:scanned-mined+1):null;
  return {id:tx.txid,height:mined,incoming:null,outgoing:null,balanceDelta:delta,fee:atomic(tx.fee,ZEC_MAX),confirmations,status:!checked?'not checked':mined!==null?(confirmations>=3?'confirmed':'pending'):tx.expiredUnmined?'expired':'pending'};
 })};
}
