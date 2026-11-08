// SPDX-License-Identifier: AGPL-3.0-only
// One backup file for Solana and Monero together: packing sealed envelopes, taking a part back out for either zone in any
// order, a distinct export identifier per export (sequential and concurrent), and names that never collide. No secret is
// opened here; the envelopes are real seals of throwaway material.
import test from 'node:test';
import assert from 'node:assert/strict';
import {sealSilo} from '../lib/silo/local-envelope.mjs';
import {createNativeKeyring} from '../lib/silo/native-keyring.mjs';
import {packSiloUnifiedBackup,siloBackupPart,siloBackupFileName,siloBackupExportId,describeSiloBackupFile,isSiloUnifiedBackup,siloBackupEnvelopeZone,SILO_UNIFIED_BACKUP_FORMAT} from '../lib/silo/unified-backup.mjs';

const passphrase='copper meadow violet lantern';
function memory(){let closed=false,value=null;return {get closed(){return closed;},async read(){return structuredClone(value);},async create(next){if(value)return false;value=structuredClone(next);return true;},close(){closed=true;},onClose(){}};}
async function solanaEnvelope(network='devnet'){const session=await createNativeKeyring({chain:'solana',passphrase,store:memory(),network});const envelope=session.exportBackup();session.lock();return envelope;}
const xmrEnvelope=(network='stagenet')=>sealSilo('xmr',network,{seed:'throwaway words only for this test',height:1},passphrase);
const secretsOf=envelope=>[envelope.salt,envelope.iv,envelope.ciphertext].filter(Boolean);

test('a unified file holds both sealed parts unchanged and comes back out for either zone, in any order', async () => {
 const solana=await solanaEnvelope(),xmr=await xmrEnvelope();
 const file=packSiloUnifiedBackup({solana,xmr},{exportId:'0123456789abcdef',createdAt:'2026-10-20T00:00:00.000Z'});
 assert.equal(file.format,SILO_UNIFIED_BACKUP_FORMAT);assert.ok(isSiloUnifiedBackup(file));
 assert.deepEqual(file.networks,{solana:'devnet',xmr:'stagenet'});
 const copy=JSON.parse(JSON.stringify(file));
 // Monero first, then Solana; and the other way round: each zone gets exactly its own sealed envelope.
 assert.deepEqual(siloBackupPart(copy,'xmr','stagenet'),xmr);assert.deepEqual(siloBackupPart(copy,'solana','devnet'),solana);
 assert.deepEqual(siloBackupPart(copy,'solana','devnet'),solana);assert.deepEqual(siloBackupPart(copy,'xmr','stagenet'),xmr);
 // A zone's own single file still opens through the same door.
 assert.deepEqual(siloBackupPart(xmr,'xmr','stagenet'),xmr);assert.deepEqual(siloBackupPart(solana,'solana','devnet'),solana);
 assert.deepEqual(describeSiloBackupFile(file),{kind:'unified',exportId:'0123456789abcdef',parts:[{zone:'solana',network:'devnet'},{zone:'xmr',network:'stagenet'}]});
 assert.deepEqual(describeSiloBackupFile(xmr),{kind:'single',exportId:null,parts:[{zone:'xmr',network:'stagenet'}]});
 assert.deepEqual(describeSiloBackupFile({hello:1}),{kind:'unknown',exportId:null,parts:[]});
 const described=JSON.stringify(describeSiloBackupFile(file));for(const secret of [...secretsOf(xmr),...secretsOf(solana),solana.address])assert.ok(!described.includes(secret),'the description carries no sealed material or address');
});

test('refusals: wrong network, missing part, not a backup, unknown part, one-part file', async () => {
 const solana=await solanaEnvelope('devnet'),xmr=await xmrEnvelope('stagenet');
 const file=packSiloUnifiedBackup({solana,xmr});
 assert.throws(()=>siloBackupPart(file,'xmr','mainnet'),/network mismatch/);
 assert.throws(()=>siloBackupPart(file,'solana','mainnet'),/network mismatch/);
 assert.throws(()=>siloBackupPart(packSiloUnifiedBackup({xmr}),'solana','devnet'),/holds no Solana wallet/);
 assert.throws(()=>siloBackupPart(packSiloUnifiedBackup({solana}),'xmr','stagenet'),/holds no Monero wallet/);
 assert.throws(()=>siloBackupPart({format:'something-else'},'xmr','stagenet'),/not a Silo Monero backup/);
 assert.throws(()=>siloBackupPart(solana,'xmr','stagenet'),/not a Silo Monero backup/);
 assert.throws(()=>siloBackupPart(xmr,'solana','devnet'),/not a Silo Solana backup/);
 assert.throws(()=>packSiloUnifiedBackup({solana:xmr}),/solana part is not/);
 assert.throws(()=>packSiloUnifiedBackup({xmr:solana}),/xmr part is not/);
 assert.throws(()=>packSiloUnifiedBackup({zec:xmr}),/Unknown backup part/);
 assert.throws(()=>packSiloUnifiedBackup({}),/No backup parts/);
 assert.throws(()=>packSiloUnifiedBackup({xmr},{exportId:'short'}),/Invalid export identifier/);
 assert.throws(()=>siloBackupPart(file,'zec','testnet'),/Unsupported wallet network/);
 assert.equal(siloBackupEnvelopeZone({zone:'xmr',network:'stagenet',version:3,ciphertext:'x'}),null,'an unknown envelope version is not claimed');
});

test('every export has its own identifier: sequential and concurrent exports never share one, and file names never collide', async () => {
 const xmr=await xmrEnvelope(),solana=await solanaEnvelope();
 const sequential=[packSiloUnifiedBackup({solana,xmr}),packSiloUnifiedBackup({solana,xmr})];
 assert.notEqual(sequential[0].exportId,sequential[1].exportId);
 assert.notEqual(siloBackupFileName(sequential[0]),siloBackupFileName(sequential[1]));
 // Concurrent: the identifiers come from the random source, not from the clock, so same-millisecond exports differ too.
 const concurrent=await Promise.all(Array.from({length:64},()=>Promise.resolve().then(()=>packSiloUnifiedBackup({xmr},{createdAt:'2026-10-20T00:00:00.000Z'}))));
 assert.equal(new Set(concurrent.map(file=>file.exportId)).size,64);assert.equal(new Set(concurrent.map(file=>siloBackupFileName(file))).size,64);
 assert.match(siloBackupFileName(sequential[0]),/^grain-silo-backup-solana-devnet\+xmr-stagenet-[a-f0-9]{16}\.encrypted\.json$/);
 assert.match(siloBackupFileName(xmr,siloBackupExportId()),/^grain-silo-backup-xmr-stagenet-[a-f0-9]{16}\.encrypted\.json$/);
 assert.throws(()=>siloBackupFileName(xmr),/Invalid export identifier/,'a single-zone export must also carry an identifier');
 assert.throws(()=>siloBackupFileName({}),/Not a Silo backup/);
 assert.match(siloBackupExportId(),/^[a-f0-9]{16}$/);assert.throws(()=>siloBackupExportId(()=>new Uint8Array(4)),/Export identifier unavailable/);
});
