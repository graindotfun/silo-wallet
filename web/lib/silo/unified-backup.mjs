// One backup file for the whole Silo wallet (owner decision, 20 October 2026, after security review of the V1 test-network
// stage, part 3): the Solana key's encrypted envelope and the Monero wallet's encrypted envelope travel together. Each part
// keeps its own seal and passphrase exactly as exported alone, so nothing here decrypts, re-encrypts or reads a secret: this
// module only arranges sealed envelopes, names the file and takes a part back out. A single-zone export uses the same naming,
// so every export has its own identifier and no export can overwrite an earlier file.
import {SILO_MAX_IMPORT_BYTES} from './local-envelope.mjs';

export const SILO_UNIFIED_BACKUP_FORMAT='grain-silo-unified-backup-v1';
/** v2 adds the EVM part (Ethereum, Base, BNB share one key). It is written ONLY when an EVM part is present, so a file without one stays
 * exactly v1 and old clients keep opening it; an old client refuses a v2 file by name rather than silently skipping the EVM key.
 * A v1 file that carries an EVM part, or a v2 file that does not, is malformed and refused (no downgrade, no ambiguity). */
export const SILO_UNIFIED_BACKUP_FORMAT_V2='grain-silo-unified-backup-v2';
/** v3 adds the Bitcoin part (mainnet, testnet or signet). Written ONLY when a Bitcoin part is present, so a file without one keeps
 * its exact v1 or v2 form and every existing client keeps opening it. An older client refuses a v3 file by name; it never silently drops
 * the Bitcoin key. The format must agree with the parts (v3 exactly when a btc part exists). */
export const SILO_UNIFIED_BACKUP_FORMAT_V3='grain-silo-unified-backup-v3';
export const SILO_BACKUP_ZONES=Object.freeze(['solana','evm','btc','xmr']);
/** The zones in their fixed file order. */
export const siloBackupZoneOrder=()=>[...SILO_BACKUP_ZONES];
const NETWORKS=Object.freeze({solana:Object.freeze(['mainnet','devnet']),evm:Object.freeze(['mainnet']),btc:Object.freeze(['mainnet','testnet','signet']),xmr:Object.freeze(['stagenet','mainnet'])});
const NATIVE_SCOPE='silo-native-keyring-v1';
const fail=(message,reason)=>Object.assign(Error(message),{siloBackup:reason});

/** 16 hex characters from 8 random bytes: distinct per export, carried in the file name and inside the file. */
export function siloBackupExportId(random=bytes=>crypto.getRandomValues(bytes)){
 const bytes=random(new Uint8Array(8));if(!(bytes instanceof Uint8Array)||bytes.length!==8)throw fail('Export identifier unavailable.','export-id');
 return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
}
export const isSiloBackupExportId=value=>typeof value==='string'&&/^[a-f0-9]{16}$/.test(value);

/** The zone and network a sealed envelope belongs to, read from its non-secret header only; null when it is neither kind. */
export function siloBackupEnvelopeZone(envelope){
 if(!envelope||typeof envelope!=='object'||Array.isArray(envelope))return null;
 if(envelope.scope===NATIVE_SCOPE&&envelope.chain==='solana'&&NETWORKS.solana.includes(envelope.network)&&typeof envelope.address==='string')return {zone:'solana',network:envelope.network};
 if(envelope.scope===NATIVE_SCOPE&&envelope.chain==='evm'&&NETWORKS.evm.includes(envelope.network)&&typeof envelope.address==='string')return {zone:'evm',network:envelope.network};
 if(envelope.scope===NATIVE_SCOPE&&envelope.chain==='btc'&&NETWORKS.btc.includes(envelope.network)&&typeof envelope.address==='string')return {zone:'btc',network:envelope.network};
 if(envelope.zone==='xmr'&&NETWORKS.xmr.includes(envelope.network)&&(envelope.version===1||envelope.version===2)&&typeof envelope.ciphertext==='string')return {zone:'xmr',network:envelope.network};
 return null;
}
export const isSiloUnifiedBackup=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&(value.format===SILO_UNIFIED_BACKUP_FORMAT||value.format===SILO_UNIFIED_BACKUP_FORMAT_V2||value.format===SILO_UNIFIED_BACKUP_FORMAT_V3));
/** The format must agree with the parts: an EVM part exists exactly when the format is v2. */
const siloBackupFormatFor=parts=>parts.btc?SILO_UNIFIED_BACKUP_FORMAT_V3:parts.evm?SILO_UNIFIED_BACKUP_FORMAT_V2:SILO_UNIFIED_BACKUP_FORMAT;
function formatMatchesParts(value){const present=zone=>value.parts?.[zone]!==undefined&&value.parts?.[zone]!==null;return value.format===siloBackupFormatFor({btc:present('btc'),evm:present('evm')});}

/** Packs sealed envelopes by zone into one container. At least one part; each part must be a sealed envelope of its zone. */
export function packSiloUnifiedBackup(parts,{exportId=siloBackupExportId(),createdAt=new Date().toISOString()}={}){
 if(!parts||typeof parts!=='object')throw fail('No backup parts.','parts');
 if(!isSiloBackupExportId(exportId))throw fail('Invalid export identifier.','export-id');
 const packed={},networks={};
 for(const zone of SILO_BACKUP_ZONES){
  const envelope=parts[zone];if(envelope===undefined||envelope===null)continue;
  const header=siloBackupEnvelopeZone(envelope);if(!header||header.zone!==zone)throw fail(`The ${zone} part is not a sealed Silo ${zone} backup.`,'part');
  packed[zone]=envelope;networks[zone]=header.network;
 }
 const extra=Object.keys(parts).filter(key=>!SILO_BACKUP_ZONES.includes(key));if(extra.length)throw fail('Unknown backup part.','part');
 if(!Object.keys(packed).length)throw fail('No backup parts.','parts');
 const container={format:siloBackupFormatFor(packed),exportId,createdAt,networks,parts:packed};
 if(JSON.stringify(container).length>SILO_MAX_IMPORT_BYTES)throw fail('Backup exceeds the supported size.','size');
 return container;
}

/** Non-secret description of a backup file: which parts it holds and for which networks. Never includes salts, nonces,
 * ciphertext or addresses. */
export function describeSiloBackupFile(value){
 if(isSiloUnifiedBackup(value)){
  if(!formatMatchesParts(value))return {kind:'unknown',exportId:null,parts:[]};
  const parts=[];for(const zone of SILO_BACKUP_ZONES){const header=siloBackupEnvelopeZone(value.parts?.[zone]);if(header&&header.zone===zone)parts.push(header);}
  return {kind:'unified',exportId:isSiloBackupExportId(value.exportId)?value.exportId:null,parts};
 }
 const header=siloBackupEnvelopeZone(value);return header?{kind:'single',exportId:null,parts:[header]}:{kind:'unknown',exportId:null,parts:[]};
}

/** The sealed envelope for one zone, from a unified file or from that zone's own file. The network must match the wallet
 * that will open it; the error names what is wrong without naming the file's networks (the caller may show them). */
export function siloBackupPart(value,zone,network){
 if(!SILO_BACKUP_ZONES.includes(zone)||!NETWORKS[zone].includes(network))throw fail('Unsupported wallet network.','target');
 let envelope=value;
 if(isSiloUnifiedBackup(value)){if(!formatMatchesParts(value))throw fail('This file is not a valid Silo backup.','format');envelope=value.parts?.[zone];if(envelope===undefined||envelope===null)throw fail(`This combined backup holds no ${zone==='solana'?'Solana':zone==='evm'?'Ethereum, Base and BNB':zone==='btc'?'Bitcoin':'Monero'} wallet. It was exported while that wallet was locked or before it existed: unlock both wallets and export again.`,'zone-missing');}
 const header=siloBackupEnvelopeZone(envelope);
 if(!header||header.zone!==zone)throw fail(`This file is not a Silo ${zone==='solana'?'Solana':zone==='evm'?'Ethereum, Base and BNB':zone==='btc'?'Bitcoin':'Monero'} backup.`,'format');
 if(header.network!==network)throw fail('Backup network mismatch.','network');
 return envelope;
}

/** `grain-silo-backup-<zone-network>[+<zone-network>]-<exportId>.encrypted.json`. Browsers add " (1)" when a name repeats,
 * but a distinct identifier per export means no two exports ever share a name in the first place. */
export function siloBackupFileName(value,exportId=isSiloUnifiedBackup(value)?value.exportId:undefined){
 const description=describeSiloBackupFile(value);if(description.kind==='unknown')throw fail('Not a Silo backup.','format');
 if(!isSiloBackupExportId(exportId))throw fail('Invalid export identifier.','export-id');
 return `grain-silo-backup-${description.parts.map(part=>`${part.zone}-${part.network}`).join('+')}-${exportId}.encrypted.json`;
}

/** One plain sentence about what a backup file holds, for the zone that is restoring it: it says whether the OTHER wallet is in the same file
 * (restore it there with the same file) or not (it needs its own backup file or the combined backup). Describes only the file's shape. */
export function siloBackupFileNote(value, zone) {
  const names = { solana: 'Solana', evm: 'Ethereum, Base and BNB', btc: 'Bitcoin', xmr: 'Monero' };
  if (!names[zone]) return '';
  const zones = describeSiloBackupFile(value).parts.map((part) => part.zone);
  if (!zones.includes(zone)) return '';
  // The notes keep naming the Solana/Monero pair exactly as before; Ethereum is named only when this file or this zone involves it.
  const relevant = SILO_BACKUP_ZONES.filter((candidate) => (candidate !== 'evm' || zone === 'evm' || zones.includes('evm')) && (candidate !== 'btc' || zone === 'btc' || zones.includes('btc')));
  const others = relevant.filter((other) => other !== zone);
  const held = others.filter((other) => zones.includes(other)), missing = others.filter((other) => !zones.includes(other));
  if (held.length) return `This combined file also holds your ${held.map((other) => names[other]).join(' and ')} wallet. Restore ${held.length > 1 ? 'each' : names[held[0]]} in its own section with the same file.${missing.length ? ` ${missing.map((other) => names[other]).join(' and ')} needs its own backup file or a combined backup that includes it.` : ''}`;
  return `This file contains ${names[zone]} only. ${missing.map((other) => names[other]).join(' and ')} needs its own backup file or the combined backup.`;
}
