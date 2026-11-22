// Silo address book: saved contacts (name + address + chain), kept ONLY in this browser (localStorage, same place as the other local
// wallet notes). Nothing here talks to a server, a node or an analytics service; addresses are checked with pure local code.
// Contacts travel in the unified backup file as one sealed envelope (see contacts-backup.mjs), never in plain text.
import {PublicKey} from '@solana/web3.js';
import {keccak_256} from '@noble/hashes/sha3';
import {siloEvmAddress} from './evm.mjs';
import {siloBtcValidAddress} from './btc.mjs';

export const SILO_CONTACT_CHAINS=Object.freeze(['solana','xmr','evm','btc']);
export const SILO_CONTACT_CHAIN_NAMES=Object.freeze({solana:'Solana',xmr:'Monero',evm:'Ethereum, Base, BNB',btc:'Bitcoin'});
export const SILO_CONTACTS_KEY='grain-silo-contacts-v1';
export const SILO_CONTACTS_VERSION=1;
export const SILO_CONTACTS_MAX=500;
export const SILO_CONTACT_NAME_MAX=40;
const fail=(message,code)=>Object.assign(Error(message),{siloContact:code});

// ---- Address validation (pure, local) ---------------------------------------------------------------------------------------
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const XMR_BLOCK=[0,2,3,5,6,7,9,10,11];
const XMR_NETWORK_BYTES={18:'mainnet',42:'mainnet',19:'mainnet',24:'stagenet',36:'stagenet',25:'stagenet',53:'testnet',63:'testnet',54:'testnet'};
/** Monero base58 (8-byte blocks, 11 characters each) decoded to bytes, or null. */
function moneroBase58(text){
 if(typeof text!=='string'||![95,106].includes(text.length))return null;
 const out=[];
 for(let offset=0;offset<text.length;offset+=11){
  const part=text.slice(offset,offset+11),size=XMR_BLOCK.indexOf(part.length);if(size<0)return null;
  let value=0n;for(const char of part){const digit=B58.indexOf(char);if(digit<0)return null;value=value*58n+BigInt(digit);}
  if(value>=1n<<BigInt(8*size))return null;
  for(let i=size-1;i>=0;i--)out.push(Number((value>>BigInt(8*i))&255n));
 }
 return Uint8Array.from(out);
}
/** Checksum-verifies a Monero address locally (network byte + 4-byte Keccak checksum). Returns the network name or null.
 * The wallet's own Monero validator still runs again when a payment is reviewed; this only keeps bad text out of the address book. */
export function siloXmrAddressNetwork(address){
 const bytes=moneroBase58(address);if(!bytes)return null;
 const network=XMR_NETWORK_BYTES[bytes[0]];if(!network)return null;
 const integrated=bytes[0]===19||bytes[0]===25||bytes[0]===54;
 if(bytes.length!==(integrated?77:69))return null;
 const sum=keccak_256(bytes.subarray(0,bytes.length-4));
 for(let i=0;i<4;i++)if(sum[i]!==bytes[bytes.length-4+i])return null;
 return network;
}
const solanaOk=address=>{try{const key=new PublicKey(address);return key.toBase58()===address&&PublicKey.isOnCurve(key.toBytes());}catch{return false;}};
const evmOk=address=>{try{siloEvmAddress(address);return true;}catch{return false;}};
const btcOk=address=>siloBtcValidAddress(address,'mainnet')||siloBtcValidAddress(address,'testnet');
/** Validates one address for one chain with the wallet's existing checks. Returns the canonical text to store (EVM addresses in
 * EIP-55 form) or throws a plain sentence. */
export function siloContactAddress(chain,address){
 if(!SILO_CONTACT_CHAINS.includes(chain))throw fail('Choose a network.','chain');
 if(typeof address!=='string'||!address.trim())throw fail('Enter an address.','address');
 const text=address.trim();
 if(/\s/.test(text))throw fail('An address has no spaces. Check what you pasted.','address');
 if(chain==='solana'){if(!solanaOk(text))throw fail('This is not a valid Solana wallet address.','address');return text;}
 if(chain==='evm'){if(!evmOk(text))throw fail('This is not a valid Ethereum, Base or BNB address (check every character).','address');return siloEvmAddress(text);}
 if(chain==='btc'){if(!btcOk(text))throw fail('This is not a valid Bitcoin address.','address');return /^(bc1|tb1)/i.test(text)?text.toLowerCase():text;}
 if(!siloXmrAddressNetwork(text))throw fail('This is not a valid Monero address (the checksum does not match). Check the complete address.','address');return text;
}
/** True when `address` is valid for `chain` (never throws). */
export const siloContactAddressValid=(chain,address)=>{try{siloContactAddress(chain,address);return true;}catch{return false;}};

// ---- Contacts ---------------------------------------------------------------------------------------------------------------
export function siloContactName(value){
 if(typeof value!=='string')throw fail('Enter a name.','name');
 const name=value.normalize('NFC').replace(/\s+/g,' ').trim();
 if(!name)throw fail('Enter a name.','name');
 if([...name].length>SILO_CONTACT_NAME_MAX)throw fail(`Use at most ${SILO_CONTACT_NAME_MAX} characters for a name.`,'name');
 if(/[\u0000-\u001f\u007f<>]/.test(name))throw fail('That name has characters that are not allowed.','name');
 return name;
}
const bech=value=>/^(bc1|tb1)/i.test(value);
const sameAddress=(chain,a,b)=>chain==='evm'||(chain==='btc'&&bech(a)&&bech(b))?a.toLowerCase()===b.toLowerCase():a===b;
const newId=(random=bytes=>crypto.getRandomValues(bytes))=>Array.from(random(new Uint8Array(8)),b=>b.toString(16).padStart(2,'0')).join('');

/** A contacts list is `{version:1,contacts:[{id,name,chain,address,createdAt}]}`. This reads untrusted data (storage, a backup file)
 * and returns only well-formed, address-valid rows; anything else is dropped and counted. */
export function siloContactsFromData(data){
 const rows=Array.isArray(data?.contacts)?data.contacts:[];const out=[];let dropped=0;
 for(const row of rows){
  try{
   if(out.length>=SILO_CONTACTS_MAX)throw fail('Too many.','limit');
   const chain=row?.chain,address=siloContactAddress(chain,row?.address),name=siloContactName(row?.name);
   if(out.some(c=>c.chain===chain&&sameAddress(chain,c.address,address)))throw fail('Duplicate.','duplicate');
   const id=typeof row.id==='string'&&/^[a-f0-9]{16}$/.test(row.id)&&!out.some(c=>c.id===row.id)?row.id:newId();
   out.push({id,name,chain,address,createdAt:Number.isSafeInteger(row.createdAt)&&row.createdAt>0?row.createdAt:0});
  }catch{dropped++;}
 }
 return {contacts:out,dropped};
}
export const siloContactsData=contacts=>({version:SILO_CONTACTS_VERSION,contacts:contacts.map(({id,name,chain,address,createdAt})=>({id,name,chain,address,createdAt}))});

/** Reads the saved list. Never throws: blocked or damaged storage reads as an empty list with `ok:false`. */
export function readSiloContacts(storage){
 try{
  const raw=storage.getItem(SILO_CONTACTS_KEY);if(raw===null)return {contacts:[],ok:true,dropped:0};
  if(raw.length>2_000_000)return {contacts:[],ok:false,dropped:0};
  const data=JSON.parse(raw);if(data?.version!==SILO_CONTACTS_VERSION)return {contacts:[],ok:false,dropped:0};
  const {contacts,dropped}=siloContactsFromData(data);return {contacts,ok:true,dropped};
 }catch{return {contacts:[],ok:false,dropped:0};}
}
/** Writes the list; throws a plain sentence when the browser refuses (private mode, full storage). */
export function writeSiloContacts(storage,contacts){
 try{storage.setItem(SILO_CONTACTS_KEY,JSON.stringify(siloContactsData(contacts)));}catch{throw fail('This browser would not save your contacts. Check storage settings and try again.','storage');}
}
/** Pure edits: each returns the new list or throws. They never touch storage. */
export function addSiloContact(contacts,{name,chain,address},{now=Date.now(),random}={}){
 const clean=siloContactAddress(chain,address),label=siloContactName(name);
 if(contacts.length>=SILO_CONTACTS_MAX)throw fail('The address book is full.','limit');
 const dup=contacts.find(c=>c.chain===chain&&sameAddress(chain,c.address,clean));
 if(dup)throw fail(`This address is already saved as "${dup.name}".`,'duplicate');
 return [...contacts,{id:newId(random),name:label,chain,address:clean,createdAt:now}];
}
export function renameSiloContact(contacts,id,name){
 const label=siloContactName(name);if(!contacts.some(c=>c.id===id))throw fail('That contact no longer exists.','missing');
 return contacts.map(c=>c.id===id?{...c,name:label}:c);
}
export function removeSiloContact(contacts,id){
 if(!contacts.some(c=>c.id===id))throw fail('That contact no longer exists.','missing');
 return contacts.filter(c=>c.id!==id);
}
export const siloContactsForChain=(contacts,chain)=>contacts.filter(c=>c.chain===chain).sort((a,b)=>a.name.localeCompare(b.name));

// ---- Address-poisoning guard --------------------------------------------------------------------------------------------------
// Attackers send dust from an address that copies the first and last characters of one you use, hoping you paste it from history.
// The fixed start every address of a kind shares (0x, bc1q, the Monero network byte) is skipped so the comparison covers characters
// an attacker had to grind for.
const SKIP={solana:0,xmr:1,evm:2,btc:0};
const skipFor=(chain,address)=>chain==='btc'?(/^(bc1|tb1)/i.test(address)?4:1):SKIP[chain];
// Look-alike: same length class, the shared start and the shared end together cover at least 6 characters, with at least 2 on each side
// (the usual attack grinds 4+4 or more; 5+3 and 3+5 are caught as well). Random addresses almost never do this.
const MIN_EACH=2,MIN_TOTAL=6;
function sharedEnds(a,b,skipA,skipB){
 let p=0;while(skipA+p<a.length&&skipB+p<b.length&&a[skipA+p]===b[skipB+p])p++;
 let q=0;while(q<a.length-skipA-p&&q<b.length-skipB-p&&a[a.length-1-q]===b[b.length-1-q])q++;
 return {p,q};
}
/** Compares a typed or pasted address with the saved ones on the same chain.
 * - `{kind:'exact',contact}`: the same address as a saved contact (show its name).
 * - `{kind:'lookalike',contact}`: a DIFFERENT address whose start and end match a saved contact (warn; the middle differs).
 * - `{kind:'none'}`: neither. Only complete, valid-looking input is compared, so half-typed text never warns. */
export function siloContactCheck(contacts,chain,typed){
 if(typeof typed!=='string')return {kind:'none'};
 const text=typed.trim();if(!text||!siloContactAddressValid(chain,text))return {kind:'none'};
 const mine=contacts.filter(c=>c.chain===chain);
 const exact=mine.find(c=>sameAddress(chain,c.address,text));if(exact)return {kind:'exact',contact:exact};
 const norm=value=>chain==='evm'||(chain==='btc'&&bech(value))?value.toLowerCase():value;
 const skip=skipFor(chain,text);
 for(const c of mine){
  const a=norm(c.address),b=norm(text),sa=skipFor(chain,c.address);
  if(a.length<20||b.length<20)continue;
  const {p,q}=sharedEnds(a,b,sa,skip);
  if(p>=MIN_EACH&&q>=MIN_EACH&&p+q>=MIN_TOTAL)return {kind:'lookalike',contact:c};
 }
 return {kind:'none'};
}

// ---- Restore: merge or replace -------------------------------------------------------------------------------------------------
/** `merge` keeps every saved contact and adds the incoming ones that are not already saved (same chain + address; the saved name wins).
 * `replace` swaps the whole list for the incoming one. Returns the new list and how many were added or skipped. */
export function mergeSiloContacts(current,incoming,mode){
if(mode==='replace'){if(!incoming.length&&current.length)throw fail('The file holds no usable contacts, so nothing was replaced.','empty');const kept=incoming.slice(0,SILO_CONTACTS_MAX);return {contacts:kept,added:kept.length,skipped:incoming.length-kept.length,replaced:current.length};}
 if(mode!=='merge')throw fail('Choose merge or replace.','mode');
 const out=[...current];let added=0,skipped=0;
 for(const c of incoming){
  if(out.some(o=>o.chain===c.chain&&sameAddress(c.chain,o.address,c.address))||out.length>=SILO_CONTACTS_MAX){skipped++;continue;}
  out.push({...c,id:out.some(o=>o.id===c.id)?newId():c.id});added++;
 }
 return {contacts:out,added,skipped,replaced:0};
}
