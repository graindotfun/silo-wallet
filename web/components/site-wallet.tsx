"use client";
import Image from 'next/image';
import {useEffect,useEffectEvent,useRef,useState} from 'react';
import {ArrowUpRight,Check,ChevronDown,ChevronRight,Copy,Loader2,Lock,LogOut,Repeat,RotateCcw} from 'lucide-react';
import {siteWalletSession,walletNetworkLabel} from '@/lib/site-wallet-session.mjs';
import {useSiteWallet} from './use-site-wallet';
import {discoverEvmWalletAdapters,connectSiteEvmWallet,restoreSiteWallet,disconnectSiteWallet} from '@/lib/site-wallet-client';
import type {EvmDiscoveredWallet} from '@/lib/chain/evm-wallet-adapter.ts';
import {connectWalletWithIntent} from '@/lib/wallet-connection-intent.mjs';
import {walletProviders,type WalletProvider} from '@/lib/wallet';
import {groupWalletProviders,readLastUsedWallet,rememberLastUsedWallet,walletConnectError,addressGradient,shortAddress} from '@/lib/wallet-picker.mjs';
import {BRAND_ASSETS} from '@/lib/brand-assets';
import {Button} from './ui/button';
import {Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle} from './ui/dialog';
import {OpenInWallet} from './open-in-wallet';
import {WalletLogo} from './wallet-logos';
type Row={provider:WalletProvider;label:string};
type Attempt={row:Row;error:string}|null;

function Avatar({address,size=28}:{address:string;size?:number}){return <span className="wallet-avatar" style={{width:size,height:size,background:addressGradient(address)}} aria-hidden="true"/>;}

function WalletRow({row,lastUsed,secondary,onSelect}:{row:Row;lastUsed?:boolean;secondary?:boolean;onSelect:()=>void}){
 const p=row.provider;
 return <button type="button" className="wallet-row" data-wallet-row={p.brand.toLowerCase()} onClick={onSelect} aria-label={`Connect ${row.label}`}>
  <WalletLogo brand={p.brand} icon={p.icon} size={secondary?32:40}/>
  <span className="wallet-row-name"><strong>{row.label}</strong>{secondary?<small>Wallet Standard connection</small>:lastUsed?<small className="wallet-row-last">Last used</small>:null}</span>
  {!secondary&&<span className="wallet-row-status">Detected</span>}
  <ChevronRight className="wallet-row-arrow" size={18} aria-hidden="true"/>
 </button>;
}

export function SiteWallet(){
 const session=useSiteWallet();
 const [family,setFamily]=useState<'solana'|'robinhood'>('solana'),[evmChoices,setEvmChoices]=useState<EvmDiscoveredWallet[]>([]),[discovering,setDiscovering]=useState(false),[evmAttempt,setEvmAttempt]=useState<{choice:EvmDiscoveredWallet;error:string}|null>(null);
 const [open,setOpen]=useState(false),[choices,setChoices]=useState<WalletProvider[]>([]),[lastUsed,setLastUsed]=useState(''),[attempt,setAttempt]=useState<Attempt>(null),[busy,setBusy]=useState(false),[moreOpen,setMoreOpen]=useState(false),[copied,setCopied]=useState(false),[notice,setNotice]=useState(''),[switching,setSwitching]=useState(false);
 const current=useRef(0);
 async function selectNetwork(next:'solana'|'robinhood'){
  siteWalletSession.invalidateRestore();const id=++current.current;setFamily(next);setAttempt(null);setEvmAttempt(null);setBusy(false);setMoreOpen(false);setNotice('');setSwitching(true);
  if(next==='solana'){setChoices(walletProviders());setLastUsed(readLastUsedWallet());setDiscovering(false);return;}
  setDiscovering(true);try{const rows=await discoverEvmWalletAdapters();if(id===current.current)setEvmChoices(rows);}catch{if(id===current.current)setNotice('Wallet discovery unavailable. Reopen the chooser to retry.');}finally{if(id===current.current)setDiscovering(false);}
 }
 function show(event?:unknown){const requested=(event as CustomEvent<{network?:string}>)?.detail?.network;const path=window.location.pathname;const target=requested==='robinhood'||(!requested&&(path.includes('/robinhood/')||siteWalletSession.getSnapshot()?.family==='evm'&&!path.startsWith('/token/')))?'robinhood':'solana';void selectNetwork(target);setSwitching(false);setOpen(true);} 
 const openFromEvent=useEffectEvent(show);
 useEffect(()=>{void restoreSiteWallet();const listener=(event:Event)=>openFromEvent(event);window.addEventListener('grainpad-open-wallet',listener);return()=>window.removeEventListener('grainpad-open-wallet',listener);},[]);
 useEffect(()=>{if(!copied)return;const t=setTimeout(()=>setCopied(false),1600);return()=>clearTimeout(t);},[copied]);
 async function connect(row:Row){
  const id=++current.current;setAttempt({row,error:''});setBusy(true);
  try{await connectWalletWithIntent(row.provider.wallet);if(id!==current.current)return;rememberLastUsedWallet(row.provider.name);setOpen(false);setAttempt(null);setSwitching(false);}
  catch(e){if(id===current.current)setAttempt({row,error:walletConnectError(e,row.label)});}
  finally{if(id===current.current)setBusy(false);}
 }
 /** Closing the chooser invalidates the adapter before any late connect event. */
 function back(){siteWalletSession.invalidateRestore();current.current++;setAttempt(null);setEvmAttempt(null);setBusy(false);}
 async function copy(address:string){try{await navigator.clipboard.writeText(address);setCopied(true);}catch{setNotice('Copy failed. Select the address to copy it.');}}
 async function disconnect(){try{await disconnectSiteWallet();setOpen(false);}catch{setNotice('Wallet disconnected from grainpad.');}}
 const account=session&&!attempt&&!evmAttempt&&!switching&&(family==='solana'?session.family==='solana':session.family==='evm'&&session.session.chainId===4663);
 const connectedNetwork=session?.family==='evm'?walletNetworkLabel(session.session.chainId):'Solana';
 const evmRows=evmChoices.filter((row,index,all)=>all.findIndex(other=>other.name.toLowerCase()===row.name.toLowerCase())===index),evmMore=evmChoices.filter(row=>!evmRows.includes(row));
 async function connectEvm(choice:EvmDiscoveredWallet){const id=++current.current;setEvmAttempt({choice,error:''});setBusy(true);try{const next=await connectSiteEvmWallet(choice);if(id!==current.current)return;siteWalletSession.activateEvm(next,choice.name);setOpen(false);setEvmAttempt(null);setSwitching(false);}catch(error){if(id===current.current)setEvmAttempt({choice,error:walletConnectError(error,choice.name)});}finally{if(id===current.current)setBusy(false);}}
 const {rows,more,install,lastUsed:lastRow}=groupWalletProviders(choices,lastUsed);

 let body;
 if(account)body=<div className="wallet-account">
  <div className="wallet-account-card">
   <Avatar address={session.owner} size={48}/>
   <div className="wallet-account-id"><strong>{shortAddress(session.owner)}</strong><small>{connectedNetwork} · {session.name.replace(' · Wallet Standard','')}</small></div>
  </div>
  <p className="wallet-account-address" title={session.owner}>{session.owner}</p>
  <div className="wallet-account-actions">
   <button type="button" className="wallet-action" onClick={()=>void copy(session.owner)} aria-live="polite">{copied?<><Check size={15}/>Copied</>:<><Copy size={15}/>Copy address</>}</button>
   <a className="wallet-action" href={session.family==='solana'?`https://solscan.io/account/${session.owner}`:`https://robinhoodchain.blockscout.com/address/${session.owner}`} target="_blank" rel="noreferrer"><ArrowUpRight size={15}/>{session.family==='solana'?'View on Solscan':session.session.chainId===4663?'View on Robinhood Explorer':'View Robinhood address'}</a>
   <button type="button" className="wallet-action" onClick={()=>void selectNetwork(family)}><Repeat size={15}/>Switch wallet</button>
   <a className="wallet-action" href="/pet/">open grainpet<ArrowUpRight size={15}/></a>
  </div>
  <button type="button" className="wallet-disconnect" onClick={()=>void disconnect()}><LogOut size={15}/>Disconnect</button>
 </div>;
 else if(evmAttempt)body=<div className="wallet-connecting" role="status" aria-live="polite"><WalletLogo brand={evmAttempt.choice.name} size={64}/><strong>{evmAttempt.error?'Not connected':`Approve in ${evmAttempt.choice.name}`}</strong><p>Connect your account and select Robinhood Chain in your wallet. No signature or transaction is requested.</p>{evmAttempt.error&&<p role="alert">{evmAttempt.error}</p>}<div className="wallet-connecting-actions">{evmAttempt.error&&<Button onClick={()=>void connectEvm(evmAttempt.choice)}>Try again</Button>}<button type="button" className="wallet-back" onClick={back}>{evmAttempt.error?'Choose another wallet':'Cancel'}</button></div>{busy&&<p className="wallet-connecting-hint"><Loader2 size={13} className="spin"/>Waiting for wallet approval</p>}</div>;
 else if(family==='robinhood')body=<>{discovering?<p role="status">Looking for EVM wallets…</p>:!evmChoices.length?<p role="status">Open this page in an EVM wallet browser or enable MetaMask or Phantom, then reopen this chooser.</p>:<div className="wallet-rows" aria-label="EVM wallets">{evmRows.map((choice,index)=><button type="button" className="wallet-row" key={index} onClick={()=>void connectEvm(choice)} aria-label={`Connect ${choice.name} on Robinhood Chain`}><WalletLogo brand={choice.name}/><span className="wallet-row-name"><strong>{choice.name}</strong><small>Robinhood Chain · EVM</small></span><ChevronRight size={18}/></button>)}</div>}{evmMore.length>0&&<details className="wallet-more"><summary>More EVM providers</summary><div className="wallet-rows">{evmMore.map((choice,index)=><button type="button" className="wallet-row" key={index} onClick={()=>void connectEvm(choice)}><WalletLogo brand={choice.name}/><span className="wallet-row-name"><strong>{choice.name}</strong><small>Additional provider</small></span></button>)}</div></details>}</>;
 else if(attempt)body=<div className="wallet-connecting" role="status" aria-live="polite">
  <div className={`wallet-connecting-logo${attempt.error?' is-error':''}`}><WalletLogo brand={attempt.row.provider.brand} icon={attempt.row.provider.icon} size={64}/>{busy&&<span className="wallet-connecting-ring" aria-hidden="true"/>}</div>
  {attempt.error?<><strong>Not connected</strong><p role="alert">{attempt.error}</p></>:<><strong>Approve in {attempt.row.label}</strong><p>Confirm the connection request in your wallet.</p></>}
  <div className="wallet-connecting-actions">
   {attempt.error&&<Button className="wallet-retry" onClick={()=>void connect(attempt.row)}><RotateCcw size={15}/>Try again</Button>}
   <button type="button" className="wallet-back" onClick={back}>{attempt.error?'Choose another wallet':'Cancel'}</button>
  </div>
  {busy&&<p className="wallet-connecting-hint"><Loader2 size={13} className="spin"/>Waiting for {attempt.row.label}</p>}
 </div>;
 else body=<>
  {rows.length>0&&<div className="wallet-rows" role="group" aria-label="Detected wallets">{rows.map(r=><WalletRow key={r.provider.name} row={r} lastUsed={r.provider.name===lastRow} onSelect={()=>void connect(r)}/>)}</div>}
  {more.length>0&&<div className="wallet-more">
   <button type="button" className="wallet-more-toggle" aria-expanded={moreOpen} onClick={()=>setMoreOpen(v=>!v)}>More options<ChevronDown size={15} aria-hidden="true"/></button>
   {moreOpen&&<div className="wallet-rows is-secondary">{more.map(r=><WalletRow key={r.provider.name} row={r} secondary onSelect={()=>void connect(r)}/>)}</div>}
  </div>}
  {!rows.length&&<OpenInWallet mobileOnly/>}
  {switching&&session&&<button type="button" className="wallet-back" onClick={()=>setSwitching(false)}>Back to your wallet</button>}
  {install.length>0&&<div className="wallet-install">
   <p>{rows.length?'Get another wallet':'Get a Solana wallet'}</p>
   <div className="wallet-rows">{install.map(link=><a key={link.brand} className="wallet-row is-install" href={link.href} target="_blank" rel="noreferrer">
    <WalletLogo brand={link.brand} size={40}/><span className="wallet-row-name"><strong>{link.brand}</strong></span><span className="wallet-row-install">Install<ArrowUpRight size={14}/></span>
   </a>)}</div>
  </div>}
 </>;

 return <><Button className="header-cta site-wallet-trigger" onClick={show} aria-label={session?`Connected wallet ${session.owner} on ${connectedNetwork}`:'Connect wallet'}>{session?<><Avatar address={session.owner} size={16}/><span className="wallet-trigger-full">{shortAddress(session.owner)}</span><span className="wallet-network-badge">{session.family==='solana'?'SOL':session.session.chainId===4663?'RH':'EVM'}</span></>:<><span className="wallet-trigger-full">Connect wallet</span><span className="wallet-trigger-short" aria-hidden="true">Connect</span></>}</Button>
 <Dialog open={open} onOpenChange={value=>{if(!value){back();window.dispatchEvent(new CustomEvent('grainpad-wallet-closed'));}setOpen(value);}}><DialogContent className="wallet-session-dialog">
  <DialogHeader className="wallet-dialog-header"><span className="wallet-dialog-mark" aria-hidden="true"><Image unoptimized src={BRAND_ASSETS.mark} alt="" width={28} height={28}/></span><DialogTitle>{account?'your wallet':switching?'switch wallet':'connect to grainpad'}</DialogTitle><DialogDescription>{account?'One connection across grainpad.':'Choose a wallet to continue.'}</DialogDescription></DialogHeader>
  <div className="wallet-network-tabs" role="group" aria-label="Wallet network"><Button variant={family==='solana'?'default':'outline'} aria-pressed={family==='solana'} onClick={()=>void selectNetwork('solana')}>Solana</Button><Button variant={family==='robinhood'?'default':'outline'} aria-pressed={family==='robinhood'} onClick={()=>void selectNetwork('robinhood')}>Robinhood Chain</Button></div>
  {session&&!account&&!attempt&&!evmAttempt&&<p className="small muted">Active wallet: {connectedNetwork}. Choose a wallet below to switch.</p>}
  {body}
  {notice&&<p className="wallet-notice" role="alert">{notice}</p>}
  {!account&&<p className="wallet-safety"><Lock size={13} aria-hidden="true"/>Connecting shares only your public address. It never approves a transaction.</p>}
 </DialogContent></Dialog></>;
}
