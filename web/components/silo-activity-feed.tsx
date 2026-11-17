'use client';
import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {readSiloManagedHistory} from '@/lib/silo/jupiter-managed-journal.mjs';
import {ATOMIC_PAUSED_COPY} from '@/lib/silo/atomic-status-copy.mjs';
import {ACTIVITY_CHAINS,coverageNotes,ACTIVITY_TYPES,filterActivity,groupTimeline,mergeActivity,moneroItems,pendingItems,readActivityFilter,refreshSources,solanaItems,swapItems,updatedLine,writeActivityFilter} from '@/lib/silo/activity-feed.mjs';
import {atomicPendingServerSnapshot,atomicPendingSnapshot,requestAtomicDirection,subscribeAtomicPending} from '@/lib/silo/atomic-pending.mjs';
import type {SiloActivityPage,SiloRefreshOutcome} from './silo-solana-activity';
import type {SiloXmrHistoryRow} from './silo-overview';
export type SiloSolanaActivityStatus='off'|'locked'|'consent'|'loading'|'error'|'ready';
type RefreshResult={at:number;failed:string[];skipped:string[];updated:boolean};
type Item={id:string;chain:'sol'|'xmr'|'both';type:string;when:number|null;title:string;detail:string;value:string|null;state:string;word:string;now?:boolean;index?:number;dir?:'xmr-sol'|'sol-xmr';sentence?:string;status?:string;href?:string};
const chainLabel:Record<string,string>={all:'All',sol:'Solana',xmr:'Monero'},typeLabel:Record<string,string>={all:'All types',sent:'Sent',received:'Received',swap:'Swaps'};
/** Activity as a plain timeline: NOW (swaps in progress), TODAY, weekday names, then dates, in the user's own time zone. Each row is one sentence and
 * one status line. Solana rows come from the bounded public read the wallet already makes (when enabled) plus swap receipts saved in this browser;
 * Monero rows from the Monero history the wallet already reads (it records no time, so those rows sit under EARLIER). Refresh re-reads every
 * source and says which one failed. `onRefreshXmr` is optional: the Monero history is read by the wallet when it syncs. */
export function SiloActivityFeed({activityPage,xmrHistory,owner,solanaStatus,concealed,onRefresh,onRefreshXmr,onOpenSwap,onLoadOlder,swapsPaused={}}:{swapsPaused?:Partial<Record<'xmr-sol'|'sol-xmr',boolean>>;onLoadOlder?:(()=>void)|null;onRefresh?:()=>SiloRefreshOutcome|Promise<SiloRefreshOutcome>;onRefreshXmr?:()=>SiloRefreshOutcome|Promise<SiloRefreshOutcome>;onOpenSwap?:()=>void;activityPage:SiloActivityPage|null;xmrHistory:SiloXmrHistoryRow[]|null;owner:string|null;solanaStatus:SiloSolanaActivityStatus;concealed:boolean;dayLabel?:(time:number|null)=>string}){
 const [filter,setFilter]=useState({chain:'all',type:'all'}),[saved,setSaved]=useState<unknown[]>([]),[savedError,setSavedError]=useState(false);
 const [now,setNow]=useState(()=>Date.now()),[refreshed,setRefreshed]=useState<RefreshResult|null>(null),[refreshing,setRefreshing]=useState(false),latch=useRef(false);
 const pending=useSyncExternalStore(subscribeAtomicPending,atomicPendingSnapshot,atomicPendingServerSnapshot);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- the stored preference is read once in the browser
 useEffect(()=>{setFilter(readActivityFilter(localStorage));},[]);
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),30000);return()=>clearInterval(timer);},[]);
 const readSaved=()=>{try{setSaved(readSiloManagedHistory(localStorage).rows);setSavedError(false);return true;}catch{setSaved([]);setSavedError(true);return false;}};
 useEffect(()=>{const read=()=>{readSaved();};read();window.addEventListener('storage',read);window.addEventListener('silo-swap-journal-changed',read);return()=>{window.removeEventListener('storage',read);window.removeEventListener('silo-swap-journal-changed',read);};},[]);
 const choose=(next:{chain:string;type:string})=>{setFilter(next);writeActivityFilter(localStorage,next);};
 // The moment the Monero history arrived: estimated row times count back from it, so they do not drift while the page stays open.
 const [xmrRead,setXmrRead]=useState(()=>({rows:xmrHistory,at:Date.now()}));
 // eslint-disable-next-line react-hooks/set-state-in-effect -- records when the Monero history last arrived
 useEffect(()=>{setXmrRead(previous=>previous.rows===xmrHistory?previous:{rows:xmrHistory,at:Date.now()});},[xmrHistory]);
 const xmrReadAt=xmrRead.at;
 const all=useMemo(()=>mergeActivity(solanaItems(activityPage),swapItems(saved,owner),moneroItems(xmrHistory,12,xmrReadAt)) as Item[],[activityPage,saved,owner,xmrHistory,xmrReadAt]);
 const shown=filterActivity(all,filter) as Item[],open=pendingItems(pending,now) as Item[];// NOW always shows: a filter never hides a swap in progress (748-M2).
 const groups=groupTimeline(open,shown,{now,concealed}) as {label:string;rows:{item:Item;sentence:string;status:string;link:{href:string;text:string}|null}[]}[];
 const notice=solanaStatus==='off'?'Solana history from the network is not switched on in this build. Swaps saved on this device still appear here.'
  :solanaStatus==='locked'?'Open your Solana wallet from Home to load its public history.'
  :solanaStatus==='consent'?'Solana history loads after you allow it in the Solana section below (tick the box, then Load). Then use Refresh here.'
  :solanaStatus==='loading'?'Loading Solana history…'
  :solanaStatus==='error'?'Solana history could not be loaded. Monero items and saved swaps are still shown.':!activityPage?'Solana history appears once it is loaded.':'';
 const notes=coverageNotes(activityPage),solanaReadable=(solanaStatus==='ready'||solanaStatus==='error')&&!!onRefresh;
 // One refresh at a time: a second tap or an overlapping call returns at once instead of starting the readers again.
 const refresh=async()=>{
  if(latch.current)return;
  latch.current=true;setRefreshing(true);
  try{
  const sources=[{id:'saved',label:'Saved swaps',read:()=>{if(!readSaved())throw new Error('saved');return 'updated' as const;}},
   ...(solanaReadable?[{id:'sol',label:'Solana',read:async()=>(await onRefresh?.())??'skipped'}]:[]),
   ...(onRefreshXmr?[{id:'xmr',label:'Monero',read:()=>onRefreshXmr()}]:[])];
  const result=await refreshSources(sources);
  setNow(result.at);setRefreshed(result);
  }finally{latch.current=false;setRefreshing(false);}
 };
 // A tap on the NOW row opens the swap screen the same way the swap card does (without a handler it clicks the swap card, which stays visible above the list).
 const openSwap=(item:Item)=>{if(item.dir)requestAtomicDirection(item.dir);if(onOpenSwap){onOpenSwap();return;}const cards=document.querySelectorAll<HTMLButtonElement>('.silo-swap-pending-row');cards[item.index??0]?.click();};
 const typeNow=ACTIVITY_TYPES.includes(filter.type)?filter.type:'all';
 return <section className="silo-section silo-activity-feed silo-tl" aria-label="All activity">
  <div className="silo-tl-controls">
   <div className="silo-tl-seg" role="radiogroup" aria-label="Show activity from">{ACTIVITY_CHAINS.map((id:string)=><button key={id} type="button" role="radio" aria-checked={filter.chain===id} onClick={()=>choose({...filter,chain:id})}>{chainLabel[id]}</button>)}</div>
   <select className="silo-tl-type" aria-label="Type" value={typeNow} onChange={event=>choose({...filter,type:event.target.value})}>{ACTIVITY_TYPES.map((id:string)=><option key={id} value={id}>{id==='all'?'Type':typeLabel[id]}</option>)}</select>
   <button type="button" className="silo-tl-refresh" disabled={refreshing||solanaStatus==='loading'} onClick={()=>{void refresh();}}>{refreshing||solanaStatus==='loading'?'Refreshing…':'Refresh'}</button>
  </div>
  {refreshed&&<p className="silo-fine silo-tl-updated" role="status" data-testid="updated-line">{refreshed.updated?updatedLine(refreshed.at):refreshed.failed.length>0&&refreshed.skipped.length===0?'Could not refresh':'Refresh attempted'}</p>}
  {refreshed?.failed.map(label=><p key={label} className="silo-fine silo-tl-fail" role="status">{label} could not be updated. The other lists are shown.</p>)}{refreshed?.skipped.map(label=><p key={`skip-${label}`} className="silo-fine silo-tl-fail" role="status">{label} was not refreshed this time. The list shown may be older.</p>)}
  {solanaStatus==='error'&&<p className="silo-fine silo-tl-fail" role="status">{notice}</p>}
  {savedError&&<p className="silo-fine" role="status">Saved swap receipts on this device could not be read. They have not been deleted.</p>}
  {groups.length===0?<p className="silo-fine" role="status">{all.length===0&&pending.length===0?(activityPage?'No transactions are listed yet. This does not mean none happened; see the notes below.':'Nothing to show yet.'):'No activity matches this filter.'}</p>
   :<ol className="silo-tl-list" data-testid="activity-rows">{groups.flatMap(group=>group.rows.map((row,index)=>{const item=row.item;
    const status=row.link&&row.status.endsWith(row.link.text)?<>{row.status.slice(0,row.status.length-row.link.text.length)}<a href={row.link.href} target="_blank" rel="noopener noreferrer">{row.link.text}</a></>:row.status;
    const text=<><span className="silo-tl-sentence">{row.sentence}</span><small className="silo-tl-status" data-state={item.state}>{status}</small></>;
    return <li key={`${item.chain}:${item.id}`} className="silo-activity-item silo-tl-row" data-chain={item.chain} data-type={item.type} data-state={item.state} data-now={item.now?'true':undefined}>
     <span className="silo-tl-when">{index===0?group.label:''}</span>
     {item.now&&item.dir&&swapsPaused[item.dir]?<p className="silo-tl-text" data-paused=""><span className="silo-tl-sentence">{row.sentence}</span><small className="silo-tl-status" data-state={item.state}>{status} {ATOMIC_PAUSED_COPY[item.dir]}</small></p>
      :item.now?<button type="button" className="silo-tl-text" onClick={()=>openSwap(item)}>{text}</button>:<p className="silo-tl-text">{text}</p>}
    </li>;}))}</ol>}
  {activityPage?.nextCursor&&onLoadOlder&&<div className="silo-tl-more"><button type="button" className="silo-tl-refresh" disabled={solanaStatus==='loading'} onClick={onLoadOlder}>Load more</button></div>}
  <footer className="silo-tl-foot">
   {notice&&solanaStatus!=='error'&&<p className="silo-fine" role="status">{notice}</p>}
   <p className="silo-fine">This list shows Solana, Monero and swaps saved on this device.{solanaStatus!=='off'&&solanaStatus!=='locked'?' Solana history is public and is fetched through Silo’s server and Alchemy. Monero history is read in your browser. Turn off automatic loading on the Solana page.':''}</p>
   {notes.length>0&&<ul className="silo-fine" aria-label="Solana coverage notes" data-testid="coverage-notes">{notes.map(note=><li key={note}>{note}</li>)}</ul>}
  </footer>
 </section>;
}
