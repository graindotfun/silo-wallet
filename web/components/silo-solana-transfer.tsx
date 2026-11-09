'use client';
import '@/lib/browser-buffer.mjs';
import {SiloBetaReviewLine,type SiloBeta} from './silo-beta';
import {SiloReviewVisibilityNotice} from './silo-balance-visibility';
import {SiloAddressText} from './silo-address-text';
import {SiloAssetIcon} from './silo-asset-icon';
import {SILO_USDC_MINT} from '@/lib/silo/swap-referral.mjs';
import {ArrowRight,ChevronDown,ClipboardPaste} from 'lucide-react';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Connection} from '@solana/web3.js';
import {Buffer} from 'buffer';
import type {WalletProvider} from '@/lib/wallet';
import {sessionRpcFetch} from '@/lib/browser-rpc-session.mjs';
import {siloSolanaAmount} from '@/lib/silo/solana-amount.mjs';
import {siloUnits} from '@/lib/silo/amounts.mjs';
import {siloJson} from '@/lib/silo/bounded-json.mjs';
import {prepareSiloTransfer,prepareSiloMaxTransfer,siloRefusalMessage} from '@/lib/silo/solana-transfer.mjs';
import {assertSiloActionConsent,siloActionConsent} from '@/lib/silo/action-consent.mjs';
import {siloTransferCosts} from '@/lib/silo/solana-transfer-review.mjs';
import {readSiloTransferJournal,signSiloTransferDurably,cancelUnpromptedSiloTransfer,assertSiloTransferSubmission,reconcileSiloTransferJournal,recoverSiloTransferSigning} from '@/lib/silo/solana-transfer-journal.mjs';
import {createSiloTransferClientFlow,verifySiloTransferBeforeSubmission,submitSiloReviewedTransfer} from '@/lib/silo/solana-transfer-client-flow.mjs';
import {useSiloAccountSigning} from './silo-account-signing';
import {siloBetaFreshness} from '@/lib/silo/beta-live-state.mjs';
import {SiloMoneyAnimation} from './silo-money-animation';
import {solanaSendMoneyPhase} from '@/lib/silo/money-animation.mjs';
type Review=Awaited<ReturnType<typeof prepareSiloTransfer>>;
type Pending=NonNullable<ReturnType<typeof readSiloTransferJournal>>;
export function SiloSolanaTransfer({provider,network,enabled,beta=null}:{provider:WalletProvider|null;network:'mainnet-beta'|'devnet';enabled:boolean;beta?:SiloBeta|null}){
 const accountSigning=useSiloAccountSigning();
 const preparedFlow=useRef<ReturnType<typeof createSiloTransferClientFlow>|null>(null),transferAbort=useRef<AbortController|null>(null);
 const [recipient,setRecipient]=useState(''),[amount,setAmount]=useState(''),[asset,setAsset]=useState('SOL'),[mint,setMint]=useState(''),[decimals,setDecimals]=useState('6');
 const [review,setReview]=useState<Review|null>(null),[sent,setSent]=useState<{signature:string;label:string;network:string}|null>(null),[outcome,setOutcome]=useState<'submitted'|'uncertain'|'expired'|null>(null),[shown,setShown]=useState(0),[pending,setPending]=useState<Pending|null>(null),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[status,setStatus]=useState(''),[acceptedReview,setAcceptedReview]=useState<Review|null>(null),[actionConsent,setActionConsent]=useState<ReturnType<typeof siloActionConsent>|null>(null);
 // Cosmetic money animation: shown only for a payment sent in THIS session; renders from the real state below, never drives it.
 const [moneyAnim,setMoneyAnim]=useState<{assets:string[]}|null>(null);
 const costs=review?siloTransferCosts(review):null;
 const kind=asset==='SOL'?'sol':mint===SILO_USDC_MINT?'usdc':'token';
 // The What to send sheet picks the asset (r8): it fills the same Asset, mint and decimals inputs as before, and drops any review.
 useEffect(()=>{const pick=(event:Event)=>{const detail=(event as CustomEvent<string|{asset:'token';mint:string;decimals:string}>).detail,choice=typeof detail==='string'?detail:detail?.asset;if(busy)return;setReview(null);setSent(null);
  // A token card on Home names its mint and decimals; the sheet's "Other token" leaves the mint for the person to type.
  if(choice==='sol'){setAsset('SOL');setMint('');}else if(choice==='usdc'){setAsset('SPL');setMint(SILO_USDC_MINT);setDecimals('6');}else if(choice==='token'){setAsset('SPL');setMint(typeof detail==='object'&&typeof detail.mint==='string'?detail.mint:'');setDecimals(typeof detail==='object'&&/^\d{1,2}$/.test(detail.decimals)?detail.decimals:'6');}};
  window.addEventListener('silo-send-asset',pick);return()=>window.removeEventListener('silo-send-asset',pick);},[busy]);
 const consentSubject=pending;
 // Sending is one explicit act: the Send button names the exact amount and recipient. Retrying a saved payment keeps its own tick.
 const actionAccepted=actionConsent!==null&&actionConsent.subject===consentSubject&&actionConsent.action==='retry';
 // Unknown costs are acknowledged per review: a new review needs a new acknowledgement.
 const unknownAccepted=acceptedReview!==null&&acceptedReview===review;
 const owner=provider?.wallet.publicKey?.toBase58()??'',mounted=useRef(true),sentLabel=useRef(''),context=useRef({provider,owner,network,enabled,revision:0});
 useLayoutEffect(()=>{context.current={provider,owner,network,enabled,revision:context.current.revision+1};return()=>{context.current.revision++;};},[provider,owner,network,enabled]);
 const permitted=enabled&&!(network==='devnet'&&provider?.kind==='standard');
 function connection(){return new Connection(new URL(`/api/silo/solana/transfer?network=${network}`,window.location.origin).href,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:sessionRpcFetch});}
 function load(){const row=readSiloTransferJournal(localStorage);setPending(row);return row;}
 // Bootstrap the external durable payment record before enabling any payment.
 // eslint-disable-next-line react-hooks/set-state-in-effect
 useEffect(()=>{mounted.current=true;try{if(!navigator.locks)throw Error();setPending(readSiloTransferJournal(localStorage));setReady(true);}catch{setReady(false);setStatus('Local recovery storage or exclusive payment locking is unavailable. Payments are held.');}return()=>{mounted.current=false;context.current.revision++;};},[]);
 // Retire a review immediately when its signing context changes.
 // eslint-disable-next-line react-hooks/set-state-in-effect
 useEffect(()=>{setReview(null);setActionConsent(null);preparedFlow.current=null;transferAbort.current?.abort();return()=>{transferAbort.current?.abort();};},[owner,network,enabled,provider]);
 useEffect(()=>{const listener=()=>{context.current.revision++;transferAbort.current?.abort();preparedFlow.current=null;setActionConsent(null);try{setPending(readSiloTransferJournal(localStorage));setReview(null);}catch{setReady(false);setStatus('Recovery record needs attention. New payments are held.');}};window.addEventListener('storage',listener);return()=>window.removeEventListener('storage',listener);},[]);
 useEffect(()=>{const retire=()=>{context.current.revision++;transferAbort.current?.abort();preparedFlow.current=null;setReview(null);setActionConsent(null);};const visibility=()=>{if(document.hidden)retire();};document.addEventListener('visibilitychange',visibility);window.addEventListener('hashchange',retire);return()=>{document.removeEventListener('visibilitychange',visibility);window.removeEventListener('hashchange',retire);};},[]);
 async function exclusive(task:(assertCurrent:()=>void)=>Promise<void>,quiet=false){if(!navigator.locks||!ready||busy)return;const revision=context.current.revision;const assertCurrent=()=>{if(!mounted.current||revision!==context.current.revision)throw Error('Wallet context changed.');};setBusy(true);try{await navigator.locks.request('grain-silo-solana-transfer',{mode:'exclusive'},async()=>{assertCurrent();await task(assertCurrent);});}catch(error){if(!mounted.current)return;if(error instanceof Error&&['Transfer review expired.','Transfer review expired while the wallet was open. Signed payment retained. Submission held; check saved outcome.'].includes(error.message)){setReview(null);const retained=readSiloTransferJournal(localStorage);setStatus(retained?.state==='signed'?'Signed payment recovery was saved, but the review expired. Submission and retries are held; check outcome.':'The review expired before signing. No payment was sent; prepare a new review.');return;}if(quiet)return;const reason=siloRefusalMessage(error);setStatus(reason?`Refused: ${reason}`:'The action could not be completed. Keep any saved signature and check its outcome before preparing another payment.');}finally{if(mounted.current){setBusy(false);try{load();}catch{setReady(false);}}}}
 async function prepare(max=false){
  // Closed beta: no new payment while paused, and a cap per transfer, checked before any wallet work (the server checks again).
  if(beta?.paused){setStatus('The beta is paused: new payments and trades are stopped. Your funds and backups stay available.');return;}
  {const freshness=network==='mainnet-beta'?siloBetaFreshness(beta):null;if(freshness){setStatus(freshness);return;}}
  if(beta&&asset==='SOL'&&!max){let lamports=null;try{lamports=BigInt(siloSolanaAmount(amount,9));}catch{/* the flow reports invalid amounts */}if(lamports!==null&&lamports>BigInt(beta.caps.solLamports)){setStatus(`Beta limit: up to ${beta.caps.sol} SOL per transfer.`);return;}}
  await exclusive(async assertCurrent=>{
  if(!permitted||!provider||load())throw Error();setReview(null);setSent(null);setStatus('');preparedFlow.current=null;transferAbort.current?.abort();
  const input={network,owner,recipient,mint:asset==='SPL'?mint:null,amount:max?'1':siloSolanaAmount(amount,asset==='SPL'?Number(decimals):9),decimals:asset==='SPL'?Number(decimals):9};
  let result:Review;
  if(network==='mainnet-beta'){
   if(provider.kind!=='native')throw Error('Silo native transfer wallet required.');const accountCurrent=accountSigning().transferContext(owner),controller=new AbortController();transferAbort.current=controller;const current=()=>{assertCurrent();accountCurrent();controller.signal.throwIfAborted();};
   const flow=createSiloTransferClientFlow({storage:localStorage,wallet:provider.wallet,connection:connection(),accountSigning,assertCurrent:current,signal:controller.signal});result=await flow.prepare({terms:input,max});current();preparedFlow.current=flow;
  }else result=await (max?prepareSiloMaxTransfer:prepareSiloTransfer)(input,{connection:connection()});
  assertCurrent();if(provider.wallet.publicKey?.toBase58()!==owner)throw Error();if(max)setAmount(siloUnits(result.terms.amount,result.terms.decimals));setReview(result);
 });}
 async function send(){const subject=review;if(!subject)return;const consent=siloActionConsent(subject,'send');await exclusive(async assertCurrent=>{
  if(!permitted||!provider||!review||review!==subject||load()||(siloTransferCosts(review).unknown&&acceptedReview!==review))throw Error();assertSiloActionConsent(consent,review,'send');
  const flow=preparedFlow.current;if(network==='mainnet-beta'&&(!flow||provider.kind!=='native'))throw Error('Exact native review flow required.');
  const saved=network==='mainnet-beta'?await flow!.approve(review,flow!.consent(review)):await signSiloTransferDurably(review,{storage:localStorage,wallet:provider.wallet,connection:connection(),assertCurrent});
  assertCurrent();setPending(saved);setMoneyAnim({assets:review.terms.mint?(review.terms.mint==='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'?['usdc']:[]):['sol']});setReview(null);preparedFlow.current=null;polls.current=0;setOutcome('uncertain');sentLabel.current=`${siloUnits(review.terms.amount,review.terms.decimals)} ${review.terms.mint?'tokens':'SOL'}`;setStatus('Sending…');await relay(saved,assertCurrent);
 });}
 async function retirementBefore(row:Pending,outcome:{state:string;signature?:string},assertCurrent:()=>void){assertCurrent();const retire=accountSigning().transferRetirement(localStorage);if(!retire)throw Error('Account retirement verifier required.');const guard=await retire(row,outcome);assertCurrent();return ()=>{assertCurrent();guard();assertCurrent();};}
 function retirementOptions(assertCurrent:()=>void){return {network,...(network==='mainnet-beta'?{beforeRetire:(row:Pending,outcome:{state:string;signature?:string})=>retirementBefore(row,outcome,assertCurrent)}:{})};}
 async function relay(row:Pending,assertCurrent:()=>void){
  assertCurrent();assertSiloTransferSubmission(row);const current=load();if(!current||current.wire!==row.wire||current.signature!==row.signature||current.owner!==row.owner||current.network!==row.network)throw Error('Saved payment changed.');if(!permitted||row.owner!==owner||row.network!==network)throw Error();
  const c=connection(),outcome=await reconcileSiloTransferJournal(localStorage,c,retirementOptions(assertCurrent));assertCurrent();if(['finalized','failed'].includes(outcome.state)){setStatus(`Saved payment ${outcome.state}.`);return;}
  if(network==='mainnet-beta'){
   if(row.version!==2){setStatus('This older payment is reconciliation-only. Keep its exact record and check outcome.');return;}
   const snapshot=JSON.stringify(row),accountCurrent=accountSigning().transferContext(owner),controller=new AbortController();transferAbort.current?.abort();transferAbort.current=controller;
   const same=()=>{assertCurrent();accountCurrent();controller.signal.throwIfAborted();if(JSON.stringify(readSiloTransferJournal(localStorage))!==snapshot)throw Error('Exact saved transfer changed.');};same();
   await verifySiloTransferBeforeSubmission(row,{signal:controller.signal,assertCurrent:same});same();const admit=accountSigning().transferSubmission(localStorage);if(!admit)throw Error('Account transfer dispatch admission required.');const guard=await admit();same();
   const dispatch=()=>{same();guard();same();};dispatch();const result=await submitSiloReviewedTransfer(row,{signal:controller.signal,assertCurrent:dispatch});dispatch();
   setOutcome(result.acknowledged?'submitted':'uncertain');setStatus(result.acknowledged?'':'Solana did not acknowledge the submission. The exact payment stays saved while Silo keeps checking.');return;
  }
  if(await c.getBlockHeight('confirmed')>row.lastValidBlockHeight){setStatus('Transaction expired. Check its final outcome before another payment.');return;}assertCurrent();const retained=readSiloTransferJournal(localStorage);if(retained)assertSiloTransferSubmission(retained);if(!retained||retained.wire!==row.wire||retained.signature!==row.signature)throw Error('Saved payment changed.');
  const result=await c.sendRawTransaction(Buffer.from(row.wire,'base64'),{skipPreflight:false,maxRetries:0,preflightCommitment:'confirmed'});assertCurrent();if(result!==row.signature)throw Error();setOutcome('submitted');setStatus('');
 }
 async function findSigningOutcome(){await exclusive(async assertCurrent=>{const saved=load();if(saved?.state!=='signing'||saved.promptStarted!==true||saved.network!==network)throw Error();setActionConsent(null);const result=await recoverSiloTransferSigning(localStorage,async(reservation:Pending)=>{const response=await sessionRpcFetch('/api/silo/solana/recover',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({reservation}),signal:AbortSignal.timeout(15000)});const body=await siloJson(response,8192);if(!response.ok||!['found','unknown'].includes(body.status))throw Error('Read-only recovery lookup unavailable.');return body;},{network});assertCurrent();setStatus(result.status==='adopted'?'An exact previously signed payment was found and saved. Check outcome to reconcile it. Submission and retries remain held.':result.status==='found-context-missing'?'An exact message was found, but this older record lacks the saved signing context needed to verify it. The original record and hold remain.':'No verified match was found in this bounded history search. This is not proof that nothing was submitted. Keep the record; another signature remains blocked.');});}
 function label(row:Pending|null){const terms=row?.version===2?row.serverReview?.terms:null;return terms?`${siloUnits(terms.amount,terms.decimals)} ${terms.mint?'tokens':'SOL'}`:sentLabel.current||'payment';}
 async function check(quiet=false){await exclusive(async assertCurrent=>{const row=load();if(!row||row.network!==network)throw Error();const result=await reconcileSiloTransferJournal(localStorage,connection(),retirementOptions(assertCurrent));assertCurrent();
  if(result.state==='finalized'&&'signature' in result){setSent({signature:result.signature,label:label(row),network:row.network});setOutcome(null);setStatus('');return;}
  if(result.state==='unknown'&&'blockhashExpired' in result&&result.blockhashExpired)setOutcome('expired');
  const said=result.state==='failed'?'The network rejected this transfer. Only the network fee was charged.':result.state==='held-other-network'?'This payment belongs to another network. Switch to it to check it.':result.state==='failed-awaiting-finality'?'The transfer is failing. Waiting for the final result…':null;
  // Background checks only add news; they never clear an earlier refusal or uncertainty message.
  if(said)setStatus(said);else if(!quiet)setStatus('Not confirmed yet. Silo keeps checking.');},quiet);}
 // A sent payment confirms by itself: check every few seconds while the page is visible, without any extra click.
 const polls=useRef(0);
 useEffect(()=>{const visible=()=>{if(!document.hidden)setShown(n=>n+1);};document.addEventListener('visibilitychange',visible);return()=>document.removeEventListener('visibilitychange',visible);},[]);
 useEffect(()=>{if(!ready||busy||pending?.state!=='signed'||pending.submissionApproved!==true||pending.network!==network)return;const timer=setTimeout(()=>{if(document.hidden)return;polls.current++;void check(true);},polls.current<40?3000:30000);return()=>clearTimeout(timer);},[ready,busy,pending,network,shown]);// eslint-disable-line react-hooks/exhaustive-deps
 const costRows=costs?.rows.filter(row=>row.status==='unknown'||row.status==='known'&&!/^(0(\.0+)? SOL|None)$/.test(row.value))??[];
 const sending=pending?.state==='signed'&&pending.submissionApproved===true;
 if(!enabled&&!pending&&!review&&!status)return null;
 const moneyPhase=moneyAnim?solanaSendMoneyPhase({sent,pending,outcome,status}):null;
 const reviewKind=review?(review.terms.mint?(review.terms.mint===SILO_USDC_MINT?'usdc':'token'):'sol'):kind;
 const reviewSymbol=review?(review.terms.mint?(review.terms.program==='token-2022'?'Token-2022':reviewKind==='usdc'?'USDC':'SPL token'):'SOL'):'';
 const reviewAmount=review?siloUnits(review.terms.amount,review.terms.decimals):'';
 const outcomeKind=pending?(pending.version===2&&pending.serverReview?.terms.mint?(pending.serverReview.terms.mint===SILO_USDC_MINT?'usdc':'token'):'sol'):kind;
 const outcomeLabel=label(pending);
 const trackState=(()=>{
  if(sent&&!pending)return {word:'Sent',segs:['done','done','done'] as const,last:null as string|null};
  if(outcome==='expired')return {word:'Not confirmed',segs:['done','done','bad'] as const,last:'Not confirmed'};
  if(/network rejected this transfer/i.test(status)||/Saved payment failed/.test(status))return {word:'Not sent',segs:['done','done','bad'] as const,last:'Rejected'};
  if(outcome==='submitted')return {word:'Sending',segs:['done','done','now'] as const,last:null};
  if(sending)return {word:'Sending',segs:['done','now'] as const,last:null};
  return {word:'Sending',segs:['now'] as const,last:null};
 })();
 const trackLabs=['Signed','Submitted','Confirmed'];
 return <section className="silo-review" aria-label="Solana transfer" data-phase={pending?'outcome':review?'review':'compose'}>{moneyAnim&&moneyPhase&&<SiloMoneyAnimation kind="send" assets={moneyAnim.assets} phase={moneyPhase} onDismiss={()=>setMoneyAnim(null)}/>}<h3>Send SOL or a token</h3>{network==='devnet'&&<p>{provider?.kind==='native'?'Test funds only. Devnet is separate from your mainnet balances. Signed by this Silo wallet\u2019s devnet key after you approve.':'Test funds only. Devnet is separate from your mainnet balances. Select devnet in your injected wallet.'}</p>}{!enabled&&<p>Payments are held until this environment passes its release conditions.</p>}{network==='devnet'&&provider?.kind==='standard'&&<p>Wallet Standard devnet signing is not available in this rehearsal. Select a supported injected wallet.</p>}
 <details className="silo-send-about"><summary>About sends</summary><p className="exposure-note">Public Solana transfer through your Silo wallet. Keys stay in this browser. The transfer review links this public address and transaction to your beta invitation.</p><p className="exposure-note">SOL, classic SPL and Token-2022 tokens, including tokens with a transfer tax (shown before you send). Tokens with transfer hooks, interest-bearing or scaled amounts, and accounts with a delegate are refused. A payment in progress is saved in this browser until it confirms; clearing browser storage removes that record.</p></details>
 {sent&&!pending&&<div className="silo-sent silo-send8-rcpt is-done" data-asset={outcomeKind} role="status"><div className="silo-send8-rh"><span className="silo-send8-word">Sent<span className="silo-send8-ok" aria-hidden="true">✓</span></span><span className="silo-send8-net"><SiloAssetIcon asset="sol"/>Public · Solana{sent.network==='devnet'?' · test funds':''}</span></div><p className="silo-send8-big" aria-label={sent.label}>{sent.label}</p><div className="silo-send8-track" role="list" aria-label="Progress">{trackLabs.map(lab=><span key={lab} className="seg done" role="listitem" aria-label={`${lab}, done`}><span className="bar"/><span className="lab">{lab}</span></span>)}</div><p><strong>Sent {sent.label}</strong> · confirmed on Solana.</p><p className="exposure-note">Transaction <code className="exposure-address">{sent.signature}</code></p></div>}
 {pending?<div className="silo-send8-outcome" data-asset={outcomeKind}>{sending?<div className={`silo-sending silo-send8-rcpt${trackState.segs[2]==='done'?' is-done':''}`} role="status">
  <div className="silo-send8-rh"><span className="silo-send8-word">{trackState.word}{trackState.segs.every(s=>s==='done')&&<span className="silo-send8-ok" aria-hidden="true">✓</span>}</span><span className="silo-send8-net"><SiloAssetIcon asset="sol"/>Public · Solana{pending.network==='devnet'?' · test funds':''}</span></div>
  <p className="silo-send8-big" aria-label={outcomeLabel}>{outcomeLabel}</p>
  <div className="silo-send8-track" role="list" aria-label="Progress">{trackLabs.map((lab,i)=>{const k=trackState.segs[i]||'';const title=i===2&&trackState.last?trackState.last:lab;return <span key={lab} className={`seg ${k}`} role="listitem" aria-label={`${title}${k==='done'?', done':k==='now'?', in progress':k==='bad'?', failed':', waiting'}`}><span className="bar"/><span className="lab">{title}</span></span>;})}</div>
  <p>{outcome==='expired'?<><strong>{label(pending)} expired before it confirmed.</strong> The outcome is not proven yet, so this exact payment stays saved and new payments wait.</>:outcome==='submitted'?<><strong>Sending {label(pending)}</strong> · confirming on Solana…</>:<><strong>{label(pending)} is signed and saved.</strong> Silo is checking whether Solana received it.</>}</p>
 </div>:<p>{pending.state==='signing'?(pending.promptStarted?'The wallet prompt started, but no returned signature was captured. New payments remain held. Preserve this record; do not replace it.':'An unsigned review was reserved before a wallet prompt. You can cancel it before signing.'):'Signed payment recovery is saved, but submission checks did not finish. Check outcome; submission and retries remain held.'}</p>}{pending.state==='signing'&&pending.promptStarted===true&&<div><p className="exposure-note">A read-only search checks a bounded part of finalized history using the saved public address and exact transaction message. It cannot prove absence. It never opens a wallet prompt or submits a transaction.</p><button disabled={busy||!ready||pending.network!==network} onClick={()=>void findSigningOutcome()}>Find existing signing outcome</button></div>}{pending.state==='signing'&&pending.promptStarted===false&&<button disabled={busy||!ready||pending.network!==network} onClick={()=>void exclusive(async()=>{cancelUnpromptedSiloTransfer(localStorage,{network});setReview(null);setStatus('Unsigned review cancelled before any wallet prompt.');})}>Cancel before wallet prompt</button>}{!sending&&pending.signature&&<code className="exposure-address">{pending.signature}</code>}<button disabled={busy||!ready||pending.state==='signing'||pending.network!==network} onClick={()=>void check()}>Check now</button>{pending.state==='signed'&&<details className="silo-send-retry"><summary>Taking too long?</summary><p className="exposure-note">Retrying sends the same signed payment again. It cannot be charged twice.</p><label><input type="checkbox" disabled={busy||pending.submissionApproved===false||network==='mainnet-beta'&&pending.version!==2} checked={actionAccepted} onChange={event=>setActionConsent(event.target.checked?siloActionConsent(pending,'retry'):null)}/>I approve retrying this exact saved payment on {pending.network}; it may already have been submitted.</label><button disabled={busy||!ready||!permitted||pending.submissionApproved===false||pending.network!==network||pending.owner!==owner||network==='mainnet-beta'&&pending.version!==2||!actionAccepted} onClick={()=>void exclusive(async guard=>{assertSiloActionConsent(actionConsent,pending,'retry');setActionConsent(null);await relay(pending,guard);})}>Retry identical saved payment</button></details>}</div>:!review&&<div className="silo-send8" data-asset={kind}>
  {/* r8 Send (6 Nov 2026): To, then the amount on the asset's own colour, the keys, Review. Same inputs, handlers and checks as before. */}
  <label className="silo-send8-to"><span>To</span><input value={recipient} disabled={busy} onChange={e=>{setRecipient(e.target.value);setReview(null);setSent(null);}} aria-label="Recipient" placeholder="Address" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}/><button type="button" className="silo-send8-icon" disabled={busy} aria-label="Paste the address" onClick={()=>void navigator.clipboard?.readText().then(text=>{setRecipient(text.trim());setReview(null);setSent(null);}).catch(()=>setStatus('Paste is not available here. Hold the field to paste.'))}><ClipboardPaste size={20} aria-hidden="true"/></button></label>
  <div className="silo-send8-slip">
   <div className="silo-send8-head"><SiloAssetIcon asset={kind==='sol'?'sol':kind==='usdc'?'usdc':'token'}/><strong>{kind==='sol'?'SOL':kind==='usdc'?'USDC':'Token'}</strong><button type="button" className="silo-send8-change" disabled={busy} onClick={()=>window.dispatchEvent(new Event('silo-send-pick'))}>Change<ChevronDown size={18} aria-hidden="true"/></button><span className="silo-send8-net"><SiloAssetIcon asset="sol"/>Public · Solana{network==='devnet'?' devnet':''}</span></div>
   <label className="silo-send8-amt"><span className="sr-only">Amount {kind==='sol'?'SOL':kind==='usdc'?'USDC':'(tokens)'}</span><input value={amount} disabled={busy} onChange={e=>{setAmount(e.target.value);setReview(null);setSent(null);}} placeholder="0" inputMode="decimal" enterKeyHint="done" data-amount-pad="" data-pad-slot="silo-send-pad" data-decimals={asset==='SPL'?Number(decimals)||0:9} data-symbol={kind==='sol'?'SOL':kind==='usdc'?'USDC':'tokens'} autoComplete="off"/></label>
   <div className="silo-send8-strip"><span>{network==='devnet'?'Devnet · test funds':'Mainnet · real funds'}</span><button disabled={busy||!ready||!permitted||!owner||!recipient||(asset==='SPL'&&!mint)} onClick={()=>void prepare(true)}>Max</button><span id="silo-send-pad-paste"/></div>
  </div>
  {asset==='SPL'&&kind!=='usdc'&&<div className="silo-fields"><label>Mint address<input value={mint} disabled={busy} onChange={e=>{setMint(e.target.value);setReview(null);}} autoComplete="off"/></label><label>Token decimals<input type="number" inputMode="numeric" min="0" max="18" value={decimals} disabled={busy} onChange={e=>{setDecimals(e.target.value);setReview(null);}}/></label></div>}
  <div id="silo-send-pad" className="silo-send8-pad"/>
  <div className="silo-send8-go"><span id="silo-send-pad-kbd"/><button className="silo-primary silo-send8-review" aria-label="Review transfer" disabled={busy||!ready||!permitted||!owner||!amount||!recipient} onClick={()=>void prepare()}>Review<ArrowRight size={20} aria-hidden="true"/></button></div>
 </div>}
 {review&&<div className="silo-review silo-send8-review-screen" data-asset={reviewKind}><h3>Review transfer</h3>
  <div className="silo-send8-sum"><span className="silo-send8-lb">You send</span><p className="silo-send8-big" aria-label={`${reviewAmount} ${reviewSymbol}`}>{reviewAmount}<span className="unit">{reviewSymbol}</span></p><span className="silo-send8-net"><SiloAssetIcon asset="sol"/>Public · Solana{review.terms.network==='mainnet-beta'?'':' · test funds'}</span></div>
  <div className="silo-send8-tobox"><div className="silo-send8-tobox-row"><span className="silo-send8-lb">To</span></div><p className="silo-send-summary">Send <strong>{reviewAmount} {reviewSymbol}</strong> to <SiloAddressText address={review.terms.recipient}/>{review.terms.network==='mainnet-beta'?'':' · test funds'}</p>{review.terms.mint&&<p>Mint: <SiloAddressText address={review.terms.mint}/></p>}</div>
  {review.issuer?.freezeAuthority&&<p className="exposure-note">The token&rsquo;s issuer can freeze token accounts, including the recipient&rsquo;s.</p>}{review.issuer?.permanentDelegate&&<p role="alert" className="exposure-note">The token&rsquo;s issuer holds a permanent delegate and can move or burn tokens from any account, including the recipient&rsquo;s.</p>}
  <table className="silo-costs"><tbody>{costRows.map(row=><tr key={row.label} data-status={row.status}><th scope="row">{row.label}</th><td>{row.value}{row.status==='unknown'&&<span className="silo-cost-flag"> · unknown</span>}</td></tr>)}<tr className="silo-cost-total"><th scope="row">Total SOL leaving your wallet</th><td>{costs?.totalSol}</td></tr><tr><th scope="row">Balance after · estimated</th><td>{costs?.balanceAfterSol}{review.terms.mint&&<span> · {costs?.balanceAfterToken}</span>}</td></tr></tbody></table>
  <details className="silo-send-about"><summary>Fee details</summary>{costs?.rows.filter(row=>row.status!=='none').map(row=><p key={row.label} className="exposure-note">{row.label}: {row.value}. {row.note}</p>)}<p className="exposure-note">{costs?.totalNote} {costs?.balanceAfterNote}</p><p className="exposure-note">The exact transaction was simulated successfully when this review was prepared; that is not a guarantee of the outcome. Silo signs exactly these instructions.</p></details>
  <SiloBetaReviewLine beta={beta}/><SiloReviewVisibilityNotice/>
  {costs?.unknown&&<label className="silo-unknown-ack" role="alert"><input type="checkbox" disabled={busy} checked={unknownAccepted} onChange={event=>setAcceptedReview(event.target.checked?review:null)}/>Some costs could not be determined (shown as —). I want to continue without knowing them.</label>}
  <div className="silo-send-actions silo-send8-acts"><button className="silo-primary" disabled={busy||!permitted||Boolean(pending)||(costs?.unknown===true&&!unknownAccepted)} onClick={()=>void send()}>Send {reviewAmount} {review.terms.mint?'tokens':'SOL'}</button><button disabled={busy} onClick={()=>{setReview(null);preparedFlow.current=null;}}>Cancel</button></div>
  <p className="exposure-note">Valid for 30 seconds{review.terms.network==='mainnet-beta'?' · real funds':''}.</p>
 </div>}
 {status&&<p role="status">{status}</p>}</section>;
}
