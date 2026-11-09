/** Display-only rate lines for the Convert quote. Everything comes from the quote on screen, the fee policy the panel
 * already holds and the price read the wallet already makes (SOL and XMR spot in USD). No new source, no network call;
 * nothing here feeds an amount that is signed or sent. */
const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const trim=(value,digits)=>{const text=value.toFixed(digits);return text.includes('.')?text.replace(/\.?0+$/,''):text;};
export function conversionRateText(rate){if(!positive(rate))return null;return trim(rate,rate>=100?2:rate>=1?4:rate>=0.01?6:8);}
/** @param {{source:string,dest:string,amount:string,amountTo:string,silo?:number|null,usd?:{SOL?:number|null,XMR?:number|null}|null}} input */
export function conversionRateLines({source,dest,amount,amountTo,silo=null,usd=null}){
 const from=Number(amount),to=Number(amountTo);
 if(!positive(from)||!positive(to))return null;
 const text=conversionRateText(to/from);if(!text)return null;
 const lines=[`Rate: 1 ${source.toUpperCase()} = ${text} ${dest.toUpperCase()}`,'Provider: outside provider (rate includes its fees)'];
 if(Number.isFinite(silo)&&silo>=0)lines.push(`Silo markup: ${trim(silo/100,2)}%`);
 const pair=[source,dest].sort().join('-');
 if(pair==='sol-xmr'){
  const sol=usd?.SOL,xmr=usd?.XMR;
  if(positive(sol)&&positive(xmr)){
   const market=source==='sol'?from*sol/xmr:from*xmr/sol;
   const gap=(1-to/market)*100;
   if(Number.isFinite(gap))lines.push(gap>=0?`about ${trim(gap,1)}% under market`:`about ${trim(-gap,1)}% above market`);
  }
 }
 return lines;
}
