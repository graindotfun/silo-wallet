'use client';
import {createRecordRunner} from '@/lib/silo/record-runner.mjs';
import {sessionRpcFetch} from '@/lib/browser-rpc-session.mjs';
import {useCallback,useEffect,useRef,useState,type ComponentType} from 'react';
import {ArrowLeftRight} from 'lucide-react';
import {atomicRateText,ATOMIC_POLL_MS,XMR_TARGET_CONFIRMATIONS} from '@/lib/silo/atomic-driver.mjs';
import {createReverseDriver,reverseRecordActive} from '@/lib/silo/atomic-reverse-driver.mjs';
import {SiloAssetIcon} from '@/components/silo-asset-icon';
import {SiloConfirmMeter,SiloWaitBar,SiloWaitDot} from '@/components/silo-wait';
import {publishAtomicPending} from '@/lib/silo/atomic-pending.mjs';
import {reverseReturnPlan} from '@/lib/silo/atomic-reverse-return.mjs';
import {atomicReverseStatus,atomicReverseReturnStatus} from '@/lib/silo/atomic-status-copy.mjs';
import {holdSiloIdleLock,releaseSiloIdleLock,SILO_SWAP_IDLE_HOLD_MAX_MS} from '@/lib/silo/idle-lock.mjs';
import {siloUnits} from '@/lib/silo/amounts.mjs';
import {REVERSE_REFUND_TIMING,REVERSE_IF_FAILS,REVERSE_RECOVERY_TITLE,REVERSE_TERMS,REVERSE_REFUNDING_KICKER,REVERSE_SCAN_FAILED_KICKER} from '@/lib/silo/atomic-reverse-terms.mjs';
import {ATOMIC_DIRECTION_TEXT,atomicChipAmounts,atomicOverCap,atomicQuoteBody} from '@/lib/silo/atomic-amount.mjs';
import type {SiloAtomicKeys} from './silo-atomic-panel';
/** "Swap SOL to XMR, no bridge (beta)". The user locks SOL in the swap program; the maker sends XMR to a shared Monero address that
 * Silo watches itself; at 10 confirmations Silo tells the program the maker may take the SOL; the maker's claim hands Silo the key to
 * that address and Silo moves the XMR into the user's own wallet. If the maker never delivers, Silo takes the SOL back. The user's
 * wallet signs only the swap's own lock, ready and refund, each checked again inside the keyring (signReviewedAtomic).
 * Threat model: docs/research/xmr-sol-atomic-swap/SOL_TO_XMR_THREAT_MODEL.md. Same v3 design language as the XMR -> SOL panel. */
export type SiloReverseQuote={direction:'sol-xmr';quoteId:string;swapId:string;xmrAtomic:string;lamports:number;solPerXmr:number;spreadBps:number;priceSource?:string;A:string;proofA:{R:string;s:string};claimer:string;expiresAt:number};
type Rec={kind:string;swapId:string;status:string;result?:string;quote:SiloReverseQuote;t0?:number;t1?:number;lockAttemptAt?:number;[key:string]:unknown};
export type SiloReverseBridge={available:boolean;records:()=>Rec[];saveRecord:(record:Rec)=>Promise<void>;daemonHeight:()=>Promise<number|null>;watchJoint:(keys:{primaryAddress:string;privateViewKey:string;restoreHeight:number})=>Promise<{atomic:string;confirmations:number}|null>;cancelScan?:(keys:{primaryAddress:string;privateViewKey:string;restoreHeight:number})=>Promise<void>;releaseScan?:(keys:{primaryAddress:string;privateViewKey:string;restoreHeight:number})=>Promise<void>;sweepRecovery:(keys:SiloAtomicKeys)=>Promise<string[]>};
type View={record:Rec;phase:string;scanFailed?:boolean;confirmations?:number|null;notice?:string;refundFrom?:number|null};
type Now={tone:'wait'|'act'|'warn';kicker:string;title:string;body:string;meter?:number;facts?:[string,string][];next:string;notice?:string;more?:readonly string[]};
const MARGIN_S=300,RENT_LAMPORTS=1_635_760,TX_FEE=5000;
const sol=(lamports:number)=>siloUnits(String(lamports),9),xmrText=(atomic:string)=>siloUnits(atomic,12);
const clockText=(seconds:number|null|undefined)=>{if(!Number.isFinite(seconds))return '-';const at=new Date((seconds as number)*1000),now=new Date();const hm=at.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false});return at.toDateString()===now.toDateString()?`${hm} today`:`${hm} ${at.toLocaleDateString([],{weekday:'short'})}`;};
const countdown=(seconds:number)=>{const left=Math.max(0,Math.floor(seconds));return `${Math.floor(left/60)}:${String(left%60).padStart(2,'0')}`;};
const sourceName=(source:unknown)=>source==='coingecko'?'CoinGecko':typeof source==='string'&&/^[\w .-]{1,40}$/.test(source)?source:null;
/** The hold: from the SOL lock until the swap ends, at the latest the refund deadline (t0 - margin), never past the idle-lock cap. */
const holdEnd=(r:Rec)=>{const t0=Number(r.t0),at=Number(r.lockAttemptAt);if(!Number.isSafeInteger(t0)||!Number.isSafeInteger(at))return 0;return Math.min((t0-MARGIN_S)*1000,at+SILO_SWAP_IDLE_HOLD_MAX_MS-60_000);};
const KEEP:[string,string]=['Silo','Stays unlocked while this page is open'];
// The folded conditions live in lib/silo/atomic-reverse-terms.mjs (pre-claim and post-claim kept apart, Astra 748-M1).
const TERMS=REVERSE_TERMS as unknown as [string,string][];
async function post(action:string,body:unknown){
 const response=await sessionRpcFetch(`/api/silo/atomic/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const result:unknown=await response.json().catch(()=>null);
 if(!response.ok)throw Object.assign(Error(typeof (result as {error?:unknown})?.error==='string'?(result as {error:string}).error:'The swap service is unavailable right now.'),{userFacing:response.status===422});
 return result;
}

/** What another screen (Move to private) needs to show this panel's own start form in its own layout. Display only: getQuote and swap are
 * this panel's own functions, unchanged, so the quote request and the swap start are exactly the ones below. */
export type SiloReverseStartApi={amount:string;setAmount:(value:string)=>void;quote:SiloReverseQuote|null;quoted:boolean;expired:boolean;secondsLeft:number;amountValid:boolean;quoting:boolean;busy:boolean;solanaReady:boolean;walletReady:boolean;error:string;capXmr:string|null;getQuote:()=>void;swap:()=>void;rentLamports:number;feeLamports:number;terms:[string,string][]};
export function SiloAtomicReversePanel({enabled=false,recoveryOnly=false,network='mainnet',owner=null,sign=null,bridge=null,capXmr=null,startView:StartView}:{startView?:ComponentType<{api:SiloReverseStartApi}>;enabled?:boolean;recoveryOnly?:boolean;network?:'mainnet'|'devnet';owner?:string|null;sign?:((encoded:string,expected:unknown)=>string)|null;bridge?:SiloReverseBridge|null;capXmr?:string|null}){
 const [amount,setAmount]=useState(''),[quote,setQuote]=useState<SiloReverseQuote|null>(null),[quoting,setQuoting]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [views,setViews]=useState<Record<string,View>>({}),[ready,setReady]=useState(false),[clock,setClock]=useState(()=>Date.now());
 const bridgeRef=useRef(bridge),signRef=useRef(sign),driver=useRef<ReturnType<typeof createReverseDriver>|null>(null),runner=useRef(createRecordRunner());
 useEffect(()=>{bridgeRef.current=bridge;signRef.current=sign;});
 useEffect(()=>{
  if(!enabled)return;let live=true;
  void import('@/lib/silo/atomic-swap/bob-flow.mjs').then(flow=>{
   if(!live)return;
   const need=()=>{const current=bridgeRef.current;if(!current)throw Error('Open your Monero wallet to continue the swap.');return current;};
   driver.current=createReverseDriver({flow,post,network,
    sign:(encoded:string,expected:unknown)=>{const fn=signRef.current;if(!fn)throw Error('Unlock your Silo Solana wallet to continue the swap.');return fn(encoded,expected);},
    bridge:{saveRecord:(record:Rec)=>need().saveRecord(record),daemonHeight:()=>need().daemonHeight(),watchJoint:(keys:Parameters<SiloReverseBridge['watchJoint']>[0])=>need().watchJoint(keys),cancelScan:(keys:Parameters<SiloReverseBridge['watchJoint']>[0])=>need().cancelScan?.(keys)??Promise.resolve(),releaseScan:(keys:Parameters<SiloReverseBridge['watchJoint']>[0])=>need().releaseScan?.(keys)??Promise.resolve(),sweepRecovery:(keys:SiloAtomicKeys)=>need().sweepRecovery(keys)}});
   setReady(true);
  }).catch(()=>{if(live)setError('The swap code could not be loaded.');});
  return()=>{live=false;driver.current=null;setReady(false);};
 },[enabled,network]);
 // F1: ticks are non-reentrant PER RECORD, not globally. A record whose tick is stuck (a slow scan, a slow RPC) only holds its own next tick; every other
 // record and every later timer pass keeps running, so a stuck swap can never keep another swap's due refund waiting.
 const runAll=useCallback(async()=>{
  const current=bridgeRef.current,active=driver.current;if(!current?.available||!active)return;
  await runner.current.runAll(current.records().filter(reverseRecordActive),record=>active.tick(record),
   (record:Rec,view:unknown)=>setViews(previous=>({...previous,[record.swapId]:view as View})),
   (record:Rec)=>setViews(previous=>({...previous,[record.swapId]:{record,phase:previous[record.swapId]?.phase??'waiting-maker',notice:'Checking again shortly.'}})));
 },[]);
 const available=Boolean(bridge?.available);
 useEffect(()=>{
  if(!enabled||!ready||!available)return;void runAll();
  const timer=setInterval(()=>void runAll(),ATOMIC_POLL_MS),tick=setInterval(()=>setClock(Date.now()),1000);
  return()=>{clearInterval(timer);clearInterval(tick);};
 },[enabled,ready,available,runAll]);
 const activeRecords=(bridge?bridge.records():[]).filter(reverseRecordActive);
 // Idle-lock hold (#624 rule): from the SOL lock until the swap ends, capped at the refund deadline. Refunding holds too: it needs this page.
 const holding=enabled?activeRecords.filter(record=>record.lockAttemptAt&&holdEnd(record)>0).map(record=>`${record.swapId}:${holdEnd(record)}`).join(','):'';
 useEffect(()=>{const ids:string[]=[];for(const item of holding?holding.split(','):[]){const [id,end]=item.split(':');if(holdSiloIdleLock(`atomic-rev:${id}`,Number(end)))ids.push(`atomic-rev:${id}`);}return()=>{for(const id of ids)releaseSiloIdleLock(id);};},[holding]);
 // Home and Activity show a pending-swap card from this summary. Display only; empty while Silo is locked or nothing is active.
 const pendingKey=JSON.stringify(enabled?activeRecords.map(record=>{const plan=reverseReturnPlan(record,{phase:views[record.swapId]?.phase},Math.floor(clock/1000)),phase=views[record.swapId]?.phase??'waiting-maker',conf=Math.max(0,Math.min(XMR_TARGET_CONFIRMATIONS,Number(views[record.swapId]?.confirmations??record.xmrConfirmations??0)||0)),waitTitle=atomicReverseStatus(phase==='xmr-confirming'||phase==='awaiting-maker-xmr'||['locking','confirming','await-claim','sweeping','refunding'].includes(phase)?phase:'setup',{xmr:xmrText(record.quote.xmrAtomic),target:XMR_TARGET_CONFIRMATIONS,confirmations:conf,scanFailed:views[record.swapId]?.scanFailed===true}).headline;return {confirmations:phase==='xmr-confirming'&&views[record.swapId]?.scanFailed!==true?conf:null,confirmTarget:XMR_TARGET_CONFIRMATIONS,waitTitle,swapId:record.swapId,short:record.swapId.slice(0,4).toUpperCase(),phase:views[record.swapId]?.phase??'waiting-maker',xmr:xmrText(record.quote.xmrAtomic),sol:sol(record.quote.lamports),claimBy:null,sendBy:null,dir:'sol-xmr',stage:plan.stage,claimed:plan.claimed,returnBy:plan.returnBy,confirmBy:plan.confirmBy};}):[]);
 useEffect(()=>{publishAtomicPending(JSON.parse(pendingKey),'sol-xmr');},[pendingKey]);
 useEffect(()=>()=>publishAtomicPending([],'sol-xmr'),[]);
 const finished=Object.values(views).filter(view=>!reverseRecordActive(view.record));
 const amountValid=/^\d{1,4}(\.\d{1,12})?$/.test(amount)&&Number(amount)>0;
 const quoteLive=quote!==null&&Math.floor(clock/1000)<quote.expiresAt;
 const solanaReady=typeof owner==='string'&&owner.length>0&&typeof sign==='function',walletReady=Boolean(bridge?.available);
 async function getQuote(){
  if(!amountValid||quoting)return;setQuoting(true);setError('');setQuote(null);
  try{const result=await post('rev-quote',atomicQuoteBody(amount)) as SiloReverseQuote;if(result?.direction!=='sol-xmr'||typeof result.xmrAtomic!=='string'||!Number.isSafeInteger(result.lamports))throw Error('The quote could not be read.');setQuote(result);setClock(Date.now());}
  catch(failure){setError(failure instanceof Error&&(failure as {userFacing?:boolean}).userFacing?failure.message:'A quote is unavailable right now. Nothing was started.');}
  finally{setQuoting(false);}
 }
 async function swap(){
  const active=driver.current;if(!active||!quote||!quoteLive||!solanaReady||!walletReady||busy||activeRecords.length>0)return;
  setBusy(true);setError('');
  try{await active.start({quote,owner:owner as string});setQuote(null);setAmount('');await runAll();}
  catch(failure){setError(failure instanceof Error&&(failure as {userFacing?:boolean}).userFacing?failure.message:'The swap could not be started. Nothing was locked.');}
  finally{setBusy(false);}
 }
 const nowFor=(view:View):Now=>{
  const r=view.record,xmr=xmrText(r.quote.xmrAtomic),t0=Number(r.t0),refundBy:[string,string]=['Confirm by',Number.isFinite(t0)?clockText(t0-MARGIN_S):'-'];
  const plan=reverseReturnPlan(r,{phase:view.phase},Math.floor(clock/1000)),status=atomicReverseReturnStatus(plan,{now:new Date(clock)}),notice=plan.stage==='refund'?undefined:status.detail,more=status.more;
  const n=Math.max(0,Math.min(XMR_TARGET_CONFIRMATIONS,Number(view.confirmations??r.xmrConfirmations??0)||0));
  const plain=atomicReverseStatus(view.phase==='xmr-confirming'||view.phase==='awaiting-maker-xmr'||['locking','confirming','await-claim','sweeping','refunding'].includes(view.phase)?view.phase:'setup',{xmr,target:XMR_TARGET_CONFIRMATIONS,confirmations:n,scanFailed:view.scanFailed===true}),body=[plain.detail,plain.eta].filter(Boolean).join(' ');
  switch(view.phase){
   case 'locking':return {tone:'wait',kicker:'Now',title:plain.headline,body:body,facts:[KEEP],next:plain.nextAction,notice,more};
   case 'awaiting-maker-xmr':return {tone:'wait',kicker:'Now',title:plain.headline,body:body,facts:[refundBy,KEEP],next:plain.nextAction,notice,more};
   case 'xmr-confirming':if(view.scanFailed)return {tone:'warn',kicker:REVERSE_SCAN_FAILED_KICKER,title:plain.headline,body:body,facts:[refundBy,KEEP],next:plain.nextAction,notice,more};
    return {tone:'wait',kicker:'Monero confirmations',title:plain.headline,meter:n,body:body,facts:[refundBy,KEEP],next:plain.nextAction,notice,more};
   case 'confirming':return {tone:'wait',kicker:'Now',title:plain.headline,body:body,facts:[KEEP],next:plain.nextAction,notice,more};
   case 'await-claim':return {tone:'wait',kicker:'Now',title:plain.headline,body:body,facts:[KEEP],next:plain.nextAction,notice,more};
   case 'sweeping':return {tone:'wait',kicker:'Now',title:plain.headline,body:body,facts:[KEEP],next:plain.nextAction,notice,more};
   case 'refunding':return {tone:'warn',kicker:REVERSE_REFUNDING_KICKER,title:plain.headline,body:body,facts:[refundBy,KEEP],next:plain.nextAction,notice,more};
   default:return {tone:'wait',kicker:'Now',title:plain.headline,body:body,next:plain.nextAction};
  }
 };
 const clear=(id:string)=>setViews(previous=>{const next={...previous};delete next[id];return next;});
 const swapView=(view:View)=>{
  const r=view.record,id4=r.swapId.slice(0,4).toUpperCase(),xmr=xmrText(r.quote.xmrAtomic),pay=sol(r.quote.lamports),result=r.result??'';
  if(!reverseRecordActive(r)){
   const got=result==='xmr-received',back=result==='sol-refunded';
   return <div className="sx-main" key={r.swapId} data-swap={r.swapId.slice(0,8)} aria-label="Swap result"><p className="sx-sum"><span className="sx-id">Swap {id4}</span></p>
    <div className={`silo-inset sx-done${got?'':' sx-ended'}`} data-now-card><p className="sx-word" role="status">{got?'Received':back?'SOL sent back':'Nothing was locked'}</p>
     <p className="sx-done-amt">{got?<><span className="sx-approx">≈</span>{xmr}<span className="sx-unit">XMR</span></>:<>{pay}<span className="sx-unit">SOL</span></>}</p>
     <p className="sx-done-t">{got?'to your Silo Monero wallet, less one Monero network fee. It shows there after Monero confirmations.':back?'to your Silo Solana wallet.':'still in your Silo Solana wallet.'}</p></div>
    <button type="button" className="silo-primary sx-go" data-primary onClick={()=>{if(got)location.hash='#wallets/xmr';else if(back)location.hash='#wallets/sol';else clear(r.swapId);}}>{got?'See your XMR':back?'See your SOL':'Get a new offer'}</button>
    {(got||back)&&<button type="button" className="sx-text" onClick={()=>clear(r.swapId)}>Start another swap</button>}</div>;
  }
  const now=nowFor(view);
  return <div className="sx-main" key={r.swapId} data-swap={r.swapId.slice(0,8)} aria-label="Swap progress">
   <p className="sx-sum"><span className="sx-id">Swap {id4}</span><span className="sx-flow sx-amounts"><span className="sx-s">{pay} SOL</span><span aria-label="to">→</span><span className="sx-x">{xmr} XMR</span></span></p>
   <div className="silo-inset sx-now" data-wait={now.tone==='wait'?'':undefined} aria-busy={now.tone==='wait'?true:undefined} data-tone={now.tone} data-now-card>
    {now.tone==='wait'&&<SiloWaitBar/>}
    <p className="sx-now-k">{now.kicker}</p><p className="sx-now-t" role="status">{now.tone==='wait'&&<SiloWaitDot/>}{now.title}</p>
    {now.meter!==undefined&&<SiloConfirmMeter className="sx-meter silo-wait-meter" value={now.meter} target={XMR_TARGET_CONFIRMATIONS} label={`${now.meter} of ${XMR_TARGET_CONFIRMATIONS} Monero confirmations`}/>}
    <p className="sx-now-b">{now.body}</p>
    {now.notice&&<p className="sx-now-n">{now.notice}</p>}
    {now.more?.length?<details className="sx-late"><summary>{REVERSE_RECOVERY_TITLE}</summary><div className="sx-late-body">{now.more.map(text=><p key={text}>{text}</p>)}</div></details>:null}
    {view.notice&&<p className="sx-now-n">{view.notice}</p>}
    {now.facts?.length?<dl className="sx-facts">{now.facts.map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>:null}
   </div>
   <p className="sx-next"><b>Next</b> {now.next}</p></div>;
 };
 if(!enabled)return null;
 const shown=[...activeRecords.map(record=>views[record.swapId]??{record,phase:'waiting-maker'} as View),...finished.filter(view=>!activeRecords.some(record=>record.swapId===view.record.swapId))];
 // Recovery-only (the server switch is off, or a rollback): the runner keeps finishing refunds, claims and sweeps of swaps already started; no new swap can be offered.
 if(recoveryOnly&&shown.length===0)return null;
 const quoted=Boolean(quote&&quoteLive),expired=Boolean(quote&&!quoteLive),q=quote as SiloReverseQuote;
 const spread=quoted?(q.spreadBps/100).toFixed(2).replace(/\.?0+$/,''):'',source=quoted?sourceName(q.priceSource):null;
 return <section id="silo-atomic-reverse" className="exposure-panel sx" aria-labelledby="silo-atomic-reverse-heading" data-stage={shown.length?'active':quoted?'quote':expired?'expired':'start'}><h2 id="silo-atomic-reverse-heading" className="sx-vh">Swap SOL → XMR, no bridge (beta)</h2>
  {!bridge?<div className="sx-main"><div className="silo-inset sx-now sx-lockedbox" data-tone="warn"><p className="sx-now-k">Silo is locked</p><p className="sx-now-t">Unlock to continue a swap</p><p className="sx-now-b">If a swap is in progress, it pauses while Silo is locked, and its deadlines keep running. Unlock your Monero wallet to continue.</p><button type="button" className="silo-primary sx-go" data-primary onClick={()=>{location.hash='#wallets/xmr';}}>Unlock Monero wallet</button></div></div>:<>
  {!solanaReady&&<p className="sx-notice" role="status">Unlock your Silo Solana wallet first. The SOL is locked from there.</p>}
  {!walletReady&&<p className="sx-notice" role="status">Your Monero wallet is open but not ready yet (Wallets, then Monero). The XMR arrives there.</p>}
  {shown.length===0&&!recoveryOnly&&StartView&&<StartView api={{amount,setAmount:value=>{setAmount(value.trim());setQuote(null);setError('');},quote,quoted,expired,secondsLeft:quote?quote.expiresAt-clock/1000:0,amountValid,quoting,busy,solanaReady,walletReady,error,capXmr,getQuote:()=>void getQuote(),swap:()=>void swap(),rentLamports:RENT_LAMPORTS,feeLamports:TX_FEE*2,terms:TERMS}}/>}
  {shown.length===0&&!recoveryOnly&&!StartView&&<div className="sx-main">
   <p className="sx-lead" data-line="what">{ATOMIC_DIRECTION_TEXT['sol-xmr'].lead}</p>
   <div className="sx-pair">
    <div className="silo-window sx-leg sx-input" data-zone="private"><div className="sx-leg-head"><span id="sx-rev-amount-label">How much XMR do you want to get</span></div>
     <div className="sx-leg-row"><label className="sx-amount"><span className="sx-vh">How much XMR do you want to get</span><input inputMode="decimal" placeholder="0" value={amount} size={Math.max(1,(amount||'0').length)} aria-describedby="sx-rev-cap" disabled={busy||quoting} onChange={event=>{setAmount(event.target.value.trim());setQuote(null);setError('');}}/><span className="sx-unit" aria-hidden="true">XMR</span></label><SiloAssetIcon asset="xmr"/></div>
     <div className="sx-chips" role="group" aria-label="Quick amounts">{atomicChipAmounts(capXmr).map(value=><button key={value} type="button" className="sx-chip" data-on={amount===value?'':undefined} disabled={busy||quoting} onClick={()=>{setAmount(value);setQuote(null);setError('');}}>{value}</button>)}</div>
     <p id="sx-rev-cap" className="sx-cap" data-line="cap" data-over={atomicOverCap(amount,capXmr)?'':undefined}>{capXmr?`Max ${capXmr} XMR per swap in the beta.`:'Small amounts only in the beta.'}</p></div>
    <div className={`sx-leg sx-get${quoted?' sx-quoted':''}`}><div className="sx-leg-head"><span>You pay</span><span>{quoted?`Includes the ${spread}% maker spread`:'From your Silo Solana wallet'}</span></div>
     <div className="sx-leg-row">{quoted?<p className="sx-big" aria-label={`${sol(q.lamports)} SOL`}>{sol(q.lamports)}<span className="sx-unit">SOL</span></p>:<p className="sx-est">You will see the exact SOL amount in the offer.</p>}<SiloAssetIcon asset="sol"/></div></div>
    <p className="sx-rate">{quoted?<><span>Market 1 XMR ≈ <b>{atomicRateText(q.solPerXmr)} SOL</b></span><span className="sx-rate-t" role="timer" aria-label={`Offer valid for ${countdown(q.expiresAt-clock/1000)}`}>Valid {countdown(q.expiresAt-clock/1000)}</span></>:expired?<span role="status">Offer expired. Nothing was started.</span>:'Rate shown after you get an offer.'}</p>
   </div>
   {quoted&&<p className="sx-lock" data-line="lock">You lock {sol(q.lamports)} SOL plus a {sol(RENT_LAMPORTS)} SOL deposit that comes back to you.</p>}
   {quoted?<button type="button" className="silo-primary sx-go" data-primary disabled={busy||!solanaReady||!walletReady} aria-busy={busy||undefined} onClick={()=>void swap()}>{busy?'Starting…':'Start swap'}</button>
    :<button type="button" className="silo-primary sx-go" data-primary disabled={!amountValid||quoting||busy||!solanaReady||!walletReady} aria-busy={quoting||undefined} onClick={()=>void getQuote()}>{quoting?'Getting offer…':expired?'Get a new offer':'Get offer'}</button>}
   <p className="sx-safety" data-line="safety">{ATOMIC_DIRECTION_TEXT['sol-xmr'].safety}</p>
   <p className="sx-note" data-line="note">{ATOMIC_DIRECTION_TEXT['sol-xmr'].note}</p>
   {error&&<p role="alert" className="exposure-error">{error}</p>}
   <details className="sx-more sx-how"><summary><span>How it works</span></summary><div className="sx-how-body">
    {quoted&&<section className="sx-terms sx-costs" aria-labelledby="sx-rev-costs-h"><h3 id="sx-rev-costs-h">What this offer costs</h3><dl>
    <div><dt>Market price</dt><dd>1 XMR ≈ {atomicRateText(q.solPerXmr)} SOL{source?`, from ${source}`:''}</dd></div>
    <div><dt>Maker spread</dt><dd>{spread}%. Already included in what you pay.</dd></div>
    <div><dt>Solana network fees</dt><dd>About {sol(TX_FEE*2)} SOL for the lock and the release, from your Silo Solana wallet. The {sol(RENT_LAMPORTS)} SOL account deposit comes back when the swap ends.</dd></div>
    <div><dt>Monero network fee</dt><dd>One fee for moving the XMR into your wallet, taken from the XMR you get.</dd></div>
    <div><dt>Service fee</dt><dd>None besides the maker spread.</dd></div>
   </dl></section>}
    <p>{ATOMIC_DIRECTION_TEXT['sol-xmr'].line}</p>
    <p><b>You can close this page</b> once your SOL shows as locked. Open Silo again, usually after about 40 minutes, to confirm your XMR.</p>
    <p>{REVERSE_IF_FAILS}</p>
    <p><b>The maker cannot take your SOL</b> before Silo confirms your XMR arrived.</p>
    <p>{REVERSE_REFUND_TIMING}</p>
    {quoted&&<p><b>Starting locks {sol(q.lamports)} SOL</b> in the swap program, plus a {sol(RENT_LAMPORTS)} SOL account deposit you get back.</p>}
    <dl className="sx-kv">{TERMS.map(([term,text])=><div key={term}><dt>{term}</dt><dd>{text}</dd></div>)}</dl>
   </div></details>
  </div>}
  {shown.length>0&&error&&<p role="alert" className="exposure-error">{error}</p>}
  {shown.map(swapView)}
  </>}
 </section>;
}

/** The no-bridge direction: one header that says which way the money flows, one flip button. Sets data-sx-dir on .silo-app; silo.css shows the matching panel. */
export function SiloAtomicDirectionSwitch({value,onChange}:{value:'xmr-sol'|'sol-xmr';onChange:(next:'xmr-sol'|'sol-xmr')=>void}){
 const root=useRef<HTMLElement|null>(null);
 useEffect(()=>{const app=root.current?.closest('.silo-app');if(!app)return undefined;app.setAttribute('data-sx-dir',value);return()=>{app.removeAttribute('data-sx-dir');};},[value]);
 const from=value==='xmr-sol'?'xmr':'sol',to=value==='xmr-sol'?'sol':'xmr',other=value==='xmr-sol'?'sol-xmr':'xmr-sol',text=ATOMIC_DIRECTION_TEXT[value];
 return <section id="silo-atomic-dir" ref={root} className="sx-dir" aria-label="Swap direction" data-dir={value}>
  <h3 className="sx-dir-title">{text.title}</h3>
  <div className="sx-dir-row"><span className="sx-dir-end"><SiloAssetIcon asset={from}/><span>{from.toUpperCase()}</span></span>
   <button type="button" className="sx-flip" aria-label={`Flip direction. Now ${from.toUpperCase()} to ${to.toUpperCase()}`} onClick={()=>onChange(other)}><ArrowLeftRight size={22} aria-hidden="true"/><span>Flip</span></button>
   <span className="sx-dir-end"><SiloAssetIcon asset={to}/><span>{to.toUpperCase()}</span></span></div>
 </section>;
}
