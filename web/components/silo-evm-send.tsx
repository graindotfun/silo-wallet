'use client';
import {useEffect,useRef,useState} from 'react';
import {keccak256} from 'viem';
import type {SiloNativeSession} from './silo-native-public-wallet';
import {sessionRpcFetch} from '@/lib/browser-rpc-session.mjs';
import {siloRecipientOrThrow,siloEvmAmountToWei,siloEvmWeiLabel,siloEvmExplorer,type SiloEvmPrepared} from '@/lib/silo/evm-send-ui.mjs';
import {createSiloEvmTransferTicket} from '@/lib/silo/evm-transfer.mjs';
import {assertSiloEvmCanSend,archiveAndClearSiloEvmAttempt,beginSiloEvmAttempt,clearSiloEvmAttempt,markSiloEvmAccepted,markSiloEvmUncertain,readSiloEvmAttempt,siloEvmAttemptResolution,siloEvmClassifyResponse,siloEvmClearToken,siloEvmSettleDecision} from '@/lib/silo/evm-attempt.mjs';
import {SILO_EVM_CAP_USD_MAX,siloEvmAssertCap} from '@/lib/silo/evm-cap.mjs';
type Chain={chainId:number;name:string;symbol:string};
type Step='form'|'checking'|'review'|'signing'|'resolve'|'done';
type Result={mined?:boolean;success?:boolean;reverted?:boolean;final?:boolean;confirmations?:number;required?:number;known?:boolean};
type Attempt={state:'signed'|'uncertain'|'accepted';from:string;chainId:number;nonce:number;hash:string;raw:string;at:number};
const dollars=(value:number)=>value<0.01?'under $0.01':`$${value.toFixed(2)}`;
const post=(path:string,body:unknown)=>sessionRpcFetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
/** Browser storage for the unresolved-attempt record. Throws when the browser will not give it (private mode, blocked): the
 * caller then pauses sending, because a transfer whose outcome might be lost must be recorded first. */
function store():Storage{const storage=window.localStorage;if(!storage)throw new Error('storage');return storage;}
/** Send the native coin (ETH on Ethereum, Base and Robinhood Chain, BNB on BNB Chain) from Silo's own EVM wallet to a normal wallet address.
 * One screen to type, one review with the fee in dollars, one Confirm. The review is what gets signed: the signature is
 * bound to the exact fields shown (one-time ticket), and the server re-checks and relays the signed bytes. The signed
 * transfer is saved BEFORE it is sent and kept until its outcome is known: while one is unresolved this wallet cannot review
 * or sign another payment, so a lost answer can never become a second payment. No approvals, contract calls or messages. */
export function SiloEvmSend({session,chain,sending=true}:{session:SiloNativeSession;chain:Chain;sending?:boolean}){
 const from=session.metadata().address;
 const [to,setTo]=useState(''),[amount,setAmount]=useState(''),[step,setStep]=useState<Step>('form'),[error,setError]=useState(''),[note,setNote]=useState('');
 const [prepared,setPrepared]=useState<SiloEvmPrepared|null>(null),[attempt,setAttempt]=useState<Attempt|null>(null),[sentHash,setSentHash]=useState<string|null>(null),[sentChain,setSentChain]=useState<number|null>(null),[busy,setBusy]=useState(false),[result,setResult]=useState<Result|null>(null),[clearing,setClearing]=useState(false),[ackTick,setAckTick]=useState(false),[ackText,setAckText]=useState(''),[corrupt,setCorrupt]=useState(false);
 const ticket=useRef<object|null>(null),epoch=useRef(0);
 useEffect(()=>()=>{epoch.current++;ticket.current=null;},[]);
 // Reading the saved record on mount: it survives lock, reload, remount and chain change because it is keyed by the wallet address.
 useEffect(()=>{
  try{const saved=readSiloEvmAttempt(store(),from) as Attempt|null;if(saved){setAttempt(saved);if(saved.state==='accepted'){setSentHash(saved.hash);setSentChain(saved.chainId);setStep('done');}else setStep('resolve');}}
  catch(failure){
   // A record that exists but cannot be read is its own state: sending stays paused and it can be cleared by hand (MC-N6).
   setCorrupt((failure as {siloEvmAttempt?:string})?.siloEvmAttempt==='corrupt');
   setError(failure instanceof Error&&failure.message!=='storage'?failure.message:'This browser cannot save transfer state, so sending is paused.');setStep('resolve');}
 },[from]);
 // Changing the chain discards a review (never an unresolved attempt).
 useEffect(()=>{if(step==='review'||step==='checking'){epoch.current++;ticket.current=null;setStep('form');setPrepared(null);}},[chain.chainId]);// eslint-disable-line react-hooks/exhaustive-deps
 async function review(){
  setError('');setNote('');const run=++epoch.current;
  try{
   assertSiloEvmCanSend(store(),from);
   const recipient=siloRecipientOrThrow(to),valueWei=siloEvmAmountToWei(amount);
   setStep('checking');
   const response=await post('/api/silo/evm/prepare',{chainId:chain.chainId,from,to:recipient,valueWei});
   const data=await response.json().catch(()=>null) as (SiloEvmPrepared&{error?:string})|null;
   if(run!==epoch.current)return;
   if(!response.ok||!data||!data.fields){setError(data?.error??'Could not prepare this transfer. Nothing was sent.');setStep('form');return;}
   if(data.fields.chainId!==chain.chainId||data.fields.to.toLowerCase()!==recipient.toLowerCase()||data.fields.valueWei!==valueWei){setError('The network answered with a different transfer. Nothing was sent.');setStep('form');return;}
   ticket.current=createSiloEvmTransferTicket(data.fields);setPrepared(data);setStep('review');
  }catch(failure){
   if(run!==epoch.current)return;
   const blocked=(failure as {siloEvmAttempt?:string})?.siloEvmAttempt;
   setError(failure instanceof Error&&(blocked||/amount|address|Enter|different/i.test(failure.message))?failure.message:'Could not prepare this transfer. Nothing was sent.');
   if(blocked)setStep('resolve');else setStep('form');
  }
 }
 /** Sends the signed bytes and returns what to do next. `definite` outcomes clear the saved record; anything else keeps it. */
 async function broadcast(raw:string,hash:string):Promise<{outcome:'accepted'|'refused'|'uncertain';message:string}>{
  try{
   const response=await post('/api/silo/evm/send',{raw});
   const data=await response.json().catch(()=>null) as {hash?:string;error?:string}|null;
   return {outcome:siloEvmClassifyResponse(response.status,data,hash),message:typeof data?.error==='string'?data.error:''};
  }catch{return {outcome:'uncertain',message:''};}
 }
 /** Applies an outcome. `first` is true only for the first send of a freshly signed transfer: only then may a refusal clear the
  * saved attempt. A refusal of a resend can mean the original already went through, so the attempt stays. */
 function settle(result:{outcome:'accepted'|'refused'|'uncertain';message:string},hash:string,first:boolean){
  const decision=siloEvmSettleDecision({first,outcome:result.outcome});
  // Accepted is NOT final: the record is kept (marked accepted) and sending stays paused until the receipt reaches the chain's depth.
  if(result.outcome==='accepted'){const kept=markSiloEvmAccepted(store(),from);setSentChain(attempt?.chainId??prepared?.fields.chainId??chain.chainId);setAttempt(kept as Attempt|null);setSentHash(hash);setNote('');setResult(null);setStep('done');return;}
  if(decision==='clear'){clearSiloEvmAttempt(store(),from);setAttempt(null);setPrepared(null);setStep('form');setError(result.message||'The transfer was refused. Nothing was sent.');return;}
  const next=markSiloEvmUncertain(store(),from);setAttempt(next as Attempt|null);setStep('resolve');
  setNote(result.outcome==='refused'?'The network refused the resend. That can mean the original transfer already went through, so do not start another payment yet. Check the status.':'');
 }
 async function confirm(){
  if(!prepared||!ticket.current||step!=='review')return;
  const current=ticket.current;epoch.current++;ticket.current=null;setError('');setStep('signing');
  let raw:string,hash:string;
  try{
   assertSiloEvmCanSend(store(),from);
   // The hard ceiling is enforced HERE, at signing, on the amount plus the largest fee (the larger of the server's figure and the
   // one recomputed from the fields), whatever the server said its own limit was.
   const localFee=21000n*BigInt(prepared.fields.maxFeePerGas),shownFee=BigInt(prepared.maxFeeWei);
   siloEvmAssertCap({valueWei:prepared.fields.valueWei,feeWei:shownFee>localFee?shownFee:localFee,priceUsd:prepared.priceUsd,capUsd:SILO_EVM_CAP_USD_MAX});
   raw=session.signReviewedEvmTransfer(prepared.fields,current);hash=keccak256(raw as `0x${string}`);
   // Saved BEFORE it is sent. If the browser cannot save it, nothing is sent.
   const saved=beginSiloEvmAttempt(store(),{from,chainId:prepared.fields.chainId,nonce:prepared.fields.nonce,hash,raw});setAttempt(saved as Attempt);
  }catch(failure){setError(failure instanceof Error?failure.message:'Could not sign. Nothing was sent.');setStep('form');setPrepared(null);return;}
  settle(await broadcast(raw,hash),hash,true);
 }
 async function check(){
  if(!attempt||busy)return;setBusy(true);setError('');setNote('');
  try{
   const response=await post('/api/silo/evm/status',{chainId:attempt.chainId,hash:attempt.hash,from});
   const data=await response.json().catch(()=>null) as (Result&{nonceLatest?:number;error?:string})|null;
   if(!response.ok||!data){setNote('Could not check the network right now. Try again in a moment.');return;}
   const resolution=siloEvmAttemptResolution(attempt,data);
   if(resolution==='mined'){clearSiloEvmAttempt(store(),from);setSentChain(attempt.chainId);setSentHash(attempt.hash);setAttempt(null);setNote('');setResult(data);setStep('done');}
   else if(resolution==='confirming'&&data.reverted){setSentChain(attempt.chainId);setSentHash(attempt.hash);setNote('');setResult(data);setStep('done');}
   else if(resolution==='confirming')setNote(`The transfer is in a block (${data.confirmations??0} of ${data.required??'several'} confirmations). Sending stays paused until it is final. Check again in a moment.`);
   else if(resolution==='pending')setNote('The network has this transfer and it is waiting to be confirmed. Check again in a moment.');
   else if(resolution==='unknown-nonce-advanced')setNote('The network does not show this transfer right now, but it may still appear. Another transaction from this wallet has used a later number, which does not prove this one failed. Check again later. Sending stays paused until this is resolved.');
   else setNote('The network does not show this transfer yet. You can send the same transfer again: it is the identical signed transaction, so it cannot be paid twice.');
  }catch{setNote('Could not check the network right now. Try again in a moment.');}
  finally{setBusy(false);}
 }
 async function resend(){
  if(!attempt||busy)return;setBusy(true);setError('');setNote('');
  try{settle(await broadcast(attempt.raw,attempt.hash),attempt.hash,false);}finally{setBusy(false);}
 }
 /** After the node accepted a transfer: reads its receipt so the screen can say confirmed, failed on the network, or still waiting. */
 async function checkResult(){
  if(!sentHash||busy)return;setBusy(true);setError('');
  try{
   const response=await post('/api/silo/evm/status',{chainId:sentChain??chain.chainId,hash:sentHash,from});
   const data=await response.json().catch(()=>null) as (Result&{error?:string})|null;
   if(!response.ok||!data){setNote('Could not check the network right now. Try again in a moment.');return;}
   setNote('');setResult(data);
   // Only a receipt at the chain's depth (success or revert) releases the saved record and with it the next payment.
   if(attempt&&siloEvmAttemptResolution(attempt,data)==='mined'){clearSiloEvmAttempt(store(),from);setAttempt(null);}
  }catch{setNote('Could not check the network right now. Try again in a moment.');}
  finally{setBusy(false);}
 }
 /** Clears an unresolved record by hand, after the person checked elsewhere. The signed bytes are saved to a list first. */
 function manualClear(){
  if(!attempt&&!corrupt)return;setError('');
  try{
   archiveAndClearSiloEvmAttempt(store(),from,{token:ackText.trim().toLowerCase()});
   setAttempt(null);setCorrupt(false);setSentHash(null);setResult(null);setClearing(false);setAckTick(false);setAckText('');setNote('The record was cleared and saved in this browser. You can send again.');setStep('form');
  }catch(failure){setError(failure instanceof Error?failure.message:'Nothing was cleared.');}
 }
 function again(){if(attempt||corrupt)return;epoch.current++;ticket.current=null;setResult(null);setClearing(false);setAckTick(false);setAckText('');setTo('');setAmount('');setPrepared(null);setSentHash(null);setError('');setNote('');setStep('form');}
 const clearPanel=<details className="silo-restore-options" open={clearing} onToggle={event=>setClearing((event.target as HTMLDetailsElement).open)}><summary>I checked elsewhere</summary><div className="silo-fields">
        <p className="exposure-note"><strong>Sending again can pay twice.</strong></p>
        <p className="exposure-note">This record lives only in this browser. If you cleared site data or restored this wallet on another device, it may be missing, so look the transaction up on a block explorer before you send anything. Clear the record only if you are sure the transfer is not there. When you clear it, the signed transfer is saved in a list in this browser first.</p>
        <label className="silo-check"><input type="checkbox" checked={ackTick} onChange={event=>setAckTick(event.target.checked)}/> I understand this transfer could still appear and be paid.</label>
        <label>Type {siloEvmClearToken(attempt)} to confirm<input value={ackText} onChange={event=>setAckText(event.target.value)} autoComplete="off" spellCheck={false}/></label>
        <button type="button" disabled={!ackTick||!ackText.trim()} onClick={manualClear}>Clear this record</button>
       </div></details>;
 const shown=attempt?.hash??sentHash,link=shown?siloEvmExplorer(attempt?.chainId??sentChain??chain.chainId,shown):null;
 return <div className="silo-inset" aria-live="polite">
  <h3>Send {chain.symbol} on {chain.name}</h3>
  {!sending&&!attempt&&!corrupt&&step==='form'&&<p className="exposure-note" role="status">Sending is paused. Nothing new can be sent right now.</p>}
  {sending&&(step==='form'||step==='checking')&&<>
   <label>To<input value={to} onChange={event=>setTo(event.target.value.trim())} placeholder="0x…" autoComplete="off" spellCheck={false} disabled={step==='checking'}/></label>
   <label>Amount ({chain.symbol})<input value={amount} onChange={event=>setAmount(event.target.value.trim())} inputMode="decimal" placeholder="0.0" autoComplete="off" disabled={step==='checking'}/></label>
   <p className="exposure-note">Only send to a normal wallet address on {chain.name}. Sends to smart contracts are not supported. Beta: small amounts only.</p>
   <button className="silo-primary" disabled={step==='checking'||!to||!amount} onClick={()=>void review()}>{step==='checking'?'Checking…':'Review'}</button>
  </>}
  {(step==='review'||step==='signing')&&prepared&&<>
   <dl className="silo-disclosure">
    <dt>You send</dt><dd><strong>{siloEvmWeiLabel(prepared.fields.valueWei)} {chain.symbol}</strong> ({dollars(prepared.valueUsd)})</dd>
    <dt>To</dt><dd><code>{prepared.fields.to}</code></dd>
    <dt>Network</dt><dd>{chain.name}</dd>
    {prepared.l1FeeWei&&prepared.l1FeeWei!=='0'
     ?<><dt>Network fee (estimate)</dt><dd>about {dollars(prepared.maxFeeUsd)} ({siloEvmWeiLabel(prepared.maxFeeWei)} {chain.symbol}), usually less. It includes an estimated Ethereum data fee of about {siloEvmWeiLabel(prepared.l1FeeWei)} {chain.symbol}, which the network sets when the transfer is included and can differ.</dd>
      <dt>Total (estimate)</dt><dd>about {dollars(prepared.totalUsd)}</dd></>
     :<><dt>Network fee</dt><dd>up to {dollars(prepared.maxFeeUsd)} ({siloEvmWeiLabel(prepared.maxFeeWei)} {chain.symbol}), usually less</dd>
      <dt>Total</dt><dd>up to {dollars(prepared.totalUsd)}</dd></>}
   </dl>
   <p className="exposure-note">Silo adds no fee. Check the address: a transfer cannot be undone. Beta limit ${prepared.capUsd} per transfer, counting the amount plus the largest expected fee. Silo checks it again when the signed transfer is sent.</p>
   <p className="exposure-note">Dollar amounts are estimates at the current market price (about a minute old) and can differ when the transfer is confirmed. The execution fee is capped in the network&apos;s own units: at most {prepared.maxFeeGwei??'?'} gwei per gas, 21,000 gas.{prepared.l1FeeWei&&prepared.l1FeeWei!=='0'?' The Ethereum data fee is not capped by the transfer itself.':''}</p>
   <div className="exposure-actions"><button className="silo-primary" disabled={step==='signing'} onClick={()=>void confirm()}>{step==='signing'?'Sending…':'Confirm and send'}</button><button disabled={step==='signing'} onClick={again}>Cancel</button></div>
  </>}
  {step==='resolve'&&<>
   {attempt
    ?<><p role="status"><strong>A transfer is not resolved yet.</strong> Silo could not confirm whether it reached the network. It may still arrive. You cannot start another payment until this one is resolved, so a second payment cannot start by mistake. This record is kept in this browser only.</p>
     <p className="exposure-note">Transaction: <code>{attempt.hash}</code>{link&&<> · <a href={link} target="_blank" rel="noopener noreferrer">View on explorer</a></>}</p>
     <div className="exposure-actions"><button className="silo-primary" disabled={busy} onClick={()=>void check()}>{busy?'Checking…':'Check status'}</button>{sending&&<button disabled={busy} onClick={()=>void resend()}>Send the same transfer again</button>}</div>
     {clearPanel}</>
    :corrupt
     ?<><p role="status"><strong>A saved transfer record cannot be read.</strong> Sending is paused for this wallet. The record may belong to a transfer that is still on its way, so look at this wallet on a block explorer first. If you are sure nothing is pending, you can clear it: the unreadable text is saved whole in a list in this browser before it is removed.</p>{clearPanel}</>
     :<p role="status">Sending is paused for this wallet until this browser can save transfer state.</p>}
  </>}
  {step==='done'&&sentHash&&<>
   {result?.mined&&result.reverted&&result.final
    ?<p role="alert" className="exposure-error"><strong>The network recorded this transfer as failed.</strong> The amount did not move, but the network fee was spent.</p>
    :result?.mined&&result.reverted
     ?<p role="status"><strong>In a block, marked as failed for now</strong> ({result.confirmations??0} of {result.required??'several'} confirmations). This is not final: a block can still be replaced. Check again before relying on it.</p>
     :result?.mined&&result.final
      ?<p role="status"><strong>Confirmed.</strong> The transfer is final on {chain.name}.</p>
      :result?.mined
       ?<p role="status"><strong>In a block, confirming</strong> ({result.confirmations??0} of {result.required??'several'}).</p>
       :<p role="status"><strong>Submitted.</strong> The network accepted it; it is not confirmed yet. Sending stays paused until it is final.</p>}
   {attempt&&<button disabled={busy} onClick={()=>void checkResult()}>{busy?'Checking…':'Check result'}</button>}
   <p className="exposure-note">Transaction: <code>{sentHash}</code>{link&&<> · <a href={link} target="_blank" rel="noopener noreferrer">View on explorer</a></>}</p>
   {attempt?<>{sending&&<p className="exposure-note">Another payment can start once this one is final.</p>}{clearPanel}</>:<button onClick={again}>Send another</button>}
  </>}
  {note&&<p className="exposure-note" role="status">{note}</p>}
  {error&&<p role="alert" className="exposure-error">{error}</p>}
 </div>;
}
