'use client';
import {useEffect,useRef,useState} from 'react';
import {ChevronDown,LockKeyhole,X} from 'lucide-react';
import {SiloAssetIcon} from './silo-asset-icon';
import {siloLookStyle} from './silo-asset-card';
import {SILO_ASSET_LOOKS,SILO_FALLBACK_LOOK} from '@/lib/silo/asset-look.mjs';
import {siloUnits} from '@/lib/silo/amounts.mjs';
import {SILO_USDC_MINT} from '@/lib/silo/swap-referral.mjs';

/** r8 Send (art direction round 8, silo-send.html; owner 6 Nov 2026). Presentation only.
 * - "What to send": a bottom sheet of asset cards in their own colour, each with its network rows. Choosing a row only moves to that
 *   network's existing send form and, for Solana, fills its existing Asset/mint inputs (event `silo-send-asset`). Nothing is signed here.
 * - For Monero, the asset card above the existing Monero send form (same Change button).
 * Only networks Silo can send on are offered. USDC is Solana USDC, mainnet only. */
type Choice='sol'|'usdc'|'token'|'xmr';
type Holdings={network?:'mainnet-beta'|'devnet';lamports:string|null;holdings:{mint:string;amount:string;decimals:number}[]}|null;

export function SiloSendScreen({test=false,zone,solanaOpen,solanaUnverified=false,solanaNetwork,xmrOpened,xmrState,xmrAmount,publicReport,concealed,go}:{test?:boolean;zone:'sol'|'xmr';solanaOpen:boolean;solanaUnverified?:boolean;solanaNetwork:'mainnet-beta'|'devnet';xmrOpened:boolean;xmrState:string;xmrAmount:string|null;publicReport:Holdings;concealed:boolean;go:(view:'send'|'wallets',zone:string)=>void}){
 const [open,setOpen]=useState(false),[chosen,setChosen]=useState<Choice>(zone==='xmr'?'xmr':'sol');
 const close=useRef<HTMLButtonElement>(null),opener=useRef<Element|null>(null);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- the chosen card follows the network the screen shows
 useEffect(()=>{setChosen(current=>zone==='xmr'?'xmr':current==='xmr'?'sol':current);},[zone]);
 useEffect(()=>{const show=()=>{opener.current=document.activeElement;setOpen(true);};window.addEventListener('silo-send-pick',show);return()=>window.removeEventListener('silo-send-pick',show);},[]);
 useEffect(()=>{if(!open)return;close.current?.focus();const key=(event:globalThis.KeyboardEvent)=>{if(event.key==='Escape')setOpen(false);};document.addEventListener('keydown',key);
  return()=>{document.removeEventListener('keydown',key);if(opener.current instanceof HTMLElement)opener.current.focus({preventScroll:true});};},[open]);
 const hidden=<span aria-label="Amount hidden">••••</span>;
 const read=publicReport&&publicReport.network===solanaNetwork?publicReport:null;
 const solAmount=read?.lamports?siloUnits(read.lamports,9):null;
 const usdc=read?.holdings.find(row=>row.mint===SILO_USDC_MINT);
 const mainnet=solanaNetwork==='mainnet-beta';
 const solState=solanaOpen?'Connected':solanaUnverified?'Open, backup not verified':'Not opened';
 const pick=(choice:Choice)=>{setChosen(choice);setOpen(false);if(choice==='xmr'){go('send','xmr');return;}go('send','sol');
  // The Solana form mounts with the page; the choice reaches it after the view switch.
  requestAnimationFrame(()=>window.dispatchEvent(new CustomEvent('silo-send-asset',{detail:choice})));};
 const row=(choice:Choice,label:string,state:string,amount:string|null,icon:'sol'|'xmr',disabled=false)=><button type="button" className="silo-pick-row" role="radio" aria-checked={chosen===choice} disabled={disabled} onClick={()=>pick(choice)}>
  <span className="silo-pick-radio" aria-hidden="true"/><SiloAssetIcon asset={icon}/><span className="silo-pick-net"><strong>{label}</strong><small data-state={state==='Connected'?'on':undefined}>{state==='Locked'&&<LockKeyhole size={12} aria-hidden="true"/>}{state}</small></span>{amount!==null&&<span className="silo-pick-amount">{concealed?hidden:amount}</span>}</button>;
 const card=(choice:Choice,symbol:string,sub:string|null,icon:'sol'|'xmr'|'usdc'|'token',rows:React.ReactNode)=><section className="silo-pick-card" data-asset={choice} style={siloLookStyle(choice=='token'?SILO_FALLBACK_LOOK:SILO_ASSET_LOOKS[choice])} aria-current={chosen===choice||undefined} aria-label={symbol}>
  <header><SiloAssetIcon asset={icon}/><span><strong>{symbol}</strong>{sub&&<small>{sub}</small>}</span></header><div className="silo-pick-rows" role="radiogroup" aria-label={`${symbol} networks`}>{rows}</div></section>;
 return <>
  {zone==='xmr'&&<div className="silo-send8-slip silo-send8-xmr" data-asset="xmr"><div className="silo-send8-head"><SiloAssetIcon asset="xmr"/><strong>XMR</strong><button type="button" className="silo-send8-change" onClick={()=>window.dispatchEvent(new Event('silo-send-pick'))}>Change<ChevronDown size={18} aria-hidden="true"/></button><span className="silo-send8-net"><SiloAssetIcon asset="xmr"/>Private · Monero</span><p className="silo-send8-funds">{test?'Stagenet · test funds':'Mainnet · real funds'}</p></div></div>}
  {zone==='sol'&&!solanaOpen&&<div className="silo-send8-closed" role="status"><p>{solanaUnverified?'Your Solana wallet is open, but its backup is not verified yet. Verify the backup to send SOL or tokens.':'Open your Solana wallet to send SOL or tokens.'}</p><button type="button" className="silo-primary" onClick={()=>go('wallets','sol')}><LockKeyhole size={18} aria-hidden="true"/>{solanaUnverified?'Verify backup':'Open Solana wallet'}</button></div>}
  {zone==='xmr'&&!xmrOpened&&<div className="silo-send8-closed" role="status"><p>Open your Monero wallet to send XMR.</p><button type="button" className="silo-primary" onClick={()=>go('wallets','xmr')}><LockKeyhole size={18} aria-hidden="true"/>Open Monero wallet</button></div>}
  {open&&<div className="silo-sheet-scrim" onClick={()=>setOpen(false)}/>}
  {open&&<div className="silo-sheet" role="dialog" aria-modal="true" aria-labelledby="silo-pick-title">
   <header><h2 id="silo-pick-title">What to send</h2><button ref={close} type="button" className="silo-icon-button" aria-label="Close" onClick={()=>setOpen(false)}><X size={22} aria-hidden="true"/></button></header>
   <div className="silo-sheet-body">
    {card('sol','SOL',null,'sol',row('sol','Public · Solana',solState,solAmount,'sol'))}
    {card('xmr','XMR',null,'xmr',row('xmr','Private · Monero',xmrOpened?xmrState:'Locked',xmrAmount,'xmr'))}
    {card('usdc','USDC','USD Coin',  'usdc',row('usdc','Public · Solana',mainnet?solState:'Mainnet only',mainnet&&usdc?siloUnits(usdc.amount,usdc.decimals):null,'sol',!mainnet))}
    {card('token','Other token','Any Solana token, by its mint address','token',row('token','Public · Solana',solState,null,'sol'))}
   </div>
  </div>}
 </>;
}
