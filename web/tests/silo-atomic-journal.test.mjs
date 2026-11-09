import test from 'node:test';import assert from 'node:assert/strict';
import {createSiloConversionRecovery} from '../lib/silo/conversion-recovery.mjs';
const swapId='ab'.repeat(32),record={kind:'silo-atomic-xmr-sol-v1',swapId,status:'maker-locked',a:'11'.repeat(32)};
test('atomic swap records are saved, revised and restored from the encrypted backup next to conversion handles',async()=>{
 const journal=await createSiloConversionRecovery({passphrase:'correct horse battery staple'});
 await journal.remember('handle-1');
 await journal.saveAtomic(record);await journal.saveAtomic({...record,status:'xmr-locked'});
 assert.equal(journal.atomicRecords().length,1);assert.equal(journal.atomicRecords()[0].status,'xmr-locked');
 const live=journal.atomicRecords();live[0].status='tampered';assert.equal(journal.atomicRecords()[0].status,'xmr-locked');
 const backup=await journal.backup();assert.equal(JSON.stringify(backup).includes('11'.repeat(32)),false,'secret scalar must not appear in the encrypted backup');
 journal.close();
 const reopened=await createSiloConversionRecovery({passphrase:'correct horse battery staple',snapshot:backup});
 assert.deepEqual(reopened.handles(),['handle-1']);assert.equal(reopened.atomicRecords()[0].status,'xmr-locked');assert.equal(reopened.atomicRecords()[0].a,'11'.repeat(32));
 await reopened.saveAtomic({...record,status:'done'});assert.equal(reopened.atomicRecords()[0].status,'done');
 reopened.close();
 await assert.rejects(createSiloConversionRecovery({passphrase:'wrong passphrase value',snapshot:backup}));
});
test('a malformed swap record is refused and nothing is saved',async()=>{
 const journal=await createSiloConversionRecovery({passphrase:'correct horse battery staple'});
 await assert.rejects(journal.saveAtomic({swapId:'short',kind:'x'}));await assert.rejects(journal.saveAtomic(null));
 assert.equal(journal.atomicRecords().length,0);journal.close();
});
test('R2-H6: once a payment may have gone out, no later save (an older copy from the swap loop) clears that flag',async()=>{
 const journal=await createSiloConversionRecovery({passphrase:'correct horse battery staple'});
 await journal.saveAtomic(record);await journal.saveAtomic({...record,fundingAttempted:1_800_000_000_000});
 await journal.saveAtomic({...record,status:'watching'});          // the driver's in-memory copy never saw the flag
 assert.equal(journal.atomicRecords()[0].fundingAttempted,1_800_000_000_000);assert.equal(journal.atomicRecords()[0].status,'watching');
 const reopened=await createSiloConversionRecovery({passphrase:'correct horse battery staple',snapshot:await journal.backup()});
 assert.equal(reopened.atomicRecords()[0].fundingAttempted,1_800_000_000_000,'the flag survives a reload');
 journal.close();reopened.close();
});
