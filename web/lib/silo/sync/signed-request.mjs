/** Device-signed account requests (`silo-signed-request-v1`): the fixed profile shared by the server and by packaged
 * clients such as the Chrome extension (docs/product/SILO_CHROME_EXTENSION_SECURE_ARCHITECTURE_20261018.md §5.4).
 * Pure functions only: no storage, network or logging. One fixed component list instead of a general HTTP message
 * signature parser, so there is less to review. The device key is a non-extractable ECDSA P-256 key; it authenticates
 * a device to the account server and has no confidentiality role (vault keys still travel by ECDH enrollment grants). */
import {b64u,fromB64u,sha256Hex,utf8} from './codec.mjs';

export const SIGNED_REQUEST_PROFILE='silo-signed-request-v1';
export const SIGNED_PREFIX='/api/silo-sync/signed';
export const SIGNED_REQUEST_LIMITS=Object.freeze({skewMs:120_000,window:64,origins:8});
export const SIGNED_HEADERS=Object.freeze({accountId:'x-silo-account-id',deviceId:'x-silo-device-id',session:'x-silo-session',created:'x-silo-created',seq:'x-silo-seq',signature:'x-silo-signature',deviceKey:'x-silo-device-key',digest:'content-digest'});
export const SIGNED_CORS_HEADERS=Object.freeze(['content-type',...Object.values(SIGNED_HEADERS)].sort());
export const SIGNED_AUTH_PATHS=Object.freeze(['/auth/start','/auth/verify']);

const ID=/^[a-f0-9]{32}$/,CREATED=/^[1-9][0-9]{12}$/,SEQ=/^[1-9][0-9]{0,15}$/,SIGNATURE=/^[A-Za-z0-9_-]{86}$/,DEVICE_KEY=/^[A-Za-z0-9_-]{122}$/;
const DIGEST=/^sha-256=:([A-Za-z0-9+/]{43}=):$/,EXTENSION_ORIGIN=/^chrome-extension:\/\/[a-p]{32}$/;
// DER prefix of a SubjectPublicKeyInfo for an uncompressed P-256 point (id-ecPublicKey, prime256v1).
const P256_SPKI_PREFIX='3059301306072a8648ce3d020106082a8648ce3d030107034200';
const P256={name:'ECDSA',namedCurve:'P-256'},ECDSA_SHA256={name:'ECDSA',hash:'SHA-256'};
const MASK=(1n<<64n)-1n;

/** The two app-shell origins (iOS WKWebView scheme, Android WebView virtual host). Owner decision Q6, 18 October 2026:
 * allowed on staging only; callers pass `allowAppOrigins` from an explicit staging environment marker. */
export const SIGNED_APP_ORIGINS=Object.freeze(['silo-app://app','https://silo.app.invalid']);
/** Exact allow-list of extension origins, e.g. `chrome-extension://<32 a-p>`, plus the app origins when explicitly allowed.
 * Empty means the signed path is off. Wildcards, patterns, other web origins, paths, trailing slashes and duplicates are
 * refused, never normalized. */
export function parseSignedDeviceOrigins(value,{allowAppOrigins=false}={}){
 if(value===undefined||value===null||value==='')return Object.freeze([]);
 if(typeof value!=='string')throw Error('signed-device-origins');
 const list=value.split(',').map(origin=>origin.trim());
 if(!list.length||list.length>SIGNED_REQUEST_LIMITS.origins||list.some(origin=>!EXTENSION_ORIGIN.test(origin)&&!(allowAppOrigins===true&&SIGNED_APP_ORIGINS.includes(origin)))||new Set(list).size!==list.length)throw Error('signed-device-origins');
 return Object.freeze(list);
}

/** Sorted, percent-encoded `key=value` pairs; `''` when there is no query. */
export function canonicalQuery(query){
 const pairs=query instanceof URLSearchParams?[...query]:Object.entries(query??{}).map(([key,value])=>[key,String(value)]);
 return pairs.map(([key,value])=>[encodeURIComponent(key),encodeURIComponent(value)]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:a[1]<b[1]?-1:a[1]>b[1]?1:0).map(([key,value])=>key+'='+value).join('&');
}

function base64(bytes){let text='';for(const byte of bytes)text+=String.fromCharCode(byte);return btoa(text);}
/** RFC 9530 style `sha-256=:<base64>:` digest of the exact body bytes. */
export async function contentDigest(body){
 const bytes=typeof body==='string'?utf8(body):body;
 return 'sha-256=:'+base64(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)))+':';
}

/** The exact bytes that are signed. Every component is a string, an integer or null; JSON of a fixed array is canonical. */
export function signingBase({accountOrigin,requestOrigin,method,path,query='',digest=null,accountId=null,deviceId=null,sessionRef=null,deviceKey=null,created,seq}){
 return JSON.stringify([SIGNED_REQUEST_PROFILE,accountOrigin,requestOrigin,method,path,query,digest??'none',accountId,deviceId,sessionRef,deviceKey,created,seq]);
}

export const keyIdFor=async spki=>(await sha256Hex('silo-device-key-v1:'+spki)).slice(0,32);
/** Account-scoped: signing in again with the same key reaches the same device and keeps its trust or its revocation. */
export const signedDeviceId=async(accountId,keyId)=>(await sha256Hex('silo-signed-device-v1:'+accountId+':'+keyId)).slice(0,32);
/** Stored in the existing session table under its own namespace, so device revocation and logout cover it unchanged. */
export const signedSessionHash=async sessionRef=>sha256Hex('silo-signed-session-v1:'+sessionRef);

/** Strict header parse. Returns null for anything malformed; callers answer one generic refusal. */
export function parseSignedHeaders(headers,{auth=false}={}){
 const get=name=>{const value=headers.get(name);return value===null?null:value;};
 const created=get(SIGNED_HEADERS.created),seq=get(SIGNED_HEADERS.seq),signature=get(SIGNED_HEADERS.signature),digest=get(SIGNED_HEADERS.digest);
 if(!CREATED.test(created??'')||!SEQ.test(seq??'')||!SIGNATURE.test(signature??'')||digest!==null&&!DIGEST.test(digest))return null;
 const parsed={created:Number(created),seq:Number(seq),signature,digest};
 if(!Number.isSafeInteger(parsed.created)||!Number.isSafeInteger(parsed.seq))return null;
 const accountId=get(SIGNED_HEADERS.accountId),deviceId=get(SIGNED_HEADERS.deviceId),session=get(SIGNED_HEADERS.session),deviceKey=get(SIGNED_HEADERS.deviceKey);
 if(auth){
  if(accountId!==null||deviceId!==null||session!==null||!DEVICE_KEY.test(deviceKey??''))return null;
  const der=fromB64u(deviceKey,128);if(der.length!==91||[...der.slice(0,26)].map(byte=>byte.toString(16).padStart(2,'0')).join('')!==P256_SPKI_PREFIX)return null;
  return {...parsed,accountId:null,deviceId:null,sessionRef:null,deviceKey};
 }
 if(deviceKey!==null||!ID.test(accountId??'')||!ID.test(deviceId??'')||!ID.test(session??''))return null;
 return {...parsed,accountId,deviceId,sessionRef:session,deviceKey:null};
}

export async function verifySignedBase(spki,base,signature){
 try{const key=await crypto.subtle.importKey('spki',fromB64u(spki,128),P256,false,['verify']);return await crypto.subtle.verify(ECDSA_SHA256,key,fromB64u(signature,64),utf8(base));}
 catch{return false;}
}
/** P1363 (r||s, 64 bytes) as WebCrypto produces it, base64url. */
export async function signBase(privateKey,base){return b64u(new Uint8Array(await crypto.subtle.sign(ECDSA_SHA256,privateKey,utf8(base))));}
export async function exportDeviceKey(publicKey){return b64u(new Uint8Array(await crypto.subtle.exportKey('spki',publicKey)));}

/** Sliding window over the last 64 sequence numbers of one session: bit i of `bitmap` marks `high - i` as seen.
 * Returns the next state, or null for a replay or a sequence number that fell out of the window. */
export function advanceReplayWindow(state,seq){
 const high=state?.high??0,bitmap=BigInt('0x'+(state?.bitmap??'0'));
 if(!Number.isSafeInteger(seq)||seq<1||!Number.isSafeInteger(high)||high<0)return null;
 const encode=value=>value.toString(16).padStart(16,'0');
 if(seq>high){const shift=seq-high;return {high:seq,bitmap:encode(shift>=SIGNED_REQUEST_LIMITS.window?1n:((bitmap<<BigInt(shift))|1n)&MASK)};}
 const distance=high-seq;if(distance>=SIGNED_REQUEST_LIMITS.window)return null;
 const bit=1n<<BigInt(distance);if(bitmap&bit)return null;
 return {high,bitmap:encode(bitmap|bit)};
}
