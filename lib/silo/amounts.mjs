// SPDX-License-Identifier: AGPL-3.0-only
// Decimals-generic exact decimal-string -> atomic-units parser, no floating-point arithmetic at any step (Sol's
// review, 29 Oct 2026: conversion-service.mjs previously used Math.round(Number(value) * 10 ** decimals), which
// is exact for siloAmount's own 8/12-decimal wallet inputs but not guaranteed in general -- IEEE-754 multiplication
// by a power of ten can misrepresent an exact decimal value for other decimals counts, such as SOL's 9 or USDC's
// 6). Extra fractional digits beyond `decimals` are truncated (never rounded up), so this never produces an
// atomic amount larger than the exact decimal value -- the same direction as flooring, just exact.
export function siloExactAtomic(value,decimals){
 if(!Number.isInteger(decimals)||decimals<0||decimals>18)throw Error('Invalid asset decimals.');
 // A number (e.g. parsed from a provider's JSON response) may be negative, non-finite, or print in exponential
 // notation when stringified (JS does this for small magnitudes, such as 5e-11). toFixed(decimals) alone would
 // sidestep the exponential-notation problem but ROUNDS to that many digits -- Sol's review, 29 Oct 2026, found
 // this could still round UP (e.g. .5 at the final kept digit), contradicting "truncated, never rounded up"
 // below. toFixed(100) instead exposes the double's own EXACT decimal expansion (doubles are dyadic rationals,
 // so this terminates and is lossless, never a rounding of the true value) with no rounding at `decimals` at
 // all -- the truncation two lines down is then the only place digits beyond `decimals` are ever dropped, same
 // as the string path. A plain string input (every one of this codebase's own amount fields) is never allowed
 // exponential notation at all -- it must already be the exact decimal text to bind.
 const text=typeof value==='number'&&Number.isFinite(value)&&value>=0?value.toFixed(100)
  :typeof value==='string'&&/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)?value:null;
 if(text===null)throw Error('Invalid amount.');
 const [whole,fraction='']=text.split('.'),truncated=fraction.length>decimals?fraction.slice(0,decimals):fraction;
 const raw=BigInt(whole)*10n**BigInt(decimals)+BigInt(truncated.padEnd(decimals,'0')||'0');
 if(raw<0n||raw>18446744073709551615n)throw Error('Amount is outside the wallet range.');
 return raw;
}
export function siloAmount(value,decimals){
 if(typeof value!=='string'||![8,12].includes(decimals)||!new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${decimals}})?$`).test(value))throw Error('Enter a positive amount without exponent notation.');
 const [whole,fraction='']=value.split('.'),raw=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0'));
 if(raw<=0n||raw>18446744073709551615n)throw Error('Amount is outside the wallet range.');return raw;
}
export function siloUnits(value,decimals){if(!Number.isInteger(decimals)||decimals<0||decimals>18)throw Error('Invalid asset decimals.');if(value===null||value===undefined)return 'not checked';if(!/^\d+$/.test(String(value)))throw Error('Invalid balance.');if(decimals===0)return BigInt(value).toString();const raw=BigInt(value).toString().padStart(decimals+1,'0');return raw.slice(0,-decimals)+'.'+(raw.slice(-decimals).replace(/0+$/,'')||'0');}
export function transactionConsent({network,asset,address,amount,fee}){return `Send ${amount} ${asset} to ${address} on ${network}. Network fee: ${fee} ${asset}.`;}
