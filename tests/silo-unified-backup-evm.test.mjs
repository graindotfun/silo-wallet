// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeKeyring} from '../lib/silo/native-keyring.mjs';
import {packSiloUnifiedBackup,siloBackupPart,describeSiloBackupFile,siloBackupFileName,siloBackupFileNote,siloBackupEnvelopeZone,isSiloUnifiedBackup,SILO_UNIFIED_BACKUP_FORMAT,SILO_UNIFIED_BACKUP_FORMAT_V2,SILO_BACKUP_ZONES} from '../lib/silo/unified-backup.mjs';

const memory=()=>{let envelope=null;return {closed:false,async read(){return envelope;},async create(e){if(envelope)return false;envelope=e;return true;},async remove(){envelope=null;return true;},close(){},onClose(){}};};
const seal=async chain=>(await createNativeKeyring({chain,passphrase:'correct horse battery staple 7',store:memory()})).exportBackup();
const xmr={zone:'xmr',network:'mainnet',version:2,ciphertext:'AAAA'};
const EXPORT_ID='0123456789abcdef';

test('the EVM envelope is recognised as its own zone, mainnet only, and a Solana envelope is never taken for it',async()=>{
 const evm=await seal('evm'),sol=await seal('solana');
 assert.deepEqual(siloBackupEnvelopeZone(evm),{zone:'evm',network:'mainnet'});
 assert.deepEqual(siloBackupEnvelopeZone(sol),{zone:'solana',network:'mainnet'});
 assert.equal(siloBackupEnvelopeZone({...evm,network:'devnet'}),null,'no EVM test-network part exists');
 assert.deepEqual([...SILO_BACKUP_ZONES],['solana','evm','xmr']);
});

test('a file with an EVM part is v2 and carries the sealed envelope byte for byte; without one it stays v1',async()=>{
 const evm=await seal('evm'),sol=await seal('solana');
 const v2=packSiloUnifiedBackup({solana:sol,evm,xmr},{exportId:EXPORT_ID});
 assert.equal(v2.format,SILO_UNIFIED_BACKUP_FORMAT_V2);assert.deepEqual(Object.keys(v2.parts),['solana','evm','xmr']);
 assert.equal(JSON.stringify(v2.parts.evm),JSON.stringify(evm),'the envelope is arranged, never re-sealed or changed');
 assert.equal(siloBackupPart(v2,'evm','mainnet').address,evm.address);
 assert.equal(siloBackupPart(v2,'solana','mainnet').address,sol.address);
 const v1=packSiloUnifiedBackup({solana:sol,xmr},{exportId:EXPORT_ID});
 assert.equal(v1.format,SILO_UNIFIED_BACKUP_FORMAT,'a file without EVM is byte-compatible with what old clients read');
 assert.throws(()=>siloBackupPart(v1,'evm','mainnet'),/holds no Ethereum, Base and BNB wallet/);
 assert.match(siloBackupFileName(v2),/^grain-silo-backup-solana-mainnet\+evm-mainnet\+xmr-mainnet-0123456789abcdef\.encrypted\.json$/);
 assert.deepEqual(describeSiloBackupFile(v2).parts.map(part=>part.zone),['solana','evm','xmr']);
 assert.ok(!JSON.stringify(describeSiloBackupFile(v2)).includes(evm.address),'the description never includes an address');
});

test('format and parts must agree: v1 with an EVM part and v2 without one are refused (no downgrade, no ambiguity)',async()=>{
 const evm=await seal('evm'),sol=await seal('solana');
 const v2=packSiloUnifiedBackup({solana:sol,evm},{exportId:EXPORT_ID});
 const downgraded={...v2,format:SILO_UNIFIED_BACKUP_FORMAT};
 const hollow={...packSiloUnifiedBackup({solana:sol},{exportId:EXPORT_ID}),format:SILO_UNIFIED_BACKUP_FORMAT_V2};
 for(const bad of [downgraded,hollow]){
  assert.equal(isSiloUnifiedBackup(bad),true);assert.equal(describeSiloBackupFile(bad).kind,'unknown');
  assert.throws(()=>siloBackupPart(bad,'solana','mainnet'),/not a valid Silo backup/);assert.throws(()=>siloBackupPart(bad,'evm','mainnet'),/not a valid Silo backup/);
 }
});

test('an EVM part must be a sealed EVM envelope: a Solana envelope, a wrong network, a stranger or an extra part is refused',async()=>{
 const evm=await seal('evm'),sol=await seal('solana');
 assert.throws(()=>packSiloUnifiedBackup({evm:sol}),/not a sealed Silo evm backup/);
 assert.throws(()=>packSiloUnifiedBackup({solana:evm}),/not a sealed Silo solana backup/);
 assert.throws(()=>packSiloUnifiedBackup({evm:{...evm,network:'devnet'}}),/not a sealed/);
 assert.throws(()=>packSiloUnifiedBackup({evm,zec:evm}),/Unknown backup part/);
 const v2=packSiloUnifiedBackup({evm},{exportId:EXPORT_ID});
 assert.throws(()=>siloBackupPart(v2,'evm','devnet'),/Unsupported wallet network/);
 assert.throws(()=>siloBackupPart({...v2,parts:{evm:sol}},'evm','mainnet'),/not a Silo Ethereum, Base and BNB backup/);
});

test('the notes name Ethereum only when it is involved, and the Solana + Monero wording is unchanged',async()=>{
 const evm=await seal('evm'),sol=await seal('solana');
 const pair=packSiloUnifiedBackup({solana:sol,xmr},{exportId:EXPORT_ID}),all=packSiloUnifiedBackup({solana:sol,evm,xmr},{exportId:EXPORT_ID}),only=packSiloUnifiedBackup({evm},{exportId:EXPORT_ID});
 assert.equal(siloBackupFileNote(pair,'solana'),'This combined file also holds your Monero wallet. Restore Monero in its own section with the same file.');
 assert.match(siloBackupFileNote(all,'evm'),/also holds your Solana and Monero wallet\. Restore each in its own section/);
 assert.match(siloBackupFileNote(only,'evm'),/^This file contains Ethereum, Base and BNB only\. Solana and Monero needs its own backup file/);
 assert.match(siloBackupFileNote(all,'solana'),/also holds your Ethereum, Base and BNB and Monero wallet/);
});
