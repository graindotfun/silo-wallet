// SPDX-License-Identifier: AGPL-3.0-only
/** Restore behaviour of the combined backup with REAL sealed envelopes (native keyring, PBKDF2 600k + AES-GCM): an old v1 file, a v2 file
 * with all three parts, partial files, a wrong passphrase per part, and corruption. No key derivation or signing code is touched. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeKeyring,restoreNativeKeyring} from '../lib/silo/native-keyring.mjs';
import {packSiloUnifiedBackup,siloBackupPart,describeSiloBackupFile,SILO_UNIFIED_BACKUP_FORMAT,SILO_UNIFIED_BACKUP_FORMAT_V2} from '../lib/silo/unified-backup.mjs';

const memory=()=>{let envelope=null;return {closed:false,async read(){return envelope;},async create(e){if(envelope)return false;envelope=e;return true;},async remove(){envelope=null;return true;},close(){},onClose(){}};};
const PASS={solana:'solana passphrase number one',evm:'evm passphrase number two!!',xmr:'monero passphrase number three'};
const make=async chain=>{const session=await createNativeKeyring({chain,passphrase:PASS[chain],store:memory()});return {envelope:session.exportBackup(),address:session.metadata().address};};
const xmr={zone:'xmr',network:'mainnet',version:2,ciphertext:'QUJD'};
const restore=(envelope,chain,passphrase)=>restoreNativeKeyring({chain,backup:envelope,passphrase,store:memory()});
const roundtrip=JSON.parse;
let sol,evm;
test.before(async()=>{sol=await make('solana');evm=await make('evm');});

test('an old v1 file (Solana + Monero) restores Solana with its own passphrase to the same address, and holds no EVM wallet',async()=>{
 const file=roundtrip(JSON.stringify(packSiloUnifiedBackup({solana:sol.envelope,xmr})));
 assert.equal(file.format,SILO_UNIFIED_BACKUP_FORMAT);
 const session=await restore(siloBackupPart(file,'solana','mainnet'),'solana',PASS.solana);
 assert.equal(session.metadata().address,sol.address);
 assert.throws(()=>siloBackupPart(file,'evm','mainnet'),/holds no Ethereum, Base and BNB wallet/);
});

test('a single-wallet file written before any combined file existed still restores (raw Solana and raw EVM envelopes)',async()=>{
 assert.equal((await restore(siloBackupPart(sol.envelope,'solana','mainnet'),'solana',PASS.solana)).metadata().address,sol.address);
 assert.equal((await restore(siloBackupPart(evm.envelope,'evm','mainnet'),'evm',PASS.evm)).metadata().address,evm.address);
});

test('a v2 file with all three parts restores each wallet with its OWN passphrase; the Monero part is carried unchanged',async()=>{
 const file=roundtrip(JSON.stringify(packSiloUnifiedBackup({solana:sol.envelope,evm:evm.envelope,xmr})));
 assert.equal(file.format,SILO_UNIFIED_BACKUP_FORMAT_V2);assert.deepEqual(describeSiloBackupFile(file).parts.map(part=>part.zone),['solana','evm','xmr']);
 assert.equal((await restore(siloBackupPart(file,'solana','mainnet'),'solana',PASS.solana)).metadata().address,sol.address);
 assert.equal((await restore(siloBackupPart(file,'evm','mainnet'),'evm',PASS.evm)).metadata().address,evm.address);
 assert.deepEqual(siloBackupPart(file,'xmr','mainnet'),xmr);
});

test('partial files: each combination restores exactly what it holds and names what it lacks',async()=>{
 const onlyEvm=packSiloUnifiedBackup({evm:evm.envelope}),solEvm=packSiloUnifiedBackup({solana:sol.envelope,evm:evm.envelope}),evmXmr=packSiloUnifiedBackup({evm:evm.envelope,xmr});
 assert.throws(()=>siloBackupPart(onlyEvm,'solana','mainnet'),/holds no Solana wallet/);assert.throws(()=>siloBackupPart(onlyEvm,'xmr','mainnet'),/holds no Monero wallet/);
 assert.equal((await restore(siloBackupPart(onlyEvm,'evm','mainnet'),'evm',PASS.evm)).metadata().address,evm.address);
 assert.equal((await restore(siloBackupPart(solEvm,'solana','mainnet'),'solana',PASS.solana)).metadata().address,sol.address);
 assert.throws(()=>siloBackupPart(solEvm,'xmr','mainnet'),/holds no Monero wallet/);
 assert.throws(()=>siloBackupPart(evmXmr,'solana','mainnet'),/holds no Solana wallet/);
});

test('a wrong passphrase per part fails, including the other wallet\'s passphrase (parts do not share one)',async()=>{
 const file=packSiloUnifiedBackup({solana:sol.envelope,evm:evm.envelope,xmr});
 await assert.rejects(restore(siloBackupPart(file,'evm','mainnet'),'evm',PASS.solana));
 await assert.rejects(restore(siloBackupPart(file,'solana','mainnet'),'solana',PASS.evm));
 await assert.rejects(restore(siloBackupPart(file,'evm','mainnet'),'evm','completely wrong passphrase'));
 await assert.rejects(restore(siloBackupPart(file,'evm','mainnet'),'evm','short'));
});

test('corruption: a changed ciphertext, salt, iv or a swapped part never restores a wallet',async()=>{
 const flip=text=>text.slice(0,4)+(text[4]==='A'?'B':'A')+text.slice(5);
 for(const field of ['ciphertext','salt','iv']){
  const bad={...evm.envelope,[field]:flip(evm.envelope[field])};
  const file=packSiloUnifiedBackup({evm:bad});
  await assert.rejects(restore(siloBackupPart(file,'evm','mainnet'),'evm',PASS.evm),undefined,`${field} changed`);
 }
 // Authenticated header: a different claimed address or network is refused, never restored under another identity.
 const claimed={...evm.envelope,address:sol.address};
 await assert.rejects(restore(siloBackupPart(packSiloUnifiedBackup({evm:claimed}),'evm','mainnet'),'evm',PASS.evm));
 // A part placed in the wrong slot, or a mangled file, is refused before any passphrase is asked.
 assert.throws(()=>packSiloUnifiedBackup({evm:sol.envelope}),/not a sealed Silo evm backup/);
 assert.throws(()=>packSiloUnifiedBackup({solana:evm.envelope}),/not a sealed Silo solana backup/);
 const file=packSiloUnifiedBackup({solana:sol.envelope,evm:evm.envelope});
 assert.throws(()=>siloBackupPart({...file,parts:{solana:evm.envelope,evm:sol.envelope}},'evm','mainnet'),/not a Silo Ethereum, Base and BNB backup/);
 assert.throws(()=>siloBackupPart({...file,format:SILO_UNIFIED_BACKUP_FORMAT},'evm','mainnet'),/not a valid Silo backup/);
 assert.equal(describeSiloBackupFile({format:SILO_UNIFIED_BACKUP_FORMAT_V2,parts:null}).kind,'unknown');
 assert.throws(()=>siloBackupPart(JSON.parse('{"format":"nope"}'),'evm','mainnet'),/not a Silo/);
});

test('the verification step (verifyBackup, which gates the receive address) works on the part taken from a v2 file and proves it is THIS wallet',async()=>{
 const open=async(chain,envelope)=>restoreNativeKeyring({chain,backup:envelope,passphrase:PASS[chain],store:memory()});
 const file=packSiloUnifiedBackup({solana:sol.envelope,evm:evm.envelope,xmr});
 const liveEvm=await open('evm',evm.envelope),liveSol=await open('solana',sol.envelope);
 assert.equal(await liveEvm.verifyBackup(siloBackupPart(file,'evm','mainnet'),PASS.evm),true);
 assert.equal(await liveSol.verifyBackup(siloBackupPart(file,'solana','mainnet'),PASS.solana),true);
 // A file that holds a DIFFERENT EVM wallet, a wrong passphrase, or a part of the wrong chain never verifies.
 const other=await make('evm'),otherFile=packSiloUnifiedBackup({evm:other.envelope});
 await assert.rejects(liveEvm.verifyBackup(siloBackupPart(otherFile,'evm','mainnet'),PASS.evm),/different wallet/);
 await assert.rejects(liveEvm.verifyBackup(siloBackupPart(file,'evm','mainnet'),PASS.solana));
 await assert.rejects(liveEvm.verifyBackup(siloBackupPart(file,'solana','mainnet'),PASS.solana));
 liveEvm.lock();liveSol.lock();
 await assert.rejects(liveEvm.verifyBackup(siloBackupPart(file,'evm','mainnet'),PASS.evm),/locked/i);
});
