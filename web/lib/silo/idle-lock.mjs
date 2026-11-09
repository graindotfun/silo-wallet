/** Idle time without activity before a Silo wallet locks. Change here only. */
export const SILO_IDLE_LOCK_MS=600000;
const ACTIVITY=['pointerdown','keydown','touchstart'];
/** Owner decision A (4 Nov 2026), extended 5 Nov 2026: while a no-bridge swap is between "XMR sent" and "SOL received", the
 * wallet does not idle-lock. The hold ends when the swap is claimed, refunded or stopped (the caller releases it) and at the
 * latest at that swap's claim deadline, which the caller passes as `until`. It can never last longer than the longest claim
 * window the swap protocol accepts (T1_MAX_LEAD in atomic-swap/swap-core.mjs, 6 hours): a hold asking for more is refused.
 * Then the normal idle lock resumes. A manual lock always works. Holds live in this page only (a reload re-registers them
 * from the swap record, with the same deadline). */
export const SILO_SWAP_IDLE_HOLD_MAX_MS=6*3600_000;
const holds=new Map();
export function holdSiloIdleLock(id,until,current=Date.now()){
 if(typeof id!=='string'||!id||!Number.isSafeInteger(until))return false;
 if(until<=current||until>current+SILO_SWAP_IDLE_HOLD_MAX_MS){holds.delete(id);return false;}
 holds.set(id,until);return true;
}
export function releaseSiloIdleLock(id){holds.delete(id);}
/** The latest time any live hold keeps the wallet unlocked, or 0. Expired holds are dropped. */
export function siloIdleLockHeldUntil(current=Date.now()){let latest=0;for(const [id,until] of holds){if(until<=current)holds.delete(id);else if(until>latest)latest=until;}return latest;}
/** Lock private input/recovery views after a period WITHOUT activity. Leaving the
 * tab or app does not lock: the clock is wall time (Date.now) from the last
 * activity, so a background tab whose timers were throttled still locks on return
 * once the timeout has elapsed, and a quick return keeps all state. Returning to
 * the page (visible) is only a check, never activity. While the page is in the
 * background the passphrase and keys stay in memory until the timeout.
 * Sensitive input is monotonic for this page lifetime; clearing a field does not
 * promise that earlier strings disappeared from JS memory. Lock reloads the page.
 * @param {{root:EventTarget|null,isActive:()=>boolean,lock:()=>void,windowTarget?:EventTarget,documentTarget?:EventTarget & {hidden?:boolean},now?:()=>number,timers?:{setTimeout:(callback:()=>void,delay:number)=>any,clearTimeout:(id:any)=>void},timeout?:number,heldUntil?:(now:number)=>number}} options */
export function bindSiloIdleLock({root,isActive,lock,windowTarget=window,documentTarget=document,now=()=>Date.now(),timers={setTimeout:(callback,delay)=>setTimeout(callback,delay),clearTimeout:id=>clearTimeout(id)},timeout=SILO_IDLE_LOCK_MS,heldUntil=siloIdleLockHeldUntil}){
 if(!root)return ()=>{};
 let sensitive=false,locked=false,disposed=false,timer,last=now();
 const clear=()=>{if(!disposed&&!locked&&(sensitive||isActive())){locked=true;timers.clearTimeout(timer);lock();}};
 const arm=delay=>{timers.clearTimeout(timer);timer=timers.setTimeout(check,delay);};
 // Timers may run late (throttled) or early; elapsed wall time decides.
 function check(){if(disposed||locked)return;const at=now(),elapsed=at-last;if(elapsed<timeout){arm(timeout-elapsed);return;}const held=heldUntil(at);if(held>at){arm(Math.min(held-at,timeout));return;}clear();}
 const reset=()=>{if(disposed||locked)return;last=now();arm(timeout);};
 const input=()=>{sensitive=true;reset();};
 const visible=()=>{if(!documentTarget.hidden)check();};
 root.addEventListener('input',input,true);
 for(const event of ACTIVITY)windowTarget.addEventListener(event,reset);
 windowTarget.addEventListener('scroll',reset,true);
 documentTarget.addEventListener('visibilitychange',visible);arm(timeout);
 return ()=>{disposed=true;timers.clearTimeout(timer);root.removeEventListener('input',input,true);for(const event of ACTIVITY)windowTarget.removeEventListener(event,reset);windowTarget.removeEventListener('scroll',reset,true);documentTarget.removeEventListener('visibilitychange',visible);};
}
