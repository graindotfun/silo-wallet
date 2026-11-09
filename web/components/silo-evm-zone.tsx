'use client';
import {SiloHiddenAmount} from './silo-balance-visibility';
import {useEffect,useRef,useState} from 'react';
import {SiloReceiveAddress} from './silo-receive-address';
import {SiloAssetIcon} from './silo-asset-icon';
import type {NativeChain,NativeEnvelope} from '@/lib/silo/native-keyring.mjs';
import {SiloNativePublicWallet,type SiloNativeSession} from './silo-native-public-wallet';
import {siloDisclosure} from '@/lib/silo/disclosures.mjs';
import {siloUnits} from '@/lib/silo/amounts.mjs';
import {siloEvmAddress} from '@/lib/silo/evm.mjs';
import {sessionRpcFetch} from '@/lib/browser-rpc-session.mjs';
import {SiloEvmSend} from './silo-evm-send';
export type SiloEvmChainStatus={chainId:number;name:string;symbol:string;enabled:boolean;configured:boolean;send?:boolean};
type Balances={chainId:number;address:string;native:{symbol:string;decimals:number;amount:string};tokens:{symbol:string;name:string;contract:string;decimals:number;amount:string|null}[]};
export type SiloEvmReport={address:string;chainId:number;chainName:string;symbol:string;decimals:number;amount:string|null;tokens:number};
/** View and receive only, with Silo's own EVM wallet. Balances come from Grain's /api/silo/evm relay, and only after an explicit read. No browser wallet is asked for anything. */
export function SiloEvmZone({chains,enabled,onReport,nativePermitted=false,reviewedOrigin=null,mainnetMode=true,sendPermitted=false,getAccountBackup}:{getAccountBackup?:(chain:NativeChain)=>Promise<NativeEnvelope>;chains:SiloEvmChainStatus[];enabled:boolean;onReport:(report:SiloEvmReport|null)=>void;nativePermitted?:boolean;reviewedOrigin?:string|null;mainnetMode?:boolean;sendPermitted?:boolean}){
 const usable=chains.filter(chain=>chain.enabled);
 const [session,setSession]=useState<SiloNativeSession|null>(null),[address,setAddress]=useState<string|null>(null),[receiveReady,setReceiveReady]=useState(false),[consented,setConsented]=useState(false),[chainId,setChainId]=useState<number>(usable.find(chain=>chain.configured)?.chainId??usable[0]?.chainId??1);
 const [balances,setBalances]=useState<Balances|null>(null),[reading,setReading]=useState(false),[readError,setReadError]=useState('');
 const epoch=useRef(0);
 const chain=chains.find(row=>row.chainId===chainId)??null;
 useEffect(()=>()=>{epoch.current++;},[]);
 function clear(){epoch.current++;setSession(null);setAddress(null);setConsented(false);setBalances(null);setReadError('');setReading(false);onReport(null);}
 async function read(address:string,target:number){
  const selected=chains.find(row=>row.chainId===target);
  const operation=++epoch.current;setBalances(null);setReadError('');onReport(null);
  // An unconfigured chain is never asked: the address does not leave the browser for it.
  if(!selected?.enabled||!selected.configured){setReading(false);return;}
  setReading(true);
  try{
   const response=await sessionRpcFetch('/api/silo/evm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chainId:target,address})});
   const data=await response.json().catch(()=>null) as Balances|{error?:string}|null;
   if(operation!==epoch.current)return;
   if(!response.ok||!data||!('native' in data)||data.chainId!==target||data.address!==address){setReadError(response.status===429?'Balance reads are busy. Try again shortly.':'Balances were not read. Try again in a moment.');return;}
   setBalances(data);onReport({address,chainId:target,chainName:selected.name,symbol:data.native.symbol,decimals:data.native.decimals,amount:data.native.amount,tokens:data.tokens.filter(row=>row.amount!==null&&row.amount!=='0').length});
  }catch{if(operation===epoch.current)setReadError('Balances were not read. Try again in a moment.');}
  finally{if(operation===epoch.current)setReading(false);}
 }
 function onSession(next:SiloNativeSession|null){clear();if(!next)return;try{setAddress(siloEvmAddress(next.metadata().address));setSession(next);}catch{/* An invalid address is never shown or sent. */}}
 function onReceive(ready:boolean){setReceiveReady(ready);if(!ready){epoch.current++;setConsented(false);setBalances(null);setReading(false);onReport(null);}}
 // The address is sent only after this explicit request, and again only when the person picks another chain.
 function check(){if(!address||!enabled)return;setConsented(true);void read(address,chainId);}
 function pick(next:number){setChainId(next);if(address&&consented)void read(address,next);}
 const disclosure=siloDisclosure('evm');
 const shown=receiveReady?address:null;
 return <section id="silo-evm" className="exposure-panel silo-zone">
  <div className="silo-zone-head"><SiloAssetIcon asset={chainId===8453?'base':chainId===56?'bnb':'eth'}/><div><h2>EVM · public zone</h2><span className="silo-zone-network">{usable.map(row=>row.name).join(', ')} · {sendPermitted&&usable.some(row=>row.send)?'view, receive and send':'view and receive'}</span></div><span className="silo-tag">Public</span></div>
  {shown&&<div className="silo-wallet-grid">
   <div className="silo-wallet-col">
    <div className="silo-inset">
     <label>Show balances on<select value={chainId} onChange={event=>pick(Number(event.target.value))}>{chains.map(row=><option key={row.chainId} value={row.chainId} disabled={!row.enabled}>{row.name}{!row.enabled?' · not available yet':!row.configured?' · not configured':''}</option>)}</select></label>
     <p className="silo-hint">This only chooses which chain Silo reads. The same address is used on every EVM chain.</p>
     <code className="exposure-address">{shown}</code>
     {chain&&!chain.configured?<p className="exposure-note" role="status">{chain.name} balances are not configured on this server. Your address was not sent anywhere for {chain.name}.</p>
      :!consented?<><p className="exposure-note">Checking sends this address and the selected chain to Grain&apos;s server and its RPC provider.</p><button disabled={!enabled||reading} onClick={check}>Check {chain?.name??'EVM'} balances</button></>
      :reading?<p className="exposure-note" role="status">Reading {chain?.name} balances…</p>
      :balances?<>
       <p className="silo-public-balance"><SiloHiddenAmount>{siloUnits(balances.native.amount,balances.native.decimals)} {balances.native.symbol}</SiloHiddenAmount></p>
       <ul className="silo-tx-list">{balances.tokens.map(row=><li key={row.contract} className="silo-tx"><SiloAssetIcon asset={chainId===8453?'base':chainId===56?'bnb':'eth'}/><span className="silo-tx-main"><strong>{row.symbol}</strong><small>{row.name} · <code>{row.contract.slice(0,6)}…{row.contract.slice(-4)}</code></small></span><span className="silo-tx-amount"><SiloHiddenAmount>{row.amount===null?'Not read':siloUnits(row.amount,row.decimals)}</SiloHiddenAmount></span></li>)}</ul>
       <p className="exposure-note">Native balance and a fixed list of major tokens only. Other tokens at this address are not shown.</p>
       <button onClick={()=>void read(shown,chainId)}>Refresh balances</button>
      </>:null}
     {readError&&<p role="alert" className="exposure-error">{readError}</p>}
     {!enabled&&<p className="exposure-note">EVM balance reads are available in the full site.</p>}
    </div>
   </div>
   <div className="silo-wallet-col"><div className="silo-inset"><SiloReceiveAddress key={shown} address={shown} asset={`${chain?.symbol??'ETH'} / ${chain?.name??'EVM'} tokens`} network={chain?.name??'EVM'} note={`Send only ${chain?.name??'EVM'} assets to this address on ${chain?.name??'that chain'}. The same address is used on all EVM chains.`}/></div></div>
  </div>}
  {/* Mounted whenever sending is permitted for this page, even with the chain's send flag off, so an unresolved transfer can still be checked while sending is paused. */}
  {shown&&session&&sendPermitted&&chain&&<SiloEvmSend session={session} chain={chain} sending={chain.send===true}/>}
  {/* Always mounted: unmounting locks the native session. */}
  <SiloNativePublicWallet sendEnabled={sendPermitted&&usable.some(row=>row.send)} getAccountBackup={getAccountBackup} chain="evm" permitted={nativePermitted} reviewedOrigin={reviewedOrigin} mainnetMode={mainnetMode} receive={null} onSession={onSession} onReceiveReady={onReceive}/>
  <div className="silo-more"><details className="silo-privacy-details"><summary>What is visible on EVM chains</summary><dl className="silo-disclosure"><dt>Network</dt><dd>{disclosure.network}</dd><dt>What is protected</dt><dd>{disclosure.hidden}</dd><dt>What remains visible</dt><dd>{disclosure.visible}</dd><dt>Who can inspect it</dt><dd>{disclosure.observers}</dd></dl></details></div>
 </section>;
}
