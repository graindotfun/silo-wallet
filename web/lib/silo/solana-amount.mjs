export function siloSolanaAmount(value,decimals){
 if(!Number.isInteger(decimals)||decimals<0||decimals>18||typeof value!=='string'||value.length>40||!new RegExp(`^(0|[1-9]\\d*)(\\.\\d{1,${Math.max(1,decimals)}})?$`).test(value)||(decimals===0&&value.includes('.')))throw Error('Enter a positive token amount without exponent notation.');
 const [whole,fraction='']=value.split('.');const raw=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0'));
 if(raw<=0n||raw>18446744073709551615n)throw Error('Amount is outside the token range.');return raw.toString();
}
