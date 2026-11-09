/** Nonsecret presentation preference only. It does not encrypt wallet data or alter payments. */
export const SILO_BALANCE_VISIBILITY_KEY='grain-silo-hide-balances-v1';
export function readSiloBalancesHidden(storage){try{const value=storage.getItem(SILO_BALANCE_VISIBILITY_KEY);if(value===null||value==='shown')return false;return true;}catch{return true;}}
export function writeSiloBalancesHidden(storage,hidden){if(typeof hidden!=='boolean')throw Error('Choose whether balances are hidden.');const value=hidden?'hidden':'shown';storage.setItem(SILO_BALANCE_VISIBILITY_KEY,value);if(storage.getItem(SILO_BALANCE_VISIBILITY_KEY)!==value)throw Error('Display preference could not be saved.');return hidden;}
