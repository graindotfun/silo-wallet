// A missing/malformed pool is unknown, never a zero balance. Keep atomic precision for the
// engine's JSON values and reject totals outside Zcash's monetary range.
const maximum=2100000000000000n;
function amount(value){
 if(typeof value==='number'&&!Number.isSafeInteger(value))return null;
 if(!['number','string'].includes(typeof value)||!/^\d{1,16}$/.test(String(value)))return null;
 const raw=BigInt(value);return raw<=maximum?raw:null;
}
export function zecBalances(summary){
 const pools={};let total=0n,spendable=0n,known=Boolean(summary);
 for(const name of ['orchard','ironwood']){
  const pool=summary?.[name],raw=amount(pool?.total),available=amount(pool?.spendable);
  const valid=raw!==null&&available!==null&&available<=raw;
  pools[name]={amount:valid?String(raw):null,unlocked:valid?String(available):null};
  if(valid){total+=raw;spendable+=available;}else known=false;
 }
 const heights=Number.isSafeInteger(summary?.chainTip)&&summary.chainTip>=0&&Number.isSafeInteger(summary?.fullyScanned)&&summary.fullyScanned>=0&&summary.fullyScanned<=summary.chainTip;
 if(!heights||total>maximum)known=false;
 return {amount:known?String(total):null,unlocked:known?String(spendable):null,pools,
  status:!known?'not checked':summary.fullyScanned===summary.chainTip?'checked':'partial coverage'};
}
