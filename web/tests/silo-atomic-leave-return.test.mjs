// Leave and return (owner decision, 5 Nov 2026): the swap survives closing, locking and idle lock; Home and Activity show it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {atomicTargetConfirmations,atomicProgress} from '../lib/silo/atomic-driver.mjs';
import {publishAtomicPending,subscribeAtomicPending,atomicPendingSnapshot,atomicPendingServerSnapshot} from '../lib/silo/atomic-pending.mjs';

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');

test('the confirmation target comes from the quote (1..10), anything else is 10',()=>{
 for(const n of [1,4,10])assert.equal(atomicTargetConfirmations({quote:{confirmations:n}}),n);
 for(const n of [0,11,4.5,'4',null,undefined])assert.equal(atomicTargetConfirmations({quote:{confirmations:n}}),10);
 assert.equal(atomicTargetConfirmations(null),10);
 const p=atomicProgress({refunder:'x',status:'maker-locked',xmrLockTxid:'t',xmrConfirmations:4,quote:{confirmations:4}},{});
 assert.equal(p.steps[1].label,'Confirming 4/4');assert.equal(p.steps[1].done,true);
});

test('pending store: publishes only on change, empties on unmount, server snapshot is empty',()=>{
 let calls=0;const stop=subscribeAtomicPending(()=>calls++);
 const item={swapId:'ab'.repeat(32),short:'ABAB',phase:'confirming',xmr:'0.01',sol:'0.06',claimBy:1_800_000_000,sendBy:null};
 publishAtomicPending([item]);publishAtomicPending([{...item}]);
 assert.equal(calls,1,'an identical list does not re-render');
 assert.equal(atomicPendingSnapshot().length,1);assert.ok(Object.isFrozen(atomicPendingSnapshot()[0]));
 publishAtomicPending([]);assert.equal(calls,2);assert.equal(atomicPendingSnapshot().length,0);
 assert.equal(atomicPendingServerSnapshot().length,0);stop();
});

test('the pending summary holds no key material, only display fields',()=>{
 const panel=read('components/silo-atomic-panel.tsx');
 const summary=panel.slice(panel.indexOf('const pendingKey='),panel.indexOf('useEffect(()=>{publishAtomicPending'));
 assert.match(summary,/\{swapId:record\.swapId,short:.*,phase:.*,xmr:.*,sol:.*,claimBy:.*,sendBy:atomicSendBy\(record\)\}/);
 assert.doesNotMatch(summary,/privateSpendKey|privateViewKey|secret|feePayerSecret|\ba:|\.a\b|claimTx/);
});

test('Home and Activity render the pending card only when the no-bridge swap is enabled, and it opens the swap',()=>{
 const overview=read('components/silo-overview.tsx'),card=read('components/silo-atomic-pending-card.tsx');
 assert.ok(overview.includes("const pendingSwap=atomicEnabled?<SiloAtomicPendingCard onOpen={()=>setTask('atomic')}/>:null;"));
 assert.match(overview,/<div className="silo-home-main">\n   \{pendingSwap\}/);
 assert.match(overview,/\{view==='activity'&&pendingSwap\}/);
 assert.ok(card.includes('open and unlock it again before')&&!card.includes('by itself'),'the pending card says the user must reopen and unlock Silo');
 assert.doesNotMatch(card,/[Kk]eep this page open|localStorage|sessionStorage/,'nothing is stored in plain text while locked');
});
