// One view-only watch wallet per swap, kept for the life of the swap and synced incrementally (monero-ts continues a wallet's
// own sync from the height it already reached, so a second pass only reads the new blocks). Rules:
//  - single flight: while a scan of one swap address is running, another request for it gets the SAME promise; a second wallet is never opened
//  - cancel() asks the wallet to stop (monero-ts stopSyncing). It is a request, not a guarantee: a hung status() may stay pending, so nothing waits on it
//  - retirement: release() moves the entry to "retiring" and keeps it there until its wallet is closed. A scan of a retiring address is
//    rejected, so a second wallet for the same address can never be opened while the old one is still alive. A close that never answers keeps
//    the entry (and so the single wallet) rather than risk a second one.
//  - release() / closeAll() never wait longer than RELEASE_BOUND_MS for the caller; closeAll closes everything in parallel
//  - nothing here holds or sees a spend key or a seed.
export const RELEASE_BOUND_MS=1000;
export const CLOSE_ATTEMPT_MS=5000;   // one close attempt
export const CLOSE_RETRY_MS=2000;      // pause between attempts
export const CLOSE_MAX_RETRIES=5;      // after this the reservation simply stays: fail closed, never a second wallet
const bounded=(promise,ms)=>{let timer;return Promise.race([promise,new Promise(resolve=>{timer=setTimeout(resolve,ms);})]).finally(()=>clearTimeout(timer));};
/** @param {{open:(keys:any)=>Promise<{status:()=>Promise<any>,cancel:()=>Promise<void>,close:()=>Promise<void>}>,registry?:Map<string,any>,closeBoundMs?:number,retryMs?:number,maxRetries?:number}} deps */
export function createWatchPool({open,registry=new Map(),closeBoundMs=CLOSE_ATTEMPT_MS,retryMs=CLOSE_RETRY_MS,maxRetries=CLOSE_MAX_RETRIES}){
 // `registry` holds the per-address reservations. A holder passes the same registry to every generation of the pool, so a new pool
 // inherits the reservations of an old one that is still retiring.
 const entries=registry;
 const me=Symbol('pool');   // cleanup ownership: this pool cancels and closes only entries it opened itself; the shared registry is only for reservation visibility
 let disposed=false;
 const idOf=keys=>String(keys?.primaryAddress??'');
 const scan=keys=>{
  if(disposed)return Promise.reject(Error('The swap check is closed.'));
  const id=idOf(keys);let e=entries.get(id);
  if(e?.retiring)return Promise.reject(Error('The swap check is closing.'));
  if(e&&e.owner!==me)return Promise.reject(Error('The swap check is held by another session.'));
  if(e?.running)return e.running;
  if(!e){e={owner:me,watch:null,opening:null,running:null,cancelled:false,retiring:null};entries.set(id,e);}
  e.cancelled=false;
  const run=(async()=>{
   try{
    if(!e.watch){e.opening??=open(keys).finally(()=>{e.opening=null;});e.watch=await e.opening;}
    if(e.cancelled||e.retiring||disposed)throw Error('cancelled');
    return await e.watch.status();
   }finally{if(e.running===run)e.running=null;}
  })();
  e.running=run;run.catch(()=>{});return run;
 };
 const own=keys=>{const e=entries.get(idOf(keys));return e&&e.owner===me?e:undefined;};
 const cancel=async keys=>{const e=own(keys);if(!e)return;e.cancelled=true;try{await e.watch?.cancel();}catch{/* the wallet may already be idle */}};
 // Retirement. The reservation is released ONLY when the wallet is known to be closed (close resolved) or never existed. A rejected or timed-out
 // close proves nothing about the wallet, so the entry stays reserved (scans of that address are rejected) and the close is retried in the background.
 // cancel and close are independent: a cancel that never settles cannot stop the close from starting. Both are bounded and fire and forget.
 const retire=(id,e)=>{
  if(e.retiring)return e.retiring;
  e.cancelled=true;
  const opening=e.opening;
  if(e.watch)void bounded(Promise.resolve().then(()=>e.watch.cancel()).catch(()=>{}),closeBoundMs);
  e.retiring=(async()=>{
   const w=e.watch??await opening?.catch(()=>null);
   if(!w){if(entries.get(id)===e)entries.delete(id);return;}
   for(let attempt=0;attempt<=maxRetries;attempt++){
    const closed=await Promise.race([Promise.resolve().then(()=>w.close()).then(()=>true,()=>false),new Promise(resolve=>{const t=setTimeout(()=>resolve(false),closeBoundMs);t.unref?.();})]);
    if(closed){if(entries.get(id)===e)entries.delete(id);return;}
    await new Promise(resolve=>{const t=setTimeout(resolve,retryMs);t.unref?.();});
   }
  })();
  e.retiring.catch(()=>{});
  return e.retiring;
 };
 /** Returns once the wallet is closed or after RELEASE_BOUND_MS, whichever comes first; the retirement itself continues in the background. */
 const release=async keys=>{const id=idOf(keys),e=own(keys);if(!e)return;await bounded(retire(id,e),RELEASE_BOUND_MS);};
 const closeAll=async()=>{disposed=true;await Promise.all([...entries].filter(([,e])=>e.owner===me).map(([id,e])=>bounded(retire(id,e),RELEASE_BOUND_MS)));};
 return Object.freeze({scan,cancel,release,closeAll,size:()=>[...entries.values()].filter(e=>e.owner===me).length,retiring:()=>[...entries.values()].filter(e=>e.owner===me&&e.retiring).length});
}
/**
 * Single-flight, generation-bound holder for the lazily created pool. get() re-checks `isLive` and the generation after every await, so a
 * wallet lock or unmount that happens during the asynchronous load can never leave a new pool installed or a scan started.
 * @param {{load:(context:{registry:Map<string,any>})=>Promise<ReturnType<typeof createWatchPool>>}} deps
 */
export function createPoolHolder({load}){
 let pool=null,init=null,generation=0;
 const registry=new Map();   // reservations survive generations until each wallet is known to be closed
 const get=async(isLive=()=>true)=>{
  const gen=generation,live=()=>gen===generation&&isLive();
  if(!live())throw Error('The swap check is held.');
  if(!pool&&!init){
   const mine=(async()=>{
    const created=await load({registry});
    if(gen!==generation){void created.closeAll().catch(()=>{});throw Error('The swap check is held.');}
    pool=created;return created;
   })();
   init=mine;
   const clear=()=>{if(init===mine)init=null;};mine.then(clear,clear);
  }
  const ready=pool??await init;
  if(!live()){throw Error('The swap check is held.');}
  return ready;
 };
 /** Invalidates the holder synchronously (a later get() starts a new generation) and closes the pool in the background. */
 const dispose=()=>{generation++;const old=pool;pool=null;init=null;return old?old.closeAll().catch(()=>{}):Promise.resolve();};
 return Object.freeze({get,dispose,current:()=>pool});
}
