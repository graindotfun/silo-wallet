import test from 'node:test';import assert from 'node:assert/strict';
import {createSiloConversionRecovery} from '../lib/silo/conversion-recovery.mjs';
import {sealSilo,openSilo} from '../lib/silo/local-envelope.mjs';
import {verifySiloBackup} from '../lib/silo/offline-recovery.mjs';
import {recoveryOnlyBackup} from '../lib/silo/backup-budget.mjs';
const passphrase='Disposable encrypted recovery passphrase';
test('conversion attempts live inside the XMR envelope and reopen without replacing either direction',async()=>{
 const journal=await createSiloConversionRecovery({passphrase});await journal.remember('synthetic-sol-to-xmr');await journal.remember('synthetic-xmr-to-sol');await journal.remember('synthetic-sol-to-xmr');const snapshot=await journal.backup();assert.equal(snapshot.entries.length,2);assert(!JSON.stringify(snapshot).includes('synthetic-sol-to-xmr'));
 const current={seed:'synthetic public words only',height:100,keysData:'AQ==',cacheData:'Ag==',conversionRecovery:snapshot};const envelope=await sealSilo('xmr','mainnet',current,passphrase),payload=await openSilo(envelope,passphrase);journal.close();assert.throws(()=>journal.handles(),/locked/);
 const reopened=await createSiloConversionRecovery({passphrase,snapshot:payload.conversionRecovery});assert.deepEqual(reopened.handles(),['synthetic-sol-to-xmr','synthetic-xmr-to-sol']);assert.deepEqual(recoveryOnlyBackup('xmr',current).conversionRecovery,snapshot);reopened.close();
});
test('backup verification rejects a stale conversion journal even with the same phrase and birthday',async()=>{
 const journal=await createSiloConversionRecovery({passphrase}),base={seed:'synthetic public words only',height:100};const old=await sealSilo('xmr','mainnet',base,passphrase);await journal.remember('synthetic-attempt');const current={...base,conversionRecovery:await journal.backup()};assert.equal((await verifySiloBackup(old,passphrase,{zone:'xmr',network:'mainnet',current})).sameConversionRecovery,false);const fresh=await sealSilo('xmr','mainnet',current,passphrase);assert.equal((await verifySiloBackup(fresh,passphrase,{zone:'xmr',network:'mainnet',current})).sameConversionRecovery,true);journal.close();
});
test('wrong passphrase, foreign record and malformed encrypted recovery refuse without changing the original',async()=>{
 const journal=await createSiloConversionRecovery({passphrase});await journal.remember('synthetic-attempt');const snapshot=await journal.backup(),before=JSON.stringify(snapshot);await assert.rejects(createSiloConversionRecovery({passphrase:'Wrong disposable passphrase',snapshot}));await assert.rejects(createSiloConversionRecovery({passphrase,snapshot:{entries:[]}}));assert.equal(JSON.stringify(snapshot),before);assert.deepEqual(journal.handles(),['synthetic-attempt']);journal.close();
});
test('retired conversion journal refuses queued saves and never reopens',async()=>{
 const journal=await createSiloConversionRecovery({passphrase});const pending=journal.remember('synthetic-late');journal.close();await assert.rejects(pending,/locked/);await assert.rejects(journal.backup(),/locked/);assert.throws(()=>journal.handles(),/locked/);
});
test('r5: an ACTIVE SOL -> XMR swap record with its secrets is in the wallet backup, restores intact, and is never plaintext in the backup',async()=>{
 const {newReverseRecord}=await import('../lib/silo/atomic-swap/bob-flow.mjs');
 const swapId='ab'.repeat(32);
 const quote={direction:'sol-xmr',quoteId:'q',swapId,xmrAtomic:'1000000000',lamports:1,solPerXmr:7,spreadBps:200,A:'aa'.repeat(32),proofA:{R:'00',s:'00'},claimer:'11111111111111111111111111111111',expiresAt:9999999999};
 let record;try{record=newReverseRecord({owner:'11111111111111111111111111111112',quote,network:'devnet'});}catch{record={kind:'silo-atomic-reverse-v1',swapId,b:'cd'.repeat(32),v:'ef'.repeat(32),status:'locking'};}
 record={...record,swapId,status:'locking',lockAttemptAt:1700000000};
 const journal=await createSiloConversionRecovery({passphrase});await journal.saveAtomic(record);
 const snapshot=await journal.backup(),text=JSON.stringify(snapshot);
 assert.ok(!text.includes(record.b)&&!text.includes(record.v),'secrets are encrypted inside the backup');
 const restored=await createSiloConversionRecovery({passphrase,snapshot});
 const back=restored.atomicRecords().find(r=>r.swapId===swapId);
 assert.equal(back.b,record.b);assert.equal(back.v,record.v);assert.equal(back.status,'locking');assert.equal(back.lockAttemptAt,1700000000);
 await assert.rejects(createSiloConversionRecovery({passphrase:'a different passphrase for the wrong restore',snapshot}));
});
