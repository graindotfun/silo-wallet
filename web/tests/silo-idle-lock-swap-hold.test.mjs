// Owner decision A (4 Nov 2026), extended 5 Nov 2026: a no-bridge swap between "XMR sent" and "SOL received" keeps the wallet
// from idle-locking until the swap is claimed, refunded or stopped, at the latest until its claim deadline; then the normal
// 10-minute idle lock resumes. A manual lock is not affected (the hold only changes the idle timer's check).
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {bindSiloIdleLock,holdSiloIdleLock,releaseSiloIdleLock,siloIdleLockHeldUntil,SILO_IDLE_LOCK_MS,SILO_SWAP_IDLE_HOLD_MAX_MS} from '../lib/silo/idle-lock.mjs';
import {T1_MAX_LEAD} from '../lib/silo/atomic-swap/swap-core.mjs';
function harness(clock){
 const pending=[];const target={addEventListener(){},removeEventListener(){},hidden:false};let locks=0;
 const timers={setTimeout:(callback,delay)=>{const t={callback,at:clock.t+delay};pending.push(t);return t;},clearTimeout:t=>{const i=pending.indexOf(t);if(i>=0)pending.splice(i,1);}};
 const dispose=bindSiloIdleLock({root:target,isActive:()=>true,lock:()=>{locks++;},windowTarget:target,documentTarget:target,now:()=>clock.t,timers});
 const advance=ms=>{const end=clock.t+ms;for(;;){pending.sort((a,b)=>a.at-b.at);const next=pending[0];if(!next||next.at>end)break;pending.shift();clock.t=next.at;next.callback();}clock.t=end;};
 return {advance,locks:()=>locks,dispose};
}
const MIN=60_000;
test('the hold runs until the deadline it is given, and is capped at the longest claim window',()=>{
 // Leave and return (PR #632, 6 Nov 2026): XMR -> SOL no longer holds the idle lock, and T1_MAX_LEAD went from 6 h to 26 h for the
 // 24 h claim window. The hold cap deliberately stays 6 h: Silo is never kept unlocked longer, whatever the swap deadline.
 assert.equal(SILO_SWAP_IDLE_HOLD_MAX_MS,6*3600_000,'the hold cap stays 6 h');assert.ok(T1_MAX_LEAD*1000>=SILO_SWAP_IDLE_HOLD_MAX_MS,'no accepted deadline is shorter than the cap');
 const t0=1_000_000_000_000,deadline=t0+3*3600_000;
 assert.equal(holdSiloIdleLock('atomic:a',deadline,t0),true);
 assert.equal(siloIdleLockHeldUntil(t0+MIN),deadline);
 assert.equal(holdSiloIdleLock('atomic:b',t0,t0),false,'a deadline that has passed holds nothing');
 assert.equal(holdSiloIdleLock('atomic:c',t0+SILO_SWAP_IDLE_HOLD_MAX_MS+1,t0),false,'a deadline beyond the cap is refused, never held forever');
 assert.equal(holdSiloIdleLock('atomic:d',Number.NaN,t0),false);
 assert.equal(holdSiloIdleLock('atomic:e',Number.POSITIVE_INFINITY,t0),false);
 assert.equal(siloIdleLockHeldUntil(deadline),0,'expired holds are dropped');
 releaseSiloIdleLock('atomic:a');
});
test('without a hold the wallet idle-locks after 10 minutes',()=>{
 const clock={t:2_000_000_000_000};const h=harness(clock);
 h.advance(SILO_IDLE_LOCK_MS-1);assert.equal(h.locks(),0);h.advance(1);assert.equal(h.locks(),1);h.dispose();
});
test('slow confirmations (60 min to claim, past the old 45-minute cap): no idle lock until the claim releases the hold',()=>{
 const clock={t:3_000_000_000_000};const deadline=clock.t+3*3600_000;
 assert.equal(holdSiloIdleLock('atomic:slow',deadline,clock.t),true);
 const h=harness(clock);
 h.advance(35*MIN);assert.equal(h.locks(),0,'no lock at 35 minutes (E21: ten confirmations took 33)');
 h.advance(25*MIN);assert.equal(h.locks(),0,'no lock at 60 minutes while the claim is still pending');
 releaseSiloIdleLock('atomic:slow');h.advance(SILO_IDLE_LOCK_MS);assert.equal(h.locks(),1,'after the claim, the normal 10-minute idle lock is back');
 h.dispose();
});
test('a swap that is never claimed holds only until its claim deadline, then locks',()=>{
 const clock={t:4_000_000_000_000};const deadline=clock.t+90*MIN;
 holdSiloIdleLock('atomic:late',deadline,clock.t);const h=harness(clock);
 h.advance(90*MIN-1);assert.equal(h.locks(),0,'held until just before the deadline');
 h.advance(1);assert.equal(h.locks(),1,'locks at the deadline (idle for longer than 10 minutes by then)');
 releaseSiloIdleLock('atomic:late');h.dispose();
});
test('a released hold (swap refunding or stopped) brings back the normal idle lock',()=>{
 const clock={t:5_000_000_000_000};holdSiloIdleLock('atomic:x',clock.t+3600_000,clock.t);const h=harness(clock);
 h.advance(5*MIN);releaseSiloIdleLock('atomic:x');h.advance(5*MIN);assert.equal(h.locks(),1);h.dispose();
});
test('leave and return (owner, 5 Nov 2026): the XMR -> SOL panel no longer holds the idle lock; the hold API and its hard cap stay',()=>{
 const panel=readFileSync(new URL('../components/silo-atomic-panel.tsx',import.meta.url),'utf8');
 assert.doesNotMatch(panel,/holdSiloIdleLock|releaseSiloIdleLock|idle-lock\.mjs/);
 assert.ok(!panel.includes('45 minutes')&&!panel.includes('20 to 25'),'old fixed-hold and timing copy is gone');
});
