/** Reads the signed transactions a WebZjs (a50df94, zcash_client_memory) backup database holds, without any wallet engine.
 * The database is a `MemoryWallet` protobuf; its `tx_table` (field 4) holds TransactionTableRecord { tx_id: TxId { hash },
 * tx_entry: TransactionEntry { expiry_height = 4, raw_tx = 5 } } (zcash_client_memory proto/memory_wallet.proto at the
 * librustzcash-nu61 fork 52efe30). Returns a Map from display-order txid to { raw, expiryHeight }. The bytes are only
 * candidates: the engine must re-parse them and recompute the same txid before they are trusted (see zec-adapter.mjs). */
const MAX_DATABASE=64*1024*1024;
function* fields(bytes){
 let at=0;const varint=()=>{let value=0n,shift=0n;for(;;){if(at>=bytes.length||shift>63n)throw Error('Truncated legacy database.');const byte=bytes[at++];value|=BigInt(byte&0x7f)<<shift;if(!(byte&0x80))return value;shift+=7n;}};
 while(at<bytes.length){
  const key=Number(varint()),field=key>>>3,type=key&7;
  if(type===0)yield {field,type,value:varint()};
  else if(type===2){const length=Number(varint());if(at+length>bytes.length)throw Error('Truncated legacy database.');yield {field,type,value:bytes.subarray(at,at+length)};at+=length;}
  else if(type===1){at+=8;}else if(type===5){at+=4;}
  else throw Error('Unsupported legacy database encoding.');
  if(at>bytes.length)throw Error('Truncated legacy database.');
 }
}
const hex=bytes=>Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
export function legacySignedTransactions(database){
 if(!(database instanceof Uint8Array)||database.length>MAX_DATABASE)throw Error('Legacy database unavailable.');
 const found=new Map();
 for(const record of fields(database)){
  if(record.field!==4||record.type!==2)continue;
  let txid=null,raw=null,expiryHeight=null;
  for(const part of fields(record.value)){
   if(part.field===1&&part.type===2){for(const id of fields(part.value))if(id.field===1&&id.type===2&&id.value.length===32)txid=hex(Uint8Array.from(id.value).reverse());}
   if(part.field===2&&part.type===2){for(const entry of fields(part.value)){if(entry.field===5&&entry.type===2)raw=Uint8Array.from(entry.value);if(entry.field===4&&entry.type===0)expiryHeight=Number(entry.value);}}
  }
  if(txid&&raw)found.set(txid,{raw,expiryHeight});
 }
 return found;
}
