// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import {useEffect,useRef,useState} from 'react';
import {useSiloSharedPassphrase,type SiloOneUnlockZone} from './silo-shared-passphrase';
import {SiloDeviceUnlockButton} from './silo-device-unlock';
/** Minimal functional locked-screen field for ONE UNLOCK (the design session styles the real locked screen to this contract):
 * one passphrase field, one Unlock button, one status line per wallet that exists in this browser, written as text and not colour alone.
 * Statuses and the single message come from useSiloSharedPassphrase().unlock; the typed passphrase is held only in this field until it is
 * handed to the provider and then cleared from the field. */
const NAMES:Record<SiloOneUnlockZone,string>={solana:'Solana',evm:'Ethereum, Base and BNB',xmr:'Monero'};
const WORDS={locked:'Locked','opening':'Opening…',open:'Open','needs-own':'Needs its own passphrase','other-tab':'Open in another tab'} as const;
export function SiloOneUnlockField(){
 const shared=useSiloSharedPassphrase(),[typed,setTyped]=useState(''),[show,setShow]=useState(false),input=useRef<HTMLInputElement|null>(null);
 // A lock clears what was typed but not yet submitted: nothing typed before a lock survives it.
 useEffect(()=>{setTyped('');setShow(false);},[shared.lockGeneration]);
 if(!shared.active)return null;
 const zones=(Object.keys(NAMES) as SiloOneUnlockZone[]).filter(zone=>shared.unlock.statuses[zone]!==undefined);
 if(!zones.length)return null;
 const everyOpen=zones.every(zone=>shared.unlock.statuses[zone]==='open'),busy=zones.some(zone=>shared.unlock.statuses[zone]==='opening');
 function submit(){if(typed.length<12||busy)return;shared.unlock.submit(typed);setTyped('');}
 return <form className="silo-one-unlock" aria-label="Unlock your wallets" onSubmit={event=>{event.preventDefault();submit();}}>
  {!everyOpen&&<>
   <SiloDeviceUnlockButton/>
   <label htmlFor="silo-one-unlock-input" style={{display:'block'}}>Passphrase (12 to 256 characters)</label>
   <div style={{display:'flex',gap:8,alignItems:'center'}}>
    <input id="silo-one-unlock-input" ref={input} type={show?'text':'password'} autoComplete="current-password" spellCheck={false} value={typed} disabled={busy} onChange={event=>setTyped(event.target.value)} style={{minHeight:44,fontSize:16,flex:1,minWidth:0}}/>
    <button type="button" style={{minHeight:44,minWidth:44}} aria-pressed={show} onClick={()=>setShow(value=>!value)}>{show?'Hide':'Show'}</button>
   </div>
   <p className="exposure-note">One passphrase opens every wallet that uses it. Silo cannot reset it.</p>
   <button type="submit" className="silo-primary" style={{minHeight:44}} disabled={typed.length<12||busy}>{busy?'Unlocking…':'Unlock'}</button>
  </>}
  <ul aria-label="Wallet status" style={{listStyle:'none',padding:0,margin:'16px 0 0'}}>{zones.map(zone=><li key={zone} data-zone={zone} data-status={shared.unlock.statuses[zone]}><strong>{NAMES[zone]}</strong>: {WORDS[shared.unlock.statuses[zone] as keyof typeof WORDS]}</li>)}</ul>
  {zones.some(zone=>shared.unlock.statuses[zone]==='needs-own')&&<p className="exposure-note">A wallet that needs its own passphrase either uses a different one, or its local copy is damaged. If its own passphrase does not open it either, restore it from your backup file.</p>}
  {shared.unlock.message&&<p role="alert" className="exposure-error">{shared.unlock.message}</p>}
 </form>;
}
