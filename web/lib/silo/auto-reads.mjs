/** The one-time choice to load Solana balances and public activity automatically (owner decision and Sol's UX
 * consultation Q3, 23 October 2026). Until this browser chooses, no address-bearing read starts by itself; an older manual
 * choice never counts. The choice is kept per Solana network with the notice version it was made under, and turning it
 * off stops later automatic reads. Nothing here sends anything. */
export const SILO_AUTO_READS_KEY='grain-silo-auto-reads-v1';
export const SILO_AUTO_READS_NOTICE='silo-beta-privacy-v4';
const networks=['mainnet-beta','devnet'];
function readAll(storage){try{const value=JSON.parse(storage.getItem(SILO_AUTO_READS_KEY)??'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}}
/** true, false, or null when this browser has not chosen for this network under the current notice. */
export function readSiloAutoReads(storage,network){
 if(!networks.includes(network))return null;
 const row=readAll(storage)[network];
 if(!row||row.version!==1||row.notice!==SILO_AUTO_READS_NOTICE||typeof row.enabled!=='boolean')return null;
 return row.enabled;
}
/** Records the choice; returns whether it was saved (a choice that cannot be saved holds for this page only). */
export function writeSiloAutoReads(storage,network,enabled){
 if(!networks.includes(network)||typeof enabled!=='boolean')throw Error('Invalid automatic-read choice.');
 try{const all=readAll(storage);all[network]={version:1,notice:SILO_AUTO_READS_NOTICE,enabled,decidedAt:new Date().toISOString().slice(0,10)};storage.setItem(SILO_AUTO_READS_KEY,JSON.stringify(all));return readSiloAutoReads(storage,network)===enabled;}catch{return false;}
}
