export function displayUnits(n,decimals){n=BigInt(n);const scale=10n**BigInt(decimals);return `${n/scale}.${(n%scale).toString().padStart(decimals,'0')}`.replace(/\.?0+$/,'');}

/** Floor in atomic units so a percentage never exceeds the spendable balance. */
export function percentageUnits(balance,percent,decimals){
 const raw=BigInt(balance);
 if(raw<0n||!Number.isInteger(percent)||percent<0||percent>100)throw Error('Invalid balance percentage.');
 const amount=raw*BigInt(percent)/100n;
 return decimals===0?amount.toString():displayUnits(amount,decimals);
}
