'use client';
import {useSyncExternalStore} from 'react';
/** False while the page is server-rendered markup and during React's first client render; true once effects have run.
 * Wallet controls that change component state (consent, passphrases, create, unlock, import) stay disabled until then, so a
 * click on not-yet-hydrated markup cannot be lost: before this flips, the control refuses the click instead of ignoring it.
 * Zones expose it as `data-silo-ready="pending" | "true"` for people's tools and for the browser tests. */
export function useSiloHydrated():boolean{return useSyncExternalStore(()=>()=>{},()=>true,()=>false);}
export const siloReadyState=(hydrated:boolean)=>hydrated?'true':'pending';
