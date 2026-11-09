'use client';
import {useEffect,useState} from 'react';
import {siloCashoutPrivacy} from '@/lib/silo/cashout-privacy.mjs';
import type {SiloActivityPage} from './silo-solana-activity';
export function SiloCashoutPrivacy({amount,owner,page}:{amount:string;owner:string|null;page:SiloActivityPage|null}){
 const [now,setNow]=useState(()=>Date.now());
 useEffect(()=>{const tick=()=>setNow(Date.now()),timer=setInterval(tick,1000);window.addEventListener('focus',tick);return()=>{clearInterval(timer);window.removeEventListener('focus',tick);};},[]);
 const result=siloCashoutPrivacy({amount,owner,page,now});
 return <section className="silo-inset" aria-label="Cash-out privacy check"><h4>What may still link this conversion</h4>
  <p className="exposure-note">Local advisory · no extra request or saved report. This does not guarantee privacy.</p>
  {result.round&&<p>Round SOL amount: at most two decimal places. Public amount patterns may help link activity.</p>}
  {result.matches.map(match=><p key={match.signature}>Within 1% of an incoming SOL balance change observed {match.blockTime===null?'at an unavailable time':`on ${new Date(match.blockTime*1000).toISOString()}`}. Possible amount correlation; purchase and ownership are unverified.</p>)}
  {result.state==='partial'?<p>Partial coverage: only loaded finalized observations were checked. {result.matches.length===0?'No similar incoming SOL amount was found in those observations. ':''}Older or unavailable history may be missing.</p>:<p>History {result.state==='stale'?'is out of date':'was not checked'}. Open Activity and choose to load or refresh activity. That read shares your public address with Silo’s server and its Solana RPC provider.</p>}
  <details><summary>Coverage and limits</summary><p>Only activity you chose to load for this mainnet address is used. Token purchases and counterparty address reuse are not checked. Balance changes may include fees, rent or wrapping. Missing history or no matches are not evidence of privacy; public amounts and timing can still be correlated.</p></details>
 </section>;
}
