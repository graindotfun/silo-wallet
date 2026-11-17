'use client';
import {useSyncExternalStore} from 'react';
import {ArrowDown} from 'lucide-react';
import {siloUnits} from '@/lib/silo/amounts.mjs';
import {atomicRateText} from '@/lib/silo/atomic-driver.mjs';
import {ATOMIC_DIRECTION_TEXT,atomicChipAmounts,atomicOverCap} from '@/lib/silo/atomic-amount.mjs';
import {BACKUP} from '@/lib/silo/atomic-reverse-return.mjs';
import {REVERSE_IF_FAILS} from '@/lib/silo/atomic-reverse-terms.mjs';
import type {SiloReverseStartApi} from './silo-atomic-reverse-panel';
/** Move to private (owner, 10 Nov 2026, direction B "two rooms"): the SOL -> XMR start form in its own layout. Display only. It holds no
 * state and no arithmetic of its own: the amount, the quote, getQuote and swap all belong to SiloAtomicReversePanel, which renders this
 * through its startView seam, so "Move X SOL" starts exactly the same swap as "Start swap" on the No bridge screen. The amount the
 * maker quotes is the XMR you ask for (the quote request is {xmr}), so the amount entry sits in the private room and the SOL that leaves
 * comes from the quote. The XMR shown is what the maker sends; one Monero network fee comes out of it when Silo moves it into your
 * wallet, so the screen says "less one Monero network fee" and never "at least". */
export const SILO_MOVE_HASH='#move/private';
const subscribe=(changed:()=>void)=>{window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);};
/** True while the Move to private screen is the current page. */
export function useSiloMoveRoute(){return useSyncExternalStore(subscribe,()=>location.hash===SILO_MOVE_HASH,()=>false);}
const sol=(lamports:number)=>siloUnits(String(lamports),9);
const clock=(seconds:number)=>{const left=Math.max(0,Math.floor(seconds));return `${Math.floor(left/60)}:${String(left%60).padStart(2,'0')}`;};
// Taken from the existing direction text so the two screens never disagree about time.
const TAKES=ATOMIC_DIRECTION_TEXT['sol-xmr'].line.match(/Usually about[^.;]*[;,]?[^.]*\./)?.[0]??'It can take longer than an hour.';
// Astra M1 (PR 748): the SOL refund depends on whether the maker has claimed; after the claim, recovery collects the XMR.
export const SILO_MOVE_IF_FAILS=REVERSE_IF_FAILS;

export function SiloMovePrivateScreen({api}:{api:SiloReverseStartApi}){
 const {amount,setAmount,quote,quoted,expired,secondsLeft,amountValid,quoting,busy,solanaReady,walletReady,error,capXmr,getQuote,swap,rentLamports,feeLamports,terms}=api;
 const q=quoted?quote:null,spread=q?(q.spreadBps/100).toFixed(2).replace(/\.?0+$/,''):'',locked=busy||quoting;
 return <div className="sx-main silo-move" data-quoted={q?'':undefined}>
  <section className="silo-move-room" data-room="public" aria-labelledby="silo-move-leaves">
   <p id="silo-move-leaves" className="silo-move-k">Leaves the public room</p>
   <p className="silo-move-big">{q?<span aria-label={`${sol(q.lamports)} SOL`}>{sol(q.lamports)}</span>:<span aria-label="Not quoted yet">-</span>}<span className="silo-move-unit">SOL</span></p>
   <p className="silo-move-note">{q?`Plus about ${Number(sol(rentLamports)).toFixed(4)} SOL account deposit you get back when the swap ends.`:'You will see the exact SOL amount in the offer.'}</p>
  </section>
  <span className="silo-move-arrow" aria-hidden="true"><ArrowDown size={20}/></span>
  <section className="silo-window silo-move-room" data-zone="private" data-room="private" aria-labelledby="silo-move-arrives">
   <label className="silo-move-k" id="silo-move-arrives" htmlFor="silo-move-amount">Arrives in the private room</label>
   <div className="silo-move-big silo-move-entry"><input id="silo-move-amount" inputMode="decimal" placeholder="0" autoComplete="off" value={amount} aria-describedby="silo-move-cap" disabled={locked} onChange={event=>setAmount(event.target.value)}/><span className="silo-move-unit">XMR</span></div>
   <p className="silo-move-note">Less one Monero network fee, taken when Silo moves it into your wallet.</p>
   <div className="sx-chips silo-move-chips" role="group" aria-label="Quick amounts">{atomicChipAmounts(capXmr).map(value=><button key={value} type="button" className="sx-chip" data-on={amount===value?'':undefined} disabled={locked} onClick={()=>setAmount(value)}>{value}</button>)}</div>
   <p id="silo-move-cap" className="silo-move-note" data-over={atomicOverCap(amount,capXmr)?'':undefined}>{capXmr?`Max ${capXmr} XMR per swap in the beta.`:'Small amounts only in the beta.'}</p>
  </section>
  <dl className="silo-move-facts">
   <div><dt>Takes</dt><dd>{TAKES}</dd></div>
   <div><dt>Cost, already included</dt><dd>{q?`The ${spread}% maker spread is in the SOL amount. Solana network fees of about ${sol(feeLamports)} SOL come on top.`:'The maker spread is in the SOL amount the offer shows.'}</dd></div>
   <div><dt>If it fails</dt><dd>{SILO_MOVE_IF_FAILS}</dd></div>
  </dl>
  {/* The No bridge safety line (PR 730, Astra M2): after the maker claims, recovery collects the XMR; it does not refund SOL. */}
  <p className="sx-safety">{ATOMIC_DIRECTION_TEXT['sol-xmr'].safety}</p>
  <p className="silo-move-rate">{q?<><span>Market 1 XMR ≈ {atomicRateText(q.solPerXmr)} SOL</span><span role="timer" aria-label={`Offer valid for ${clock(secondsLeft)}`}>Valid {clock(secondsLeft)}</span></>:expired?<span role="status">Offer expired. Nothing was started.</span>:'Rate shown after you get an offer.'}</p>
  {q?<button type="button" className="silo-primary sx-go silo-move-go" data-primary disabled={busy||!solanaReady||!walletReady} aria-busy={busy||undefined} onClick={swap}>{busy?'Starting…':`Move ${sol(q.lamports)} SOL`}</button>
   :<button type="button" className="silo-primary sx-go silo-move-go" data-primary disabled={!amountValid||quoting||busy||!solanaReady||!walletReady} aria-busy={quoting||undefined} onClick={getQuote}>{quoting?'Getting offer…':expired?'Get a new offer':'Get offer'}</button>}
  {error&&<p role="alert" className="exposure-error">{error}</p>}
  <p className="silo-move-backup">{BACKUP}</p>
  <details className="silo-move-more"><summary>Costs and all conditions</summary>
   {q&&<dl><div><dt>Account deposit</dt><dd>{sol(rentLamports)} SOL, returned to your Silo Solana wallet when the swap ends.</dd></div><div><dt>Monero network fee</dt><dd>One fee for moving the XMR into your wallet, taken from the XMR you get.</dd></div><div><dt>Service fee</dt><dd>None besides the maker spread.</dd></div></dl>}
   <dl>{terms.map(([term,text])=><div key={term}><dt>{term}</dt><dd>{text}</dd></div>)}</dl>
  </details>
 </div>;
}
