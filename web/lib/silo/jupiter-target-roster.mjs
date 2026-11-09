/** Owner-selected planning catalogue, not the execution admission registry.
 * Exact mint identity is never inferred from a ticker or connected holdings.
 * Pending targets cannot initiate provider or wallet actions. */
const CLASSIC='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN2022='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const SILO_TARGET_SOL_MINT='So11111111111111111111111111111111111111112';
export const SILO_TARGET_USDC_MINT='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** @type {Array<[string,string,number,string,string,string]>} */
const rows=[
 ['SOL',SILO_TARGET_SOL_MINT,9,CLASSIC,'indicative-only','Executable acceptance remains held.'],
 ['USDC',SILO_TARGET_USDC_MINT,6,CLASSIC,'indicative-only','Executable acceptance remains held; issuer mint and freeze authorities remain present.'],
 ['WIF','EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',6,CLASSIC,'candidate-held','The existing SOL-anchored candidate still needs release acceptance.'],
 ['BONK','DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',5,CLASSIC,'under-review','Exact routes and execution are not accepted in Silo yet.'],
 ['PENGU','2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv',6,CLASSIC,'under-review','Exact routes and execution are not accepted in Silo yet.'],
 ['POPCAT','7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',9,CLASSIC,'under-review','Exact routes and execution are not accepted in Silo yet.'],
 ['FARTCOIN','9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump',6,CLASSIC,'under-review','Exact routes and execution are not accepted in Silo yet.'],
 ['TRUMP','6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN',6,CLASSIC,'under-review','Exact routes and execution are not accepted in Silo yet.'],
 ['PNUT','2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump',6,CLASSIC,'under-review','Exact routes and execution are not accepted in Silo yet.'],
 ['BOME','ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',6,CLASSIC,'under-review','Exact routes and execution are not accepted in Silo yet.'],
 ['MEW','MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5',5,CLASSIC,'under-review','Exact routes and execution are not accepted in Silo yet.'],
 ['PUMP','pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn',6,TOKEN2022,'unsupported-transfer-behavior','Pending: its transfer behavior can change; Silo does not support that swap contract.'],
 ['ANSEM','9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump',6,TOKEN2022,'token-2022-under-review','Pending: Token-2022 swap handling is under review; this exact mint is The Black Bull.'],
];
export const SILO_JUPITER_TARGET_ROSTER=Object.freeze(rows.map(([symbol,mint,decimals,program,status,reason])=>Object.freeze({symbol,mint,decimals,program,status,reason,releaseAccepted:false,unavailable:status!=='indicative-only',label:status==='indicative-only'?symbol:`${symbol} · under review`,primaryMintSlot:mint===SILO_TARGET_SOL_MINT?null:455748176})));
export function siloJupiterTarget(mint){return SILO_JUPITER_TARGET_ROSTER.find(row=>row.mint===mint)??null;}
/** This permits the current indicative surface only, not signing/execution. */
export function siloJupiterIndicativePair(inputMint,outputMint){const a=siloJupiterTarget(inputMint),b=siloJupiterTarget(outputMint);return Boolean(a&&b&&!a.unavailable&&!b.unavailable&&a.mint!==b.mint);}
