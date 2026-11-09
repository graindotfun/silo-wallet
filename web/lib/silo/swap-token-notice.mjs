// Non-blocking notices for the swap review. Informational only: nothing here refuses or changes a swap.
// Token-2022 is detected from the mint account owner (the contract's input/output program), never by parsing extensions.
export const SILO_KNOWN_SWAP_MINTS=Object.freeze(new Set([
 'So11111111111111111111111111111111111111112',
 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
 'FCN2KLyUGT9EddKf8MZYjPce8CWxUid7nWpAx9ograin']));
export const SILO_TOKEN_2022_PROGRAM='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const SILO_UNVERIFIED_TOKEN_NOTICE='Unverified token. Anyone can create a token with any name. Check the address before you swap.';
export const SILO_TOKEN_2022_NOTICE='This token uses Token-2022 and may charge a fee on every transfer, so you may receive less than quoted.';
export function siloSwapTokenNotices(contract){
 const out=[];
 if(!contract)return out;
 if([contract.inputMint,contract.outputMint].some(m=>typeof m==='string'&&!SILO_KNOWN_SWAP_MINTS.has(m)))out.push(SILO_UNVERIFIED_TOKEN_NOTICE);
 if(contract.inputProgram===SILO_TOKEN_2022_PROGRAM||contract.outputProgram===SILO_TOKEN_2022_PROGRAM)out.push(SILO_TOKEN_2022_NOTICE);
 return out;
}
