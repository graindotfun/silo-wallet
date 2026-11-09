'use client';
import {sessionRpcFetch} from '@/lib/browser-rpc-session.mjs';
import {useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {atomicIdlePhase,atomicRateText,atomicRecordActive,atomicSendBy,atomicTargetConfirmations,createAtomicDriver,ATOMIC_POLL_MS} from '@/lib/silo/atomic-driver.mjs';
import {SiloAssetIcon} from '@/components/silo-asset-icon';
import {publishAtomicPending} from '@/lib/silo/atomic-pending.mjs';
import {siloUnits} from '@/lib/silo/amounts.mjs';
/** "Swap XMR to SOL, no bridge (beta)". The user sends XMR to a joint Monero address; the maker has already locked SOL in a Solana program;
 * the claim reveals the user's secret on chain and delivers the SOL to her own Silo Solana address. If the maker refunds, the revealed
 * maker secret lets her recover the XMR. This panel NEVER signs with the user's Solana wallet key: the only transaction is the claim,
 * signed by a throwaway fee-payer key kept inside the (encrypted) swap record. */
export type SiloAtomicKeys={primaryAddress:string;privateSpendKey:string;privateViewKey:string;restoreHeight:number};
export type SiloAtomicQuote={quoteId:string;swapId:string;xmrAtomic:string;lamports:number;gasLamports?:number;solPerXmr:number;spreadBps:number;priceSource?:string;expiresAt:number};
type SwapRecord={kind:string;swapId:string;status:string;result?:string;quote:SiloAtomicQuote;[key:string]:unknown};
export type SiloAtomicNativeBridge={network:'mainnet'|'stagenet';available:boolean;records:()=>SwapRecord[];saveRecord:(record:SwapRecord)=>Promise<void>;lockStatus:(query:{address:string;amountAtomic:string})=>Promise<{found:boolean;txid:string|null;confirmations:number|null;height:number|null}>;daemonHeight:()=>Promise<number|null>;prepareLock:(request:{address:string;amountAtomic:string;swapId:string;expiresAt:number})=>Promise<void>;sweepRecovery:(keys:SiloAtomicKeys)=>Promise<string[]>};
type View={record:SwapRecord;phase:string;confirmations:number|null;notice?:string;recoveryKeys?:SiloAtomicKeys;refundFrom?:number|null;resumedPhase?:string|null};
// Round-3 design (owner-approved for preparation, 4 Nov 2026; HANDOFF-SPEC.md). Every number on this screen comes from the live
// maker quote (solPerXmr, spreadBps, lamports, gasLamports, priceSource) or the swap record; CLAIM_FEE is the protocol constant.
const CLAIM_FEE=5000,DEADLINE_MARGIN_S=300;
const FINAL_TEXT:Record<string,string>={'sol-received':'Done. Your SOL arrived at your Silo Solana address.','xmr-recovered':'The claim deadline passed and the maker refunded the SOL lock. No SOL arrived for this swap.',cancelled:'Cancelled before any XMR was sent. Nothing was spent.','quote-expired':'This offer expired before any XMR was sent. Nothing was spent.','bad-terms':'The on-chain lock did not match your offer, so no XMR was sent. Nothing was spent.','too-late-to-lock':'It was too late to lock XMR safely, so none was sent. Nothing was spent.','maker-answer-rejected':'The offer did not check out, so no XMR was sent. Nothing was spent.'};
type Now={tone:'wait'|'act'|'warn';kicker:string;title:string;body:string;meter?:number;facts?:[string,string][];next:string;notice?:string};
type Stop={id:string;label:string;detail?:string;state:'done'|'now'|'next'|'stop'};
const KEEP:[string,string]=['Needs','Silo open with Monero unlocked'];
// Leave and return (owner decision, 5 Nov 2026): no idle-lock hold, and the page never has to stay open. The swap record is encrypted in
// the wallet; every unlock resumes it (runAll below), and the claim needs only the record's own fee payer, not the user's key.
const TERMS:[string,string][]=[['You can close Silo','Keep Silo open only until you confirm the XMR payment in your Monero wallet. After that you can close this page, lock your phone or let Silo lock itself: the swap is saved, encrypted, in your wallet. Nothing runs in the background, so open and unlock Silo again before the claim deadline so it can try the SOL claim. The Monero confirmations take about half an hour.'],['Send the XMR soon','The maker locks the SOL first. If your XMR has not arrived in about 30 minutes, the maker cancels and nothing is spent.'],['A claim deadline','Silo shows it as soon as the SOL is locked. If you are not back in Silo before it, the SOL can no longer be claimed. Getting your XMR back then needs the maker to return the SOL lock and reveal its key part; expiry alone does not return your XMR. Once the maker has, open and unlock Silo and it returns the XMR.'],['Beta','Small amounts only. Software not externally audited.']];
/** What the claim delivers: the escrow plus the rest of the maker's fee allowance after the one claim fee (E18: exact to the lamport). */
export function atomicYouGetLamports(quote:{lamports:number;gasLamports?:number}){const gas=Number.isSafeInteger(quote.gasLamports)&&(quote.gasLamports as number)>0?quote.gasLamports as number:0;return quote.lamports+(gas?gas-CLAIM_FEE:0);}
const clockText=(seconds:number|null|undefined)=>{if(!Number.isFinite(seconds))return '-';const at=new Date((seconds as number)*1000),now=new Date();const hm=at.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false});return at.toDateString()===now.toDateString()?`${hm} today`:`${hm} ${at.toLocaleDateString([],{day:'numeric',month:'short'})}`;};
/** "3 h 40 min left" / "25 min left" / "less than a minute left", from the record's own time and this page's clock. */
const leftText=(seconds:number|null|undefined,nowMs:number)=>{if(!Number.isFinite(seconds))return '';const left=Math.floor((seconds as number)-nowMs/1000);if(left<=0)return '';const minutes=Math.floor(left/60);if(minutes<1)return 'less than a minute left';const h=Math.floor(minutes/60),m=minutes%60;return h?`${h} h ${m} min left`:`${m} min left`;};
const untilText=(seconds:number|null|undefined,nowMs:number)=>{const left=leftText(seconds,nowMs);return left?`${clockText(seconds)} · ${left}`:clockText(seconds);};
const WIDE_QUERY='(min-width:1100px)';
const subscribeWide=(changed:()=>void)=>{if(typeof matchMedia!=='function')return ()=>{};const query=matchMedia(WIDE_QUERY);query.addEventListener('change',changed);return ()=>query.removeEventListener('change',changed);};
const wideSnapshot=()=>typeof matchMedia==='function'&&matchMedia(WIDE_QUERY).matches;
const countdown=(seconds:number)=>{const left=Math.max(0,Math.floor(seconds));return `${Math.floor(left/60)}:${String(left%60).padStart(2,'0')}`;};
const sourceName=(source:unknown)=>source==='coingecko'?'CoinGecko':typeof source==='string'&&/^[\w .-]{1,40}$/.test(source)?source:null;
async function post(action:string,body:unknown){
 // Through the RPC session helper: it opens (and once renews) the short-lived Silo connection session these routes require.
 const response=await sessionRpcFetch(`/api/silo/atomic/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const result:unknown=await response.json().catch(()=>null);
 if(!response.ok)throw Object.assign(Error(typeof (result as {error?:unknown})?.error==='string'?(result as {error:string}).error:'The swap service is unavailable right now.'),{userFacing:response.status===422});
 return result;
}
/** The program id comes from the server's public configuration and is set explicitly before the flow is used. */
async function loadFlow(programId:string){
 const solModule=await import('@/lib/silo/atomic-swap/sol.mjs');
 solModule.setProgramId(programId);
 return import('@/lib/silo/atomic-swap/alice-flow.mjs');
}
const sol=(lamports:number)=>siloUnits(String(lamports),9),xmrText=(atomic:string)=>siloUnits(atomic,12);
export function SiloAtomicPanel({enabled=false,network='mainnet',programId=null,claimer=null,bridge=null,capXmr=null}:{enabled?:boolean;network?:'mainnet'|'devnet';programId?:string|null;claimer?:string|null;bridge?:SiloAtomicNativeBridge|null;capXmr?:string|null}){
 const [amount,setAmount]=useState(''),[quote,setQuote]=useState<SiloAtomicQuote|null>(null),[quoting,setQuoting]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 // Desktop rail (1100 px and up) opens All steps; read without a state update in an effect, and closed on the server.
 const wide=useSyncExternalStore(subscribeWide,wideSnapshot,()=>false);
 const [views,setViews]=useState<Record<string,View>>({}),[ready,setReady]=useState(false),[clock,setClock]=useState(()=>Date.now());
 const bridgeRef=useRef(bridge),driver=useRef<ReturnType<typeof createAtomicDriver>|null>(null),running=useRef(false);
 useEffect(()=>{bridgeRef.current=bridge;});
 // The driver talks to the wallet only through this stable proxy, so a re-issued bridge never restarts a swap.
 useEffect(()=>{
  if(!enabled||!programId)return;let live=true;
  void loadFlow(programId).then(flow=>{
   if(!live)return;
   const need=()=>{const current=bridgeRef.current;if(!current)throw Error('Open your Monero wallet to continue the swap.');return current;};
   driver.current=createAtomicDriver({flow,post,network,bridge:{saveRecord:(record:SwapRecord)=>need().saveRecord(record),lockStatus:(query:{address:string;amountAtomic:string})=>need().lockStatus(query),prepareLock:(request:{address:string;amountAtomic:string;swapId:string;expiresAt:number})=>need().prepareLock(request),daemonHeight:()=>need().daemonHeight(),sweepRecovery:(keys:SiloAtomicKeys)=>need().sweepRecovery(keys)}});
   setReady(true);
  }).catch(()=>{if(live)setError('The swap code could not be loaded.');});
  return()=>{live=false;driver.current=null;setReady(false);};
 },[enabled,programId,network]);
 // After a reload or an unlock, the first view of a swap that was already running says so once, until its next phase change.
 const [loadedAt]=useState(()=>Date.now());
 const runAll=useCallback(async()=>{
  const current=bridgeRef.current,active=driver.current;if(!current?.available||!active||running.current)return;running.current=true;
  try{
   for(const record of current.records().filter(atomicRecordActive)){
    try{const view=await active.tick(record) as View;setViews(previous=>({...previous,[record.swapId]:{...view,resumedPhase:previous[record.swapId]?previous[record.swapId].resumedPhase??null:Number(record.acceptedAt)*1000<loadedAt?view.phase:null}}));}
    catch(failure){setViews(previous=>({...previous,[record.swapId]:{record,phase:previous[record.swapId]?.phase??atomicIdlePhase(record),confirmations:previous[record.swapId]?.confirmations??null,notice:'Checking again shortly.'}}));void failure;}
   }
  }finally{running.current=false;}
 },[loadedAt]);
 // Resume: whenever the wallet bridge appears, every saved swap that is not done continues; then every 20 s while this page is open.
 const available=Boolean(bridge?.available);
 useEffect(()=>{
  if(!enabled||!ready||!available)return;void runAll();
  const timer=setInterval(()=>void runAll(),ATOMIC_POLL_MS);const tick=setInterval(()=>setClock(Date.now()),1000);
  return()=>{clearInterval(timer);clearInterval(tick);};
 },[enabled,ready,available,runAll]);
 // Saved swaps are listed whenever the Monero wallet is open, also while it is held from sending (for example until its backup is
 // verified again): a swap in progress never looks gone. They advance only while the wallet is available.
 const activeRecords=(bridge?bridge.records():[]).filter(atomicRecordActive);
 const finished=Object.values(views).filter(view=>!atomicRecordActive(view.record));
 const amountValid=/^\d{1,4}(\.\d{1,12})?$/.test(amount)&&Number(amount)>0;
 const quoteLive=quote!==null&&Math.floor(clock/1000)<quote.expiresAt;
 const solanaReady=typeof claimer==='string'&&claimer.length>0,walletReady=Boolean(bridge?.available);
 async function getQuote(){
  if(!amountValid||quoting)return;setQuoting(true);setError('');setQuote(null);
  try{const result=await post('quote',{xmr:amount}) as SiloAtomicQuote;if(typeof result?.xmrAtomic!=='string'||!Number.isSafeInteger(result.lamports))throw Error('The quote could not be read.');setQuote(result);setClock(Date.now());}
  catch(failure){setError(failure instanceof Error&&(failure as {userFacing?:boolean}).userFacing?failure.message:'A quote is unavailable right now. Nothing was started.');}
  finally{setQuoting(false);}
 }
 async function swap(){
  const active=driver.current;if(!active||!quote||!quoteLive||!solanaReady||!walletReady||busy||activeRecords.length>0)return;
  setBusy(true);setError('');
  try{await active.start({quote,claimer:claimer as string});setQuote(null);setAmount('');await runAll();}
  catch(failure){setError(failure instanceof Error&&(failure as {userFacing?:boolean}).userFacing?failure.message:'The swap could not be started. Nothing was sent; check Unfinished swaps below before trying again.');}
  finally{setBusy(false);}
 }
 const [revealed,setRevealed]=useState<Record<string,boolean>>({});
 // While a swap is running or just finished, the task selector steps back (shell CSS: .silo-app[data-sx-active] .silo-task).
 const root=useRef<HTMLElement|null>(null);
 const engaged=enabled&&(activeRecords.length>0||finished.length>0);
 useEffect(()=>{const app=root.current?.closest('.silo-app');if(!app)return undefined;if(engaged)app.setAttribute('data-sx-active','');else app.removeAttribute('data-sx-active');return()=>{app.removeAttribute('data-sx-active');};},[engaged]);
 // Home and Activity show a pending-swap card from this summary (lib/silo/atomic-pending.mjs). Empty while Silo is locked.
 const pendingKey=JSON.stringify(enabled?activeRecords.map(record=>{const t1=Number(record.t1);return {swapId:record.swapId,short:record.swapId.slice(0,4).toUpperCase(),phase:views[record.swapId]?.phase??atomicIdlePhase(record),xmr:xmrText(record.quote.xmrAtomic),sol:sol(atomicYouGetLamports(record.quote)),claimBy:Number.isSafeInteger(t1)?t1-DEADLINE_MARGIN_S:null,sendBy:atomicSendBy(record)};}):[]);
 useEffect(()=>{publishAtomicPending(JSON.parse(pendingKey));},[pendingKey]);
 useEffect(()=>()=>publishAtomicPending([]),[]);
 const nowFor=(view:View):Now=>{
  const {record}=view,target=atomicTargetConfirmations(record);
  const xmr=xmrText(record.quote.xmrAtomic),t1=Number(record.t1),claimBy=Number.isFinite(t1)?t1-DEADLINE_MARGIN_S:null,deadline:[string,string]=['Claim deadline',untilText(claimBy,clock)];
  const leave=`You can close this. Your SOL waits for you until ${clockText(claimBy)}. Open Silo to collect it.`;
  const n=Math.max(0,Math.min(target,Number.isFinite(view.confirmations)?view.confirmations as number:Number(record.xmrConfirmations??0)||0));
  switch(view.phase){
   case 'checking-lock':return {tone:'wait',kicker:'Now',title:'Checking the SOL lock on Solana',body:'The maker’s lock was found. Silo checks it on an independent Solana node before you send anything.',next:'You send the XMR once the check passes.'};
   case 'awaiting-xmr':return {tone:'act',kicker:`Your step · send by ${untilText(atomicSendBy(record),clock)}`,title:`Send exactly\u00a0${xmr}\u00a0XMR`,body:'The payment is ready in your Monero wallet, with its network fee. Nothing is sent until you confirm there.',facts:[['Keep','Silo open until you confirm the payment']],next:`${target} Monero confirmations, then Silo claims your SOL. Once the XMR is sent you can close Silo.`};
   case 'confirming':return {tone:'wait',kicker:'Monero confirmations',title:`${n} of ${target} confirmations`,meter:n,body:`Usually about ${target*2+15} minutes in all, sometimes longer. No action needed.`,facts:[deadline],next:`At ${target} confirmations Silo claims your SOL: right away while it is open, otherwise the next time you open and unlock it, before the claim deadline.`,notice:leave};
   case 'claiming':return {tone:'wait',kicker:'Now',title:'Claiming your SOL',body:'The claim was sent to Solana. While Silo is open and unlocked it checks that the claim landed and retries.',facts:[deadline],next:'The SOL shows at your Silo Solana address.',notice:'You can close this, but nothing runs while Silo is closed or locked. If the claim has not landed yet, open and unlock Silo before the deadline so it can send it again.'};
   case 'awaiting-refund':return {tone:'warn',kicker:`Claim deadline passed at ${clockText(Number.isFinite(t1)?t1-DEADLINE_MARGIN_S:null)}`,title:'Waiting for the maker’s refund',body:'The SOL can no longer be claimed. Your XMR comes back only if the maker returns the SOL lock and reveals its key part; expiry alone does not return it. Once the maker has, open and unlock Silo and it returns the XMR.',facts:[['Maker can refund from',(()=>{const from=view.refundFrom??(Number.isFinite(t1)?t1:null),left=leftText(from,clock);return left?`${clockText(from)} · in ${left.replace(' left','')}`:clockText(from);})()],KEEP],next:'Silo returns your XMR to your Monero wallet.'};
   case 'recovering':return {tone:'wait',kicker:'Refund in progress',title:'Returning your XMR',body:'The maker refunded the SOL lock, so your XMR can come back. Silo does this while it is open with your Monero wallet unlocked; if you close or lock it, it continues only after you open and unlock it again.',facts:[KEEP],next:'The XMR shows in your Monero wallet after Monero confirmations.'};
   case 'stopped':return {tone:'wait',kicker:'Now',title:'The maker cancelled this offer',body:'Nothing was spent. While Silo is open and unlocked it watches for a late payment, then closes this swap.',facts:[KEEP],next:'If you did send XMR, it comes back only if the maker returns the SOL lock.'};
   default:return {tone:'wait',kicker:'Now',title:'Waiting for the maker to lock the SOL',body:'No action needed. Nothing has left your wallet.',next:'You send the XMR once the lock is checked.'};
  }
 };
 const refundPhase=(view:View)=>view.phase==='awaiting-refund'||view.phase==='recovering';
 const stopsFor=(view:View):Stop[]=>{
  const xmr=xmrText(view.record.quote.xmrAtomic),p=view.phase;
  if(refundPhase(view))return [{id:'send',label:`You sent ${xmr} XMR`,state:'done'},{id:'stop',label:p==='awaiting-refund'?'Claim deadline passed':'Swap did not finish',detail:'No SOL will arrive for this swap.',state:'stop'},{id:'refund',label:p==='recovering'?'Maker refunded the SOL lock':'Maker refunds the SOL lock',state:p==='recovering'?'done':'now'},{id:'ret',label:'Silo returns your XMR',state:p==='recovering'?'now':'next'},{id:'back',label:'XMR sent back to your Monero wallet',state:'next'}];
  const order=['waiting-maker','checking-lock','awaiting-xmr','confirming','claiming'],at=Math.max(0,order.indexOf(p));
  const st=(i:number):Stop['state']=>i<at?'done':i===at?'now':'next';
  return [{id:'offer',label:'Offer accepted',state:'done'},{id:'lock',label:at>1?'SOL locked · verified on Solana':at===1?'SOL lock found · checking it on Solana':'Maker locks the SOL',state:at<=1?'now':'done'},{id:'send',label:at>2?`You sent ${xmr} XMR`:`You send ${xmr} XMR`,state:st(2)},{id:'conf',label:at>3?`${atomicTargetConfirmations(view.record)} Monero confirmations`:'Monero confirmations',state:st(3)},{id:'claim',label:at===4?'Claiming your SOL':'SOL arrives at your Silo Solana address',state:st(4)}];
 };
 const recovery=(view:View)=>{const id=view.record.swapId,keys=view.recoveryKeys;if(!keys&&!refundPhase(view))return null;
  return <details className="sx-more sx-help"><summary><span>Need help with this swap?</span><span className="sx-more-k">Recover manually</span></summary><div className="sx-help-body"><p>If the automatic return does not finish, you can restore this swap&apos;s Monero keys in any Monero wallet. Anyone with these keys can take the XMR. Show them only on a device you trust.</p>
   {keys&&revealed[id]?<dl className="sx-keys"><dt>Address</dt><dd><code className="exposure-address">{keys.primaryAddress}</code></dd><dt>Private spend key</dt><dd><code className="exposure-address">{keys.privateSpendKey}</code></dd><dt>Private view key</dt><dd><code className="exposure-address">{keys.privateViewKey}</code></dd><dt>Restore height</dt><dd>{keys.restoreHeight}</dd></dl>
   :keys?<button type="button" onClick={()=>setRevealed(previous=>({...previous,[id]:true}))}>Show recovery keys</button>:<p>The keys appear here once the maker’s refund is seen on Solana.</p>}</div></details>;};
 const clear=(swapId:string)=>setViews(previous=>{const next={...previous};delete next[swapId];return next;});
 const swapView=(view:View)=>{
  const {record}=view,final=!atomicRecordActive(record),result=record.result??'',id8=record.swapId.slice(0,4).toUpperCase(),xmr=xmrText(record.quote.xmrAtomic),youGet=sol(atomicYouGetLamports(record.quote));
  if(final&&result==='sol-received')return <div className="sx-main" key={record.swapId} data-swap={record.swapId.slice(0,8)} aria-label="Swap result">
   <p className="sx-sum"><span className="sx-id">Swap {id8}</span></p>
   <div className="silo-inset sx-done" data-now-card><div className="silo-sent-mark" aria-hidden="true"><span><svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span></div>
    <p className="sx-word" role="status">Received</p><p className="sx-done-k">Amount in your offer</p><p className="sx-done-amt">{youGet}<span className="sx-unit">SOL</span></p><p className="sx-done-t">at your Silo Solana address · for {xmr} XMR</p><p className="sx-fine">Activity shows what arrived.</p></div>
   <button type="button" className="silo-primary sx-go" data-primary onClick={()=>{location.hash='#wallets/sol';}}>See your SOL</button>
   <button type="button" className="sx-go" onClick={()=>{location.hash='#activity/sol';}}>View in Activity</button>
   <button type="button" className="sx-text" onClick={()=>clear(record.swapId)}>Start another swap</button></div>;
  if(final){const refunded=result==='xmr-recovered';return <div className="sx-main" key={record.swapId} data-swap={record.swapId.slice(0,8)} aria-label="Swap result">
   <p className="sx-sum"><span className="sx-id">Swap {id8}</span></p>
   <div className="silo-inset sx-done sx-ended" data-now-card><p className="sx-word" role="status">{refunded?'XMR sent back':'Nothing was sent'}</p><p className="sx-done-amt sx-x">{refunded?<span className="sx-approx">≈</span>:null}{xmr}<span className="sx-unit">XMR</span></p><p className="sx-done-t">{refunded?'to your Monero wallet, less one Monero network fee. It shows there after Monero confirmations.':'still in your Monero wallet'}</p><p className="sx-fine">{FINAL_TEXT[result]??'This swap is finished.'}</p></div>
   <button type="button" className="silo-primary sx-go" data-primary onClick={()=>{if(refunded)location.hash='#wallets/xmr';else clear(record.swapId);}}>{refunded?'See your XMR':'Get a new offer'}</button>
   {refunded&&<button type="button" className="sx-go" onClick={()=>{location.hash='#activity/xmr';}}>View in Activity</button>}</div>;}
  const now=nowFor(view),stops=stopsFor(view),stepAt=Math.max(1,stops.findIndex(stop=>stop.state==='now')+1),done=stops.filter(stop=>stop.state==='done'||stop.state==='stop').length;
  return <div className="sx-main" key={record.swapId} data-swap={record.swapId.slice(0,8)} aria-label="Swap progress">
   <p className="sx-sum"><span className="sx-id">Swap {id8}</span>{refundPhase(view)?<span className="sx-amounts"><span className="sx-x">{xmr} XMR</span> <span className="sx-mute">· no SOL for this swap</span></span>:<span className="sx-flow sx-amounts"><span className="sx-x">{xmr} XMR</span><span aria-label="to">→</span><span className="sx-s">{youGet} SOL</span></span>}</p>
   <div className="sx-strip"><span className="sx-segs" aria-hidden="true">{stops.map(stop=><i key={stop.id} data-state={stop.state}/>)}</span><span className="sx-strip-t">Step {stepAt} of {stops.length}</span></div>
   <div className={now.tone==='act'?'silo-window sx-now':'silo-inset sx-now'} data-zone={now.tone==='act'?'private':undefined} data-tone={now.tone} data-now-card>
    <p className="sx-now-k">{now.kicker}</p><p className="sx-now-t" role="status">{now.title}</p>
    {now.meter!==undefined&&<span className="sx-meter" role="meter" aria-valuemin={0} aria-valuemax={atomicTargetConfirmations(record)} aria-valuenow={now.meter} aria-label={`${now.meter} of ${atomicTargetConfirmations(record)} Monero confirmations`}>{Array.from({length:atomicTargetConfirmations(record)},(_,i)=><i key={i} data-on={i<(now.meter as number)?'':undefined} data-now={i===now.meter?'':undefined}/>)}</span>}
    <p className="sx-now-b">{now.body}</p>
    {now.tone==='act'&&<button type="button" className="silo-primary sx-go" data-primary onClick={()=>{location.hash='#wallets/xmr';}}>Review in Monero wallet</button>}
    {view.resumedPhase&&view.resumedPhase===view.phase&&<p className="sx-now-n">Picked up where it left off. The deadline still applies.</p>}
    {now.notice&&<p className="sx-now-n">{now.notice}</p>}
    {view.notice&&<p className="sx-now-n">{view.notice}</p>}
    {now.facts?.length?<dl className="sx-facts">{now.facts.map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>:null}
   </div>
   <p className="sx-next"><b>Next</b> {now.next}</p>
   <details className="sx-more sx-steps" open={wide||undefined}><summary><span>{done} of {stops.length} steps done</span><span className="sx-more-k">All steps</span></summary><ol className="sx-line" aria-label="Swap steps">{stops.map(stop=><li key={stop.id} data-state={stop.state}><span className="sx-dot" aria-hidden="true">{stop.state==='done'?'✓':stop.state==='stop'?'!':null}</span><span className="sx-step"><span className="sx-label">{stop.label}<span className="sx-vh">{stop.state==='done'?', done':stop.state==='now'?', now':stop.state==='stop'?', stopped':', next'}</span></span>{stop.detail&&<span className="sx-detail">{stop.detail}</span>}</span></li>)}</ol></details>
   {recovery(view)}
  </div>;
 };
 if(!enabled)return null;
 const shown=[...activeRecords.map(record=>views[record.swapId]??{record,phase:atomicIdlePhase(record),confirmations:null} as View),...finished.filter(view=>!activeRecords.some(record=>record.swapId===view.record.swapId))];
 const quoted=Boolean(quote&&quoteLive),expired=Boolean(quote&&!quoteLive),q=quote as SiloAtomicQuote;
 const spread=quoted?(q.spreadBps/100).toFixed(2).replace(/\.?0+$/,''):'';
 const spreadSol=quoted?sol(Math.round(Number(q.xmrAtomic)/1e12*q.solPerXmr*q.spreadBps/10000*1e9)):'';
 const source=quoted?sourceName(q.priceSource):null,gas=quoted&&Number.isSafeInteger(q.gasLamports)&&(q.gasLamports as number)>0?q.gasLamports as number:0;
 return <section id="silo-atomic" ref={root} className="exposure-panel sx" aria-labelledby="silo-atomic-heading" data-stage={shown.length?'active':quoted?'quote':expired?'expired':'start'}><h2 id="silo-atomic-heading" className="sx-vh">Swap XMR → SOL, no bridge (beta)</h2>
  {!bridge?<div className="sx-main"><div className="silo-inset sx-now sx-lockedbox" data-tone="warn"><p className="sx-now-k">Silo is locked</p><p className="sx-now-t">Unlock to continue a swap</p><p className="sx-now-b">A swap in progress is saved and waiting. Cancelling leaves Silo locked and pauses swap processing. Open your Monero wallet before the claim deadline so Silo can try the SOL claim. After the deadline, getting your XMR back needs the maker to return the SOL lock and reveal its key part; expiry alone does not return your XMR.</p><button type="button" className="silo-primary sx-go" data-primary onClick={()=>{location.hash='#wallets/xmr';}}>Unlock Monero wallet</button><p className="sx-now-n">Swap details stay encrypted in your wallet until you unlock, so Silo cannot show them here.</p></div></div>:<>
  {!solanaReady&&<p className="sx-notice" role="status">Open your Silo Solana wallet first. The SOL arrives there.</p>}
  {!walletReady&&<p className="sx-notice" role="status">Your Monero wallet is open but not ready to send yet (Wallets, then Monero). Saved swaps continue as soon as it is.</p>}
  {shown.length===0&&<div className="sx-main">
   <div className="sx-pair">
    <div className="silo-window sx-leg" data-zone="private"><div className="sx-leg-head"><span>You send</span><span id="sx-cap">{capXmr?`Max ${capXmr} XMR in the beta`:'XMR'}</span></div>
     <div className="sx-leg-row"><label className="sx-amount">Amount in XMR<input inputMode="decimal" enterKeyHint="done" data-amount-pad="" data-decimals={12} data-symbol="XMR" placeholder="0" value={amount} size={Math.max(1,(amount||'0').length)} aria-describedby="sx-cap" disabled={busy||quoting} onChange={event=>{setAmount(event.target.value.trim());setQuote(null);setError('');}}/><span className="sx-unit" aria-hidden="true">XMR</span></label><SiloAssetIcon asset="xmr"/></div></div>
    <p className={`sx-rate${quoted?'':' sx-rate-empty'}`}>{quoted?<><span>Market 1 XMR ≈ <b>{atomicRateText(q.solPerXmr)} SOL</b></span><span className="sx-rate-t" role="timer" aria-label={`Offer valid for ${countdown(q.expiresAt-clock/1000)}`}>{countdown(q.expiresAt-clock/1000)}</span></>:expired?<span role="status">Offer expired. Nothing was started.</span>:'Rate after you get an offer'}</p>
    {quoted&&<p className="sx-rate sx-fee-line">{spread}% spread{gas?` + ${sol(gas)} SOL gas`:''}</p>}
    <div className={`sx-leg sx-get${quoted?' sx-quoted':''}`}><div className="sx-leg-head"><span>You get</span><span>{quoted?`After the ${spread}% maker spread`:'To your Silo Solana address'}</span></div>
     <div className="sx-leg-row">{quoted?<p className="sx-big" aria-label={`${sol(atomicYouGetLamports(q))} SOL`}>{sol(atomicYouGetLamports(q))}<span className="sx-unit">SOL</span></p>:<p className="sx-big sx-none" aria-label="Not quoted yet">–<span className="sx-unit">SOL</span></p>}<SiloAssetIcon asset="sol"/></div></div>
   </div>
   {quoted?<button type="button" className="silo-primary sx-go" data-primary disabled={busy||!solanaReady||!walletReady} onClick={()=>void swap()}>{busy?'Starting…':'Start swap'}</button>
    :<button type="button" className="silo-primary sx-go" data-primary disabled={!amountValid||quoting||busy||!solanaReady||!walletReady} onClick={()=>void getQuote()}>{quoting?'Getting offer…':expired?'Get a new offer':'Get offer'}</button>}
   <ul className="sx-brief" aria-label="Before you start"><li><b>Nothing leaves your wallet</b> until you confirm the XMR in your Monero wallet.</li><li>Cancelling leaves Silo locked and pauses swap processing. Open your Monero wallet before the claim deadline so Silo can try the SOL claim. After the deadline, getting your XMR back needs the maker to return the SOL lock and reveal its key part; expiry alone does not return your XMR.</li></ul>
   {error&&<p role="alert" className="exposure-error">{error}</p>}
   {quoted&&<section className="sx-terms sx-costs" aria-labelledby="sx-costs-h"><h3 id="sx-costs-h">What this offer costs</h3><dl className="sx-kv">
    <div className="is-key"><dt>You get about</dt><dd>{sol(atomicYouGetLamports(q))} SOL</dd></div>
    <div className="is-key"><dt>Maker spread</dt><dd>{spread}%<small>About {spreadSol} SOL, already taken off what you get.</small></dd></div>
    <div className="is-key"><dt>Network gas</dt><dd>{gas?`${sol(gas)} SOL`:'0.000005 SOL'}<small>{gas?`The claim costs 0.000005 SOL, paid from the maker’s ${sol(gas)} SOL fee allowance. The rest of the allowance is included in what you get.`:'The claim costs 0.000005 SOL.'}</small></dd></div>
    <div><dt>Market price</dt><dd>1 XMR ≈ {atomicRateText(q.solPerXmr)} SOL{source?`, from ${source}`:''}</dd></div>
    <div><dt>Monero network fee</dt><dd>Shown in your Monero wallet’s review, before you confirm.</dd></div>
    <div><dt>Service fee</dt><dd>None besides the maker spread.</dd></div>
   </dl></section>}
   <section className="sx-terms sx-steps" aria-labelledby="sx-terms-h"><h3 id="sx-terms-h">How it works</h3>
    <ol className="sx-steplist"><li><b>The maker locks the SOL.</b> It waits on Solana for your XMR.</li><li><b>You send the XMR and confirm it.</b> You confirm in your Monero wallet. The maker cancels after about 30 minutes without it, and nothing is spent.</li><li><b>Keep Silo open until you confirm.</b> After that you can close it. The swap is saved, encrypted, in your wallet.</li><li><b>Open and unlock Silo before the claim deadline.</b> Silo then tries the SOL claim. Miss it and your XMR comes back only if the maker returns the SOL lock and reveals its key part.</li></ol>
    <p className="sx-beta">{TERMS[3][1]}</p>
    <details className="sx-more"><summary>Details</summary><dl className="sx-kv">{TERMS.slice(0,3).map(([term,text])=><div key={term}><dt>{term}</dt><dd>{text}</dd></div>)}</dl></details></section>
  </div>}
  {shown.length>0&&error&&<p role="alert" className="exposure-error">{error}</p>}
  {shown.map(swapView)}
  </>}
 </section>;
}
