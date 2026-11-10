// F1: one view-only watch wallet per swap, single flight, cancel keeps the wallet, release closes it.
import test from 'node:test';import assert from 'node:assert/strict';
import {createWatchPool,createPoolHolder,RELEASE_BOUND_MS as BOUND} from '../lib/silo/xmr-watch-pool.mjs';
const keys={primaryAddress:'4'.repeat(95),privateViewKey:'a'.repeat(64),restoreHeight:10};
function fake(){
 const log={opened:0,statuses:0,cancels:0,closed:0,release:null};
 const open=async()=>{log.opened++;await new Promise(r=>setImmediate(r));
  return {status:()=>{log.statuses++;return new Promise((resolve,reject)=>{log.release={resolve,reject};});},cancel:async()=>{log.cancels++;log.release?.reject(Error('sync stopped'));},close:async()=>{log.closed++;}};};
 return {log,pool:createWatchPool({open})};
}
test('no second wallet is opened while one is syncing: concurrent scans share one wallet and one sync',async()=>{
 const {log,pool}=fake();
 const a=pool.scan(keys),b=pool.scan(keys),c=pool.scan({...keys});
 assert.equal(a,b);assert.equal(b,c);
 await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
 log.release.resolve({atomic:'5',confirmations:3});
 assert.deepEqual(await a,{atomic:'5',confirmations:3});assert.equal(log.opened,1);assert.equal(log.statuses,1);
});
test('the wallet is kept between passes (incremental sync): the second pass opens nothing and syncs the same wallet',async()=>{
 const {log,pool}=fake();
 let p=pool.scan(keys);await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));log.release.resolve({atomic:'0',confirmations:0});await p;
 p=pool.scan(keys);await new Promise(r=>setImmediate(r));log.release.resolve({atomic:'9',confirmations:1});await p;
 assert.equal(log.opened,1);assert.equal(log.statuses,2);assert.equal(pool.size(),1);
});
test('cancel stops the running sync, keeps the wallet, and the next pass reuses it',async()=>{
 const {log,pool}=fake();
 const p=pool.scan(keys);await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
 await pool.cancel(keys);await assert.rejects(p,/sync stopped/);assert.equal(log.cancels,1);assert.equal(log.closed,0);
 const q=pool.scan(keys);await new Promise(r=>setImmediate(r));log.release.resolve({atomic:'1',confirmations:1});await q;
 assert.equal(log.opened,1,'the same wallet continues');
});
test('release cancels and closes the wallet; closeAll closes every swap',async()=>{
 const {log,pool}=fake();
 const p=pool.scan(keys);p.catch(()=>{});await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
 await pool.release(keys);assert.equal(log.closed,1);assert.equal(pool.size(),0);
 const q=pool.scan(keys);q.catch(()=>{});await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
 await pool.closeAll();assert.equal(log.closed,2);assert.equal(pool.size(),0);
});
test('release returns within its bound when status never settles and cancel is a no-op',async()=>{
 const {RELEASE_BOUND_MS}=await import('../lib/silo/xmr-watch-pool.mjs');
 const pool=createWatchPool({open:async()=>({status:()=>new Promise(()=>{}),cancel:async()=>{},close:()=>new Promise(()=>{})})});
 const p=pool.scan(keys);p.catch(()=>{});await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
 const began=Date.now();await pool.release(keys);const took=Date.now()-began;
 assert.ok(took<RELEASE_BOUND_MS+500,'release took '+took+' ms');assert.equal(pool.retiring(),1,'a close that never answers keeps the entry, so no second wallet can open');
 await assert.rejects(pool.scan(keys),/closing/);
});

// ---- Astra F1-M1: independently pending open / status / cancel / close ----
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(r=>setImmediate(r));
function controlled(){
 const c={opens:[],closes:[],statuses:[],cancels:[]};
 const open=async()=>{const o=deferred();c.opens.push(o);await o.promise;
  const w={status:()=>{const d=deferred();c.statuses.push(d);return d.promise;},cancel:()=>{const d=deferred();c.cancels.push(d);return d.promise;},close:()=>{const d=deferred();c.closes.push(d);return d.promise;}};return w;};
 return {c,pool:createWatchPool({open})};
}
test('release/rescan race: while the old wallet is retiring a scan is rejected and no second wallet opens; after the close it may open a new one',async()=>{
 const {c,pool}=controlled();
 const p=pool.scan(keys);p.catch(()=>{});await tick();c.opens[0].resolve();await tick();await tick();
 const released=pool.release(keys);await tick();
 assert.equal(pool.retiring(),1);
 await assert.rejects(pool.scan(keys),/closing/);assert.equal(c.opens.length,1,'no second open during retirement');
 c.cancels[0].resolve();await tick();c.closes[0].resolve();await released;await tick();
 assert.equal(pool.size(),0);
 const q=pool.scan(keys);q.catch(()=>{});await tick();assert.equal(c.opens.length,2,'a new wallet only after the old one is closed');
});
test('release while the wallet is still opening: the new wallet is closed, never left running',async()=>{
 const {c,pool}=controlled();
 const p=pool.scan(keys);p.catch(()=>{});await tick();
 const released=pool.release(keys);await tick();c.opens[0].resolve();await tick();await tick();
 assert.equal(c.closes.length,1);c.closes[0].resolve();await released;assert.equal(pool.size(),0);
 await assert.rejects(p,/cancelled/);assert.equal(c.statuses.length,0,'no sync was started on a retiring wallet');
});
test('closeAll runs every close in parallel with its own bound: one stuck close does not hold the others',async()=>{
 const {c,pool}=controlled();
 const k2={...keys,primaryAddress:'8'.repeat(95)};
 const a=pool.scan(keys),b=pool.scan(k2);a.catch(()=>{});b.catch(()=>{});await tick();c.opens[0].resolve();c.opens[1].resolve();await tick();await tick();
 const began=Date.now();const done=pool.closeAll();await tick();await tick();
 c.cancels.forEach(d=>d.resolve());await tick();await tick();
 assert.equal(c.closes.length,2,'both closes started without waiting for each other');
 c.closes[1].resolve();await done;assert.ok(Date.now()-began<BOUND+500);
 await assert.rejects(pool.scan(keys),/closed|closing/);assert.equal(c.opens.length,2,'a disposed pool opens nothing');
});
test('holder: two first calls share one load (single flight)',async()=>{
 const loads=[];const mk=()=>createWatchPool({open:async()=>({status:async()=>null,cancel:async()=>{},close:async()=>{}})});
 const h=createPoolHolder({load:()=>{const d=deferred();loads.push(d);return d.promise;}});
 const a=h.get(),b=h.get();await tick();assert.equal(loads.length,1);const pool=mk();loads[0].resolve(pool);
 assert.equal(await a,pool);assert.equal(await b,pool);assert.equal(h.current(),pool);
});
test('holder: dispose (lock or unmount) during the load installs nothing, closes the new pool and rejects the waiting scans',async()=>{
 const d=deferred();const closed=[];
 const h=createPoolHolder({load:()=>d.promise});
 const a=h.get();a.catch(()=>{});await tick();void h.dispose();
 d.resolve({closeAll:async()=>{closed.push(1);}});
 await assert.rejects(a,/held/);assert.equal(h.current(),null);assert.equal(closed.length,1);
});
test('holder: wallet no longer current after the load rejects the scan',async()=>{
 const d=deferred();let live=true;const h=createPoolHolder({load:()=>d.promise});
 const a=h.get(()=>live);a.catch(()=>{});await tick();live=false;d.resolve(createWatchPool({open:async()=>null}));
 await assert.rejects(a,/held/);
});

// ---- Astra round 3, residual F1-M1: a close rejection is not a shutdown; reservations cross generations; close is independent of cancel ----
test('a close that rejects keeps the reservation: a replacement scan is rejected and no second wallet opens; a later successful retry frees it',async()=>{
 const c={opens:0,closes:[]};
 const pool=createWatchPool({retryMs:5,closeBoundMs:200,maxRetries:50,open:async()=>{c.opens++;return {status:()=>new Promise(()=>{}),cancel:async()=>{},close:()=>{const d=deferred();c.closes.push(d);return d.promise;}};}});
 const p=pool.scan(keys);p.catch(()=>{});await tick();await tick();
 const rel=pool.release(keys);await tick();assert.equal(c.closes.length,1);c.closes[0].reject(Error('close failed'));await new Promise(r=>setTimeout(r,2));void rel;
 await assert.rejects(pool.scan(keys),/closing/);assert.equal(c.opens,1,'a rejection does not prove shutdown');assert.equal(pool.retiring(),1);
 await new Promise(r=>setTimeout(r,30));assert.ok(c.closes.length>=2,'the close is retried in the background');
 c.closes[c.closes.length-1].resolve();await new Promise(r=>setTimeout(r,20));assert.equal(pool.size(),0,'freed only once a close succeeded');
 const q=pool.scan(keys);q.catch(()=>{});await tick();assert.equal(c.opens,2);
});
test('a close that keeps failing is retried a bounded number of times and the reservation then stays (fail closed)',async()=>{
 let closes=0,opens=0;
 const pool=createWatchPool({retryMs:2,closeBoundMs:20,maxRetries:2,open:async()=>{opens++;return {status:()=>new Promise(()=>{}),cancel:async()=>{},close:async()=>{closes++;throw Error('no');}};}});
 const p=pool.scan(keys);p.catch(()=>{});await tick();await tick();await pool.release(keys);await new Promise(r=>setTimeout(r,60));
 assert.equal(closes,3);await assert.rejects(pool.scan(keys),/closing/);assert.equal(opens,1);assert.equal(pool.retiring(),1);
});
test('a hung cancel does not stop the close from starting',async()=>{
 const c={cancels:0,closes:0};
 const pool=createWatchPool({open:async()=>({status:()=>new Promise(()=>{}),cancel:()=>{c.cancels++;return new Promise(()=>{});},close:async()=>{c.closes++;}})});
 const p=pool.scan(keys);p.catch(()=>{});await tick();await tick();
 await pool.release(keys);assert.equal(c.cancels,1);assert.equal(c.closes,1);assert.equal(pool.size(),0);
});
test('a new holder generation inherits the reservations of an old pool that is still retiring',async()=>{
 const opens=[],closes=[];
 const mk=({registry})=>createWatchPool({registry,retryMs:5,closeBoundMs:50,open:async()=>{opens.push(1);return {status:()=>new Promise(()=>{}),cancel:async()=>{},close:()=>{const d=deferred();closes.push(d);return d.promise;}};}});
 const h=createPoolHolder({load:async ctx=>mk(ctx)});
 const p1=await h.get();const s1=p1.scan(keys);s1.catch(()=>{});await tick();await tick();
 void h.dispose();await tick();await tick();assert.equal(closes.length,1);
 const p2=await h.get();assert.notEqual(p2,p1);
 await assert.rejects(p2.scan(keys),/closing/);assert.equal(opens.length,1,'the new generation does not open a second wallet for the address');
 closes[0].resolve();await new Promise(r=>setTimeout(r,20));
 const s2=p2.scan(keys);s2.catch(()=>{});await tick();await tick();assert.equal(opens.length,2,'after the old wallet closed, the address is free');
});

// ---- Astra closure5: cleanup ownership. A stale generation finishing late must never touch another generation's live wallet ----
test('stale generation A completes after B opened a wallet in the shared registry: B stays usable, gets no cancel and no close',async()=>{
 const log={opens:0,cancels:0,closes:0,statuses:[]};
 const mk=ctx=>createWatchPool({...ctx,open:async()=>{log.opens++;return {status:()=>{const d=deferred();log.statuses.push(d);return d.promise;},cancel:async()=>{log.cancels++;},close:async()=>{log.closes++;}};}});
 const loads=[];
 const h=createPoolHolder({load:ctx=>{const d=deferred();loads.push({d,ctx});return d.promise;}});
 const a=h.get();a.catch(()=>{});await tick();                 // generation A is loading
 void h.dispose();                                                // A is invalidated
 const b=h.get();await tick();                                    // generation B starts its own load
 assert.equal(loads.length,2);
 loads[1].d.resolve(mk(loads[1].ctx));const poolB=await b;        // B is ready (out of order: B before A)
 const scanB=poolB.scan(keys);await tick();await tick();assert.equal(log.opens,1);
 loads[0].d.resolve(mk(loads[0].ctx));await assert.rejects(a,/held/);await tick();await tick();  // A resolves late and runs its stale cleanup
 assert.equal(log.cancels,0,'B got no cancel');assert.equal(log.closes,0,'B got no close');assert.equal(poolB.size(),1);
 log.statuses[0].resolve({atomic:'7',confirmations:2});assert.deepEqual(await scanB,{atomic:'7',confirmations:2});
 assert.equal(h.current(),poolB);
});
test('a pool does not scan, cancel or release an address whose live wallet belongs to another pool',async()=>{
 const reg=new Map();let opens=0,cancels=0,closes=0;
 const open=async()=>{opens++;return {status:()=>new Promise(()=>{}),cancel:async()=>{cancels++;},close:async()=>{closes++;}};};
 const p1=createWatchPool({registry:reg,open}),p2=createWatchPool({registry:reg,open});
 const s=p1.scan(keys);s.catch(()=>{});await tick();await tick();
 await assert.rejects(p2.scan(keys),/another/);await p2.cancel(keys);await p2.release(keys);await p2.closeAll();
 assert.equal(opens,1);assert.equal(cancels,0);assert.equal(closes,0);assert.equal(p1.size(),1);
});
