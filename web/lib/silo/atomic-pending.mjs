// Leave-and-return (owner decision, 5 Nov 2026): the no-bridge swap panel publishes a summary of every swap in progress here, so
// Home and Activity can show a pending-swap card. Display only: nothing here moves money or holds a key, and nothing is stored.
// While Silo is locked the swap records stay encrypted, so the list is empty and no card shows (nothing readable while locked).
/** @typedef {{swapId:string,short:string,phase:string,xmr:string,sol:string,claimBy:number|null,sendBy:number|null,dir?:'sol-xmr',stage?:string,claimed?:boolean,returnBy?:number|null,confirmBy?:number|null,confirmations?:number|null,confirmTarget?:number,waitTitle?:string}} SiloAtomicPending */
/** @type {readonly SiloAtomicPending[]} */
let snapshot=Object.freeze([]);
let key='[]';
const listeners=new Set();
// One list per direction (each panel publishes only its own; the card shows both). Default source keeps the XMR -> SOL call unchanged.
/** @type {Map<string,string>} */
const sources=new Map();
/** @param {SiloAtomicPending[]} list @param {string} [source] */
export function publishAtomicPending(list,source='xmr-sol'){
 const own=JSON.stringify(Array.isArray(list)?list:[]);
 if((sources.get(source)??'[]')===own)return;
 if(own==='[]')sources.delete(source);else sources.set(source,own);
 const merged=[...sources.keys()].sort().flatMap(name=>JSON.parse(sources.get(name)));
 const next=JSON.stringify(merged);
 if(next===key)return;
 key=next;snapshot=Object.freeze(JSON.parse(next).map(item=>Object.freeze(item)));
 for(const listener of listeners)listener();
}
/** @param {()=>void} listener */
export function subscribeAtomicPending(listener){listeners.add(listener);return()=>{listeners.delete(listener);};}
export const atomicPendingSnapshot=()=>snapshot;
/** @type {readonly SiloAtomicPending[]} */
const EMPTY=Object.freeze([]);
export const atomicPendingServerSnapshot=()=>EMPTY;

// Which direction a tap on a pending card asks for. A signal, not state: every tap fires, so a manual direction switch never leaves the
// user on the wrong screen (Astra 704-L1). Display only.
/** @type {Set<(dir:'xmr-sol'|'sol-xmr')=>void>} */
const directionListeners=new Set();
/** @param {'xmr-sol'|'sol-xmr'} dir */
export function requestAtomicDirection(dir){const next=dir==='sol-xmr'?'sol-xmr':'xmr-sol';for(const listener of directionListeners)listener(next);}
/** @param {(dir:'xmr-sol'|'sol-xmr')=>void} listener */
export function subscribeAtomicDirectionRequest(listener){directionListeners.add(listener);return()=>{directionListeners.delete(listener);};}
