import test from 'node:test';import assert from 'node:assert/strict';
import {bindSiloIdleLock,SILO_IDLE_LOCK_MS} from '../lib/silo/idle-lock.mjs';
function fixture(){
 const root=new EventTarget(),windowTarget=new EventTarget(),documentTarget=new EventTarget();documentTarget.hidden=false;
 let clock=0,next=0,locks=0,active=false;const pending=new Map();
 const timers={setTimeout:(run,delay)=>{pending.set(++next,{at:clock+delay,run});return next;},clearTimeout:id=>pending.delete(id)};
 const cleanup=bindSiloIdleLock({root,windowTarget,documentTarget,timers,now:()=>clock,isActive:()=>active,lock:()=>locks++});
 // advance runs due timers; skip moves the wall clock WITHOUT running timers (throttled background tab).
 return {root,windowTarget,documentTarget,cleanup,active:value=>{active=value;},locks:()=>locks,skip:amount=>{clock+=amount;},advance:amount=>{clock+=amount;for(const [id,row] of [...pending])if(row.at<=clock){pending.delete(id);row.run();}},pending:()=>pending.size};
}
const T=SILO_IDLE_LOCK_MS;
test('idle timeout is ten minutes',()=>assert.equal(T,600000));
test('private input and offline recovery lock after the idle timeout without an SDK wallet',()=>{
 const f=fixture();f.advance(T);assert.equal(f.locks(),0,'blank idle page need not reload');
 f.root.dispatchEvent(new Event('input'));f.advance(T-1);assert.equal(f.locks(),0);f.advance(1);assert.equal(f.locks(),1);
 f.cleanup();
});
test('hiding the page does not lock, even with private input or an open wallet',()=>{
 const f=fixture();f.active(true);f.root.dispatchEvent(new Event('input'));
 f.documentTarget.hidden=true;f.documentTarget.dispatchEvent(new Event('visibilitychange'));assert.equal(f.locks(),0);
 f.advance(T-1);assert.equal(f.locks(),0);f.cleanup();
});
test('returning after the timeout locks at once and only once, even if the timer was throttled',()=>{
 const f=fixture();f.active(true);f.documentTarget.hidden=true;f.documentTarget.dispatchEvent(new Event('visibilitychange'));
 f.skip(T);f.documentTarget.hidden=false;f.documentTarget.dispatchEvent(new Event('visibilitychange'));assert.equal(f.locks(),1);
 f.documentTarget.dispatchEvent(new Event('visibilitychange'));f.advance(T*2);assert.equal(f.locks(),1);f.cleanup();
});
test('returning inside the window keeps the wallet open and does not count as activity',()=>{
 const f=fixture();f.active(true);f.documentTarget.hidden=true;f.documentTarget.dispatchEvent(new Event('visibilitychange'));
 f.skip(T-1000);f.documentTarget.hidden=false;f.documentTarget.dispatchEvent(new Event('visibilitychange'));assert.equal(f.locks(),0);
 f.advance(999);assert.equal(f.locks(),0);f.advance(1);assert.equal(f.locks(),1,'visibility did not reset the clock');f.cleanup();
});
test('a late timer still locks by elapsed wall time; an early one re-arms',()=>{
 const f=fixture();f.active(true);f.skip(T+5000);f.advance(0);assert.equal(f.locks(),1);f.cleanup();
});
test('pointer, key, touch, scroll and input activity each reset the deadline',()=>{
 for(const [target,type] of [['windowTarget','pointerdown'],['windowTarget','keydown'],['windowTarget','touchstart'],['windowTarget','scroll'],['root','input']]){
  const f=fixture();f.active(true);f.advance(T-10000);f[target].dispatchEvent(new Event(type));f.advance(T-1);assert.equal(f.locks(),0,type);f.advance(1);assert.equal(f.locks(),1,type);f.cleanup();
 }
});
test('cleanup removes all input, visibility and timer callbacks',()=>{
 const f=fixture();f.root.dispatchEvent(new Event('input'));f.cleanup();assert.equal(f.pending(),0);
 f.skip(T*2);f.documentTarget.dispatchEvent(new Event('visibilitychange'));f.advance(T*2);assert.equal(f.locks(),0);
});
