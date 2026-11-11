'use client';
import {useEffect,useRef,useState} from 'react';
import {SiloSecretField} from './silo-secret-field';
import {bindSiloIdleLock} from '@/lib/silo/idle-lock.mjs';
import type {SiloProductAccount} from './silo-account-panel';
/** Uses the Settings-owned account instance. This opens no native wallet and
 * grants no signing or receive permission. Account and wallet secrets differ. */
export function SiloInlineAccountUnlock({controller,enabled,authenticated,vaultUnlocked,accountBusy=false,reviewedOrigin}:{controller:SiloProductAccount|null;enabled:boolean;authenticated:boolean;vaultUnlocked:boolean;accountBusy?:boolean;reviewedOrigin:string|null}){
 const [passphrase,setPassphrase]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[idleVersion,setIdleVersion]=useState(0);
 const root=useRef<HTMLElement|null>(null),typedInput=useRef(false),lockLatest=useRef<()=>void>(()=>{});
 const epoch=useRef(0),pending=useRef<{controller:SiloProductAccount;epoch:number}|null>(null),mounted=useRef(true);
 const invalidate=()=>{epoch.current++;const active=pending.current;pending.current=null;active?.controller.lock();typedInput.current=false;setPassphrase('');setBusy(false);setError('');setIdleVersion(value=>value+1);};
 useEffect(()=>{lockLatest.current=invalidate;});
 useEffect(()=>{mounted.current=true;const version=epoch;
  // Leaving the page no longer invalidates: the idle lock below (and unmount) end the session.
  return()=>{mounted.current=false;version.current++;const active=pending.current;pending.current=null;active?.controller.lock();};
 },[controller,enabled,authenticated,reviewedOrigin]);
 // Context changes also retire unsubmitted input. Effects must not depend on the
 // controller's own busy/unlocked notifications: that would cancel its success.
 useEffect(()=>{queueMicrotask(()=>{if(mounted.current){typedInput.current=false;setPassphrase('');setBusy(false);setError('');}});},[controller,enabled,authenticated,reviewedOrigin]);
 const needed=enabled&&authenticated&&!vaultUnlocked;
 useEffect(()=>bindSiloIdleLock({root:root.current,isActive:()=>typedInput.current||Boolean(pending.current),lock:()=>{if(mounted.current)lockLatest.current();}}),[controller,enabled,authenticated,vaultUnlocked,idleVersion]);
 async function unlock(){
  const active=controller;if(!needed||!active||busy||accountBusy||reviewedOrigin!=='https://review-retired.invalid'||location.origin!==reviewedOrigin||passphrase.length<12)return;
  const operation=++epoch.current,typed=passphrase;typedInput.current=false;setPassphrase('');setError('');setBusy(true);pending.current={controller:active,epoch:operation};
  try{await active.unlockVault({passphrase:typed});if(!mounted.current||epoch.current!==operation)return;}
  catch{if(mounted.current&&epoch.current===operation)setError('The account vault could not be opened. Check its passphrase or device approval. Your wallet was not opened or changed.');}
  finally{if(pending.current?.epoch===operation)pending.current=null;if(mounted.current&&epoch.current===operation)setBusy(false);}
 }
 if(!needed)return null;
 return <section ref={root} className="silo-inset" aria-labelledby="silo-inline-account-title"><h3 id="silo-inline-account-title">Unlock your account vault first</h3><p>Your account is signed in, but its encrypted vault is locked. Open it here, then unlock your Solana wallet separately. The two passphrases may differ.</p><form onSubmit={event=>{event.preventDefault();void unlock();}}><label>Account vault passphrase<SiloSecretField name="silo-inline-account-passphrase" autoComplete="current-password" value={passphrase} onChange={event=>{typedInput.current=Boolean(event.target.value);setPassphrase(event.target.value);}} disabled={busy||accountBusy}/></label><button type="submit" disabled={!controller||busy||accountBusy||passphrase.length<12}>{busy?'Opening account vault…':'Unlock account vault here'}</button></form><p className="exposure-note">The vault locks again after 10 minutes without activity. This step does not unlock a wallet, verify a backup, or approve receiving, signing or payments.</p>{error&&<p role="alert" className="exposure-error">{error}</p>}</section>;
}
