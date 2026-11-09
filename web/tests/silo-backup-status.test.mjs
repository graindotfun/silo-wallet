import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {siloEncryptedBackupIdentity,readSiloBackupStatus,recordSiloBackupEvent,readSiloRecoveryProof,recordSiloRecoveryProof,clearSiloRecoveryProof} from '../lib/silo/backup-status.mjs';
const target={zone:'xmr',network:'stagenet'},envelope={version:1,...target,kdf:'PBKDF2-SHA256',iterations:600000,cipher:'AES-256-GCM',salt:'AAAA',iv:'BBBB',ciphertext:'CCCC'};
const memory=()=>{const values=new Map();return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),values};};
test('fingerprint equals canonical encrypted-envelope SHA and ignores object insertion order',async()=>{
 const identity=await siloEncryptedBackupIdentity(envelope,target),canonical=JSON.stringify(Object.fromEntries(Object.entries(envelope).sort(([a],[b])=>a.localeCompare(b))));assert.equal(identity.fingerprint,createHash('sha256').update(canonical).digest('hex'));assert.deepEqual(await siloEncryptedBackupIdentity(Object.fromEntries(Object.entries(envelope).reverse()),target),identity);
});
test('export means initiated only; successful local verification persists across helper recreation',async()=>{
 const storage=memory(),identity=await siloEncryptedBackupIdentity(envelope,target);assert.equal(readSiloBackupStatus(storage,identity).current,false);
 recordSiloBackupEvent(storage,identity,'export-initiated',{at:100});recordSiloBackupEvent(storage,identity,'verified-local',{at:200,successfulCheck:true});assert.deepEqual(readSiloBackupStatus(storage,identity),{current:true,exportInitiatedAt:100,checkedAt:200,scope:'Exact encrypted file version; download initiation and local check only.'});
 assert.throws(()=>recordSiloBackupEvent(storage,identity,'verified-local',{at:300}));assert.equal(readSiloBackupStatus(storage,identity).checkedAt,200);
});
test('resealing/sync changes exact encrypted version and cannot inherit exported or checked status',async()=>{
 const storage=memory(),old=await siloEncryptedBackupIdentity(envelope,target);recordSiloBackupEvent(storage,old,'export-initiated',{at:100});recordSiloBackupEvent(storage,old,'verified-local',{at:200,successfulCheck:true});const newer=await siloEncryptedBackupIdentity({...envelope,iv:'BBBC'},target);
 assert.equal(readSiloBackupStatus(storage,newer).current,false);recordSiloBackupEvent(storage,newer,'export-initiated',{at:300});assert.equal(readSiloBackupStatus(storage,newer).checkedAt,null);assert.equal(readSiloBackupStatus(storage,old).current,false);
});
test('zone/network isolation never shares a current backup status',async()=>{
 const storage=memory(),one=await siloEncryptedBackupIdentity(envelope,target);recordSiloBackupEvent(storage,one,'export-initiated',{at:100});const main={zone:'xmr',network:'mainnet'},two=await siloEncryptedBackupIdentity({...envelope,...main},main);assert.equal(readSiloBackupStatus(storage,two).current,false);await assert.rejects(siloEncryptedBackupIdentity(envelope,main));
});
test('metadata is bounded, contains only fingerprint/version/times, never caller secrets',async()=>{
 const storage=memory(),identity=await siloEncryptedBackupIdentity(envelope,target);recordSiloBackupEvent(storage,{...identity,seed:'PRIVATE-SEED',passphrase:'PRIVATE-PASSWORD',ciphertext:'PRIVATE-CIPHER'},'export-initiated',{at:100});const text=[...storage.values.values()][0];assert.doesNotMatch(text,/PRIVATE|ciphertext|salt|passphrase|seed/);assert.ok(text.length<1024);
 await assert.rejects(siloEncryptedBackupIdentity({...envelope,seed:'PRIVATE'},target));
});
test('chunked backup fingerprint binds every encrypted chunk',async()=>{
 const chunked={...envelope,version:2,plainBytes:20000000,extraChunks:[{iv:'DDDD',ciphertext:'EEEE'}]},one=await siloEncryptedBackupIdentity(chunked,target),two=await siloEncryptedBackupIdentity({...chunked,extraChunks:[{iv:'DDDD',ciphertext:'EEEF'}]},target);assert.notEqual(one.fingerprint,two.fingerprint);
});
test('corrupt metadata, quota and failed readback cannot appear saved',async()=>{
 const storage=memory(),identity=await siloEncryptedBackupIdentity(envelope,target);recordSiloBackupEvent(storage,identity,'export-initiated',{at:100});const k=[...storage.values.keys()][0];storage.values.set(k,'broken');assert.throws(()=>readSiloBackupStatus(storage,identity));storage.values.delete(k);storage.setItem=()=>{throw Error('quota');};assert.throws(()=>recordSiloBackupEvent(storage,identity,'export-initiated',{at:100}));storage.setItem=()=>{};assert.throws(()=>recordSiloBackupEvent(storage,identity,'export-initiated',{at:100}),/could not be saved/);
});

test('checking an older imported file cannot mark a resealed browser version current',async()=>{const storage=memory(),older=await siloEncryptedBackupIdentity(envelope,target),saved=await siloEncryptedBackupIdentity({...envelope,iv:'BBBC'},target);recordSiloBackupEvent(storage,saved,'export-initiated',{at:100});recordSiloBackupEvent(storage,older,'verified-local',{at:200,successfulCheck:true});const shown=readSiloBackupStatus(storage,saved);assert.equal(shown.current,false);assert.equal(shown.checkedAt,200);assert.equal(shown.exportInitiatedAt,null);});

test('receive recovery proof requires a positive exact-copy record, not a missing negative flag',async()=>{
 const storage=memory(),identity=await siloEncryptedBackupIdentity(envelope,target);
 assert.equal(readSiloRecoveryProof(storage,identity),false);
 assert.throws(()=>recordSiloRecoveryProof(storage,identity));
 recordSiloRecoveryProof(storage,identity,{recoveryProven:true});assert.equal(readSiloRecoveryProof(storage,identity),true);
 const newer=await siloEncryptedBackupIdentity({...envelope,iv:'BBBC'},target);assert.equal(readSiloRecoveryProof(storage,newer),false);
 storage.setItem=()=>{throw Error('quota');};assert.throws(()=>recordSiloRecoveryProof(storage,newer,{recoveryProven:true}));assert.equal(readSiloRecoveryProof(storage,newer),false);
 assert.equal(readSiloRecoveryProof({getItem:()=>{throw Error('read denied');}},identity),false);
 storage.setItem=()=>{};assert.throws(()=>recordSiloRecoveryProof(storage,newer,{recoveryProven:true}));assert.equal(readSiloRecoveryProof(storage,newer),false);
});
test('recovery proof is network isolated and contains no plaintext wallet material',async()=>{
 const storage=memory();storage.removeItem=k=>storage.values.delete(k);const identity=await siloEncryptedBackupIdentity(envelope,target);recordSiloRecoveryProof(storage,{...identity,seed:'PRIVATE',passphrase:'PRIVATE'},{recoveryProven:true});
 assert.doesNotMatch([...storage.values.values()].join(''),/PRIVATE|seed|passphrase|ciphertext/);
 const main={zone:'xmr',network:'mainnet'},other=await siloEncryptedBackupIdentity({...envelope,...main},main);assert.equal(readSiloRecoveryProof(storage,other),false);clearSiloRecoveryProof(storage,target);assert.equal(readSiloRecoveryProof(storage,identity),false);
});
