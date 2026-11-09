'use client';
import {useEffect,useState,useSyncExternalStore} from 'react';
import {atomicPendingServerSnapshot,atomicPendingSnapshot,subscribeAtomicPending} from '@/lib/silo/atomic-pending.mjs';
/** Home and Activity: one card per no-bridge swap in progress (leave and return, owner decision 5 Nov 2026). Display only; the
 * swap itself runs in the swap panel, which resumes on every unlock whatever screen is shown. Nothing shows while Silo is locked. */
const at=(seconds:number|null)=>{if(!Number.isFinite(seconds))return null;const d=new Date((seconds as number)*1000),now=new Date();const hm=d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false});return d.toDateString()===now.toDateString()?`${hm} today`:`${hm} ${d.toLocaleDateString([],{day:'numeric',month:'short'})}`;};
export function SiloAtomicPendingCard({onOpen}:{onOpen:()=>void}){
 const list=useSyncExternalStore(subscribeAtomicPending,atomicPendingSnapshot,atomicPendingServerSnapshot);
 const [clock,setClock]=useState(()=>Date.now());
 useEffect(()=>{if(!list.length)return undefined;const timer=setInterval(()=>setClock(Date.now()),30000);return()=>clearInterval(timer);},[list.length]);
 if(!list.length)return null;
 return <section className="silo-section silo-swap-pending" aria-labelledby="silo-swap-pending-title">
  <div className="silo-section-head"><h2 id="silo-swap-pending-title"><span className="silo-label">Swap in progress</span></h2></div>
  {list.map(item=>{
   const open=item.claimBy!==null&&clock/1000<item.claimBy,refund=item.phase==='awaiting-refund'||item.phase==='recovering';
   const [title,line]=item.phase==='awaiting-xmr'?['Your step: send the XMR',`Confirm ${item.xmr} XMR in your Monero wallet${at(item.sendBy)?` by ${at(item.sendBy)}`:''}.`]
    :refund?['Your XMR is coming back','The claim deadline passed. Your XMR comes back only if the maker returns the SOL lock. Open and unlock Silo to continue.']
    :item.phase==='waiting-maker'||item.phase==='checking-lock'?['Starting your swap','The maker is locking the SOL. Nothing has left your wallet.']
    :[`${item.sol} SOL on its way`,open?`Silo collects it while it is open and unlocked. If you close or lock Silo, open and unlock it again before ${at(item.claimBy)} so it can try the claim.`:'Silo is checking this swap.'];
   return <button type="button" key={item.swapId} className="silo-account silo-swap-pending-row" data-phase={item.phase} onClick={onOpen}>
    <span className="silo-account-name">{title}<small>{line}</small></span>
    <span className="silo-fine">Swap {item.short} · {item.xmr} XMR → SOL</span>
   </button>;
  })}
 </section>;
}
