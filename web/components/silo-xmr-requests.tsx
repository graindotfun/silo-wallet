'use client';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Check,Copy,Download,Link2,Share2} from 'lucide-react';
import {siloRequestUriQr} from '@/lib/silo/receive-qr.mjs';
import {buildMoneroUri,buildReceipt,buildRequestLink,parseRequestInput,requestAmountText,requestStatus,requestStatusText,SILO_REQUEST_NOTE_MAX} from '@/lib/silo/xmr-request.mjs';
import {SiloAddressText} from './silo-address-text';

/** The public page that shows a request. It is a static page: the whole request sits in the link after the #, which browsers never send to a server. */
export const SILO_PAY_PAGE='https://pay.silo.trading/';
type Payment={hash:string;amountAtomic:string;confirmed:boolean;confirmations?:number;failed:boolean;timestamp:number|null};
type RequestRow={index:number;address:string;createdAt:number;amountAtomic:bigint|null;note:string|null;payments:Payment[]|null};
export type SiloRequestWallet={createRequest:(input:{amountAtomic:bigint|null;note:string|null})=>Promise<{address:string;index:number}>;requestsOverview:()=>Promise<RequestRow[]>;requestProof:(hash:string,address:string)=>Promise<string>;commitRequest:(index:number)=>Promise<void>;discardRequest:(index:number)=>Promise<void>;requestsGated?:()=>boolean};
const when=(time:number)=>new Date(time).toISOString().slice(0,16).replace('T',' ')+' UTC';
function copyText(text:string){return navigator.clipboard.writeText(text);}

function RequestCard({row,network,open,onToggle,wallet,payPage}:{row:RequestRow;network:string;open:boolean;onToggle:()=>void;wallet:()=>SiloRequestWallet|null;payPage:string}){
 const status=requestStatus(row.payments??[],{amountAtomic:row.amountAtomic});
 const unknown=row.payments===null;
 const uri=useMemo(()=>buildMoneroUri({address:row.address,amountAtomic:row.amountAtomic,note:row.note}),[row]);
 const link=useMemo(()=>buildRequestLink(payPage,{address:row.address,amountAtomic:row.amountAtomic,note:row.note}),[row,payPage]);
 const qr=useMemo(()=>{try{return siloRequestUriQr(uri);}catch{return null;}},[uri]);
 const [copied,setCopied]=useState(''),[receipt,setReceipt]=useState<{hash:string;text:string}|null>(null),[problem,setProblem]=useState('');
 const copy=async(what:string,text:string)=>{try{await copyText(text);setCopied(what);setProblem('');}catch{setCopied('');setProblem('Copy is unavailable here. Select the text and copy it.');}};
 async function share(){
  try{if(navigator.share){await navigator.share({title:'Monero payment request',url:link});return;}}catch(failure){if((failure as Error)?.name==='AbortError')return;}
  await copy('link',link);
 }
 async function makeReceipt(payment:Payment){
  setProblem('');setReceipt(null);
  try{
   const active=wallet();if(!active)throw Error('locked');
   const proof=await active.requestProof(payment.hash,row.address);
   setReceipt({hash:payment.hash,text:buildReceipt({network,address:row.address,payment,proof,paidAt:payment.timestamp??new Date().getTime(),note:row.note,requestedAtomic:row.amountAtomic})});
  }catch{setProblem('The receipt could not be made. Unlock and sync this wallet, then try again.');}
 }
 function download(text:string,hash:string){const url=URL.createObjectURL(new Blob([text],{type:'text/plain'}));const a=document.createElement('a');a.href=url;a.download=`silo-receipt-${hash.slice(0,12)}.txt`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 const done=status.state==='paid';
 return <li className="silo-request" data-state={unknown?'unknown':status.state}>
  <button type="button" className="silo-request-head" aria-expanded={open} onClick={onToggle}>
   <span className="silo-request-main"><strong>{row.amountAtomic===null?'Any amount':`${requestAmountText(row.amountAtomic)} XMR`}</strong><small>{row.note??'No note'} · {when(row.createdAt)}</small></span>
   <span className="silo-request-status">{unknown?'Sync to check':requestStatusText(status)}</span>
  </button>
  {open&&<div className="silo-request-body">
   {!done&&<div className="silo-receive">
    {qr&&<div className="silo-qr-tile"><svg role="img" aria-label="Monero payment request QR code" width="176" height="176" viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges"><rect width={qr.size} height={qr.size} fill="white"/><path d={qr.path} fill="black"/></svg></div>}
    <SiloAddressText address={row.address}/>
    <div className="silo-request-buttons">
     <button type="button" onClick={()=>void share()}>{typeof navigator.share==='function'?<Share2 size={17} aria-hidden="true"/>:<Link2 size={17} aria-hidden="true"/>}Share link</button>
     <button type="button" onClick={()=>void copy('link',link)}>{copied==='link'?<Check size={17} aria-hidden="true"/>:<Copy size={17} aria-hidden="true"/>}{copied==='link'?'Link copied':'Copy link'}</button>
     <button type="button" onClick={()=>void copy('address',row.address)}>{copied==='address'?<Check size={17} aria-hidden="true"/>:<Copy size={17} aria-hidden="true"/>}{copied==='address'?'Address copied':'Copy address'}</button>
    </div>
    <p className="exposure-note">The link and the code show this one-time address, the amount and your note. They do not show your name, your balance or your other addresses.</p>
   </div>}
   {row.payments&&row.payments.length>0&&<ul className="silo-request-payments">{row.payments.filter(p=>!p.failed).map(p=><li key={p.hash}>
    <span>{requestAmountText(p.amountAtomic)} XMR · {p.confirmed?`${Math.min(p.confirmations??0,10)}/10 confirmations`:'in the network pool'}</span>
    {p.confirmed&&(p.confirmations??0)>=10&&<button type="button" onClick={()=>void makeReceipt(p)}>Make receipt</button>}
   </li>)}</ul>}
   {receipt&&<div className="silo-request-receipt"><pre>{receipt.text}</pre><div className="silo-request-buttons"><button type="button" onClick={()=>void copy('receipt',receipt.text)}>{copied==='receipt'?<Check size={17} aria-hidden="true"/>:<Copy size={17} aria-hidden="true"/>}{copied==='receipt'?'Receipt copied':'Copy receipt'}</button><button type="button" onClick={()=>download(receipt.text,receipt.hash)}><Download size={17} aria-hidden="true"/>Save receipt</button></div><p className="exposure-note">The receipt names this one payment only. The payment proof lets the payer check it; it does not reveal any other payment.</p></div>}
   {problem&&<p role="alert">{problem}</p>}
  </div>}
 </li>;
}

/** Request XMR: a fresh one-time address per request, a payment URI, a QR code and a share link, then Pending, Confirming n/10 and Paid. */
export function SiloXmrRequests({network,enabled,gated=false,busy,checkedAt,wallet,create,onWatching,payPage=SILO_PAY_PAGE}:{network:string;enabled:boolean;busy:boolean;checkedAt:number|null;wallet:()=>SiloRequestWallet|null;create:(input:{amountAtomic:bigint|null;note:string|null})=>Promise<{address:string}|null>;gated?:boolean;onWatching:(watching:boolean)=>void;payPage?:string}){
 const [rows,setRows]=useState<RequestRow[]>([]),[amount,setAmount]=useState(''),[note,setNote]=useState(''),[error,setError]=useState(''),[openAddress,setOpenAddress]=useState<string|null>(null),[creating,setCreating]=useState(false),[formOpen,setFormOpen]=useState(false);
 const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const load=useCallback(async()=>{
  const active=wallet();if(!active||!enabled)return {rows:[] as RequestRow[],failed:false};
  try{return {rows:await active.requestsOverview(),failed:false};}catch{return {rows:[] as RequestRow[],failed:true};}
 },[wallet,enabled]);
 // Re-read after every successful wallet check (the wallet's own sync), so Pending, Confirming and Paid follow the chain.
 useEffect(()=>{void load().then(result=>{if(!alive.current)return;setRows(result.rows);setError(result.failed?'Requests could not be read from this wallet.':'');});},[load,checkedAt]);
 const watching=rows.some(row=>row.payments!==null&&requestStatus(row.payments,{amountAtomic:row.amountAtomic}).state!=='paid');
 useEffect(()=>{onWatching(enabled&&rows.length>0&&rows.some(row=>row.payments===null||requestStatus(row.payments,{amountAtomic:row.amountAtomic}).state!=='paid'));return()=>onWatching(false);},[watching,rows,enabled,onWatching]);
 async function submit(){
  setError('');
  let input;try{input=parseRequestInput({amount,note});}catch(failure){setError(failure instanceof Error?failure.message:'Check the amount and note.');return;}
  setCreating(true);
  try{
   const made=await create(input);
   if(made){setAmount('');setNote('');setFormOpen(false);const result=await load();if(alive.current){setRows(result.rows);setOpenAddress(made.address);}}
  }finally{setCreating(false);}
 }
 return <section id="silo-xmr-request" className="silo-inset silo-requests" aria-label="Request XMR">
  <div className="silo-requests-head"><h3>Request XMR</h3>{!formOpen&&<button type="button" className="silo-primary" disabled={!enabled||gated||busy} onClick={()=>setFormOpen(true)}>Request</button>}</div>
  {!enabled&&<p className="exposure-note">Requests open once this wallet is unlocked and backed up.</p>}
  {enabled&&gated&&<p className="exposure-note" role="status">Requests are off for this wallet because it was restored from the recovery phrase alone: earlier requests cannot be known, so an address could be handed out twice. Restore from the encrypted backup to use Requests. Receiving and sending work as usual.</p>}
  {formOpen&&<div className="silo-fields">
   <label>Amount in XMR (optional)<input value={amount} onChange={event=>setAmount(event.target.value)} inputMode="decimal" autoComplete="off" placeholder="Any amount" disabled={creating}/></label>
   <label>Note (optional)<input value={note} onChange={event=>setNote(event.target.value)} maxLength={SILO_REQUEST_NOTE_MAX} autoComplete="off" placeholder="What is it for?" disabled={creating}/></label>
   <p className="exposure-note">Each request gets its own new address. The payer sees the note, so leave out anything private.</p>
   <div className="silo-request-buttons"><button type="button" className="silo-primary" disabled={creating||busy} onClick={()=>void submit()}>Create request</button><button type="button" disabled={creating} onClick={()=>{setFormOpen(false);setError('');}}>Cancel</button></div>
  </div>}
  {error&&<p role="alert">{error}</p>}
  {rows.length>0&&<ul className="silo-request-list">{rows.map(row=><RequestCard key={row.address} row={row} network={network} wallet={wallet} payPage={payPage} open={openAddress===row.address} onToggle={()=>setOpenAddress(openAddress===row.address?null:row.address)}/>)}</ul>}
  {enabled&&rows.length===0&&!formOpen&&<p className="exposure-note">No requests yet. A request is a link or a code someone can pay, with the amount filled in.</p>}
 </section>;
}
