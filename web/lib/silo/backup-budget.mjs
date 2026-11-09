import {SILO_MAX_PLAINTEXT_BYTES,SILO_MAX_XMR_PLAINTEXT_BYTES} from './local-envelope.mjs';
/** A wallet cache that outgrows the envelope bound must never cost the recovery material or a pending payment.
 * Over the bound, the scan cache is dropped and the seed, birthday, account and pending journal are kept;
 * the next unlock rescans from the birthday. A ZEC pending payment lives in the wallet database, so it cannot
 * be reduced: persistence fails, which also blocks its broadcast. */
export function boundedSiloBackup(zone,backup,limit=zone==='xmr'?SILO_MAX_XMR_PLAINTEXT_BYTES:SILO_MAX_PLAINTEXT_BYTES){
 const size=value=>new TextEncoder().encode(JSON.stringify(value)).length;
 if(size(backup)<=limit)return backup;
 const reduced=recoveryOnlyBackup(zone,backup);
 if(size(reduced)>limit)throw Error('Recovery material exceeds the local storage bound.');
 return reduced;
}
/** The seed, birthday, account and pending journal without the scan cache. */
export function recoveryOnlyBackup(zone,backup){
 if(zone==='xmr'&&backup?.subaddressCacheRequired===true)throw Error('Known XMR receive addresses need the full wallet cache. Keep this wallet open and export its full encrypted backup.');
 if(zone==='zec'&&backup?.pending)throw Error('The wallet database is too large to save with a pending payment. Keep this wallet open and export its backup.');
 const recovery=Object.fromEntries(Object.entries(backup).filter(([key])=>!['keysData','cacheData','database'].includes(key)));
 if(typeof recovery.seed!=='string'||!recovery.seed)throw Error('Recovery material is unavailable; the wallet cache was not reduced.');
 return {...recovery,cacheOmitted:true};
}
