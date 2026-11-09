'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {AlertTriangle} from 'lucide-react';
import {SiloAssetIcon} from './silo-asset-icon';
import {SiloReceiveAddress} from './silo-receive-address';
import {SiloHiddenAmount} from './silo-balance-visibility';
import {SiloNativePublicWallet,type SiloNativeSession} from './silo-native-public-wallet';
import {sessionRpcFetch} from '@/lib/browser-rpc-session.mjs';
import {siloBtcScanWallet,siloBtcNextIndex,SILO_BTC_GAP_LIMIT,SILO_BTC_SCAN_MAX,siloBtcValidAddress} from '@/lib/silo/btc.mjs';
import {siloBtcRelayClient} from '@/lib/silo/btc-client.mjs';
import {siloBtcErrorText,siloBtcJournalBegin,siloBtcJournalRead,siloBtcAssertNoUnresolved,siloBtcBroadcastJournaled,siloBtcResolveUnresolved,siloBtcJournalManualClear,siloBtcAuditArchive,SILO_BTC_ARCHIVE_MAX,siloBtcReceiveIndexRead,siloBtcReceiveIndexRaise,SILO_BTC_UNRESOLVED_NOTE} from '@/lib/silo/btc-journal.mjs';
import {siloBtcBuildSend,siloBtcFeeTiers,siloBtcFormat,siloBtcParseAmount} from '@/lib/silo/btc-send.mjs';
import {SILO_BTC_COPY,siloBtcLimitText} from '@/lib/silo/btc-copy.mjs';
import {siloBtcNetworkLabel} from '@/lib/silo/btc.mjs';
import type {NativeChain,NativeEnvelope} from '@/lib/silo/native-keyring.mjs';

type Network='signet'|'testnet'|'mainnet';
type Row={address:string;txCount:number;confirmedSats:number;pendingSats:number;agree?:boolean};
type Coin={txid:string;vout:number;value:number;confirmed:boolean;address:string};
type Activity={txid:string;netSats:number;confirmed:boolean;time:number|null;agree?:boolean};
type Review={psbt:Uint8Array;summary:ReturnType<NativeBtc['reviewBtc']>;tier:string};
type NativeBtc=SiloNativeSession;
type Scan={confirmed:number;pending:number;nextChange:string|null;used:{chain:0|1;index:number;address:string}[];firstUnused:number;remembered:number};
const FEE_LABEL:Record<string,string>={fast:'Fast · about 1 block',normal:'Normal · about 3 blocks',economy:'Economy · about 12 blocks'};
/** Bitcoin test-network wallet (first release). Receive, balance, history and send, with Silo's own key. Reads go through Grain's
 * /api/silo/btc relay and only after an explicit request. Sending needs its own flag and always shows a review decoded from the
 * transaction bytes before anything is signed. Real bitcoin is not supported in this version. */
export function SiloBtcZone({network,sendEnabled,capSats,mainnetMode=false,getAccountBackup,reviewedOrigin=null}:{network:Network;sendEnabled:boolean;capSats:number;mainnetMode?:boolean;getAccountBackup?:(chain:NativeChain)=>Promise<NativeEnvelope>;reviewedOrigin?:string|null}){
 const session=useRef<NativeBtc|null>(null),epoch=useRef(0);
 const [open,setOpen]=useState(false),[receiveReady,setReceiveReady]=useState(false),[consented,setConsented]=useState(false);
 const [scan,setScan]=useState<Scan|null>(null),[history,setHistory]=useState<Activity[]|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[ahead,setAhead]=useState(0);
 const [dest,setDest]=useState(''),[amount,setAmount]=useState(''),[all,setAll]=useState(false),[tier,setTier]=useState('normal'),[fees,setFees]=useState<Record<string,number>|null>(null);
 const [disagree,setDisagree]=useState(false),[review,setReview]=useState<Review|null>(null),[sent,setSent]=useState<string|null>(null),[phrase,setPhrase]=useState(''),[phrasePass,setPhrasePass]=useState(''),[phraseNote,setPhraseNote]=useState('');
 useEffect(()=>()=>{epoch.current++;},[]);
 const reset=useCallback(()=>{epoch.current++;setScan(null);setHistory(null);setBusy(false);setError('');setAhead(0);setReview(null);setSent(null);setConsented(false);setFees(null);setPhrase('');setPhrasePass('');setPhraseNote('');},[]);
 const onSession=useCallback((next:SiloNativeSession|null)=>{reset();session.current=next;setOpen(Boolean(next));if(!next)setReceiveReady(false);},[reset]);
 const onReceiveReady=useCallback((ready:boolean)=>{setReceiveReady(ready);if(!ready)reset();},[reset]);
 const setErrorSafe=(message:string)=>{let store:Storage|null=null;try{store=window.localStorage;}catch{store=null;}setError(store?siloBtcErrorText(store,network,message):message);};
 const client=siloBtcRelayClient((body:Record<string,unknown>)=>sessionRpcFetch('/api/silo/btc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
 const relay=(body:Record<string,unknown>)=>client.relay(body,network);
 const storage=()=>{try{return window.localStorage;}catch{return null;}};
 const [unresolved,setUnresolved]=useState<string>(''),[unresolvedId,setUnresolvedId]=useState(''),[ackText,setAckText]=useState(''),[ackTick,setAckTick]=useState(false),[revived,setRevived]=useState<string[]>([]);
 const refreshUnresolved=useCallback(()=>{const store=storage();const row=store?siloBtcJournalRead(store,network):{unreadable:true};setUnresolved(row===null?'':SILO_BTC_UNRESOLVED_NOTE);setUnresolvedId(row&&!row.unreadable?row.txid:row?'unreadable':'');},[network]);
 useEffect(()=>{refreshUnresolved();},[refreshUnresolved,open]);
 async function check(){
  const active=session.current;if(!active)return;const operation=++epoch.current;setBusy(true);setError('');setConsented(true);
  try{
   const rows=new Map<string,Row>();
   const lookup=async(addresses:string[])=>{const data=await relay({action:'status',addresses});if(!Array.isArray(data.rows)||data.rows.length!==addresses.length)throw Object.assign(Error('The Bitcoin data provider sent an unexpected answer.'),{relay:true});
    return data.rows.map((row:Row,i:number)=>{if(row.address!==addresses[i])throw Object.assign(Error('The Bitcoin data provider sent an unexpected answer.'),{relay:true});rows.set(row.address,row);return row.txCount>0;});};
   // Every used address of both chains is found and kept (no truncation); derivation is in batches of the gap limit, under the session's per-call limit.
   const found=await siloBtcScanWallet({derive:(chain:number,from:number,count:number)=>active.btcAddresses(chain as 0|1,from,count),lookup,maxIndex:SILO_BTC_SCAN_MAX});
   if(operation!==epoch.current)return;
   const used=found.used as Scan['used'];setDisagree([...rows.values()].some(r=>r.agree===false));
   let confirmed=0,pending=0;for(const item of used){const row=rows.get(item.address);if(row){confirmed+=row.confirmedSats;pending+=row.pendingSats;}}
   const firstUnused=found.chains[0].firstUnused,changeUnused=found.chains[1].firstUnused;
   const store=storage();const remembered=store?siloBtcReceiveIndexRead(store,network):0;
   const changePlan=siloBtcNextIndex({firstUnused:changeUnused});
   setScan({confirmed,pending,nextChange:changePlan.index===null?null:active.btcAddresses(1,changePlan.index,1)[0].address,used,firstUnused,remembered});setAhead(0);
   const recent=[...used].sort((x,y)=>y.index-x.index).slice(0,SILO_BTC_GAP_LIMIT).map(item=>item.address);
   if(recent.length){const data=await relay({action:'history',addresses:recent});if(operation===epoch.current)setHistory(Array.isArray(data.rows)?data.rows:[]);}else setHistory([]);
  }catch(failure){if(operation===epoch.current)setErrorSafe(failure instanceof Error&&(failure as Error&{relay?:boolean}).relay?failure.message:'Balance could not be read.');}
  finally{if(operation===epoch.current)setBusy(false);}
 }
 // A new receive address is only offered up to the gap limit ahead of the first unused one, so a restore always finds every coin.
 const plan=scan?siloBtcNextIndex({firstUnused:scan.firstUnused,remembered:scan.remembered,pressed:ahead}):null;
 const receiveIndex=plan?.index??0;
 const receiveAddress=scan&&open&&plan&&plan.index!==null?session.current?.btcAddresses(0,plan.index,1)[0].address??null:null;
 useEffect(()=>{const store=storage();if(store&&scan&&receiveAddress)siloBtcReceiveIndexRaise(store,network,receiveIndex);},[scan,receiveAddress,receiveIndex,network]);
 const canAdvance=Boolean(plan?.canAdvance);
 async function prepare(){
  const active=session.current;if(!active||!scan)return;const operation=++epoch.current;setBusy(true);setError('');setReview(null);setSent(null);
  try{
   const store=storage();if(!store)throw Object.assign(Error('This browser cannot keep a record of a send, so sending is off.'),{relay:true});
   siloBtcAssertNoUnresolved(store,network);
   if(!siloBtcValidAddress(dest.trim(),network))throw Object.assign(Error('That is not a valid address for this Bitcoin network.'),{relay:true});
   const sats=all?undefined:siloBtcParseAmount(amount);
   const feeData=await relay({action:'fees'});const tiers=siloBtcFeeTiers(feeData.estimates,network);if(operation!==epoch.current)return;setFees({...tiers});
   const tip=await relay({action:'tip'});
   if(!scan.used.length)throw Object.assign(Error('There is nothing to send yet.'),{relay:true});
   if(!scan.nextChange)throw Object.assign(Error(SILO_BTC_COPY.exhausted),{relay:true});
   // ALL used addresses are asked, in batches of 20: a coin on an old address is never left out of a send.
   const coins:Coin[]=[];const addresses=scan.used.map(item=>item.address);
   for(let i=0;i<addresses.length;i+=20){const part=await relay({action:'utxos',addresses:addresses.slice(i,i+20)});if(!Array.isArray(part.coins))throw Object.assign(Error('The Bitcoin data provider sent an unexpected answer.'),{relay:true});coins.push(...part.coins);if(operation!==epoch.current)return;}
   const fetchPrevTxs=async(txids:string[])=>{const out:Record<string,string>={};for(let i=0;i<txids.length;i+=20){const part=await relay({action:'txhex',txids:txids.slice(i,i+20)});if(!Array.isArray(part.rows))throw Object.assign(Error('The Bitcoin data provider sent an unexpected answer.'),{relay:true});for(const row of part.rows)out[row.txid]=row.hex;}return out;};
   const {psbt}=await siloBtcBuildSend({network,utxos:coins,destination:dest.trim(),amountSats:sats as number,feeRate:tiers[tier as keyof typeof tiers],changeAddress:scan.nextChange as string,sendAll:all,fetchPrevTxs,lockTime:tip.height,capSats});
   const summary=active.reviewBtc(psbt);if(operation!==epoch.current)return;
   setReview({psbt,summary,tier});
  }catch(failure){if(operation===epoch.current)setErrorSafe(failure instanceof Error&&((failure as Error&{relay?:boolean;siloBtc?:boolean;siloBtcJournal?:string}).relay||(failure as Error&{siloBtc?:boolean}).siloBtc||(failure as Error&{siloBtcJournal?:string}).siloBtcJournal)?failure.message:'The send could not be prepared. Nothing was signed.');}
  finally{if(operation===epoch.current)setBusy(false);}
 }
 const sendRaw=client.send,statusRaw=client.status,outspendsRaw=client.outspends;
 function explain(result:{state:string;note?:string}){
  if(result.state==='accepted'||result.state==='already-known')return {done:true,text:''};
  return {done:false,text:result.note??SILO_BTC_UNRESOLVED_NOTE};
 }
 async function approve(){
  const active=session.current;if(!active||!review)return;const operation=++epoch.current;setBusy(true);setError('');
  try{
   const store=storage();if(!store)throw Object.assign(Error('This browser cannot keep a record of a send, so nothing was signed.'),{relay:true});
   siloBtcAssertNoUnresolved(store,network);
   const signed=active.signReviewedBtc(review.psbt,review.summary.digest,{capSats});
   // The signed bytes and the intent are written BEFORE any broadcast; if that fails nothing is sent.
   const record=siloBtcJournalBegin(store,network,{txid:signed.txid,hex:signed.hex,destination:review.summary.outputs.find(o=>!o.own)?.address??'',amountSats:review.summary.sendSats,feeSats:review.summary.feeSats});
   setReview(null);
   const result=await siloBtcBroadcastJournaled({storage:store,network,record,send:sendRaw,status:statusRaw});
   refreshUnresolved();
   if(operation!==epoch.current&&result.state!=='unresolved')return;
   const verdict=explain(result);
   if(verdict.done){setSent(signed.txid);setDest('');setAmount('');setAll(false);}
   else setError(verdict.text);
  }catch(failure){if(operation===epoch.current)setErrorSafe(failure instanceof Error&&((failure as Error&{relay?:boolean;siloBtc?:boolean;siloBtcJournal?:string}).relay||(failure as Error&{siloBtc?:boolean}).siloBtc||(failure as Error&{siloBtcJournal?:string}).siloBtcJournal)?failure.message:'The transaction was not signed.');refreshUnresolved();}
  finally{setBusy(false);}
 }
 async function resolveUnresolved(){
  const store=storage();if(!store)return;setBusy(true);setError('');
  try{const result=await siloBtcResolveUnresolved({storage:store,network,send:sendRaw,status:statusRaw,outspends:outspendsRaw});refreshUnresolved();
   if(result.state==='accepted'||result.state==='already-known'){setSent('resolved');setError('');}
   else setError(result.note??SILO_BTC_UNRESOLVED_NOTE);}
  finally{setBusy(false);}
 }
 // The only other exit: the person's own deliberate clear, after checking elsewhere. The record is archived, never lost.
 function manualClear(){
  const store=storage();if(!store)return;setError('');
  try{siloBtcJournalManualClear(store,network,{acknowledge:ackText.trim()});setAckText('');setAckTick(false);refreshUnresolved();void siloBtcAuditArchive({storage:store,network,status:statusRaw}).then(seen=>setRevived(seen.map(x=>x.txid)));}
  catch(failure){setError(failure instanceof Error?failure.message:'The record was not cleared.');}
 }
 useEffect(()=>{const store=storage();if(!store||!open)return;let live=true;void siloBtcAuditArchive({storage:store,network,status:statusRaw}).then(seen=>{if(live)setRevived(seen.map(x=>x.txid));});return()=>{live=false;};// eslint-disable-next-line react-hooks/exhaustive-deps
 },[open,network]);
 async function reveal(){
  const active=session.current;if(!active)return;setPhraseNote('');
  try{setPhrase(await active.revealRecoveryPhrase(phrasePass));setPhrasePass('');}catch{setPhraseNote('The passphrase did not open this wallet.');}
 }
 const real=network==='mainnet',label=real?'mainnet':network;
 return <section id="silo-btc" className="exposure-panel silo-zone">
  <div className="silo-zone-head"><SiloAssetIcon asset="btc" network={network}/><div><h2>{real?'Bitcoin':'Bitcoin · test network'}</h2><span className="silo-zone-network">{real?'Public · Mainnet · real funds':`Public · ${label} · test coins only, no real bitcoin`}</span></div></div>
  {network!=='mainnet'&&!(receiveReady&&open)&&<p className="exposure-note" data-btc-moved-slot>{SILO_BTC_COPY.movedSlot}</p>}
  {receiveReady&&open&&<div className="silo-wallet-grid">
   <div className="silo-wallet-col"><div className="silo-inset">
    {!consented?<><p className="exposure-note">Checking sends this wallet&apos;s public addresses to Grain&apos;s server and a public Bitcoin data provider (mempool.space or blockstream.info). Addresses used together can be linked by anyone reading the chain.</p><button disabled={busy} onClick={()=>void check()}>{busy?'Checking…':'Check balance'}</button></>
     :scan?<>
      <p className="silo-public-balance"><SiloHiddenAmount>{siloBtcFormat(scan.confirmed)} BTC</SiloHiddenAmount></p>
      {scan.pending!==0&&<p className="exposure-note" role="status">Pending: {scan.pending>0?'+':''}{siloBtcFormat(Math.abs(scan.pending))} BTC until confirmed.</p>}
      <button disabled={busy} onClick={()=>void check()}>{busy?'Checking…':'Refresh'}</button>
      {history&&history.some(row=>row.agree===false)&&<p className="exposure-note" role="status">{SILO_BTC_COPY.historyDisagree}</p>}
      {history&&(history.length?<ul className="silo-tx-list">{history.map(row=><li key={row.txid} className="silo-tx"><span className="silo-tx-main"><strong>{row.netSats>=0?'Received':'Sent'}</strong><span>{row.confirmed?'Confirmed':'Pending'}{row.agree===false?' · providers differ':''} · <code>{row.txid.slice(0,12)}…</code></span></span><SiloHiddenAmount>{row.netSats>=0?'+':'-'}{siloBtcFormat(Math.abs(row.netSats))} BTC</SiloHiddenAmount></li>)}</ul>:<p className="silo-empty">No activity yet.</p>)}
     </>:busy?<p className="exposure-note" role="status">Checking this wallet&apos;s addresses…</p>:null}
    {error&&<p role="alert" className="exposure-error">{error}</p>}
    {disagree&&<p className="exposure-note" role="status">{SILO_BTC_COPY.disagree}</p>}
   </div></div>
   <div className="silo-wallet-col"><div className="silo-inset">
    {receiveAddress?<><SiloReceiveAddress key={receiveAddress} address={receiveAddress} asset={real?'Bitcoin':`Bitcoin ${label} coins`} network={siloBtcNetworkLabel(network)} note={real?'Send only Bitcoin to this address, on the Bitcoin network.':SILO_BTC_COPY.testNetwork}/>
     <button type="button" disabled={!canAdvance} onClick={()=>setAhead(ahead+1)}>New address</button></>
     :scan&&plan?.exhausted?<p className="exposure-error" role="alert">{SILO_BTC_COPY.exhausted}</p>:<p className="exposure-note">Check the balance first. Silo then shows the next unused receive address, so an address is not reused.</p>}
   </div></div>
  </div>}
  {receiveReady&&open&&sendEnabled&&scan&&<div id="silo-btc-send" className="silo-inset silo-send">
   <h3>Send</h3>
   {real&&<p className="exposure-note">{siloBtcLimitText(capSats)}</p>}
   {revived.length>0&&<p role="alert" className="exposure-error">A payment you cleared by hand now appears on the network ({revived[0].slice(0,12)}…). It may be real. Check this wallet&apos;s history before sending anything.</p>}
   {unresolved?<><div role="alert" className="silo-btc-unresolved"><AlertTriangle size={18} aria-hidden="true"/><div><p className="exposure-error">{unresolved}</p><p className="exposure-note">{SILO_BTC_COPY.unresolved}</p>{unresolvedId&&unresolvedId!=='unreadable'&&<p className="exposure-note">Transaction id <code>{unresolvedId}</code></p>}</div></div>
    <button type="button" className="primary-action silo-btc-wide" disabled={busy} onClick={()=>void resolveUnresolved()}>{busy?'Checking…':'Check status or rebroadcast'}</button>
    <details className="silo-restore-options"><summary>I checked elsewhere</summary><div className="silo-fields">
     <p className="exposure-note"><strong>Sending again can pay twice.</strong></p>
     <p className="exposure-note">Silo cannot know for you whether this payment will appear. Bitcoin payments do not expire, and a payment that is not visible now can still appear later and be paid. Look up the transaction id above in a block explorer for this network, or in another wallet that shows this wallet&apos;s history. Clear the record only if you are sure it is not there. Until it is cleared or confirmed, this wallet will not send.</p>
     <p className="exposure-note">What is kept: when you clear, the signed transaction, its id and the amount and address are saved in this browser, in a list of up to {SILO_BTC_ARCHIVE_MAX} cleared payments (an unreadable record is saved whole, as text). If the list cannot be read or saved, or is full, nothing is cleared. Silo looks for those payments again each time this screen opens and right after you clear, and warns you if one appears. It cannot look while the screen is closed, and erasing this browser&apos;s data erases the list.</p>
     <label className="silo-check"><input type="checkbox" checked={ackTick} onChange={event=>setAckTick(event.target.checked)}/> I understand this payment could still appear and be paid.</label>
     <label>Type {unresolvedId==='unreadable'?'unreadable':unresolvedId.slice(0,8)} to confirm<input value={ackText} onChange={event=>setAckText(event.target.value)} autoComplete="off" spellCheck={false}/></label>
     <button type="button" className="silo-btc-danger" disabled={!ackTick||!ackText.trim()} onClick={manualClear}>Clear this record</button>
    </div></details></>:sent?<p role="status" className="exposure-note">Sent{real?'':` on ${label}`}. {sent==='resolved'?'The network has this transaction.':<>Transaction id <code>{sent}</code>.</>} It shows as pending until it is confirmed.</p>:review?<>
    <p className="silo-btc-amount"><span className="silo-eyebrow">Amount</span><strong><SiloHiddenAmount>{siloBtcFormat(review.summary.sendSats)} BTC</SiloHiddenAmount></strong><span className="silo-btc-net">{siloBtcNetworkLabel(network)}</span></p>
    <dl className="silo-disclosure silo-btc-review" aria-label="Review before signing">
     <dt>To</dt><dd><code>{review.summary.outputs.find(o=>!o.own)?.address??review.summary.outputs[0].address}</code></dd>
     <dt>Network fee</dt><dd>{siloBtcFormat(review.summary.feeSats)} BTC · {review.summary.feeRate} sat/vB · {FEE_LABEL[review.tier]}</dd>
     <dt>Total leaving this wallet</dt><dd>{siloBtcFormat(review.summary.leavesWalletSats)} BTC</dd>
     {review.summary.outputs.some(o=>o.change)&&<><dt>Change returns to</dt><dd><code>{review.summary.outputs.find(o=>o.change)?.address}</code></dd></>}
    </dl>
    <details className="silo-restore-options"><summary>Details</summary><dl className="silo-disclosure silo-btc-review"><dt>Coins used</dt><dd>{review.summary.inputs.length}</dd><dt>Network</dt><dd>{siloBtcNetworkLabel(network)}</dd></dl></details>
    <p className="exposure-note">{SILO_BTC_COPY.review}</p>
    <div className="silo-btc-actions"><button className="primary-action" disabled={busy} onClick={()=>void approve()}>{busy?'Sending…':'Sign and send'}</button><button type="button" disabled={busy} onClick={()=>setReview(null)}>Cancel</button></div>
    <p className="exposure-note">{SILO_BTC_COPY.confirmations}</p>
   </>:<>
    <label>To<input value={dest} onChange={event=>setDest(event.target.value)} autoComplete="off" spellCheck={false} placeholder={real?'bc1…':'tb1…'}/></label>
    <label>Amount (BTC)<input value={amount} disabled={all} inputMode="decimal" onChange={event=>setAmount(event.target.value)} autoComplete="off" placeholder="0.00010000"/></label>
    <label className="silo-check"><input type="checkbox" checked={all} onChange={event=>setAll(event.target.checked)}/> Send everything (the fee comes out of the amount)</label>
    <label>Fee<select value={tier} onChange={event=>setTier(event.target.value)}>{Object.keys(FEE_LABEL).map(key=><option key={key} value={key}>{FEE_LABEL[key]}{fees?` · ${fees[key]} sat/vB`:''}</option>)}</select></label>
    <button disabled={busy||!dest.trim()||(!all&&!amount.trim())} onClick={()=>void prepare()}>{busy?'Preparing…':'Review'}</button>
    <p className="exposure-note">Review shows the exact amount, fee and destination. Nothing is signed until you approve it.</p>
   </>}
   {error&&<p role="alert" className="exposure-error">{error}</p>}
  </div>}
  {receiveReady&&open&&<details className="silo-restore-options"><summary>Recovery phrase</summary><div className="silo-fields">
   <p className="exposure-note">The 24 words restore this wallet in any standard Bitcoin wallet. Anyone who sees them can take the coins. Show them only in private.</p>
   <p className="exposure-note">{SILO_BTC_COPY.notRestored}</p>
   {phrase?<><code className="exposure-address" aria-label="Recovery phrase">{phrase}</code><button type="button" onClick={()=>setPhrase('')}>Hide</button></>:<><label>Passphrase<input type="password" value={phrasePass} onChange={event=>setPhrasePass(event.target.value)} autoComplete="current-password"/></label><button type="button" disabled={!phrasePass} onClick={()=>void reveal()}>Show recovery phrase</button></>}
   {phraseNote&&<p role="alert" className="exposure-error">{phraseNote}</p>}
  </div></details>}
  <details className="silo-restore-options"><summary>What is visible</summary><div className="silo-fields"><p className="exposure-note">{SILO_BTC_COPY.visible}</p></div></details>
  {/* Always mounted: unmounting locks the native session. Creating, unlocking, backing up and restoring use the same flows as the other wallets. */}
  <SiloNativePublicWallet getAccountBackup={getAccountBackup} chain="btc" keyNetwork={network} permitted={true} reviewedOrigin={reviewedOrigin} mainnetMode={mainnetMode||real} receive={null} onSession={onSession} onReceiveReady={onReceiveReady}/>
 </section>;
}
