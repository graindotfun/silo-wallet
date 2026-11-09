import {SILO_JUPITER_TARGET_ROSTER} from './jupiter-target-roster.mjs';
/** Display names for the owner-selected exact catalogue. Names/tickers are not
 * mint identity or release acceptance; user holdings cannot extend this list. */
/** @type {Readonly<Record<string,string>>} */
const names=Object.freeze({SOL:'Solana',USDC:'USD Coin',WIF:'dogwifhat',BONK:'Bonk',PENGU:'Pudgy Penguins',POPCAT:'Popcat',FARTCOIN:'Fartcoin',TRUMP:'Official Trump',PNUT:'Peanut the Squirrel',BOME:'Book of Meme',MEW:'cat in a dogs world',PUMP:'pump.fun',ANSEM:'The Black Bull'});
export const SILO_TARGET_SEARCH_MAX_CHARS=64;
/** @param {string} query */
export function siloJupiterTargetSearch(query){
 if(typeof query!=='string'||query.length>SILO_TARGET_SEARCH_MAX_CHARS||/[\u0000-\u001f\u007f-\u009f]/.test(query))return Object.freeze({valid:false,rows:Object.freeze(SILO_JUPITER_TARGET_ROSTER.filter(()=>false)),reason:'Use at most 64 characters without control characters.'});
 const search=query.trim();
 const exact=SILO_JUPITER_TARGET_ROSTER.find(row=>row.mint===search);
 const normalized=search.toLocaleLowerCase('en-US');
 // Address-looking input requires case-sensitive exact identity, never a fuzzy mint match.
 const addressLike=search.length>=32&&/^[A-Za-z0-9]+$/.test(search);
 const rows=exact?[exact]:addressLike?[]:SILO_JUPITER_TARGET_ROSTER.filter(row=>!search||row.symbol.toLocaleLowerCase('en-US').includes(normalized)||names[row.symbol].toLocaleLowerCase('en-US').includes(normalized));
 return Object.freeze({valid:true,rows:Object.freeze(rows),reason:null});
}
export function siloJupiterTargetDisplayName(symbol){return names[symbol]??null;}
