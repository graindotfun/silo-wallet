/** UI illustration only. Never import into trade, quote or payout amount paths. */
import {exactCreditUnits} from './reward-credit-totals.mjs';
export const CURRENCIES=Object.freeze(['wXMR','USD','SOL']);
export function priceFreshness(row,now){
 if(!row||!Number.isFinite(row.price)||row.price<=0||!Number.isFinite(row.updatedAt)||!['fresh','stale'].includes(row.freshness))return 'expired';
 const age=now-row.updatedAt;if(!Number.isFinite(age)||age<0||age>600000)return 'expired';
 return row.freshness==='stale'||age>60000?'stale':'fresh';
}
export function illustrationAvailable(currency,prices,now){return currency==='wXMR'||priceFreshness(prices?.wXMR,now)!=='expired'&&(currency==='USD'||currency==='SOL'&&priceFreshness(prices?.SOL,now)!=='expired');}
export function illustrateCredit(raw,currency,prices,now){
 if(currency==='wXMR')return {exact:exactCreditUnits(raw),value:null,unit:currency,approximate:false,freshness:'fresh'};
 if(!illustrationAvailable(currency,prices,now))return null;
 const value=Number(BigInt(raw))/1e12*prices.wXMR.price/(currency==='SOL'?prices.SOL.price:1);
 if(!Number.isFinite(value)||value<0)return null;
 return {exact:exactCreditUnits(raw),value,unit:currency,approximate:true,freshness:priceFreshness(prices.wXMR,now)==='stale'||currency==='SOL'&&priceFreshness(prices.SOL,now)==='stale'?'stale':'fresh'};
}
/** Display bounds: finite values outside them would print hundreds of digits, so they are shown as bounds. */
const MAX_SHOWN=1e15,MIN_SHOWN=1e-12;
export function formatIllustration(value,currency){
 if(!Number.isFinite(value)||value<0)return 'n/a';
 if(value>MAX_SHOWN)return '>1e15';
 if(value>0&&value<MIN_SHOWN)return '<1e-12';
 if(currency==='USD')return value===0?'$0.00':value>=1?'$'+value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'$'+significant(value,3);
 return significant(value,4);
}
function significant(value,digits){return value.toLocaleString('en-US',{maximumSignificantDigits:digits,useGrouping:true});}
export function formatQuotePrice(value){if(!Number.isFinite(value)||value<=0)return 'n/a';if(value>MAX_SHOWN)return '>$1e15';if(value<MIN_SHOWN)return '<$1e-12';return value>=1?'$'+value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'$'+significant(value,4);}
export function exactCreditParts(raw){const exact=exactCreditUnits(raw),[whole,decimals]=exact.split('.');return {exact,head:whole+'.'+decimals.slice(0,6),tail:decimals.slice(6)};}
/** wXMR per SOL from both quotes (SOL price / wXMR price); null when either is expired or the ratio is not a positive finite number. */
export function derivedSolWxmr(prices,now){if(priceFreshness(prices?.SOL,now)==='expired'||priceFreshness(prices?.wXMR,now)==='expired')return null;const ratio=prices.SOL.price/prices.wXMR.price;return Number.isFinite(ratio)&&ratio>0?ratio:null;}
export function quoteAge(updatedAt,now){const seconds=Math.max(0,Math.floor((now-updatedAt)/1000));return seconds<60?`${seconds}s ago`:seconds<3600?`${Math.floor(seconds/60)}m ago`:`${Math.floor(seconds/3600)}h ago`;}
