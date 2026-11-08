// SPDX-License-Identifier: AGPL-3.0-only
// Leave-and-return (product decision): the no-bridge swap panel publishes a summary of every swap in progress here, so
// Home and Activity can show a pending-swap card. Display only: nothing here moves money or holds a key, and nothing is stored.
// While Silo is locked the swap records stay encrypted, so the list is empty and no card shows (nothing readable while locked).
/** @typedef {{swapId:string,short:string,phase:string,xmr:string,sol:string,claimBy:number|null,sendBy:number|null}} SiloAtomicPending */
/** @type {readonly SiloAtomicPending[]} */
let snapshot=Object.freeze([]);
let key='[]';
const listeners=new Set();
/** @param {SiloAtomicPending[]} list */
export function publishAtomicPending(list){
 const next=JSON.stringify(Array.isArray(list)?list:[]);
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
