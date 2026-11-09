import {displayUnits} from './token-units.mjs';

/** Exact operator accounting. Cancellation never counts as a payment. */
export function rewardCreditTotals(lots){
 const totals={earnedRaw:0n,verifiedPaidRaw:0n,unpaidRaw:0n,cancelledRaw:0n};
 for(const lot of lots){
  const row=Object.fromEntries(Object.keys(totals).map(key=>[key,BigInt(lot[key]??'0')]));
  if(Object.values(row).some(value=>value<0n)||row.earnedRaw!==row.verifiedPaidRaw+row.unpaidRaw+row.cancelledRaw)throw Error('Registered credit accounting is inconsistent.');
  for(const key of Object.keys(totals))totals[key]+=row[key];
 }
 return totals;
}
export function exactCreditUnits(raw){const [whole,fraction='']=displayUnits(raw,12).split('.');return whole+'.'+fraction.padEnd(12,'0');}
export function groupedCreditUnits(raw){const [whole,fraction]=exactCreditUnits(raw).split('.');return whole+'.'+fraction.match(/.{3}/g).join('\u2009');}
/** Integer ratio first; conversion is only for CSS geometry, never amounts. */
export function creditShare(raw,total){return total===0n?0:Number(BigInt(raw)*10000n/BigInt(total))/100;}
export function mergeCreditPages(previous,page){
 if(previous&&previous.mint!==page.mint)throw Error('Token records do not match.');
 const lots=[...new Map([...(previous?.lots??[]),...page.lots].map(lot=>[lot.lotId,lot])).values()];
 rewardCreditTotals(lots);
 return {...page,lots,observedAt:Math.max(previous?.observedAt??0,page.observedAt??0)||null};
}
