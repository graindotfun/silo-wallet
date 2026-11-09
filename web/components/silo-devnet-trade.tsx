'use client';
import '@/lib/browser-buffer.mjs';
import {SiloBetaReviewLine,type SiloBeta} from './silo-beta';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Connection} from '@solana/web3.js';
import type {WalletProvider} from '@/lib/wallet';
import {sessionRpcFetch} from '@/lib/browser-rpc-session.mjs';
import {siloSolanaAmount} from '@/lib/silo/solana-amount.mjs';
import {siloUnits} from '@/lib/silo/amounts.mjs';
import {SILO_DEVNET_TRADE_ROUTES} from '@/lib/silo/devnet-trade/cpmm.mjs';
import {prepareSiloDevnetTrade,signSiloDevnetTrade,submitSiloDevnetTrade,reconcileSiloDevnetTrade,readSiloDevnetTradeJournal,cancelUnpromptedSiloDevnetTrade} from '@/lib/silo/devnet-trade/flow.mjs';
import {siloRefusalMessage} from '@/lib/silo/solana-transfer.mjs';
import {SiloAddressText} from './silo-address-text';
type Review=Awaited<ReturnType<typeof prepareSiloDevnetTrade>>;
type Saved=NonNullable<ReturnType<typeof readSiloDevnetTradeJournal>>;
type Receipt={side:string;failed:boolean;networkFeeRaw:string;memeDeltaRaw:string;solDeltaRaw:string;signature:string};
const SLIPPAGE=[50,100,300];
/** Test-network memecoin trading (V1 test-network stage). Devnet only, with the Silo wallet's own key, one trade at a time.
 * The token is a Silo test memecoin with no value; the product's mainnet trading route (Jupiter) is not exercised here. */
export function SiloDevnetTrade({provider,enabled,beta=null}:{provider:WalletProvider|null;enabled:boolean;beta?:SiloBeta|null}){
 const routes=SILO_DEVNET_TRADE_ROUTES as unknown as {id:string;symbol:string;label:string;decimals:number;network:string}[];
 const [routeId,setRouteId]=useState(routes[0]?.id??''),[side,setSide]=useState<'buy'|'sell'>('buy'),[amount,setAmount]=useState(''),[slippage,setSlippage]=useState(100);
 const [review,setReview]=useState<Review|null>(null),[saved,setSaved]=useState<Saved|null>(null),[receipt,setReceipt]=useState<Receipt|null>(null),[consent,setConsent]=useState<Review|null>(null);
 const [ready,setReady]=useState(false),[busy,setBusy]=useState(false),[status,setStatus]=useState('');
 const owner=provider?.wallet.publicKey?.toBase58()??'',route=routes.find(r=>r.id===routeId)??null,mounted=useRef(true),context=useRef({owner,routeId,enabled,revision:0});
 useLayoutEffect(()=>{context.current={owner,routeId,enabled,revision:context.current.revision+1};return()=>{context.current.revision++;};},[owner,routeId,enabled]);
 const permitted=enabled&&provider?.kind==='native'&&Boolean(route);
 const connection=()=>new Connection(new URL('/api/silo/solana/trade?network=devnet',window.location.origin).href,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:sessionRpcFetch});
 const load=()=>{const row=readSiloDevnetTradeJournal(localStorage);setSaved(row);return row;};
 // eslint-disable-next-line react-hooks/set-state-in-effect
 useEffect(()=>{mounted.current=true;try{if(!navigator.locks)throw Error();setSaved(readSiloDevnetTradeJournal(localStorage));setReady(true);}catch{setReady(false);setStatus('Local recovery storage or exclusive locking is unavailable. Trading is held.');}return()=>{mounted.current=false;context.current.revision++;};},[]);
 // A review is retired whenever its context changes or the page is hidden.
 // eslint-disable-next-line react-hooks/set-state-in-effect
 useEffect(()=>{setReview(null);setConsent(null);},[owner,routeId,side,amount,slippage,enabled,provider]);
 useEffect(()=>{const retire=()=>{context.current.revision++;setReview(null);setConsent(null);};const visibility=()=>{if(document.hidden)retire();};document.addEventListener('visibilitychange',visibility);return()=>document.removeEventListener('visibilitychange',visibility);},[]);
 async function exclusive(task:(assertCurrent:()=>void)=>Promise<void>){
  if(!navigator.locks||!ready||busy)return;const revision=context.current.revision;const assertCurrent=()=>{if(!mounted.current||revision!==context.current.revision)throw Error('Wallet context changed.');};
  setBusy(true);
  // The same lock as native transfers: one Solana payment or trade at a time in this browser.
  try{await navigator.locks.request('grain-silo-solana-transfer',{mode:'exclusive'},async()=>{assertCurrent();await task(assertCurrent);});}
  catch(error){if(!mounted.current)return;const reason=siloRefusalMessage(error);setStatus(reason?`Refused: ${reason}`:'The action could not be completed. Keep any saved trade and check its outcome.');}
  finally{if(mounted.current){setBusy(false);try{load();}catch{setReady(false);}}}
 }
 async function prepare(){
  // Closed beta: no new trade while paused, and the SOL cap on a buy, checked before any wallet work (the server checks again).
  if(beta?.paused){setStatus('The beta is paused: new payments and trades are stopped. Your funds and backups stay available.');return;}
  if(beta&&side==='buy'){let lamports=null;try{lamports=BigInt(siloSolanaAmount(amount,9));}catch{/* the flow reports invalid amounts */}if(lamports!==null&&lamports>BigInt(beta.caps.solLamports)){setStatus(`Beta limit: up to ${beta.caps.sol} SOL per trade.`);return;}}
  await exclusive(async assertCurrent=>{
  if(!permitted||!provider||!route||load())throw Error();setReview(null);setReceipt(null);setStatus('');
  const raw=siloSolanaAmount(amount,side==='buy'?9:route.decimals);
  const result=await prepareSiloDevnetTrade({network:'devnet',owner,route:route.id,side,amountIn:raw,slippageBps:slippage},{connection:connection()});
  assertCurrent();if(provider.wallet.publicKey?.toBase58()!==owner)throw Error();setReview(result);
 });}
 async function approve(){await exclusive(async assertCurrent=>{
  if(!permitted||!provider||!review||consent!==review||load())throw Error();setConsent(null);
  const row=await signSiloDevnetTrade(review,{storage:localStorage,wallet:provider.wallet as never,connection:connection(),assertCurrent});
  assertCurrent();setSaved(row);setReview(null);setStatus('Signed trade saved locally. Submitting…');
  await submitSiloDevnetTrade(localStorage,connection());assertCurrent();setStatus('Submitted. Use Check outcome; new trades wait until it is final.');
 });}
 async function check(){await exclusive(async assertCurrent=>{
  const result=await reconcileSiloDevnetTrade(localStorage,connection());assertCurrent();
  if(result.receipt)setReceipt(result.receipt);
  setStatus({finalized:'Trade finalized.',failed:'The trade failed on the network. Only the network fee was spent.','expired-unlanded':'The trade expired without landing. Nothing was traded.','prompt-unresolved':'The wallet prompt started but no signature was saved. The record stays; nothing can be resent.',reserved:'An unsigned trade is reserved. You can cancel it.',unknown:'Not on the network yet. Check again, or submit the same saved trade again.'}[result.state as string]??`Trade ${result.state}.`);
 });}
 const sym=route?.symbol??'',memeUnits=(raw:string)=>route?siloUnits(raw.replace('-',''),route.decimals):'',solUnits=(raw:string)=>siloUnits(raw.replace('-',''),9);
 return <section className="silo-review" aria-label="Test memecoin trading"><h3>Trade a test memecoin · devnet</h3>
  <p>Test network only. {route?<>{route.label} has no value.</>:'No test pool is set up yet.'} The product trades through Jupiter on mainnet; that route is not part of this test.</p>
  {!enabled&&<p>Test-network trading is off in this environment.</p>}
  {enabled&&provider?.kind!=='native'&&<p>Unlock your Silo wallet to trade with its own key.</p>}
  {saved?<div><p>{saved.state==='signing'?(saved.promptStarted?'The wallet prompt started, but no signature was saved. New trades are held; the record stays.':'An unsigned trade is reserved before any wallet prompt.'):'A signed trade is saved locally. New trades wait until its outcome is final.'}</p>
   {saved.signature&&<code className="exposure-address">{saved.signature}</code>}
   <button disabled={busy||!ready||saved.state==='signing'} onClick={()=>void check()}>Check outcome</button>
   <button disabled={busy||!ready||saved.state!=='signed'} onClick={()=>void exclusive(async guard=>{await submitSiloDevnetTrade(localStorage,connection());guard();setStatus('The same saved trade was submitted again. It can land at most once.');})}>Submit the same saved trade again</button>
   {saved.state==='signing'&&!saved.promptStarted&&<button disabled={busy} onClick={()=>void exclusive(async()=>{cancelUnpromptedSiloDevnetTrade(localStorage);setStatus('Reserved trade cancelled before any wallet prompt.');})}>Cancel before wallet prompt</button>}
  </div>:route&&<div className="silo-fields">
   {routes.length>1&&<label>Token<select value={routeId} disabled={busy} onChange={e=>setRouteId(e.target.value)}>{routes.map(r=><option key={r.id} value={r.id}>{r.symbol}</option>)}</select></label>}
   <div role="radiogroup" aria-label="Buy or sell"><label><input type="radio" checked={side==='buy'} disabled={busy} onChange={()=>setSide('buy')}/>Buy {sym} with SOL</label><label><input type="radio" checked={side==='sell'} disabled={busy} onChange={()=>setSide('sell')}/>Sell {sym} for SOL</label></div>
   <label>Amount ({side==='buy'?'SOL':sym})<input value={amount} disabled={busy} onChange={e=>setAmount(e.target.value)} inputMode="decimal" autoComplete="off"/></label>
   <label>Slippage<select value={slippage} disabled={busy} onChange={e=>setSlippage(Number(e.target.value))}>{SLIPPAGE.map(b=><option key={b} value={b}>{b/100}%</option>)}</select></label>
   <button disabled={busy||!ready||!permitted||!owner||!amount} onClick={()=>void prepare()}>Review trade</button>
  </div>}
  {review&&<div className="silo-review"><h3>Review trade</h3><SiloBetaReviewLine beta={beta}/>
   <p>Network: devnet · Pool: <SiloAddressText address={(SILO_DEVNET_TRADE_ROUTES as unknown as {id:string;pool:string}[]).find(r=>r.id===review.terms.route)?.pool??''}/></p>
   <table className="silo-costs"><caption>This trade</caption><tbody>
    <tr><th scope="row">You pay</th><td>{review.terms.side==='buy'?`${solUnits(review.terms.amountIn)} SOL`:`${memeUnits(review.terms.amountIn)} ${sym}`}</td></tr>
    <tr><th scope="row">You receive · expected</th><td>{review.terms.side==='buy'?`${memeUnits(review.quote.amountOut)} ${sym}`:`${solUnits(review.quote.amountOut)} SOL`}</td></tr>
    <tr><th scope="row">You receive · at least</th><td>{review.terms.side==='buy'?`${memeUnits(review.terms.minAmountOut)} ${sym}`:`${solUnits(review.terms.minAmountOut)} SOL`}<small>Slippage {review.quote.slippageBps/100}%. Below this the network refuses the trade.</small></td></tr>
    <tr data-status={review.quote.impactBps>=500?'warn':undefined}><th scope="row">Price impact</th><td>{(review.quote.impactBps/100).toFixed(2)}%{review.quote.impactBps>=500&&<small role="alert"> · large for this pool</small>}</td></tr>
    <tr><th scope="row">Pool trade fee</th><td>{review.terms.side==='buy'?`${solUnits(review.quote.tradeFee)} SOL`:`${memeUnits(review.quote.tradeFee)} ${sym}`}<small>Raydium pool fee, included above. Silo charges no fee on this test.</small></td></tr>
    <tr><th scope="row">Network fee</th><td>{solUnits(review.networkFeeRaw)} SOL</td></tr>
    {review.rentKeptRaw!=='0'&&<tr><th scope="row">New token account</th><td>{solUnits(review.rentKeptRaw)} SOL<small>Rent kept in your new {sym} account.</small></td></tr>}
   </tbody></table>
   <p>Simulation succeeded for these exact instructions when this review was prepared. It is not a guarantee. This review expires after 30 seconds.</p>
   <label><input type="checkbox" disabled={busy} checked={consent===review} onChange={e=>setConsent(e.target.checked?review:null)}/>I approve this exact trade on devnet using test funds.</label>
   <button className="silo-primary" disabled={busy||!permitted||Boolean(saved)||consent!==review} onClick={()=>void approve()}>Approve in Silo wallet</button>
  </div>}
  {receipt&&<div className="silo-review" role="status"><h3>{receipt.failed?'Trade failed':'Trade finalized'}</h3><p>{receipt.failed?`Only the network fee was spent: ${solUnits(receipt.networkFeeRaw)} SOL.`:receipt.side==='buy'?`Received ${memeUnits(receipt.memeDeltaRaw)} ${sym}. SOL change: −${solUnits(receipt.solDeltaRaw)} including fees.`:`Sold ${memeUnits(receipt.memeDeltaRaw)} ${sym}. SOL change: +${solUnits(receipt.solDeltaRaw)} after fees.`}</p><code className="exposure-address">{receipt.signature}</code></div>}
  {status&&<p role="status">{status}</p>}
 </section>;
}
