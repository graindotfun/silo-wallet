import {restoreNativeKeyring} from './native-keyring.mjs';
import {openSilo} from './local-envelope.mjs';
import {migrateBackupToOnePassphrase} from './backup-reseal.mjs';
import {packSiloUnifiedBackup,siloBackupPart,siloBackupZoneOrder,siloBackupEnvelopeZone} from './unified-backup.mjs';
/** "Switch to one passphrase": the three steps behind the Settings > Backup screen, pure and injectable so every failure path is tested.
 *   1. prepare: read each open wallet's sealed envelope, re-seal ALL of them under the one passphrase (all-or-nothing), build the new combined
 *      file. Nothing is written to any device store.
 *   2. verifySaved: the person saves the file and picks it again; every part must open with the NEW passphrase and the file must be exactly the
 *      one prepared. Only this proof unlocks step 3.
 *   3. commit: replace each device copy with the new part, one wallet at a time. Each replacer keeps the ORIGINAL (archived, deleted only by
 *      the person) and, if any replacement fails, the ones already replaced are put back from their originals and the failure is reported.
 * Key derivation, signing and the sealed formats are the existing ones. */
const fail=(message,reason,zone)=>Object.assign(Error(message),{siloSwitch:reason,zone});
/** SHA-256 of the canonical JSON of a sealed part (ciphertext and public header only). The encoded bytes are zeroed after hashing. */
export async function siloPartDigest(value){const bytes=new TextEncoder().encode(JSON.stringify(value));try{const out=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));return Array.from(out,b=>b.toString(16).padStart(2,'0')).join('');}finally{bytes.fill(0);}}
/** The Monero RECOVERY STATE revision: a digest of everything in the wallet's backup payload except the volatile sync cache (keysData, cacheData, database,
 * cacheOmitted): the seed, birthday, account, receive state, pending payment and the swap/conversion recovery journal. It changes exactly when recovery data is
 * added or changed, and not on a re-seal or a sync. Keys are sorted, so the same state always gives the same digest. */
const VOLATILE=new Set(['keysData','cacheData','database','cacheOmitted']);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export async function siloXmrRecoveryDigest(payload){
 if(!payload||typeof payload!=='object')throw fail('The Monero recovery state could not be read.','recovery');
 const stable=Object.fromEntries(Object.entries(payload).filter(([key])=>!VOLATILE.has(key)));
 return 'recovery:'+await siloPartDigest(canonical(stable));
}
/** What identifies a wallet's CURRENT state for the inventory binding. Solana and EVM: the digest of the sealed envelope (stable). Monero: its envelope is re-sealed
 * (fresh salt) on every read, so its RECOVERY STATE revision is bound instead: the envelope is opened with the wallet's current passphrase and the revision of
 * its payload is computed (the payload is scrubbed afterwards). */
export async function siloInventoryDigest(zone,envelope,passphrase){
 if(zone!=='xmr')return siloPartDigest(envelope);
 let payload=null;
 try{payload=await openSilo(envelope,passphrase);return await siloXmrRecoveryDigest(payload);}
 catch(error){if(error?.siloSwitch)throw error;throw fail('The Monero wallet could not be read to check its recovery state.','recovery','xmr');}
 finally{if(payload&&typeof payload==='object')for(const key of Object.keys(payload))delete payload[key];payload=null;}
}
const memoryStore=()=>{let envelope=null;return {closed:false,async read(){return envelope;},async create(e){if(envelope)return false;envelope=e;return true;},async remove(){envelope=null;return true;},close(){},onClose(){}};};

/** sources: {zone:{envelope():Promise<sealed>}} for every wallet open now. locked: zones that exist but are locked (the switch refuses while any is). */
/** @param {{sources:any,locked?:string[],passphrases:any,newPassphrase:string}} input */
export async function prepareOnePassphraseSwitch({sources,locked=[],passphrases,newPassphrase}){
 if(locked.length)throw fail(`Unlock ${locked.join(' and ')} first: every wallet in this browser must be open to switch together.`,'locked',locked[0]);
 const zones=siloBackupZoneOrder().filter(zone=>sources?.[zone]);
 if(!zones.length)throw fail('No unlocked wallet to switch.','none');
 const originals={};
 for(const zone of zones){
  try{originals[zone]=await sources[zone].envelope();}catch{throw fail(`The ${zone} wallet is locked. Unlock it and try again.`,'locked',zone);}
  const header=siloBackupEnvelopeZone(originals[zone]);if(!header||header.zone!==zone)throw fail(`The ${zone} wallet could not be read.`,'part',zone);
 }
 let newParts;
 try{newParts=await migrateBackupToOnePassphrase({parts:originals,passphrases,newPassphrase});}
 catch(error){throw Object.assign(fail(error.message,error.siloMigration??'migrate',error.zone),{cause:error});}
 const file=JSON.parse(JSON.stringify(packSiloUnifiedBackup(newParts)));
 // The preparation's immutable identity: the exact file, the exact original of every wallet, the exact new part of every wallet. Verification of the
 // saved file and the commit both carry this id, so neither can be applied to a different (older, newer or cancelled) preparation.
 const inventory={zones:[...zones],digests:Object.fromEntries(await Promise.all(zones.map(async zone=>[zone,await siloInventoryDigest(zone,originals[zone],passphrases?.[zone])])))};
 const partDigests=Object.fromEntries(await Promise.all(zones.map(async zone=>[zone,await siloPartDigest(newParts[zone])])));
 const id=await siloPartDigest({file,inventory,partDigests});
 return deepFreeze({id,originals,newParts,file,zones,inventory,partDigests});
}
function deepFreeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const key of Object.keys(value))deepFreeze(value[key]);}return value;}

/** `text` is the file as the person saved it. Proves every part opens with the new passphrase and the file is exactly the prepared one. */
export async function verifySavedSwitchFile({text,prepared,newPassphrase}){
 let parsed;try{parsed=JSON.parse(text);}catch{throw fail('That file is not the saved backup. Pick the file you just downloaded.','file');}
 if(JSON.stringify(parsed)!==JSON.stringify(prepared.file))throw fail('That is not the file just prepared. Pick the file you just downloaded.','file');
 for(const zone of prepared.zones){
  const part=siloBackupPart(parsed,zone,siloBackupEnvelopeZone(prepared.newParts[zone]).network);
  try{
   if(zone==='xmr')await openSilo(part,newPassphrase);
   else{const session=await restoreNativeKeyring({chain:zone,backup:part,passphrase:newPassphrase,store:memoryStore(),network:part.network});try{if(session.metadata().address!==prepared.originals[zone].address)throw Error();}finally{session.lock();}}
  }catch{throw fail(`The saved file's ${zone} part did not open with the new passphrase.`,'verify',zone);}
 }
 return Object.freeze({preparationId:prepared.id});
}

/** verification: what verifySavedSwitchFile returned for THIS preparation. currentInventory(): async () => {zones, locked, digests} of the wallets right now.
 * replacers: {zone:{replace(envelope,{original,rollback,partDigest,preparationId,written,writtenDigest})}}. Replaces in file order.
 * ROLLBACK IS OWNERSHIP AWARE (Astra round 3, H3): a replacer calls `written()` immediately BEFORE it issues the write to the stored copy (after every check that can
 * refuse). On a failure only the wallets whose replacer called `written()` are put back, and a put-back receives `writtenDigest` (the digest of the part this switch
 * wrote) so the wallet restores the original only over a copy that is still exactly what this switch wrote. A replacer that refused without writing is never rolled
 * back: restoring an older snapshot there would overwrite newer recovery data. A put-back that fails is reported by name. */
export async function commitOnePassphraseSwitch({prepared,verification,replacers,currentInventory}){
 if(!verification||verification.preparationId!==prepared.id)throw fail('The saved file was not checked for this preparation. Prepare again and check the file you save.','verification');
 if(typeof currentInventory==='function'){
  let now;try{now=await currentInventory();}catch{throw fail('The wallets could not be read just before switching. Nothing was changed.','inventory-changed');}
  const same=now&&Array.isArray(now.zones)&&(now.locked??[]).length===0&&now.zones.length===prepared.inventory.zones.length&&prepared.inventory.zones.every(zone=>now.zones.includes(zone))&&prepared.inventory.zones.every(zone=>now.digests?.[zone]===prepared.inventory.digests[zone]);
  if(!same)throw fail('The set of wallets (or one of them) changed since the backup was prepared. Nothing was changed. Prepare again.','inventory-changed');
 }
 const wrote=new Set();let current;
 try{
  for(const zone of prepared.zones){
   current=zone;const replacer=replacers?.[zone]?.replace;if(typeof replacer!=='function')throw fail(`The ${zone} wallet cannot be switched here.`,'no-replacer',zone);
   await replacer(prepared.newParts[zone],{original:prepared.originals[zone],rollback:false,partDigest:prepared.partDigests[zone],preparationId:prepared.id,recoveryDigest:zone==='xmr'?prepared.inventory.digests.xmr:undefined,written:()=>{wrote.add(zone);}});
  }
 }catch(error){
  const stuck=[];
  for(const zone of [...prepared.zones].reverse()){
   if(!wrote.has(zone))continue;
   try{await replacers[zone].replace(prepared.originals[zone],{original:prepared.originals[zone],rollback:true,partDigest:await siloPartDigest(prepared.originals[zone]),preparationId:prepared.id,writtenDigest:prepared.partDigests[zone]});}catch{stuck.push(zone);}
  }
  throw Object.assign(fail(stuck.length?`The switch stopped and could not put back: ${stuck.join(', ')}. Your downloaded file and your original wallet copies are intact.`:'The switch stopped and every wallet was put back as it was.',stuck.length?'rollback-failed':'rolled-back',error.zone??current),{cause:error,stuck,wrote:[...wrote]});
 }
 return {replaced:[...wrote]};
}
