'use client';
import {useSyncExternalStore,type ReactNode} from 'react';
import {SILO_BALANCE_VISIBILITY_KEY,readSiloBalancesHidden,writeSiloBalancesHidden} from '@/lib/silo/balance-visibility.mjs';
const CHANGED='silo-balance-visibility-changed';
let fallback:boolean|null=null;
function snapshot(){if(fallback!==null)return 'temporary-hidden';try{return readSiloBalancesHidden(window.localStorage)?'hidden':'shown';}catch{return 'hidden';}}
function subscribe(changed:()=>void){const fromStorage=(event:StorageEvent)=>{if(event.key===SILO_BALANCE_VISIBILITY_KEY||event.key===null){fallback=null;changed();}};window.addEventListener('storage',fromStorage);window.addEventListener(CHANGED,changed);return()=>{window.removeEventListener('storage',fromStorage);window.removeEventListener(CHANGED,changed);};}
function setConcealed(hidden:boolean){try{writeSiloBalancesHidden(window.localStorage,hidden);fallback=null;}catch{fallback=true;window.dispatchEvent(new Event(CHANGED));throw Error('The display preference could not be saved or shared. Amounts are hidden in this tab; other tabs may still show amounts. Check browser storage before reloading.');}window.dispatchEvent(new Event(CHANGED));}
/** SSR conceals personal values until this browser's local preference has been read. */
export function useSiloBalanceVisibility(){const state=useSyncExternalStore(subscribe,snapshot,()=>'hidden');return {concealed:state!=='shown',persistenceFailed:state==='temporary-hidden',setConcealed};}
/** Hidden children are not rendered: no amount remains in text, tooltips or accessible names. */
export function SiloHiddenAmount({children}:{children:ReactNode}){const {concealed}=useSiloBalanceVisibility();return concealed?<span aria-label="Amount hidden">••••</span>:<>{children}</>;}
export function SiloReviewVisibilityNotice(){const {concealed}=useSiloBalanceVisibility();return concealed?<p className="exposure-note" role="note">Balances and history amounts are hidden. Entered amounts, transaction reviews and fees remain visible so you can approve exactly what you send.</p>:null;}
