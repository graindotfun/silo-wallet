import {resealNativeBackup,restoreNativeKeyring} from './native-keyring.mjs';
import {openSilo,sealSilo} from './local-envelope.mjs';
import {siloBackupEnvelopeZone,siloBackupZoneOrder} from './unified-backup.mjs';
/** One-passphrase migration of a wallet's sealed backup parts (Solana, EVM, Monero), pure and local. Nothing here stores anything:
 * it takes the ORIGINAL sealed parts and the passphrase each one has today, and returns NEW sealed parts all under one new passphrase,
 * or fails with the exact part that did not verify. The original parts are never changed (the caller keeps them until the user
 * discards them), and the result is all-or-nothing: if any part fails to open, re-seal or verify, no new part is returned at all.
 * Verification per part: the new part opens with the NEW passphrase and holds the same wallet (same address for Solana and EVM; the
 * same recovery payload, compared by digest, for Monero). Key derivation, signing and the sealed formats are the existing ones. */
const fail=(message,reason,zone)=>Object.assign(Error(message),{siloMigration:reason,zone});
const memoryStore=()=>{let envelope=null;return {closed:false,async read(){return envelope;},async create(e){if(envelope)return false;envelope=e;return true;},async remove(){envelope=null;return true;},close(){},onClose(){}};};
const digest=async value=>{const bytes=new TextEncoder().encode(JSON.stringify(value));try{const out=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));return Array.from(out,b=>b.toString(16).padStart(2,'0')).join('');}finally{bytes.fill(0);}};
/** Best-effort: drops every field of a decrypted recovery object once it is no longer needed. JavaScript cannot guarantee that strings are erased from memory; this removes our references. */
const scrub=value=>{if(value&&typeof value==='object'){for(const key of Object.keys(value))delete value[key];}};
async function resealNative(zone,chain,envelope,original,fresh){
 const header=siloBackupEnvelopeZone(envelope);
 if(!header||header.zone!==zone)throw fail(`The ${zone} part is not a sealed Silo ${zone} backup.`,'part',zone);
 let sealed;
 try{sealed=await resealNativeBackup({chain,backup:envelope,originalPassphrase:original,newPassphrase:fresh,network:header.network});}
 catch(error){throw fail(`The ${zone} part did not open with the passphrase given for it. Nothing was changed.`,'original-passphrase',zone);}
 let opened;
 try{opened=await restoreNativeKeyring({chain,backup:sealed,passphrase:fresh,store:memoryStore(),network:header.network});}
 catch{throw fail(`The re-sealed ${zone} part did not verify. Nothing was changed.`,'verify',zone);}
 try{if(opened.metadata().address!==envelope.address)throw fail(`The re-sealed ${zone} part holds a different wallet. Nothing was changed.`,'verify',zone);}finally{opened.lock();}
 return sealed;
}
async function resealMonero(envelope,original,fresh){
 const header=siloBackupEnvelopeZone(envelope);
 if(!header||header.zone!=='xmr')throw fail('The xmr part is not a sealed Silo xmr backup.','part','xmr');
 let payload=null,again=null;
 try{
  try{payload=await openSilo(envelope,original);}catch{throw fail('The xmr part did not open with the passphrase given for it. Nothing was changed.','original-passphrase','xmr');}
  const before=await digest(payload);
  let sealed;try{sealed=await sealSilo(envelope.zone,envelope.network,payload,fresh);}catch{throw fail('The xmr part could not be re-sealed. Nothing was changed.','verify','xmr');}
  try{again=await openSilo(sealed,fresh);}catch{throw fail('The re-sealed xmr part did not verify. Nothing was changed.','verify','xmr');}
  if(await digest(again)!==before)throw fail('The re-sealed xmr part holds different data. Nothing was changed.','verify','xmr');
  return sealed;
 }finally{scrub(payload);scrub(again);payload=null;again=null;}
}
/** parts: {solana?,evm?,xmr?} sealed originals. passphrases: the passphrase of each part today. newPassphrase: the one passphrase. Returns the new parts. */
export async function migrateBackupToOnePassphrase({parts,passphrases,newPassphrase}){
 if(!parts||typeof parts!=='object'||Array.isArray(parts))throw fail('No backup parts.','parts');
 if(Object.keys(parts).some(zone=>!siloBackupZoneOrder().includes(zone)))throw fail('Unknown backup part.','part');
 const zones=siloBackupZoneOrder().filter(zone=>parts[zone]!==undefined&&parts[zone]!==null);
 if(!zones.length)throw fail('No backup parts.','parts');
 const out={};
 for(const zone of zones){
  const original=passphrases?.[zone];
  out[zone]=zone==='xmr'?await resealMonero(parts[zone],original,newPassphrase):await resealNative(zone,zone,parts[zone],original,newPassphrase);
 }
 return out;
}
