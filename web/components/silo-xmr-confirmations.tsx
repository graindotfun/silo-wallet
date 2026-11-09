'use client';
import {xmrConfirmationState,xmrEtaText,XMR_CONFIRMATION_TARGET} from '@/lib/silo/xmr-confirmations.mjs';

export type SiloXmrConfirmationsProps={confirmations:number|null;target?:number;direction:'in'|'out';txid?:string;minedHeight?:number|null;label?:string};

/** Confirmation window for a Monero transaction: n/10, a calm progress bar and an approximate wait (about 2 minutes a block).
 * Display only. "Ready" is shown only at the full confirmation count; anything unchecked stays unchecked. */
export function SiloXmrConfirmations({confirmations,target=XMR_CONFIRMATION_TARGET,direction,txid,minedHeight,label}:SiloXmrConfirmationsProps){
 const s=xmrConfirmationState({confirmations,target});
 const eta=xmrEtaText(s.etaMinutes);
 const noun=direction==='in'?'incoming Monero':'Monero payment';
 const headline=s.state==='ready'?(direction==='in'?'Ready to spend':'Payment confirmed'):s.state==='unchecked'?'Not checked yet':s.state==='waiting'?'Waiting for the first confirmation':`${s.confirmations}/${s.target} confirmations`;
 const detail=s.state==='ready'?(direction==='in'?'These funds are now spendable.':'The payment has all the confirmations it needs.'):s.state==='unchecked'?'Sync the wallet to see where this stands. A failed check does not mean the payment failed.':s.state==='waiting'?`It has been seen but is not in a block yet. A block takes about 2 minutes. Spendable after ${s.target} confirmations${eta?`, about ${s.etaMinutes} min once it is mined`:''}.`:`${eta?`${eta[0].toUpperCase()}${eta.slice(1)} left (estimate)`:'Almost there'}. ${direction==='in'?'Funds stay locked until':'Confirmed once'} all ${s.target} are in.`;
 return <div className="silo-review silo-confirms" data-state={s.state} data-direction={direction} role="status" aria-live="polite" aria-label={label??`${noun} confirmations`}>
  <div className="silo-confirms-head"><h3>{label??(direction==='in'?'Incoming confirmations':'Payment confirmations')}</h3><strong>{s.state==='unchecked'?'Not checked':`${s.confirmations}/${s.target}`}</strong></div>
  <p className="silo-confirms-title"><span className="silo-xmr-confirms-dot" aria-hidden="true"/>{headline}</p>
  <div className="silo-ticks silo-confirms-ticks" aria-hidden="true" style={{gridTemplateColumns:`repeat(${s.target},minmax(0,1fr))`}}>{Array.from({length:s.target},(_,i)=><span key={i} data-on={s.confirmations!==null&&i<s.confirmations||undefined}/>)}</div>
  {s.state!=='unchecked'&&<progress max={s.target} value={s.confirmations??0} aria-label={`${noun} confirmations`}/>}
  <p className="exposure-note">{detail}</p>
  {(txid||(minedHeight!==null&&minedHeight!==undefined))&&<details><summary>Details</summary>{txid&&<code className="exposure-address">{txid}</code>}{minedHeight!==null&&minedHeight!==undefined&&<p>Block {minedHeight}</p>}</details>}
 </div>;
}
