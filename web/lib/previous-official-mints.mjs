/** Previous official GRAIN mints stay readable and are refused by every current-official path. */
export const PREVIOUS_OFFICIAL_MINTS=Object.freeze([
 Object.freeze({mint:'Db91fm8AxxfoFySAp6Jg3KVcfZHUTAR7bJDJb5WLMgrn',retiredAt:'2026-10-04',reason:'relaunch'}),
]);
const mints=new Set(PREVIOUS_OFFICIAL_MINTS.map(row=>row.mint));
export const PREVIOUS_TOKEN_BANNER='Previous GRAIN token. Not supported by grainpad.';
export function isPreviousOfficialMint(mint){return typeof mint==='string'&&mints.has(mint);}
export function assertNotPreviousOfficialMint(mint){
 if(isPreviousOfficialMint(mint))throw Error('Previous GRAIN token. Not supported by grainpad.');
}
