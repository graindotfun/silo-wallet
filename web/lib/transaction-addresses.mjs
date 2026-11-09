/** Verified lookup mapping only. Never grants a transaction permission to relay. */
import {Buffer} from 'buffer';
import {PublicKey,AddressLookupTableAccount,AddressLookupTableProgram} from '@solana/web3.js';
const contexts=new WeakSet(),MAX_SLOT=18446744073709551615n;
const freeze=xs=>Object.freeze(xs),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const canonical=value=>{const key=new PublicKey(value);if(String(key)!==String(value))throw Error('Non-canonical lookup account key.');return key;};
function floor(value){if(!Number.isSafeInteger(value)||value<1)throw Error('Lookup resolution requires a positive slot floor.');return value;}
function shape(transaction){
 const m=transaction?.message;if(m?.version!==0||!Array.isArray(m.addressTableLookups)||m.addressTableLookups.length>8)throw Error('Unsupported lookup message.');
 return m.addressTableLookups.map(t=>{
  const writableIndexes=[...t.writableIndexes],readonlyIndexes=[...t.readonlyIndexes],indices=[...writableIndexes,...readonlyIndexes];
  if(!indices.length||indices.some(i=>!Number.isInteger(i)||i<0||i>255)||new Set(indices).size!==indices.length)throw Error('Invalid or duplicate lookup index.');
  return {accountKey:String(canonical(t.accountKey)),writableIndexes,readonlyIndexes};
 });
}
export async function loadAddressLookupTables(connection,addresses,{minContextSlot=1}={}){
 floor(minContextSlot);if(!Array.isArray(addresses)||!addresses.length||addresses.length>8||new Set(addresses.map(String)).size!==addresses.length)throw Error('Invalid lookup table set.');
 const keys=addresses.map(canonical),response=await connection.getMultipleAccountsInfoAndContext(keys,{commitment:'confirmed',minContextSlot});
 const slot=response?.context?.slot,accounts=response?.value;
 if(!Number.isSafeInteger(slot)||slot<minContextSlot||!Array.isArray(accounts)||accounts.length!==keys.length)throw Error('Lookup table snapshot is unavailable or stale.');
 const tables=accounts.map((a,i)=>{
  if(!a||String(a.owner)!==String(AddressLookupTableProgram.programId)||a.executable!==false||!Number.isSafeInteger(a.lamports)||a.lamports<1||!(a.data instanceof Uint8Array)||a.data.length<56||a.data.length>56+32*256||(a.data.length-56)%32)throw Error('Invalid lookup table owner or layout.');
  if(a.data[21]>1)throw Error('Invalid lookup authority option.');
  const state=AddressLookupTableAccount.deserialize(Buffer.from(a.data));
  if(state.deactivationSlot!==MAX_SLOT||!Number.isSafeInteger(state.lastExtendedSlot)||state.lastExtendedSlot<0||state.lastExtendedSlot>slot||!Number.isInteger(state.lastExtendedSlotStartIndex)||state.lastExtendedSlotStartIndex<0||state.lastExtendedSlotStartIndex>state.addresses.length)throw Error('Inactive or invalid lookup table state.');
  return new AddressLookupTableAccount({key:keys[i],state});
 });
 return {tables,slot};
}
export async function resolveTransactionAddresses(connection,transaction,{minContextSlot=1}={}){
 floor(minContextSlot);const requested=shape(transaction);
 if(new Set(requested.map(t=>t.accountKey)).size!==requested.length)throw Error('Duplicate lookup table.');
 const snapshot=requested.length?await loadAddressLookupTables(connection,requested.map(t=>t.accountKey),{minContextSlot}):{tables:[],slot:minContextSlot};
 const lookups=freeze(requested.map((t,i)=>{
  const state=snapshot.tables[i].state,active=state.lastExtendedSlot===snapshot.slot?state.lastExtendedSlotStartIndex:state.addresses.length;
  const keyAt=index=>{if(index>=active)throw Error('Lookup index is missing or not yet active.');return String(state.addresses[index]);};
  return Object.freeze({...t,writableIndexes:freeze(t.writableIndexes),readonlyIndexes:freeze(t.readonlyIndexes),writableKeys:freeze(t.writableIndexes.map(keyAt)),readonlyKeys:freeze(t.readonlyIndexes.map(keyAt))});
 }));
 const context=Object.freeze({slot:snapshot.slot,lookups,loadedWritable:freeze(lookups.flatMap(t=>t.writableKeys)),loadedReadonly:freeze(lookups.flatMap(t=>t.readonlyKeys)),fingerprint:JSON.stringify(lookups)});
 contexts.add(context);transactionAddressKeys(transaction,context);return context;
}
/** Resolved addresses are accepted only from this process's trusted resolver. */
export function transactionAddressKeys(transaction,addressContext){
 const requested=shape(transaction),m=transaction.message;
 const h=m.header,n=m.staticAccountKeys.length;
 if(!h||!['numRequiredSignatures','numReadonlySignedAccounts','numReadonlyUnsignedAccounts'].every(k=>Number.isInteger(h[k])&&h[k]>=0&&h[k]<=255)||h.numRequiredSignatures<1||h.numRequiredSignatures>n||h.numReadonlySignedAccounts>=h.numRequiredSignatures||h.numReadonlyUnsignedAccounts>n-h.numRequiredSignatures)throw Error('Invalid resolved message header or payer.');
 if(requested.length&&(!addressContext||!contexts.has(addressContext)))throw Error('Verified address lookup context required.');
 if(addressContext&&(!contexts.has(addressContext)||!same(requested,addressContext.lookups.map(({accountKey,writableIndexes,readonlyIndexes})=>({accountKey,writableIndexes,readonlyIndexes})))))throw Error('Verified lookup mapping changed.');
 const keys=[...m.staticAccountKeys.map(String),...(addressContext?.loadedWritable||[]),...(addressContext?.loadedReadonly||[])];
 if(!keys.length||keys.length>256||new Set(keys).size!==keys.length)throw Error('Duplicate or unsupported resolved account keys.');
 return keys;
}
