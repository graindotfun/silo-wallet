'use client';
import {createContext,useCallback,useContext,useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {createOneUnlock,type OneUnlockStatus} from '@/lib/silo/one-unlock.mjs';

/** One passphrase for both Silo wallets, as UX only. The string lives in this provider's memory (a ref), never in storage,
 * a URL, a log or a network request. Each wallet still seals its own envelope with it; no cryptography or file format
 * changes. It is cleared when either wallet locks and when the provider unmounts; an idle lock reloads the page, which
 * discards memory altogether. A new share (a different passphrase, or the same one typed again) advances `version`, so a
 * wallet tries the shared value at most once per version and never loops. */
export type SiloSharedPassphrase={
 /** Present only inside a provider; a wallet rendered alone behaves exactly as before. */
 active:boolean;
 /** The shared passphrase, or '' when none. Read at the moment of use, not kept in React state. */
 get():string;
 /** The passphrase that JUST OPENED a wallet in this lock generation, or ''. It is set only after a wallet opened with it (a silent open that was accepted and published, or a passphrase typed into a wallet's own field that opened it); typing into the central field alone never sets it. Cleared on every lock. Device unlock may wrap only this value. */
 provenPassphrase():string;
 /** Advances on every share and every clear; never repeats. */
 version:number;
 /** `atGeneration`: the lock generation the caller started in; a share from before a lock is refused, so a late completion can never bring the passphrase back. */
 share(value:string,atGeneration?:number):void;
 /** Locks everything: every registered wallet disposes its session and cancels its own pending operations (except `origin`, which is already locking itself), the passphrase and statuses are cleared and the lock generation advances. */
 clear(origin?:SiloOneUnlockZone):void;
 /** Advances on every lock. Read when an operation starts and compare before publishing a session or sharing a passphrase. */
 generation():number;
 /** Same value as a React state, for screens that must reset unsubmitted text on a lock. */
 lockGeneration:number;
 /** One unlock for every wallet (lib/silo/one-unlock.mjs): the state contract the locked screen renders and the wallets report to. */
 unlock:SiloOneUnlock;
};
export type SiloOneUnlockZone='solana'|'evm'|'btc'|'xmr';
export type SiloOneUnlockOutcome='open'|'wrong'|'in-use'|'error';
export type SiloOneUnlock={
 /** Per wallet that exists in this browser: locked, opening, open, needs-own (its own passphrase differs), other-tab. */
 statuses:Partial<Record<SiloOneUnlockZone,OneUnlockStatus>>;
 /** One sentence for the whole screen; never names a wallet. '' when there is nothing to say. */
 message:string;
 /** The person typed the one passphrase (12+ characters). Wallets that are already open are left alone. */
 submit(value:string):boolean;
 setPresent(zone:SiloOneUnlockZone,here:boolean):void;
 setOpen(zone:SiloOneUnlockZone):void;
 /** A wallet asks whether it may make its silent attempt now (Monero only after Solana and EVM settled; never twice per typed passphrase). */
 canOpen(zone:SiloOneUnlockZone):boolean;
 started(zone:SiloOneUnlockZone):boolean;
 /** The wallet's attempt ended. false means a lock or a newer passphrase came first: the wallet must lock what it opened. */
 report(zone:SiloOneUnlockZone,outcome:SiloOneUnlockOutcome):boolean;
 /** Ends an attempt that never reported (an early return, a refused storage permission): if it is still opening it becomes locked, so nothing stays stuck. */
 settle(zone:SiloOneUnlockZone):void;
 /** A wallet registers how to dispose its own session and cancel its own pending operations when ANY wallet locks. Returns the unregister function. */
 registerDispose(zone:SiloOneUnlockZone,dispose:()=>void):()=>void;
 lockAll():void;
};
const inertUnlock:SiloOneUnlock={statuses:{},message:'',submit:()=>false,setPresent:()=>{},setOpen:()=>{},canOpen:()=>true,started:()=>true,report:()=>true,settle:()=>{},registerDispose:()=>()=>{},lockAll:()=>{}};
const inactive:SiloSharedPassphrase={active:false,get:()=>'',provenPassphrase:()=>'',version:0,share:()=>{},clear:()=>{},generation:()=>0,lockGeneration:0,unlock:inertUnlock};
const Context=createContext<SiloSharedPassphrase>(inactive);
export const useSiloSharedPassphrase=()=>useContext(Context);

export function SiloSharedPassphraseProvider({children}:{children:ReactNode}){
 const held=useRef(''),[version,setVersion]=useState(0),[tick,setTick]=useState(0),[lockGeneration,setLockGeneration]=useState(0),started=useRef(new Map<SiloOneUnlockZone,number>());
 const proven=useRef(''),pendingProven=useRef(new Map<SiloOneUnlockZone,string>());
 const generation=useRef(0),locking=useRef(false),disposers=useRef(new Map<SiloOneUnlockZone,Set<()=>void>>());
 const controller=useRef<ReturnType<typeof createOneUnlock>|null>(null);
 if(!controller.current)controller.current=createOneUnlock({onChange:()=>setTick(t=>t+1)});
 const one=controller.current;
 // `share` is called by a wallet right AFTER a passphrase typed into its own field opened it, so it also records that passphrase as proven; typing into the central field goes through `submit`, which does not.
 const shareValue=useCallback((value:string,atGeneration:number|undefined,isProven:boolean)=>{if(atGeneration!==undefined&&atGeneration!==generation.current)return;if(value.length>=12){held.current=value;if(isProven)proven.current=value;one.submit(value);setVersion(v=>v+1);}},[one]);
 const share=useCallback((value:string,atGeneration?:number)=>shareValue(value,atGeneration,true),[shareValue]);
 const provenPassphrase=useCallback(()=>proven.current,[]);
 /** A lock is authority removal: it advances the generation FIRST (so every in-flight attempt is already stale), tells every other wallet to dispose its session and
  * cancel its own operations, then clears the passphrase and the statuses. Re-entrant calls (a disposed wallet calling clear on its way out) do nothing more. */
 const clear=useCallback((origin?:SiloOneUnlockZone)=>{
  if(locking.current)return;locking.current=true;
  try{
   generation.current++;setLockGeneration(generation.current);
   held.current='';proven.current='';pendingProven.current.clear();started.current.clear();
   for(const [zone,set] of disposers.current)if(zone!==origin)for(const dispose of [...set]){try{dispose();}catch{/* a wallet that fails to dispose must not stop the others */}}
   one.lockAll();setVersion(v=>v+1);
  }finally{locking.current=false;}
 },[one]);
 const get=useCallback(()=>held.current,[]);
 const registerDispose=useCallback((zone:SiloOneUnlockZone,dispose:()=>void)=>{let set=disposers.current.get(zone);if(!set){set=new Set();disposers.current.set(zone,set);}set.add(dispose);return()=>{set!.delete(dispose);};},[]);
 const generationNow=useCallback(()=>generation.current,[]);
 // Disposal of the provider ends its lifetime like a lock: the generation advances (so every pending ceremony or storage commit that checks it is stale), the proven passphrase and every pending token are forgotten.
 useEffect(()=>()=>{generation.current++;held.current='';proven.current='';pendingProven.current.clear();started.current.clear();one.lockAll();},[one]);
 const unlock=useMemo<SiloOneUnlock>(()=>({
  statuses:one.statuses() as SiloOneUnlock['statuses'],message:one.message(),
  submit(value){if(value.length<12)return false;shareValue(value,undefined,false);return true;},
  setPresent:(zone,here)=>one.setPresent(zone,here),setOpen:zone=>{one.setOpen(zone);const used=pendingProven.current.get(zone);if(used!==undefined){pendingProven.current.delete(zone);proven.current=used;}},
  canOpen:zone=>one.canOpen(zone,one.version()),
  started(zone){const v=one.version();if(!one.started(zone,v))return false;started.current.set(zone,v);return true;},
  report(zone,outcome){const v=started.current.get(zone)??-1;started.current.delete(zone);const accepted=one.report(zone,outcome,v).accept;if(accepted&&outcome==='open')pendingProven.current.set(zone,held.current);return accepted;},
  settle(zone){const v=started.current.get(zone);if(v===undefined)return;started.current.delete(zone);one.report(zone,'error',v);},
  registerDispose,
  lockAll:clear,
 // eslint-disable-next-line react-hooks/exhaustive-deps -- `tick` re-reads the controller's statuses and message on every change
 }),[one,shareValue,clear,registerDispose,tick]);
 const value=useMemo(()=>({active:true,get,provenPassphrase,version,share,clear,generation:generationNow,lockGeneration,unlock}),[get,provenPassphrase,version,share,clear,generationNow,lockGeneration,unlock]);
 return <Context.Provider value={value}>{children}</Context.Provider>;
}
