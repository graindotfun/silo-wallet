'use client';
import {SiloMoneyAnimation} from './silo-money-animation';
import {useCallback,useEffect,useRef,useState} from 'react';
import {ShieldAlert,PauseCircle} from 'lucide-react';
import {SiloGateHero} from './silo-gate-hero';
import {SILO_AUTO_READS_NOTICE} from '@/lib/silo/auto-reads.mjs';
import {SILO_BETA_TERMS} from '@/lib/silo/beta-terms.mjs';
import {initialBetaLiveState,betaLiveAnswered,betaLiveFailed,betaLiveTick,SILO_BETA_POLL_INTERVAL_MS,SILO_BETA_FETCH_TIMEOUT_MS} from '@/lib/silo/beta-live-state.mjs';
/** The beta guards (invite-only or open) as the browser sees them: no hashes, no secret (lib/silo/beta-guard.mjs, siloBetaPublic). The live
 * copy carries when it was observed and until when it is good for; every payment boundary checks that against the clock
 * (lib/silo/beta-live-state.mjs, siloBetaFreshness). */
export type SiloBeta={closed:boolean;open?:boolean;paused:boolean;caps:{sol:string;xmr:string;solLamports:string;xmrAtomic:string};auditDeferred:boolean;notice:string;stale?:boolean;observedAt?:number;validUntil?:number};
export type SiloBetaLive={beta:SiloBeta|null;invited:boolean|null;checkedAt:number|null;refresh:()=>Promise<void>};

/** Polls the server every minute so a flipped kill switch reaches open pages without a reload. Each request has a timeout; an
 * answer that arrives after a newer one is dropped; the last good status expires on its own clock whether a later poll
 * answered, failed or hung; a page coming back from the background re-reads at once. */
export function useSiloBetaLive(initial:SiloBeta|undefined,intervalMs=SILO_BETA_POLL_INTERVAL_MS,fetchTimeoutMs=SILO_BETA_FETCH_TIMEOUT_MS):SiloBetaLive{
 const [state,setState]=useState(()=>initialBetaLiveState({beta:initial,intervalMs}));
 const sequence=useRef(0),stopped=useRef(false);
 const read=useCallback(async()=>{
  const mine=++sequence.current;
  try{const response=await fetch('/api/silo/invite',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(fetchTimeoutMs)});if(!response.ok)throw Error();const body=await response.json() as SiloBeta&{invited?:boolean};
   if(!stopped.current)setState(previous=>betaLiveAnswered(previous,{sequence:mine,body}));}
  catch{if(!stopped.current)setState(previous=>betaLiveFailed(previous,{sequence:mine}));}
 },[fetchTimeoutMs]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- the poll's result and the passing of time are this state by definition
 useEffect(()=>{if(!initial)return;stopped.current=false;void read();
  const poll=setInterval(()=>{void read();},intervalMs);
  // The clock runs between polls too: a hung request cannot keep an old permissive status alive past its window.
  const tick=setInterval(()=>{setState(previous=>betaLiveTick(previous));},Math.max(1000,Math.min(intervalMs,15000)));
  const resumed=()=>{if(!document.hidden){setState(previous=>betaLiveTick(previous));void read();}};document.addEventListener('visibilitychange',resumed);
  return()=>{stopped.current=true;clearInterval(poll);clearInterval(tick);document.removeEventListener('visibilitychange',resumed);};
 },[initial,intervalMs,read]);
 return {beta:state.beta,invited:state.invited,checkedAt:state.checkedAt,refresh:read};
}

/** The standing notice (always, paused or not), the limits, and the pause state. Rendered at the top of the wallet. */
export function SiloBetaBanner({beta}:{beta:SiloBeta|null}){
 if(!beta)return null;
 const audit=beta.auditDeferred?' The independent audit was deferred by the owner; it has not been passed.':'';
 return <div className={`silo-beta-banner${beta.paused?' silo-beta-banner-paused':''}`} role={beta.paused?'alert':'note'} aria-label="Beta notice">
  {beta.paused?<><PauseCircle size={18} aria-hidden="true"/><strong>Paused.</strong> New payments and trades are stopped by the operator. Your funds, your receive addresses and your backups stay available. Beta, not externally audited.{audit}</>
  :<><ShieldAlert size={18} aria-hidden="true"/><strong>Beta, not externally audited.</strong> Use small amounts: up to {beta.caps.sol} SOL and {beta.caps.xmr} XMR per wallet action.{audit}</>}
  {beta.stale&&<span className="silo-beta-stale" role="status"> The beta status could not be refreshed in time; new payments wait for a fresh status.</span>}
 </div>;
}

/** Closed beta: the wallet opens for invitees only. The code is sent once; the server keeps a proof cookie, never the code.
 * A local acceptance lasts only until the next live status says this browser is not invited (review N4). */
export function SiloBetaGate({invited,open=false,checkedAt=null,onAccepted,children}:{invited:boolean|null;open?:boolean;checkedAt?:number|null;onAccepted?:()=>Promise<void>|void;children:React.ReactNode}){
 const [code,setCode]=useState(''),[terms,setTerms]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[acceptedAt,setAcceptedAt]=useState<number|null>(null);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- a later poll that denies this browser closes the gate again
 useEffect(()=>{if(acceptedAt!==null&&invited===false&&checkedAt!==null&&checkedAt>acceptedAt)setAcceptedAt(null);},[invited,checkedAt,acceptedAt]);
 if(invited===true||acceptedAt!==null)return <>{acceptedAt!==null&&<SiloOpening/>}{children}</>;
 async function redeem(){setBusy(true);setError('');try{const response=await fetch('/api/silo/invite',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(open?{enter:true,terms:SILO_BETA_TERMS}:{code,terms:SILO_BETA_TERMS})});if(!response.ok){const refusal=await response.json().then(body=>(body as {refusal?:string}|null)?.refusal,()=>null);setError(refusal==='daily-cap'?'Today\'s places in the beta are taken. Please come back tomorrow.':response.status===429?'Too many attempts. Try again in a minute.':open?'Silo could not be opened. Try again.':'This invite code was not accepted.');return;}setAcceptedAt(Date.now());await onAccepted?.();}catch{setError('The invitation could not be checked. Try again.');}finally{setBusy(false);}}
 // The signup page's look: the field works from the first frame; the logo assembles around it in under a second.
 return <section className="silo-gate" aria-label="Beta invitation">
  <header className="silo-gate-top"><span>silo by grain</span><span>{open?'open beta':'closed beta'}</span></header>
  <SiloGateHero/>
  {/* Open beta (owner, 23 October 2026): one click enters; no code. The same entry proof is set either way. */}
  <form className="silo-gate-form" onSubmit={event=>{event.preventDefault();if(busy)return;if(!terms){setError('Please confirm you are 18 or older and accept the beta terms.');return;}if(!open&&code.trim().length<8){setError('Enter the code from your invitation.');return;}void redeem();}}>
   {!open&&<><label htmlFor="silo-invite-code">Your invite code</label>
   <input id="silo-invite-code" name="silo-invite-code" value={code} onChange={event=>setCode(event.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} disabled={busy}/></>}
   <label className="silo-gate-terms"><input type="checkbox" name="silo-beta-terms" checked={terms} onChange={event=>setTerms(event.target.checked)} disabled={busy}/><span>I am 18 or older and accept the <a href={`/${SILO_BETA_TERMS}`} target="_blank" rel="noopener">beta terms</a>.</span></label>
   <button type="submit" disabled={busy}>{busy?(open?'Opening…':'Checking…'):open?'Enter Silo':'Enter the beta'}</button>
   {error&&<p role="alert" className="silo-gate-error">{error}</p>}
   <p className="silo-gate-note">Beta, not externally audited. Use small amounts. <a href={`/${SILO_AUTO_READS_NOTICE}`}>Privacy notice</a></p>
  </form>
 </section>;
}
/** A festive moment right after the invitation is accepted, once per device: about a second, skipped by any tap or key,
 * never in front of a later screen. Reduced motion shows nothing. */
function SiloOpening(){
 const [show,setShow]=useState(()=>{try{return localStorage.getItem('grain-silo-opening-v1')===null;}catch{return false;}});
 useEffect(()=>{if(!show)return;try{localStorage.setItem('grain-silo-opening-v1','1');}catch{/* the moment simply plays again next time */}
  const done=()=>setShow(false),timer=setTimeout(done,4200);window.addEventListener('keydown',done,{once:true});return()=>{clearTimeout(timer);window.removeEventListener('keydown',done);};},[show]);
 if(!show)return null;
 return <SiloMoneyAnimation kind="entry" assets={['xmr','sol']} phase="pending" onDismiss={()=>setShow(false)}/>;
}
/** One line for every review screen. */
export function SiloBetaReviewLine({beta}:{beta:SiloBeta|null|undefined}){return beta?<p className="silo-beta-line" role="note">Beta, not externally audited. Small amounts only{beta.paused?' · paused':''}.</p>:null;}
/** The one BETA marker for wallet labels (replaces "(beta)" in brackets): a small outlined tag in the text's own colour, so it reads on any skin and on a selected tab. */
export function SiloBetaBadge(){return <span className="silo-beta-badge">Beta</span>;}
