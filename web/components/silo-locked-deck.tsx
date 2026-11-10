'use client';
import {useId,useState,type FormEvent,type ReactNode} from 'react';
import {AlertTriangle,ArrowRight,Eye,EyeOff,LockKeyhole} from 'lucide-react';
import {SiloAssetIcon} from './silo-asset-icon';
import {siloLookStyle} from './silo-asset-card';
import {SILO_ASSET_LOOKS,SILO_FALLBACK_LOOK} from '@/lib/silo/asset-look.mjs';

/** r8 Locked screen, "one unlock for all" (owner, 6 Nov 2026). PRESENTATION ONLY: the unlock logic lives with the multichain session and
 * reaches this screen through the state contract below; this file never touches keys, storage or decryption.
 *
 * State contract (one row per wallet that exists in this browser):
 * - status 'locked' | 'opening' | 'open' | 'own-passphrase' | 'other-tab', always shown in words, never by colour alone.
 * - 'own-passphrase': that wallet did not open with the shared passphrase. Its row sends the person to that wallet's own area, where its
 *   own field is (onOpenWallet); this screen never opens one wallet by itself.
 * Rows (from useSiloSharedPassphrase via the multichain adapter): solana, evm (one key for Ethereum, Base and BNB: one row), xmr. Only
 * wallets that exist in this browser appear. Creating a wallet is the host's (onCreate, optional).
 * - wrong: true after a wrong passphrase; the screen shows SILO_UNLOCK_WRONG, which never says which wallet or part failed.
 * The passphrase lives only in this component's field state, is handed to the callback and cleared; it is never shown except in the field
 * itself (show/hide) and never stored. The deck at the top shows supported colours only, never what the person holds (r8 rule 1). */
export type SiloUnlockStatus='locked'|'opening'|'open'|'own-passphrase'|'other-tab';
export type SiloUnlockRow={id:'solana'|'evm'|'btc'|'xmr';asset:'sol'|'evm'|'btc'|'xmr';name:string;status:SiloUnlockStatus};
export type SiloUnlockState={rows:SiloUnlockRow[];busy:boolean;wrong:boolean};
/** The one line for a wrong passphrase. Fixed here so it can never name which wallet or part failed. */
export const SILO_UNLOCK_WRONG='Nothing was opened. Check the passphrase and try again.';
const statusWord=(row:SiloUnlockRow)=>row.status==='opening'?`Opening ${row.name}…`:row.status==='open'?'Open':row.status==='own-passphrase'?'Needs its own passphrase':row.status==='other-tab'?'Open in another tab':'Locked';
// The EVM row is one key for three chains, and the Bitcoin test-network row is not a brand-coloured asset yet, so both stand on the neutral fallback.
const lookOf=(row:SiloUnlockRow)=>row.asset==='evm'||row.asset==='btc'?SILO_FALLBACK_LOOK:SILO_ASSET_LOOKS[row.asset]??SILO_FALLBACK_LOOK;
const zoneOf=(row:SiloUnlockRow)=>row.asset==='xmr'?'Private · Monero':row.asset==='sol'?'Public · Solana':row.asset==='btc'?'Public · Bitcoin test network':'Public · Ethereum, Base and BNB';

function Secret({id,label,value,onChange,disabled,autoFocus=false}:{id:string;label:string;value:string;onChange:(next:string)=>void;disabled:boolean;autoFocus?:boolean}){
 const [shown,setShown]=useState(false);
 return <div className="silo-unlock-field"><label htmlFor={id}>{label}</label><div className="silo-unlock-input">
  <input id={id} type={shown?'text':'password'} value={value} onChange={event=>onChange(event.target.value)} disabled={disabled} autoComplete="current-password" autoCapitalize="off" autoCorrect="off" spellCheck={false} minLength={12} maxLength={256} required autoFocus={autoFocus}/>
  <button type="button" className="silo-unlock-eye" aria-label={shown?'Hide passphrase':'Show passphrase'} aria-pressed={shown} onClick={()=>setShown(!shown)} disabled={disabled}>{shown?<EyeOff size={20} aria-hidden="true"/>:<Eye size={20} aria-hidden="true"/>}</button>
 </div></div>;
}

export function SiloLockedDeck({state,onUnlock,onOpenWallet,onCreate,deviceAction}:{deviceAction?:ReactNode;state:SiloUnlockState;onUnlock:(passphrase:string)=>void;onOpenWallet:(id:SiloUnlockRow['id'])=>void;onCreate?:()=>void}){
 const id=useId(),[passphrase,setPassphrase]=useState('');
 const submit=(event:FormEvent)=>{event.preventDefault();if(state.busy||passphrase.length<12)return;const value=passphrase;setPassphrase('');onUnlock(value);};
 const many=state.rows.length>1;
 return <section className="silo-locked" aria-labelledby={`${id}-title`}>
  <div className="silo-locked-deck" aria-hidden="true"><i style={siloLookStyle(SILO_ASSET_LOOKS.sol)}/><i style={siloLookStyle(SILO_ASSET_LOOKS.usdc)}/><i style={siloLookStyle(SILO_ASSET_LOOKS.xmr)}/><b><LockKeyhole size={16}/>Locked</b></div>
  <h1 id={`${id}-title`}>unlock your silo<span className="silo-stop" aria-hidden="true">.</span></h1>
  <p className="silo-locked-lead">{many?'One passphrase opens every wallet on this device.':'Your passphrase opens this wallet on this device.'} Silo cannot reset it, and your email cannot open your wallet.</p>
  <form className="silo-locked-form" onSubmit={submit} noValidate>
   <Secret id={`${id}-pass`} label="Passphrase (12 to 256 characters)" value={passphrase} onChange={setPassphrase} disabled={state.busy}/>
   {state.wrong&&<p className="silo-locked-error" role="alert"><AlertTriangle size={18} aria-hidden="true"/>{SILO_UNLOCK_WRONG}</p>}
   <div className="silo-unlock-actions"><button type="submit" className="silo-locked-go" disabled={state.busy||passphrase.length<12}>{state.busy?'Unlocking…':'Unlock'}</button>{deviceAction}</div>
  </form>
  {state.rows.length>0&&<ul className="silo-locked-rows" aria-label="Wallets on this device">{state.rows.map(row=><li key={row.id} className="silo-locked-row" data-status={row.status} style={siloLookStyle(lookOf(row))}>
   <div className="silo-locked-row-head"><SiloAssetIcon asset={row.asset}/><span><strong>{row.name}</strong><small>{zoneOf(row)}</small></span><em aria-live="polite" data-state={row.status==='open'?'on':row.status==='opening'?'busy':undefined}>{row.status==='locked'&&<LockKeyhole size={12} aria-hidden="true"/>}{statusWord(row)}</em></div>
   {row.status==='own-passphrase'&&<button type="button" className="silo-locked-own" onClick={()=>onOpenWallet(row.id)}>Open {row.name} with its own passphrase<ArrowRight size={18} aria-hidden="true"/></button>}
  </li>)}</ul>}
  <p className="silo-locked-note">The passphrase is never shown or saved. It unlocks the encrypted copies kept in this browser.</p>
  {onCreate&&<button type="button" className="silo-locked-create" onClick={onCreate} disabled={state.busy}>Create or restore locally</button>}
 </section>;
}
