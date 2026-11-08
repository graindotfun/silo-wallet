// SPDX-License-Identifier: AGPL-3.0-only
const encoder = new TextEncoder(), decoder = new TextDecoder();
const MAX_BYTES = 16 * 1024 * 1024;
/** Plaintext bound for one sealed envelope. `boundedSiloBackup` keeps recovery material under it. */
export const SILO_MAX_PLAINTEXT_BYTES = MAX_BYTES;
// XMR's encrypted native scan cache includes chain hashes. Retain it with bounded,
// independently authenticated chunks; the old 16 MiB envelope remains readable.
export const SILO_MAX_XMR_PLAINTEXT_BYTES = 128 * 1024 * 1024;
export const SILO_MAX_IMPORT_BYTES = 192 * 1024 * 1024;
const CHUNK_BYTES = 8 * 1024 * 1024;
const extendedZone = zone => zone === 'xmr' || zone === 'vault';
const chunkMetadata = (metadata,index) => encoder.encode(JSON.stringify({...metadata,index}));
export const SILO_KDF_ITERATIONS = 600000;
const encode = bytes => {let raw='';for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(raw);};
const decode = value => {if(typeof value!=='string'||value.length>MAX_BYTES*2)throw Error('Invalid encrypted data.');const raw=atob(value),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);return bytes;};
// Passphrases are sealed in Unicode NFC, so the same words typed on another keyboard or OS (which may produce decomposed
// accents) open the backup. Backups sealed before this change are opened with the passphrase exactly as typed as a fallback.
const nfc=value=>typeof value==='string'?value.normalize('NFC'):value;
async function key(passphrase,salt){
 if(typeof passphrase!=='string'||passphrase.length<12||passphrase.length>256)throw Error('Use a passphrase of 12–256 characters.');
 const material=await crypto.subtle.importKey('raw',encoder.encode(passphrase),'PBKDF2',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:SILO_KDF_ITERATIONS,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export function assertSiloNetwork(zone,network){if(!((zone==='xmr'&&['stagenet','mainnet'].includes(network))||(zone==='zec'&&['testnet','mainnet'].includes(network))))throw Error('Unsupported wallet network.');}
export async function sealSilo(zone,network,payload,typed){
 const passphrase=nfc(typed);
 assertSiloNetwork(zone,network);const plain=encoder.encode(JSON.stringify(payload));if(plain.length>MAX_BYTES){try{return await sealChunks(zone,network,plain,passphrase);}finally{plain.fill(0);}}
 const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
 const metadata={version:1,zone,network,kdf:'PBKDF2-SHA256',iterations:SILO_KDF_ITERATIONS,cipher:'AES-256-GCM'};
 const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(JSON.stringify(metadata))},await key(passphrase,salt),plain);
 plain.fill(0);return {...metadata,salt:encode(salt),iv:encode(iv),ciphertext:encode(new Uint8Array(encrypted))};
}
/** Opening failures carry `siloDecrypt`, a category without secrets: 'format' (unknown envelope version or parameters), 'structure'
 * (lengths or encodings inconsistent), 'key' (the passphrase cannot derive a key), 'auth' (AES-GCM authentication failed: a different
 * passphrase than the one that sealed it, or altered ciphertext/metadata; the two cannot be told apart) or 'parse'. */
const openFailure=(message,reason)=>Object.assign(Error(message),{siloDecrypt:reason});
const keyFor=(passphrase,salt)=>key(passphrase,salt).catch(()=>{throw openFailure('The passphrase or encrypted backup is invalid.','key');});
const decrypted=(params,derived,encrypted)=>crypto.subtle.decrypt(params,derived,encrypted).then(value=>new Uint8Array(value),()=>{throw openFailure('The passphrase or encrypted backup is invalid.','auth');});
const parsed=plain=>{try{return JSON.parse(decoder.decode(plain));}catch{throw openFailure('The passphrase or encrypted backup is invalid.','parse');}};
const decodeChecked=value=>{try{return decode(value);}catch{throw openFailure('Invalid encrypted wallet.','structure');}};
/** Non-secret shape of a stored envelope for failure reports: format version, zone, network, chunk count and whether its encodings
 * and lengths are consistent. Never includes salt, nonces or ciphertext. */
export function describeSiloEnvelope(envelope){
 const version=envelope?.version===1||envelope?.version===2?`v${envelope.version}`:'v?';
 const zone=['xmr','zec'].includes(envelope?.zone)?envelope.zone:'?',network=['stagenet','testnet','mainnet'].includes(envelope?.network)?envelope.network:'?';
 const chunks=envelope?.version===2&&Array.isArray(envelope.extraChunks)?1+envelope.extraChunks.length:1;
 let shape='ok';
 try{
  if(envelope?.kdf!=='PBKDF2-SHA256'||envelope?.iterations!==SILO_KDF_ITERATIONS||envelope?.cipher!=='AES-256-GCM')shape='params';
  else{const parts=[{iv:envelope.iv,ciphertext:envelope.ciphertext},...(envelope.version===2?envelope.extraChunks:[])];if(decode(envelope.salt).length!==16||parts.some(part=>decode(part.iv).length!==12||decode(part.ciphertext).length<17))shape='lengths';}
 }catch{shape='encoding';}
 return `${version}:${zone}:${network}:${chunks}:${shape}`;
}
export async function openSilo(envelope,typed){
 const passphrase=nfc(typed);
 try{return await openExact(envelope,passphrase);}
 catch(error){if(passphrase===typed||error?.siloDecrypt==='format'||error?.siloDecrypt==='structure')throw error;return openExact(envelope,typed);}
}
async function openExact(envelope,passphrase){
 assertSiloNetwork(envelope?.zone,envelope?.network);
 if(envelope.version===2)return openChunks(envelope,passphrase);
 if(envelope.version!==1||envelope.kdf!=='PBKDF2-SHA256'||envelope.iterations!==SILO_KDF_ITERATIONS||envelope.cipher!=='AES-256-GCM')throw openFailure('Unsupported encrypted wallet format.','format');
 const salt=decodeChecked(envelope.salt),iv=decodeChecked(envelope.iv),encrypted=decodeChecked(envelope.ciphertext);
 if(salt.length!==16||iv.length!==12||encrypted.length>MAX_BYTES+16)throw openFailure('Invalid encrypted wallet.','structure');
 const metadata={version:1,zone:envelope.zone,network:envelope.network,kdf:envelope.kdf,iterations:envelope.iterations,cipher:envelope.cipher};
 let plain;try{plain=await decrypted({name:'AES-GCM',iv,additionalData:encoder.encode(JSON.stringify(metadata))},await keyFor(passphrase,salt),encrypted);return parsed(plain);}finally{plain?.fill(0);}
}
export {encode as encodeSiloBytes};
export function decodeSiloBytes(value){
 if(typeof value!=='string'||value.length>SILO_MAX_XMR_PLAINTEXT_BYTES)throw Error('Invalid wallet data.');
 const raw=atob(value),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);return bytes;
}

async function sealChunks(zone,network,plain,passphrase){
 if(!extendedZone(zone)||plain.length>SILO_MAX_XMR_PLAINTEXT_BYTES)throw Error('Wallet cache exceeds storage bound.');
 const salt=crypto.getRandomValues(new Uint8Array(16));
 const metadata={version:2,zone,network,kdf:'PBKDF2-SHA256',iterations:SILO_KDF_ITERATIONS,cipher:'AES-256-GCM',plainBytes:plain.length};
 const derived=await key(passphrase,salt),parts=[],nonces=new Set();
 for(let offset=0;offset<plain.length;offset+=CHUNK_BYTES){
  const iv=crypto.getRandomValues(new Uint8Array(12)),encodedIv=encode(iv);
  if(nonces.has(encodedIv))throw Error('Duplicate encryption nonce.');nonces.add(encodedIv);
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:chunkMetadata(metadata,parts.length)},derived,plain.subarray(offset,offset+CHUNK_BYTES));
  parts.push({iv:encodedIv,ciphertext:encode(new Uint8Array(encrypted))});
 }
 return {...metadata,salt:encode(salt),...parts[0],extraChunks:parts.slice(1)};
}
async function openChunks(envelope,passphrase){
 const {zone,network,plainBytes}=envelope;
 if(!extendedZone(zone)||envelope.kdf!=='PBKDF2-SHA256'||envelope.iterations!==SILO_KDF_ITERATIONS||envelope.cipher!=='AES-256-GCM'||!Number.isSafeInteger(plainBytes)||plainBytes<=MAX_BYTES||plainBytes>SILO_MAX_XMR_PLAINTEXT_BYTES||!Array.isArray(envelope.extraChunks)||envelope.extraChunks.length!==Math.ceil(plainBytes/CHUNK_BYTES)-1)throw openFailure('Invalid chunked encrypted wallet.','format');
 const metadata={version:2,zone,network,kdf:envelope.kdf,iterations:envelope.iterations,cipher:envelope.cipher,plainBytes};
 const salt=decodeChecked(envelope.salt);if(salt.length!==16)throw openFailure('Invalid encrypted wallet.','structure');
 const parts=[{iv:envelope.iv,ciphertext:envelope.ciphertext},...envelope.extraChunks],nonces=new Set();
 // Validate every length before KDF, allocation or decryption. No partial plaintext is returned.
 for(let i=0;i<parts.length;i++){
  const part=parts[i],expected=Math.min(CHUNK_BYTES,plainBytes-i*CHUNK_BYTES)+16;
  if(typeof part?.iv!=='string'||part.iv.length!==16||typeof part.ciphertext!=='string'||part.ciphertext.length!==4*Math.ceil(expected/3)||nonces.has(part.iv))throw openFailure('Invalid encrypted chunk.','structure');nonces.add(part.iv);
 }
 const derived=await keyFor(passphrase,salt),plain=new Uint8Array(plainBytes);
 try{
  for(let i=0;i<parts.length;i++){
   const iv=decodeChecked(parts[i].iv);if(iv.length!==12)throw openFailure('Invalid encrypted chunk.','structure');
   const encrypted=decodeChecked(parts[i].ciphertext),expected=Math.min(CHUNK_BYTES,plainBytes-i*CHUNK_BYTES);
   if(encrypted.length!==expected+16)throw openFailure('Invalid encrypted chunk.','structure');
   const chunk=await decrypted({name:'AES-GCM',iv,additionalData:chunkMetadata(metadata,i)},derived,encrypted);
   try{if(chunk.length!==expected)throw openFailure('Invalid encrypted chunk.','structure');plain.set(chunk,i*CHUNK_BYTES);}finally{chunk.fill(0);}
  }
  return parsed(plain);
 }catch(error){throw openFailure('The passphrase or encrypted backup is invalid.',error?.siloDecrypt??'structure');}finally{plain.fill(0);}
}
