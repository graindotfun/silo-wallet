'use client';
import {createRecordRunner} from '@/lib/silo/record-runner.mjs';
import {sessionRpcFetch} from '@/lib/browser-rpc-session.mjs';
import {useCallback,useEffect,useRef,useState} from 'react';
import {atomicRateText,ATOMIC_POLL_MS,XMR_TARGET_CONFIRMATIONS} from '@/lib/silo/atomic-driver.mjs';
import {createReverseDriver,reverseRecordActive} from '@/lib/silo/atomic-reverse-driver.mjs';
import {SiloAssetIcon} from '@/components/silo-asset-icon';
import {holdSiloIdleLock,releaseSiloIdleLock,SILO_SWAP_IDLE_HOLD_MAX_MS} from '@/lib/silo/idle-lock.mjs';
import {siloUnits} from '@/lib/silo/amounts.mjs';
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
type Now={tone:'wait'|'act'|'warn';kicker:string;title:string;body:string;meter?:number;facts?:[string,string][];next:string;notice?:string};
const MARGIN_S=300,RENT_LAMPORTS=1_635_760,TX_FEE=5000;
const sol=(lamports:number)=>siloUnits(String(lamports),9),xmrText=(atomic:string)=>siloUnits(atomic,12);
const clockText=(seconds:number|null|undefined)=>{if(!Number.isFinite(seconds))return '-';const at=new Date((seconds as number)*1000),now=new Date();const hm=at.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false});return at.toDateString()===now.toDateString()?`${hm} today`:`${hm} ${at.toLocaleDateString([],{weekday:'short'})}`;};
const countdown=(seconds:number)=>{const left=Math.max(0,Math.floor(seconds));return `${Math.floor(left/60)}:${String(left%60).padStart(2,'0')}`;};
const sourceName=(source:unknown)=>source==='coingecko'?'CoinGecko':typeof source==='string'&&/^[\w .-]{1,40}$/.test(source)?source:null;
/** The hold: from the SOL lock until the swap ends, at the latest the refund deadline (t0 - margin), never past the idle-lock cap. */
const holdEnd=(r:Rec)=>{const t0=Number(r.t0),at=Number(r.lockAttemptAt);if(!Number.isSafeInteger(t0)||!Number.isSafeInteger(at))return 0;return Math.min((t0-MARGIN_S)*1000,at+SILO_SWAP_IDLE_HOLD_MAX_MS-60_000);};
const KEEP:[string,string]=['Keep','Page open · Silo stays unlocked'];
const TERMS:[string,string][]=[
 ['Keep this page open','The swap runs only on this open page. From when your SOL is locked until your XMR arrives, Silo does not lock itself. Ten Monero confirmations usually take about 35 minutes, sometimes longer.'],
 ['The maker cannot take your SOL first','The swap program releases your SOL to the maker only after Silo has confirmed that your XMR arrived. Until then nobody else can move it.'],
 ['If the maker does not deliver','Silo takes your SOL back by itself if no XMR arrives within about 30 minutes, if it does not arrive in full, or once the confirmation deadline passes. If Silo cannot check Monero (a slow or blocked connection), it cannot tell that nothing arrived, so it waits and takes your SOL back about 15 minutes before the confirmation deadline, which can be almost 3 hours after you started. If you close Silo, it does this when you open it again.'],
 ['If the maker does not finish','After you confirm that your XMR arrived, the maker has up to 2 hours to start its claim and then up to 1 hour to finish it. Your SOL stays locked until both have run out, so if the maker goes quiet at that point your refund can take up to 3 hours. Silo takes it back by itself while it is open, or when you open it again.'],
 ['Beta','Small amounts only. Software not externally audited.']];
async function post(action:string,body:unknown){
 const response=await sessionRpcFetch(`/api/silo/atomic/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const result:unknown=await response.json().catch(()=>null);
 if(!response.ok)throw Object.assign(Error(typeof (result as {error?:unknown})?.error==='string'?(result as {error:string}).error:'The swap service is unavailable right now.'),{userFacing:response.status===422});
 return result;
}

export function SiloAtomicReversePanel({enabled=false,recoveryOnly=false,network='mainnet',owner=null,sign=null,bridge=null,capXmr=null}:{enabled?:boolean;recoveryOnly?:boolean;network?:'mainnet'|'devnet';owner?:string|null;sign?:((encoded:string,expected:unknown)=>string)|null;bridge?:SiloReverseBridge|null;capXmr?:string|null}){
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
 const finished=Object.values(views).filter(view=>!reverseRecordActive(view.record));
 const amountValid=/^\d{1,4}(\.\d{1,12})?$/.test(amount)&&Number(amount)>0;
 const quoteLive=quote!==null&&Math.floor(clock/1000)<quote.expiresAt;
 const solanaReady=typeof owner==='string'&&owner.length>0&&typeof sign==='function',walletReady=Boolean(bridge?.available);
 async function getQuote(){
  if(!amountValid||quoting)return;setQuoting(true);setError('');setQuote(null);
  try{const result=await post('rev-quote',{xmr:amount}) as SiloReverseQuote;if(result?.direction!=='sol-xmr'||typeof result.xmrAtomic!=='string'||!Number.isSafeInteger(result.lamports))throw Error('The quote could not be read.');setQuote(result);setClock(Date.now());}
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
  const held=holdEnd(r)>clock,notice=held?'Keep this page open until your XMR arrives.':undefined;
  const n=Math.max(0,Math.min(XMR_TARGET_CONFIRMATIONS,Number(view.confirmations??r.xmrConfirmations??0)||0));
  switch(view.phase){
   case 'locking':return {tone:'wait',kicker:'Now',title:'Locking your SOL',body:'Your Silo Solana wallet signs one lock into the swap program. It can only go to the maker if your XMR arrives first.',facts:[KEEP],next:'The maker sends your XMR to a shared Monero address.',notice};
   case 'awaiting-maker-xmr':return {tone:'wait',kicker:'Now',title:'The maker is sending your XMR',body:'Silo watches the shared Monero address itself. If nothing arrives within about 30 minutes, Silo returns your SOL. If Silo cannot check Monero it waits longer; the conditions below say how long.',facts:[refundBy,KEEP],next:`${XMR_TARGET_CONFIRMATIONS} Monero confirmations, then the XMR is yours.`,notice};
   case 'xmr-confirming':if(view.scanFailed)return {tone:'warn',kicker:'Check failed',title:'Silo cannot check Monero right now',body:'This device could not read the Monero network, so Silo cannot tell whether your XMR has arrived. Your SOL stays locked in the swap program and only you can take it back. Silo keeps trying. If it cannot confirm the XMR, it returns your SOL about 15 minutes before the confirmation deadline, which can be almost 3 hours after you started.',facts:[refundBy,KEEP],next:'Keep this page open. Nothing is sent to the maker until Silo has seen the XMR itself.',notice};
    return {tone:'wait',kicker:'Monero confirmations',title:`${n} of ${XMR_TARGET_CONFIRMATIONS} confirmations`,meter:n,body:'Usually about 35 minutes in all, sometimes longer. No action needed.',facts:[refundBy,KEEP],next:`At ${XMR_TARGET_CONFIRMATIONS} confirmations Silo releases the SOL to the maker.`,notice};
   case 'confirming':return {tone:'wait',kicker:'Now',title:'Your XMR arrived',body:`Silo saw ${xmr} XMR with ${XMR_TARGET_CONFIRMATIONS} confirmations and tells the swap program the maker may take the SOL.`,facts:[KEEP],next:'The maker claims the SOL, which gives Silo the key to your XMR.',notice};
   case 'await-claim':return {tone:'wait',kicker:'Now',title:'The maker is claiming the SOL',body:'When it does, Silo gets the key to the shared address and moves your XMR into your wallet. If the maker goes quiet, your SOL comes back after up to 3 hours.',facts:[KEEP],next:'Your XMR moves into your Silo Monero wallet.',notice};
   case 'sweeping':return {tone:'wait',kicker:'Now',title:'Moving your XMR into your wallet',body:'One Monero transaction from the shared address to your own Silo Monero address.',facts:[KEEP],next:'The XMR shows in your Monero wallet after Monero confirmations.',notice};
   case 'refunding':return {tone:'warn',kicker:'The maker did not deliver',title:'Returning your SOL',body:'The XMR did not arrive in full in time, so Silo is taking your SOL back from the swap program. Nothing else is needed.',facts:[refundBy,KEEP],next:'Your SOL returns to your Silo Solana wallet.',notice};
   default:return {tone:'wait',kicker:'Now',title:'Setting up the swap',body:'Silo is checking the maker’s offer. Nothing has been locked.',next:'Your Silo Solana wallet locks the SOL.'};
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
   <div className="silo-inset sx-now" data-tone={now.tone} data-now-card>
    <p className="sx-now-k">{now.kicker}</p><p className="sx-now-t" role="status">{now.title}</p>
    {now.meter!==undefined&&<span className="sx-meter" role="meter" aria-valuemin={0} aria-valuemax={XMR_TARGET_CONFIRMATIONS} aria-valuenow={now.meter} aria-label={`${now.meter} of ${XMR_TARGET_CONFIRMATIONS} Monero confirmations`}>{Array.from({length:XMR_TARGET_CONFIRMATIONS},(_,i)=><i key={i} data-on={i<(now.meter as number)?'':undefined} data-now={i===now.meter?'':undefined}/>)}</span>}
    <p className="sx-now-b">{now.body}</p>
    {now.notice&&<p className="sx-now-n">{now.notice}</p>}
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
  {shown.length===0&&!recoveryOnly&&<div className="sx-main">
   <div className="sx-pair">
    <div className={`sx-leg sx-get${quoted?' sx-quoted':''}`}><div className="sx-leg-head"><span>You pay</span><span>{quoted?`Includes the ${spread}% maker spread`:'From your Silo Solana wallet'}</span></div>
     <div className="sx-leg-row">{quoted?<p className="sx-big" aria-label={`${sol(q.lamports)} SOL`}>{sol(q.lamports)}<span className="sx-unit">SOL</span></p>:<p className="sx-big sx-none" aria-label="Not quoted yet">–<span className="sx-unit">SOL</span></p>}<SiloAssetIcon asset="sol"/></div></div>
    <p className={`sx-rate${quoted?'':' sx-rate-empty'}`}>{quoted?<><span>Market 1 XMR ≈ <b>{atomicRateText(q.solPerXmr)} SOL</b></span><span className="sx-rate-t" role="timer" aria-label={`Offer valid for ${countdown(q.expiresAt-clock/1000)}`}>{countdown(q.expiresAt-clock/1000)}</span></>:expired?<span role="status">Offer expired. Nothing was started.</span>:'Rate after you get an offer'}</p>
    <div className="silo-window sx-leg" data-zone="private"><div className="sx-leg-head"><span>You get</span><span id="sx-rev-cap">{capXmr?`Max ${capXmr} XMR in the beta`:'XMR'}</span></div>
     <div className="sx-leg-row"><label className="sx-amount">Amount in XMR<input inputMode="decimal" placeholder="0" value={amount} size={Math.max(1,(amount||'0').length)} aria-describedby="sx-rev-cap" disabled={busy||quoting} onChange={event=>{setAmount(event.target.value.trim());setQuote(null);setError('');}}/><span className="sx-unit" aria-hidden="true">XMR</span></label><SiloAssetIcon asset="xmr"/></div></div>
   </div>
   {quoted?<button type="button" className="silo-primary sx-go" data-primary disabled={busy||!solanaReady||!walletReady} onClick={()=>void swap()}>{busy?'Starting…':'Start swap'}</button>
    :<button type="button" className="silo-primary sx-go" data-primary disabled={!amountValid||quoting||busy||!solanaReady||!walletReady} onClick={()=>void getQuote()}>{quoting?'Getting offer…':expired?'Get a new offer':'Get offer'}</button>}
   <ul className="sx-brief" aria-label="Before you start"><li><b>Keep this page open</b> for about 40 minutes, until your XMR arrives.</li><li><b>The maker cannot take your SOL</b> before Silo confirms your XMR arrived. If it does not deliver, Silo returns your SOL.</li>{quoted&&<li><b>Starting locks {sol(q.lamports)} SOL</b> in the swap program, plus a {sol(RENT_LAMPORTS)} SOL account deposit you get back.</li>}</ul>
   {error&&<p role="alert" className="exposure-error">{error}</p>}
   {quoted&&<section className="sx-terms sx-costs" aria-labelledby="sx-rev-costs-h"><h3 id="sx-rev-costs-h">What this offer costs</h3><dl>
    <div><dt>Market price</dt><dd>1 XMR ≈ {atomicRateText(q.solPerXmr)} SOL{source?`, from ${source}`:''}</dd></div>
    <div><dt>Maker spread</dt><dd>{spread}%. Already included in what you pay.</dd></div>
    <div><dt>Solana network fees</dt><dd>About {sol(TX_FEE*2)} SOL for the lock and the release, from your Silo Solana wallet. The {sol(RENT_LAMPORTS)} SOL account deposit comes back when the swap ends.</dd></div>
    <div><dt>Monero network fee</dt><dd>One fee for moving the XMR into your wallet, taken from the XMR you get.</dd></div>
    <div><dt>Service fee</dt><dd>None besides the maker spread.</dd></div>
   </dl></section>}
   <section className="sx-terms" aria-labelledby="sx-rev-terms-h"><h3 id="sx-rev-terms-h">All conditions</h3><dl>{TERMS.map(([term,text])=><div key={term}><dt>{term}</dt><dd>{text}</dd></div>)}</dl></section>
  </div>}
  {shown.length>0&&error&&<p role="alert" className="exposure-error">{error}</p>}
  {shown.map(swapView)}
  </>}
 </section>;
}

/** The two no-bridge directions, one tap apart. Sets data-sx-dir on .silo-app; silo.css shows the matching panel. */
export function SiloAtomicDirectionSwitch({value,onChange}:{value:'xmr-sol'|'sol-xmr';onChange:(next:'xmr-sol'|'sol-xmr')=>void}){
 const root=useRef<HTMLElement|null>(null);
 useEffect(()=>{const app=root.current?.closest('.silo-app');if(!app)return undefined;app.setAttribute('data-sx-dir',value);return()=>{app.removeAttribute('data-sx-dir');};},[value]);
 const option=(id:'xmr-sol'|'sol-xmr',from:'xmr'|'sol',to:'xmr'|'sol')=><button type="button" role="radio" aria-checked={value===id} data-on={value===id?'':undefined} onClick={()=>onChange(id)}><SiloAssetIcon asset={from}/><span>{from.toUpperCase()}</span><span aria-label="to">→</span><span>{to.toUpperCase()}</span><SiloAssetIcon asset={to}/></button>;
 return <section id="silo-atomic-dir" ref={root} className="sx-dir" role="radiogroup" aria-label="Swap direction">{option('xmr-sol','xmr','sol')}{option('sol-xmr','sol','xmr')}</section>;
}
