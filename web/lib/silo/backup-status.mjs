import {sha256} from '@noble/hashes/sha256';
import {assertSiloNetwork} from './local-envelope.mjs';
const MAX_METADATA=1024,MAX_ENVELOPE=192*1024*1024;
const encoder=new TextEncoder();
const key=identity=>{assertSiloNetwork(identity?.zone,identity?.network);if(!/^[a-f0-9]{64}$/.test(identity?.fingerprint??'')||![1,2].includes(identity?.envelopeVersion))throw Error('Encrypted backup identity required.');return `grain-silo-backup-status-v1:${identity.zone}:${identity.network}`;};
/** Hashes only a known encrypted-envelope shape, incrementally to avoid another
 * complete cache-sized allocation. The digest is identity, not authentication or
 * proof of recovery. No seed, plaintext, passphrase or ciphertext is persisted. */
export async function siloEncryptedBackupIdentity(envelope,{zone,network}={}){
 assertSiloNetwork(zone,network);
 const fields=['version','zone','network','kdf','iterations','cipher','salt','iv','ciphertext','plainBytes','extraChunks'];
 if(!envelope||Object.keys(envelope).some(k=>!fields.includes(k))||envelope.zone!==zone||envelope.network!==network||![1,2].includes(envelope.version)||envelope.kdf!=='PBKDF2-SHA256'||envelope.iterations!==600000||envelope.cipher!=='AES-256-GCM')throw Error('Known encrypted backup envelope required.');
 const b64=value=>{if(typeof value!=='string'||value.length<1||value.length>MAX_ENVELOPE||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw Error('Invalid encrypted backup field.');return value;};
 const snapshot={...envelope,salt:b64(envelope.salt),iv:b64(envelope.iv),ciphertext:b64(envelope.ciphertext)};
 if(envelope.version===1&&(envelope.extraChunks!==undefined||envelope.plainBytes!==undefined))throw Error('Invalid legacy backup shape.');
 if(envelope.version===2){if(!Number.isSafeInteger(envelope.plainBytes)||envelope.plainBytes<1||envelope.plainBytes>128*1024*1024||!Array.isArray(envelope.extraChunks)||envelope.extraChunks.length>15)throw Error('Invalid chunked backup shape.');snapshot.extraChunks=envelope.extraChunks.map(part=>{if(!part||Object.keys(part).length!==2||!Object.hasOwn(part,'iv')||!Object.hasOwn(part,'ciphertext'))throw Error('Invalid encrypted backup chunk.');return {iv:b64(part.iv),ciphertext:b64(part.ciphertext)};});}
 const digest=sha256.create();let total=0,sinceYield=0;
 const update=async text=>{for(let start=0;start<text.length;start+=65536){const bytes=encoder.encode(text.slice(start,start+65536));total+=bytes.length;sinceYield+=bytes.length;if(total>MAX_ENVELOPE)throw Error('Encrypted backup exceeds fingerprint bound.');digest.update(bytes);if(sinceYield>=4*1024*1024){sinceYield=0;await new Promise(resolve=>setTimeout(resolve,0));}}};
 const walk=async value=>{if(typeof value==='string'){await update('"');await update(value);await update('"');}else if(Array.isArray(value)){await update('[');for(let i=0;i<value.length;i++){if(i)await update(',');await walk(value[i]);}await update(']');}else if(value&&typeof value==='object'){await update('{');const keys=Object.keys(value).sort();for(let i=0;i<keys.length;i++){if(i)await update(',');await update(JSON.stringify(keys[i])+':');await walk(value[keys[i]]);}await update('}');}else await update(JSON.stringify(value));};
 await walk(snapshot);return Object.freeze({zone,network,envelopeVersion:snapshot.version,fingerprint:Array.from(digest.digest(),byte=>byte.toString(16).padStart(2,'0')).join('')});
}
function record(storage,identity){const text=storage.getItem(key(identity));if(text===null)return null;if(text.length>MAX_METADATA)throw Error('Backup status metadata exceeds bound.');const row=JSON.parse(text),allowed=['version','zone','network','envelopeVersion','fingerprint','exportInitiatedAt','checkedAt'];if(!row||Object.keys(row).some(k=>!allowed.includes(k))||row.version!==1||row.zone!==identity.zone||row.network!==identity.network)throw Error('Invalid backup status metadata.');key(row);for(const name of ['exportInitiatedAt','checkedAt'])if(row[name]!==null&&(!Number.isSafeInteger(row[name])||row[name]<0))throw Error('Invalid backup status time.');return row;}
export function readSiloBackupStatus(storage,identity){const row=record(storage,identity),current=Boolean(row&&row.fingerprint===identity.fingerprint&&row.envelopeVersion===identity.envelopeVersion);return {current,exportInitiatedAt:row?.exportInitiatedAt??null,checkedAt:row?.checkedAt??null,scope:'Exact encrypted file version; download initiation and local check only.'};}
export function recordSiloBackupEvent(storage,identity,event,{at=Date.now(),successfulCheck=false}={}){
 if(!Number.isSafeInteger(at)||at<0||!['export-initiated','verified-local'].includes(event)||event==='verified-local'&&successfulCheck!==true)throw Error('Successful explicit backup event required.');
 const previous=record(storage,identity),same=previous?.fingerprint===identity.fingerprint&&previous?.envelopeVersion===identity.envelopeVersion;
 const row={version:1,zone:identity.zone,network:identity.network,envelopeVersion:identity.envelopeVersion,fingerprint:identity.fingerprint,exportInitiatedAt:same?previous.exportInitiatedAt:null,checkedAt:same?previous.checkedAt:null};
 row[event==='export-initiated'?'exportInitiatedAt':'checkedAt']=at;const text=JSON.stringify(row);if(text.length>MAX_METADATA)throw Error('Backup status metadata exceeds bound.');storage.setItem(key(identity),text);if(storage.getItem(key(identity))!==text)throw Error('Backup status metadata could not be saved.');return readSiloBackupStatus(storage,identity);
}

// Positive receive-gate proof is bound to the exact encrypted browser copy, not
// absence of a best-effort "needs backup" flag. Missing, stale or unreadable
// metadata never proves recovery; resealing may carry only an already proven
// in-session wallet state. This is local UX evidence, not external restore proof.
const recoveryKey=identity=>{key(identity);return `grain-silo-recovery-proof-v1:${identity.zone}:${identity.network}`;};
export function readSiloRecoveryProof(storage,identity){
 try{const text=storage.getItem(recoveryKey(identity));if(typeof text!=='string'||text.length>256)return false;const row=JSON.parse(text);return Boolean(row&&Object.keys(row).length===3&&row.version===1&&row.fingerprint===identity.fingerprint&&row.envelopeVersion===identity.envelopeVersion);}
 catch{return false;}
}
export function recordSiloRecoveryProof(storage,identity,{recoveryProven=false}={}){
 if(recoveryProven!==true)throw Error('Successful recovery proof required.');
 const target=recoveryKey(identity),text=JSON.stringify({version:1,fingerprint:identity.fingerprint,envelopeVersion:identity.envelopeVersion});
 storage.setItem(target,text);if(storage.getItem(target)!==text)throw Error('Recovery proof could not be saved.');
 return true;
}
export function clearSiloRecoveryProof(storage,{zone,network}){assertSiloNetwork(zone,network);storage.removeItem(`grain-silo-recovery-proof-v1:${zone}:${network}`);}
