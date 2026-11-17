'use client';
import {Fragment,useEffect,useState,useSyncExternalStore} from 'react';
import {SiloConfirmMeter,SiloWaitBar,SiloWaitStatus} from '@/components/silo-wait';
import {ATOMIC_PAUSED_COPY,atomicForwardCardStatus,atomicReverseReturnStatus} from '@/lib/silo/atomic-status-copy.mjs';
import {reverseConfirmTime} from '@/lib/silo/atomic-reverse-return.mjs';
import {atomicPendingServerSnapshot,atomicPendingSnapshot,requestAtomicDirection,subscribeAtomicPending} from '@/lib/silo/atomic-pending.mjs';
/** Home and Activity: one card per no-bridge swap in progress (leave and return, owner decision 5 Nov 2026). Display only; the
 * swap itself runs in the swap panel, which resumes on every unlock whatever screen is shown. Nothing shows while Silo is locked. */
const at=(seconds:number|null)=>{if(!Number.isFinite(seconds))return null;const d=new Date((seconds as number)*1000),now=new Date();const hm=d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false});return d.toDateString()===now.toDateString()?`${hm} today`:`${hm} ${d.toLocaleDateString([],{day:'numeric',month:'short'})}`;};
/** compact (Home, owner 10 Nov 2026): one short card per swap, the step and its time, and Open. The same words as the full card, cut to
 * their title; the full explanation stays inside the swap. */
/** Live state under a compact Home card: the same shared bar as the swap screen. N of 10 and its segments in the Monero confirmation stage, the
 * indeterminate orange bar in every other stage. Display only, from the summary the panel already publishes. */
const live=(item:{confirmations?:number|null;confirmTarget?:number},title:string)=>{
 const target=item.confirmTarget&&item.confirmTarget>0?item.confirmTarget:10;
 if(typeof item.confirmations==='number')return <span className="silo-wait-live" data-silo-wait-live="" data-kind="confirmations" aria-busy="true"><span className="silo-wait-live-t">{item.confirmations} of {target} confirmations</span><SiloConfirmMeter value={item.confirmations} target={target} label={`${item.confirmations} of ${target} Monero confirmations`}/></span>;
 return <span className="silo-wait-live" data-silo-wait-live="" data-kind="indeterminate" aria-busy="true"><span className="silo-wait-live-t">{title}</span><span className="silo-wait-track"><SiloWaitBar/></span><SiloWaitStatus>{title}</SiloWaitStatus></span>;
};
/** paused: a direction switched off in this build. Its card stays, read-only (no Open: that screen is not offered), with the paused line (748-M2). */
export function SiloAtomicPendingCard({onOpen,compact=false,paused={}}:{onOpen:()=>void;compact?:boolean;paused?:Partial<Record<'xmr-sol'|'sol-xmr',boolean>>}){
 const list=useSyncExternalStore(subscribeAtomicPending,atomicPendingSnapshot,atomicPendingServerSnapshot);
 const [clock,setClock]=useState(()=>Date.now());
 useEffect(()=>{if(!list.length)return undefined;const timer=setInterval(()=>setClock(Date.now()),30000);return()=>clearInterval(timer);},[list.length]);
 if(!list.length)return null;
 return <section className="silo-section silo-swap-pending" aria-labelledby="silo-swap-pending-title">
  <div className="silo-section-head"><h2 id="silo-swap-pending-title"><span className="silo-label">Swap in progress</span></h2></div>
  {list.map(item=>{
   if(item.dir==='sol-xmr'){
    // SOL -> XMR: the words come from one tested module (lib/silo/atomic-reverse-return.mjs); nothing here claims the swap moves while Silo is closed.
    const stage=['start','confirm','pending','collect','refund'].includes(item.stage??'')?item.stage as 'start'|'confirm'|'pending'|'collect'|'refund':'confirm';
    const nowS=clock/1000,late=Number.isFinite(item.confirmBy)&&nowS>=(item.confirmBy as number);
    // A published 'confirm' that is past the latest time is a refund now (the panel's plan says the same on its next tick).
    const shownStage=late&&stage==='confirm'?'refund':stage;
    const words=atomicReverseReturnStatus({stage:shownStage,canLeave:shownStage!=='start',confirmBy:item.confirmBy??null,returnBy:item.returnBy??null,late,claimed:item.claimed===true},{now:new Date(clock)});
    // The same time choice as the detailed card (reverseConfirmTime): "Come back by" while ahead, else "Latest possible", never a passed time.
    const picked=shownStage==='confirm'?reverseConfirmTime({stage:shownStage,canLeave:true,confirmBy:item.confirmBy??null,returnBy:item.returnBy??null,late,claimed:false},{now:new Date(clock)}):{kind:null,text:null};
    const by=picked.kind==='comeBack'?picked.text:null;
    const ahead=(seconds:number|null|undefined)=>Number.isFinite(seconds)&&nowS<(seconds as number);
    const facts=shownStage==='confirm'?(picked.kind==='latest'?[['Latest possible',picked.text as string]]:[]):words.facts.filter(([key])=>key==='Latest possible'&&ahead(item.confirmBy));
    const compactLine=[words.nextAction,...facts.map(([key,value])=>`${key}: ${value}.`)].join(' ');
    if(paused['sol-xmr'])return <div key={item.swapId} className="silo-account silo-swap-pending-row" data-paused="" data-compact={compact?'':undefined} data-phase={item.phase} data-stage={shownStage}>
     <span className="silo-account-name">{compact?`${item.sol} SOL to XMR`:words.headline}<small>{compact?words.headline:words.detail}</small><small data-paused-line="">{ATOMIC_PAUSED_COPY['sol-xmr']}</small></span>
    </div>;
    if(compact)return <button type="button" key={item.swapId} className="silo-account silo-swap-pending-row" data-compact="" data-phase={item.phase} data-stage={shownStage} onClick={()=>{requestAtomicDirection('sol-xmr');onOpen();}}>
     <span className="silo-account-name">{item.sol} SOL to XMR<small>{words.headline}{by&&by!=='-'?` by ${by}`:''}</small><small data-compact-line="">{compactLine}</small></span><span className="silo-swap-pending-open">Open</span>{live(item,item.waitTitle||words.headline)}
    </button>;
    return <Fragment key={item.swapId}><button type="button" className="silo-account silo-swap-pending-row" data-phase={item.phase} data-stage={stage} onClick={()=>{requestAtomicDirection('sol-xmr');onOpen();}}>
     <span className="silo-account-name">{words.headline}<small>{words.detail}</small></span>
     <span className="silo-fine">Swap {item.short} · {item.sol} SOL → XMR</span>
    </button>
    {words.more?.length?<details className="sx-late silo-swap-late"><summary>{words.moreTitle}</summary><div className="sx-late-body">{words.more.map(text=><p key={text}>{text}</p>)}</div></details>:null}</Fragment>;
   }
   const open=item.claimBy!==null&&clock/1000<item.claimBy;
   const plain=atomicForwardCardStatus(item.phase,{xmr:item.xmr,sol:item.sol,sendByText:at(item.sendBy),claimByText:at(item.claimBy),claimOpen:open}),title=plain.headline,line=plain.detail;
   if(paused['xmr-sol'])return <div key={item.swapId} className="silo-account silo-swap-pending-row" data-paused="" data-compact={compact?'':undefined} data-phase={item.phase}>
    <span className="silo-account-name">{compact?`${item.xmr} XMR to SOL`:title}<small>{compact?title:line}</small><small data-paused-line="">{ATOMIC_PAUSED_COPY['xmr-sol']}</small></span>
   </div>;
   if(compact)return <button type="button" key={item.swapId} className="silo-account silo-swap-pending-row" data-compact="" data-phase={item.phase} onClick={()=>{requestAtomicDirection('xmr-sol');onOpen();}}>
    <span className="silo-account-name">{item.xmr} XMR to SOL<small>{title}{item.phase==='awaiting-xmr'&&Number.isFinite(item.sendBy)&&clock/1000<(item.sendBy as number)&&at(item.sendBy)?` by ${at(item.sendBy)}`:''}</small>{item.phase!=='awaiting-xmr'&&<small data-compact-line="">{['recovering','awaiting-refund','stopped'].includes(item.phase)?line:plain.nextAction}</small>}</span><span className="silo-swap-pending-open">Open</span>{item.phase!=='awaiting-xmr'&&live(item,title)}
   </button>;
   return <button type="button" key={item.swapId} className="silo-account silo-swap-pending-row" data-phase={item.phase} onClick={()=>{requestAtomicDirection('xmr-sol');onOpen();}}>
    <span className="silo-account-name">{title}<small>{line}</small></span>
    <span className="silo-fine">Swap {item.short} · {item.xmr} XMR → SOL</span>
   </button>;
  })}
 </section>;
}
