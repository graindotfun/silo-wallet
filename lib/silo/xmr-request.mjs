// SPDX-License-Identifier: AGPL-3.0-only
// Monero payment requests (Silo "Request"). Pure functions only: no network, no keys, no wallet state.
//
// What a request is: one fresh account-0 subaddress of the requester's wallet, an optional amount and note, a `monero:` URI
// (the standard payment URI that wallets and QR scanners already understand) and a share link. The share link carries
// the whole request in its URL fragment (#...). Browsers do not send the fragment to a server, so the public page needs no
// server state and the request is not sent to Silo's servers by the browser. Nothing in a request names the wallet: a subaddress is not linkable
// to the primary address or to other subaddresses by public chain data alone.
//
// Open source first: URI shape follows the Monero URI draft (monero-project/monero docs, `tx_amount`, `tx_description`,
// `recipient_name`); QR comes from `qrcode-generator` (already a dependency, see receive-qr.mjs); keccak from `@noble/hashes`
// (already a dependency); subaddress creation and incoming-payment scanning come from monero-ts (already the wallet engine).
import {keccak_256} from '@noble/hashes/sha3';
import {siloExactAtomic,siloUnits} from './amounts.mjs';

export const SILO_REQUEST_LABEL_PREFIX='silo-request-v1:';
export const SILO_REQUEST_NOTE_MAX=140;
export const SILO_REQUEST_TARGET=10;
const ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// Monero network bytes for a subaddress. Standard and integrated addresses are refused: a request always uses its own subaddress.
const SUBADDRESS_NETWORK=Object.freeze({42:'mainnet',36:'stagenet',63:'testnet'});
const BLOCK_BYTES=[0,2,3,5,6,7,9,10,11];

/** Decodes a Monero base58 address into bytes, or null when it is not valid base58. */
function decodeBase58(text){
 if(typeof text!=='string'||text.length===0)return null;
 const bytes=[];
 for(let at=0;at<text.length;at+=11){
  const block=text.slice(at,at+11),size=BLOCK_BYTES.indexOf(block.length);
  if(size<0)return null;
  let value=0n;
  for(const char of block){const digit=ALPHABET.indexOf(char);if(digit<0)return null;value=value*58n+BigInt(digit);}
  if(value>=1n<<BigInt(8*size))return null;
  for(let i=size-1;i>=0;i--)bytes.push(Number((value>>BigInt(8*i))&0xffn));
 }
 return Uint8Array.from(bytes);
}

/** Checks the checksum and returns the network name for a Monero SUBADDRESS, or null for anything else. */
export function moneroSubaddressNetwork(address){
 if(typeof address!=='string'||address.length!==95)return null;
 const bytes=decodeBase58(address);
 if(!bytes||bytes.length!==69)return null;
 const sum=keccak_256(bytes.slice(0,65));
 for(let i=0;i<4;i++)if(sum[i]!==bytes[65+i])return null;
 return SUBADDRESS_NETWORK[bytes[0]]??null;
}

/** Atomic units (picomonero) -> shortest exact decimal text, e.g. 1500000000000n -> "1.5". */
export function requestAmountText(atomic){
 return siloUnits(String(atomic),12).replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'');
}

/** Validates the optional amount and note a person typed. Returns {amountAtomic: bigint|null, note: string|null}. */
/** @param {{amount?:string,note?:string}} [input] */
export function parseRequestInput({amount,note}={}){
 let amountAtomic=null;
 const rawAmount=typeof amount==='string'?amount.trim():'';
 if(rawAmount!==''){
  if(!/^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/.test(rawAmount))throw Error('Enter an amount like 0.5, or leave it empty.');
  amountAtomic=siloExactAtomic(rawAmount,12);
  if(amountAtomic<=0n)throw Error('Enter an amount above zero, or leave it empty.');
 }
 const cleanNote=typeof note==='string'?note.normalize('NFC').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g,' ').trim():'';
 if([...cleanNote].length>SILO_REQUEST_NOTE_MAX)throw Error(`Keep the note under ${SILO_REQUEST_NOTE_MAX} characters.`);
 return {amountAtomic,note:cleanNote===''?null:cleanNote};
}

/** The standard payment URI: monero:<address>?tx_amount=<decimal>&tx_description=<text>. */
/** @param {{address:string,amountAtomic?:bigint|null,note?:string|null}} input */
export function buildMoneroUri({address,amountAtomic=null,note=null}){
 if(!moneroSubaddressNetwork(address))throw Error('A valid Monero subaddress is required.');
 const query=[];
 if(amountAtomic!==null&&amountAtomic!==undefined){
  const atomic=BigInt(amountAtomic);
  if(atomic<=0n)throw Error('The amount must be above zero.');
  query.push(`tx_amount=${requestAmountText(atomic)}`);
 }
 if(note)query.push(`tx_description=${encodeURIComponent(note)}`);
 return `monero:${address}${query.length?`?${query.join('&')}`:''}`;
}

/** Reads a `monero:` URI back (used by tests and by the public page). Returns null when it is not a valid request URI. */
export function parseMoneroUri(uri){
 if(typeof uri!=='string'||!uri.startsWith('monero:'))return null;
 const [address,query='']=uri.slice(7).split('?');
 const network=moneroSubaddressNetwork(address);
 if(!network)return null;
 let amountAtomic=null,note=null;
 for(const pair of query.split('&').filter(Boolean)){
  const at=pair.indexOf('='),key=at<0?pair:pair.slice(0,at),value=at<0?'':pair.slice(at+1);
  if(key==='tx_amount'){if(!/^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/.test(value))return null;amountAtomic=siloExactAtomic(value,12);if(amountAtomic<=0n)return null;}
  else if(key==='tx_description'){try{note=decodeURIComponent(value);}catch{return null;}}
 }
 return {address,network,amountAtomic,note};
}

const toBase64Url=text=>{const bytes=new TextEncoder().encode(text);let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');};
const fromBase64Url=text=>{if(!/^[A-Za-z0-9_-]*$/.test(text))throw Error('bad link');const binary=atob(text.replace(/-/g,'+').replace(/_/g,'/'));return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(binary,c=>c.charCodeAt(0)));};

/** Share link: <base>#v1.<base64url of [address, amountText|null, note|null]>. Everything is in the fragment. */
/** @param {string} base @param {{address:string,amountAtomic?:bigint|null,note?:string|null}} input */
export function buildRequestLink(base,{address,amountAtomic=null,note=null}){
 if(!moneroSubaddressNetwork(address))throw Error('A valid Monero subaddress is required.');
 const url=new URL(base);
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)))throw Error('The share link base must be https.');
 url.search='';url.hash='';
 const payload=JSON.stringify([address,amountAtomic===null?null:requestAmountText(amountAtomic),note||null]);
 return `${url.href}#v1.${toBase64Url(payload)}`;
}

/** Reads the fragment of a share link. Returns {address,network,amountAtomic,note} or null for anything malformed. */
export function parseRequestFragment(fragment){
 try{
  const match=/^#?v1\.([A-Za-z0-9_-]{1,2048})$/.exec(String(fragment));
  if(!match)return null;
  const data=JSON.parse(fromBase64Url(match[1]));
  if(!Array.isArray(data)||data.length!==3)return null;
  const [address,amount,note]=data,network=moneroSubaddressNetwork(address);
  if(!network)return null;
  const parsed=parseRequestInput({amount:amount===null?'':amount,note:note===null?'':note});
  if(note!==null&&parsed.note!==note)return null;
  return {address,network,amountAtomic:parsed.amountAtomic,note:parsed.note};
 }catch{return null;}
}

/** A subaddress label that records the request inside the wallet's own encrypted data (restored with the backup). */
/** @param {{amountAtomic?:bigint|null,note?:string|null,createdAt:number}} input */
export function encodeRequestLabel({amountAtomic=null,note=null,createdAt}){
 if(!Number.isSafeInteger(createdAt)||createdAt<=0)throw Error('A creation time is required.');
 return SILO_REQUEST_LABEL_PREFIX+JSON.stringify([createdAt,amountAtomic===null?null:String(amountAtomic),note||null]);
}
export function decodeRequestLabel(label){
 if(typeof label!=='string'||!label.startsWith(SILO_REQUEST_LABEL_PREFIX))return null;
 try{
  const data=JSON.parse(label.slice(SILO_REQUEST_LABEL_PREFIX.length));
  if(!Array.isArray(data)||data.length!==3)return null;
  const [createdAt,amount,note]=data;
  if(!Number.isSafeInteger(createdAt)||createdAt<=0)return null;
  if(amount!==null&&!/^[1-9][0-9]{0,19}$/.test(amount))return null;
  if(note!==null&&(typeof note!=='string'||[...note].length>SILO_REQUEST_NOTE_MAX))return null;
  return {createdAt,amountAtomic:amount===null?null:BigInt(amount),note};
 }catch{return null;}
}

/**
 * Pending, Confirming n/10 or Paid for one request, from the payments to ITS subaddress only.
 * `payments`: [{hash, amountAtomic, confirmed, confirmations, failed}]. A payment still in the pool is Pending; mined but under
 * the target is Confirming; at the target it is Paid. When an amount was requested, less than that is "partial" and never Paid.
 */
/** @param {{hash?:string,amountAtomic:string|bigint,confirmed?:boolean,confirmations?:number,failed?:boolean}[]|null|undefined} payments @param {{amountAtomic?:bigint|null,target?:number}} [options] */
export function requestStatus(payments,{amountAtomic=null,target=SILO_REQUEST_TARGET}={}){
 const rows=(Array.isArray(payments)?payments:[]).filter(p=>p&&p.failed!==true&&/^[0-9]+$/.test(String(p.amountAtomic))&&BigInt(p.amountAtomic)>0n);
 if(!rows.length)return {state:'waiting',receivedAtomic:0n,confirmations:null,target,payments:[]};
 const received=rows.reduce((sum,p)=>sum+BigInt(p.amountAtomic),0n);
 // The slowest payment decides: a request is Paid only when every payment counted toward it has the full confirmations.
 const depth=rows.map(p=>p.confirmed===true&&Number.isSafeInteger(p.confirmations)&&p.confirmations>=0?p.confirmations:0);
 const slowest=Math.min(...depth),anyPool=rows.some(p=>p.confirmed!==true);
 const short=amountAtomic!==null&&received<BigInt(amountAtomic);
 const state=short?'partial':anyPool?'pending':slowest>=target?'paid':'confirming';
 return {state,receivedAtomic:received,confirmations:Math.min(slowest,target),target,payments:rows};
}

/** Short words for the status line. */
export function requestStatusText(status){
 if(status.state==='waiting')return 'Waiting for payment';
 if(status.state==='pending')return 'Pending';
 if(status.state==='confirming')return `Confirming ${status.confirmations}/${status.target}`;
 if(status.state==='partial')return `Partly paid: ${requestAmountText(status.receivedAtomic)} XMR so far`;
 return 'Paid';
}

/**
 * The receipt text the requester can share. It names ONE transaction and only the amount that transaction paid to this request's
 * subaddress. It never lists other payments, balances or the primary address.
 * `proof` is the requester's payment proof for that transaction and this subaddress (see requestProof in xmr-adapter.mjs).
 * The sender's transaction key is known only to the sender, so the receipt cannot contain it; the proof is its counterpart.
 */
/** @param {{network:string,address:string,payment:{hash:string,amountAtomic:string|bigint},proof:string,paidAt:number,note?:string|null,requestedAtomic?:bigint|null}} input */
export function buildReceipt({network,address,payment,proof,paidAt,note=null,requestedAtomic=null}){
 if(!moneroSubaddressNetwork(address))throw Error('A valid Monero subaddress is required.');
 if(!payment||!/^[a-f0-9]{64}$/.test(payment.hash??'')||!/^[1-9][0-9]*$/.test(String(payment.amountAtomic)))throw Error('A payment is required.');
 if(typeof proof!=='string'||!/^(InProofV[12]|OutProofV[12])[1-9A-HJ-NP-Za-km-z]+$/.test(proof))throw Error('A payment proof is required.');
 if(!Number.isSafeInteger(paidAt)||paidAt<=0)throw Error('A payment time is required.');
 const date=new Date(paidAt).toISOString().replace('T',' ').replace(/:\d\d\.\d+Z$/,' UTC');
 const lines=[
  `Monero payment receipt (${network})`,
  `Amount received: ${requestAmountText(payment.amountAtomic)} XMR`,
  ...(requestedAtomic!==null?[`Amount requested: ${requestAmountText(requestedAtomic)} XMR`]:[]),
  `Date: ${date}`,
  ...(note?[`Note: ${note}`]:[]),
  `Paid to: ${address}`,
  `Transaction id: ${payment.hash}`,
  `Payment proof: ${proof}`,
  '',
  'Check it: in any Monero wallet that has "check_tx_proof" (monero-wallet-cli: check_tx_proof <txid> <address> <proof>), or ask the requester for a check.',
  'The proof confirms this transaction paid this address. It reveals nothing about any other payment.',
 ];
 return lines.join('\n');
}
