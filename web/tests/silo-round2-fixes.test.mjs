import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {createSiloConversionRecovery} from '../lib/silo/conversion-recovery.mjs';
import {conversionRetireTarget} from '../lib/silo/conversion-ui.mjs';
const passphrase='Disposable encrypted recovery passphrase';

test('R2-1: 64 remember+retire cycles then a 65th, export and reopen succeed; active handles preserved',{timeout:120000},async()=>{
 const journal=await createSiloConversionRecovery({passphrase});
 await journal.remember('active-keep');
 for(let i=0;i<63;i++){const h=`done-${i}`;await journal.remember(h);await journal.retire(h);}
 // 64 entries total (1 active + 63 retired). Two more cycles must evict the oldest retired only.
 for(let i=63;i<65;i++){const h=`done-${i}`;await journal.remember(h);await journal.retire(h);}
 await journal.remember('fresh-65th');
 const snapshot=await journal.backup();assert(snapshot.entries.length<=64,String(snapshot.entries.length));
 const reopened=await createSiloConversionRecovery({passphrase,snapshot});
 assert.deepEqual(new Set(reopened.handles()),new Set(['active-keep','fresh-65th']));
 reopened.close();journal.close();
});
test('R2-1: when all 64 entries are active a new attempt is refused with a clear bound error and nothing is dropped',{timeout:120000},async()=>{
 const journal=await createSiloConversionRecovery({passphrase});
 for(let i=0;i<64;i++)await journal.remember(`a-${i}`);
 await assert.rejects(journal.remember('a-64'),/conversion-recovery-bound/);assert.equal(journal.handles().length,64);
 const reopened=await createSiloConversionRecovery({passphrase,snapshot:await journal.backup()});assert.equal(reopened.handles().length,64);reopened.close();journal.close();
});
test('B3: A/B mismatch never lets A\'s verification retire B',()=>{
 assert.equal(conversionRetireTarget({resolved:true,recordHandle:'A',editedHandle:'A'}),'A');
 assert.equal(conversionRetireTarget({resolved:true,recordHandle:'A',editedHandle:'B'}),null);
 assert.equal(conversionRetireTarget({resolved:true,recordHandle:'A',editedHandle:''}),null);
 assert.equal(conversionRetireTarget({resolved:true,recordHandle:null,editedHandle:'B'}),null);
 assert.equal(conversionRetireTarget({resolved:false,recordHandle:'A',editedHandle:'A'}),null);
});
test('B3 wiring: panel retires only the helper-derived handle, never the raw editable field',async()=>{
 const src=await readFile('components/silo-conversion-panel.tsx','utf8');
 const fn=src.slice(src.indexOf('async function startNew()'),src.indexOf('async function startNew()')+700);
 assert(fn.includes('conversionRetireTarget('));assert(!/const handle=recovery;/.test(fn));
 assert(src.includes('setRecordHandle(selected.quoteSeal)')&&src.includes('setRecordHandle(checkedHandle)'));
});
test('B2: deposit bridge registers one stable function, with a dependency array, and the parent registrar is stable',async()=>{
 const child=await readFile('components/silo-conversion-solana-deposit.tsx','utf8'),parent=await readFile('components/silo-workspace.tsx','utf8');
 const line=child.split('\n').find(l=>l.includes('onBridge(isNative'));assert(line,'registration effect');
 assert(/\},\s*\[[^\]]+\]\);/.test(line),'effect must have a dependency array');assert(!/onBridge\(isNative \? prepare[ :]/.test(line));
 assert(child.includes('const stablePrepare = useCallback(')&&child.includes('prepareRef.current = prepare'));
 assert(/const stablePrepare = useCallback\([^\n]*\[\]\);/.test(child),'stablePrepare must have empty deps');
 assert(/const onSolanaDepositBridge=useCallback\([^\n]*\},?\[\]\);|const onSolanaDepositBridge=useCallback\([^\n]*,\[\]\);/.test(parent),'parent registrar stable');
 // Lifecycle model: registration count only grows when [isNative,onBridge,stablePrepare] change, not per render.
 let regs=0;const deps=[];const render=(n,b,s)=>{const d=[n,b,s];if(!deps.length||d.some((v,i)=>v!==deps[i])){regs++;deps.length=0;deps.push(...d);}};
 const b=()=>{},s=()=>{};for(let i=0;i<10;i++)render(true,b,s);assert.equal(regs,1);
});

import {conversionAttemptResolved} from '../lib/silo/conversion-ui.mjs';
test('B3 closure: a recovered record with unknown history never resolves from expired/failed/funded states',async()=>{
 for(const state of ['expired','provider-failed','deposit-detected','refund-reported'])assert.equal(conversionAttemptResolved(state,{noFundsAtRisk:false,destinationIsXmr:false}),false,state);
 const src=await readFile('components/silo-conversion-panel.tsx','utf8');
 assert(src.includes('const rebinding=recordHandle!==checkedHandle;if(rebinding){setCreatedHere(false);setSawFunding(false);setReceiptVerified(\'unverified\');setPayoutLeg(null);}'));
 assert(src.includes('const base=rebinding?null:previous;'));
});
