'use client';
/* eslint-disable @next/next/no-html-link-for-pages, @next/next/no-img-element -- Native navigation and supplied local SVG artwork. */
import {SiloAtomicPendingCard} from '@/components/silo-atomic-pending-card';
import {useEffect,useState,useSyncExternalStore,type KeyboardEvent,type ReactNode} from 'react';
import {useSiloBalanceVisibility,SiloReviewVisibilityNotice} from './silo-balance-visibility';
import {ArrowUpRight,ArrowDownLeft,ArrowLeftRight,ChevronRight,ChevronLeft,Eye,EyeOff,House,Settings2,History,LockKeyhole,Check,AlertTriangle,CircleDashed,PauseCircle} from 'lucide-react';
import {SiloAssetIcon} from './silo-asset-icon';
import {useSiloKeyboardGuard} from './silo-keyboard-guard';
import {SiloThemeControl,useSiloTheme} from './silo-theme';
import {useSiloPrices,useSiloGrain,siloUsd,siloDisplayAmount} from './silo-price';
import {siloUnits} from '@/lib/silo/amounts.mjs';
import {xmrConfirmationState,xmrEtaText,xmrLockedAmount,xmrPendingIncoming,xmrNextUnlockMinutes} from '@/lib/silo/xmr-confirmations.mjs';
import {useSiloTokens,siloTokenRows,siloTokenLabel,siloTokenAmount,siloShortMint,SiloUnverified} from './silo-tokens';
import type {SiloBalanceState} from './silo-native-zone';
import type {SiloEvmReport} from './silo-evm-zone';
import type {SiloActivityPage} from './silo-solana-activity';
import {BUILD_COMMIT} from '@/lib/build-commit';
import {SiloBetaBadge,type SiloBeta} from './silo-beta';
import {useSiloKeyboardFit} from './silo-keyboard-fit';
import {SiloAmountPad} from './silo-amount-pad';
import {SiloSendScreen} from './silo-send-screen';
import {SiloAssetCard,SiloNetworkRow} from './silo-asset-card';
import {SILO_ASSET_LOOKS,SILO_FALLBACK_LOOK,siloAssetLook,siloChainLook} from '@/lib/silo/asset-look.mjs';
import {SILO_TAGLINE} from '@/lib/silo-brand';
import {SiloUnlockHome} from './silo-unlock-home';
import {useSiloUnlockState} from './silo-unlock-state';
import {SiloOnePassphrase} from './silo-one-passphrase';
import {SiloDeviceUnlockOffer,SiloDeviceUnlockSetting} from './silo-device-unlock';
type Holdings={network?:'mainnet-beta'|'devnet';lamports:string|null;holdings:{mint:string;amount:string;decimals:number}[]};
export type SiloXmrHistoryRow={id:string;height:number|null;incoming:string|null;outgoing:string|null;selfTransfer?:boolean;balanceDelta:string|null;fee:string|null;confirmations:number|null;status:string};
type View='overview'|'wallets'|'send'|'swap'|'activity'|'settings';
type Task='swap'|'cashout'|'atomic';
type Page='index'|'backup'|'devices'|'display'|'fees'|'build'|'about';
type Reason={key:string;text:string;next?:{label:string;go:()=>void}};
// Wallets are reached from Home rows, so Home is the current place while a wallet is open.
const views=[{id:'overview' as View,label:'Home',icon:House},{id:'swap' as View,label:'Swap',icon:ArrowLeftRight},{id:'activity' as View,label:'Activity',icon:History},{id:'settings' as View,label:'Settings',icon:Settings2}];
const pages:Page[]=['index','backup','devices','display','fees','build','about'];
const networks=['xmr','sol','zec','evm'];
const subscribeNavigation=(changed:()=>void)=>{window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);};
const navigationSnapshot=()=>/^#settings\/(xmr|sol|zec|evm)$/.test(location.hash)?'#settings/devices':/^#(overview|wallets|send|swap|activity|settings)\/(xmr|sol|zec|evm|index|backup|devices|display|fees|build|about|cashout)$/.test(location.hash)||location.hash==='#swap/atomic'?location.hash:'#overview/xmr';
const pageTitle:Record<Page,string>={index:'settings',backup:'backup',devices:'devices',display:'display',fees:'fees and privacy',build:'this build',about:'about'};
const pageLine:Record<Page,string>={index:'Backup, devices, display, fees and what this build can do.',backup:'Your encrypted wallet is kept in this browser.',devices:'Sign in on another device, then unlock and approve it separately.',display:'How the wallet looks and what it shows on screen.',fees:'What stays public, what costs money and what this wallet cannot promise.',build:'What works in this build and what is held.',about:'Beta, not externally audited. Use small amounts.'};
function dayLabel(time:number|null){if(time===null)return 'Time not recorded';const day=new Date(time),today=new Date(),start=(date:Date)=>Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate());const delta=Math.round((start(today)-start(day))/86400000);return delta===0?'Today':delta===1?'Yesterday':day.toISOString().slice(0,10);}
type Activity={id:string;when:number|null;title:string;detail:string;value:string|null;state:'ok'|'held'|'danger'|'idle';word:string;network:'sol'|'xmr'};
function solanaActivity(page:SiloActivityPage|null):Activity[]{
 if(!page)return [];
 return page.rows.map(row=>{
  const title=row.status==='failed'?'Failed transaction':row.status==='receipt-unavailable'?'Receipt unavailable':row.status==='unknown'?'Unknown transaction details':row.classification==='jupiter-unverified'?'Jupiter activity · swap details unverified':row.classification==='transfer'?'Transfer observation':'Other on-chain activity';
  const net=row.nativeNetRaw,value=net!==null?`${net.startsWith('-')?'−':'+'}${siloUnits(net.replace(/^-/,''),9)} SOL`:null;
  const state=row.status==='finalized'?'ok':row.status==='failed'?'danger':'held';
  return {id:row.signature,when:row.blockTime===null?null:row.blockTime*1000,title,detail:'Solana · public · observed SOL balance change',value,state,word:row.status==='finalized'?'Confirmed':row.status==='failed'?'Failed':'Not confirmed yet',network:'sol' as const};
 });
}
/** Row subtitle: unchanged wording once checked, with n/10 and an approximate wait while still confirming. */
function xmrActivityDetail(confirmations:number|null,status:string){
 const state=xmrConfirmationState({confirmations});
 if(state.state==='unchecked'||status!=='pending'||state.state==='ready')return `Monero · ${confirmations??'not checked'} confirmations`;
 const eta=xmrEtaText(state.etaMinutes);
 return `Monero · ${state.confirmations}/${state.target} confirmations${eta?` · ${eta} left`:''}`;
}
function monero(rows:SiloXmrHistoryRow[]|null,decimals=12):Activity[]{
 if(!rows)return [];
 return rows.map(row=>{
  const kind=row.selfTransfer?'self':row.balanceDelta!==null?'delta':row.outgoing!==null&&row.outgoing!=='0'?'out':'in';
  const value=row.selfTransfer?`−${siloUnits(row.fee,decimals)}`:row.balanceDelta!==null?`${row.balanceDelta.startsWith('-')?'−':'+'}${siloUnits(row.balanceDelta.replace(/^-/,''),decimals)}`:kind==='out'?`−${siloUnits(row.outgoing,decimals)}`:`+${siloUnits(row.incoming,decimals)}`;
  const failed=row.status==='reported-failed'||row.status==='expired';
  const title=row.status==='reported-failed'?'Reported failed · outcome unresolved':row.status==='expired'?'Reported expired · recovery may still be held':kind==='delta'?'Account balance change':kind==='self'?'Moved within this wallet':kind==='in'?'Received':'Sent';
  return {id:row.id,when:null,title,detail:xmrActivityDetail(row.confirmations,row.status),value:`${value} XMR`,state:failed?'held':row.confirmations!==null&&row.confirmations>=10?'ok':'held',word:failed?'Not confirmed yet':row.confirmations!==null&&row.confirmations>=10?'Confirmed':'Not confirmed yet',network:'xmr' as const};
 });
}
export function SiloOverview({atomicEnabled=false,solanaOpen=false,launchpad='',prices=false,children,xmr,zec,publicReport,evm=null,test,zecSoon=true,solanaNetwork='mainnet-beta',releaseHeld=false,swapMode='held',activityPage=null,xmrHistory=null,backupNeeded=false,conversionLive=false}:{backupNeeded?:boolean;atomicEnabled?:boolean;conversionLive?:boolean;solanaOpen?:boolean;launchpad?:string;beta?:SiloBeta|null;releaseHeld?:boolean;swapMode?:'preview'|'held'|'execute';children:ReactNode;xmr:SiloBalanceState;zec:SiloBalanceState;publicReport:Holdings|null;evm?:SiloEvmReport|null;test:boolean;zecSoon?:boolean;solanaNetwork?:'mainnet-beta'|'devnet';solanaTransfersEnabled?:boolean;prices?:boolean;activityPage?:SiloActivityPage|null;xmrHistory?:SiloXmrHistoryRow[]|null}){
 useSiloKeyboardGuard();
 const unlockRows=useSiloUnlockState().state.rows,deckShown=unlockRows.length>0&&unlockRows.every(row=>row.status!=='open');
 const {appearance}=useSiloTheme();
 const nav=useSyncExternalStore(subscribeNavigation,navigationSnapshot,()=> '#overview/xmr');
 const [view,slot]=nav.slice(1).split('/') as [View,string];
 const page:Page=view==='settings'&&pages.includes(slot as Page)?slot as Page:'index';
 const selectedNetwork=networks.includes(slot)?slot:'xmr';
 const network=selectedNetwork==='zec'?'xmr':selectedNetwork;
 /* While token-swap execution is held, the memecoin swap panel is not offered at all: Swap opens straight on Convert (SOL, USDC, XMR). */
 const swapHeld=swapMode==='held',task:Task=view==='swap'&&slot==='atomic'&&atomicEnabled?'atomic':swapHeld||(view==='swap'&&slot==='cashout')?'cashout':'swap';
 const navigate=(next:View,zone:string=network)=>{history.replaceState(history.state,'',`#${next}/${zone}`);window.dispatchEvent(new HashChangeEvent('hashchange'));};
 const setTask=(next:Task)=>navigate('swap',next==='cashout'?'cashout':next==='atomic'?'atomic':'sol');
 const setView=(next:View)=>navigate(next,next==='settings'?'index':network),setNetwork=(zone:string)=>navigate('wallets',zone);
 useSiloKeyboardFit();
 const {concealed,setConcealed,persistenceFailed}=useSiloBalanceVisibility();const [concealmentError,setConcealmentError]=useState('');
 const toggleConcealment=()=>{try{setConcealed(!concealed);setConcealmentError('');}catch(failure){setConcealmentError(failure instanceof Error?failure.message:'The display preference could not be saved.');}};
 const openNetwork=(zone:string)=>navigate('wallets',zone);
 const showView=(next:View)=>{if(next==='overview')navigate('overview');else setView(next);};
 const [nowMs,setNowMs]=useState(()=>Date.now());useEffect(()=>{const timer=setInterval(()=>setNowMs(Date.now()),60_000);return()=>clearInterval(timer);},[]);
 const amount=(value:string|null,decimals:number,unit:string)=>concealed?<span aria-label="Amount hidden">••••</span>:value===null?'Not checked':`${siloUnits(value,decimals)} ${unit}`;
 const synced=xmr.opened&&xmr.coverage==='checked'&&!xmr.syncError;
 const currentXmrAmount=synced?xmr.amount:null;
 const status=xmr.syncError?'Sync failed':xmr.coverage==='working'?'Syncing…':synced?'Synced':xmr.opened?'Open · syncing starts automatically':'Locked';
 // A balance read from this device's saved state is shown while the sync runs, always flagged as not final and never used as available or current.
 const savedAgo=(at:number|null|undefined)=>{if(typeof at!=='number'||!Number.isSafeInteger(at))return 'your last saved state';const minutes=Math.max(0,Math.round((nowMs-at)/60000));return minutes<1?'just now':minutes<60?`${minutes} min ago`:`${Math.round(minutes/60)} h ago`;};
 const showSaved=xmr.opened&&!synced&&!xmr.syncError&&typeof xmr.cachedAmount==='string';
 const available=!synced||xmr.spendable==null?'not checked':`${siloUnits(xmr.spendable,12)} XMR`;
 // Locked funds (arriving or change in flight) are never counted as available; the wait is an estimate.
 const lockedAtomic=synced?xmrLockedAmount(xmr.amount,xmr.spendable):null;
 const lockedWait=xmrEtaText(xmrNextUnlockMinutes(xmrPendingIncoming(xmrHistory??[])));
 const lockedNote=lockedAtomic!==null&&lockedAtomic!=='0'?` · ${siloUnits(lockedAtomic,12)} XMR still confirming${lockedWait?`, spendable in ${lockedWait}`:''}`:'';
 // Display-only estimate of real funds; test networks have no value. Tokens without a price are left out and said so.
 const priceRead=useSiloPrices('1D',prices&&!test),quote=priceRead.data?.assets;
 const grain=useSiloGrain('1D',prices&&solanaNetwork==='mainnet-beta'&&Boolean(publicReport?.holdings.length)).data;
 // Token names and display-only USD values; shares the workspace's request (mints only, never the address).
 const tokens=useSiloTokens(publicReport?.network??solanaNetwork,publicReport?.holdings,prices);
 const tokenRows=publicReport?siloTokenRows(publicReport.holdings,tokens,!test&&solanaNetwork==='mainnet-beta'):[];
 const openGrain=()=>{openNetwork('sol');requestAnimationFrame(()=>document.getElementById('silo-grain')?.scrollIntoView({behavior:'smooth',block:'start'}));};
 const xmrValue=xmr.opened?[siloDisplayAmount(currentXmrAmount,12),quote?.XMR?.usd] as [number|null,number|null|undefined]:null;
 const solValue=publicReport&&solanaNetwork==='mainnet-beta'?[siloDisplayAmount(publicReport.lamports,9),quote?.SOL?.usd] as [number|null,number|null|undefined]:null;
 const parts=[xmrValue,solValue].filter((part):part is [number|null,number|null|undefined]=>part!==null);
 const total=parts.length&&parts.every(([value,usd])=>value!=null&&usd!=null)?parts.reduce((sum,[value,usd])=>sum+(value as number)*(usd as number),0):null;
 const privateUsd=xmrValue&&xmrValue[0]!=null&&xmrValue[1]!=null?xmrValue[0]*xmrValue[1]:null;
 const privateShare=total!==null&&total>0&&privateUsd!==null&&solValue!==null?Math.min(100,Math.max(0,Math.round(privateUsd/total*100))):null;

 // What this build can actually do. Off-in-this-build is a different state from Locked: nothing exists to unlock.
 const xmrOff=xmr.coverage==='not enabled',zecOff=!zecSoon&&zec.coverage==='not enabled';
 const xmrState=xmrOff?'Off in this build':releaseHeld?'Review held':status;
 const swapOpens=swapMode!=='held';
 // Held features are absent from navigation, not shown as dead ends.
 // The bridge-free XMR->SOL swap lives under Swap too, so the tab shows whenever it is enabled even while Jupiter swaps are held.
 const shownViews=views.filter(item=>item.id!=='swap'||swapOpens||atomicEnabled);
 const heldReason='Real-funds release is held. No native mainnet keys or payments can be opened until the release review is complete.';
 const goBuild=()=>navigate('settings','build');
 const icon=(state:string)=>state==='off'||state==='soon'?<CircleDashed size={16} aria-hidden="true"/>:state==='held'?<PauseCircle size={16} aria-hidden="true"/>:state==='locked'?<LockKeyhole size={16} aria-hidden="true"/>:state==='danger'?<AlertTriangle size={16} aria-hidden="true"/>:state==='ok'?<Check size={16} aria-hidden="true"/>:<span className="silo-dot"/>;
 const badge=(state:string,label:string)=><span className="silo-state" data-state={state}>{icon(state)}{label}</span>;
 // The note names the wallets the screen is about: Monero on its own page, both on Convert, Solana everywhere else.
 const solanaMainnet=solanaNetwork==='mainnet-beta';
 // One small badge in the header says which network the wallet is on; the real-funds fact lives in its label and the review step, not in a row of copy.
 const solanaReal=solanaMainnet,moneroReal=!test,networkBadgeLabel=solanaReal&&moneroReal?'Mainnet':!solanaReal&&!moneroReal?'Test network':'Mixed networks',
  networkBadgeNote=`Monero: ${moneroReal?'Mainnet · real funds':'Stagenet · test funds'}. Solana: ${solanaReal?'Mainnet · real funds':'Devnet · test funds'}.${solanaReal||moneroReal?' This uses real funds.':' This uses test funds; test balances are separate from mainnet.'}`;
 const title=view==='overview'?'home':view==='activity'?'activity':view==='swap'?'swap':view==='settings'?pageTitle[page]:view==='send'?'send':({xmr:'monero',sol:'solana',evm:'evm'} as Record<string,string>)[network]??'wallets';
 // One sentence that says what is true now, from the same state the screens below use.
 const monerosentence=xmrOff?'Monero is off in this build.':releaseHeld&&!xmr.opened?'Monero is held in this build.':xmr.syncError?'Monero sync failed. The balance is not checked.':synced?'Monero is synced.':xmr.coverage==='working'?'Monero is syncing.':xmr.opened?'Monero is open. Syncing starts automatically; the saved balance is not final until then.':'Monero is locked.';
 const solanasentence=publicReport?'Solana is connected and public.':'Solana is not checked.';
 const homeLine=`${xmrOff?'Monero off':releaseHeld&&!xmr.opened?'Monero held':xmr.syncError?'Monero sync failed':synced?'Monero synced':xmr.coverage==='working'?'Monero syncing':xmr.opened?'Monero open':'Monero locked'} · ${publicReport?'Solana open':'Solana not opened'}`;
 const stateLine=view==='overview'?homeLine
  :view==='activity'||view==='swap'||view==='send'?''
  :view==='settings'?pageLine[page]
  :network==='xmr'?`${monerosentence} Native XMR in your Monero wallet.`:network==='sol'?'Solana trades and balances are visible on-chain.':'EVM networks are public. View, receive and, where enabled, send.';

 // Why an action is unavailable, and what to do next; listed once under the row.
 const privateReasons:Reason[]=[];
 if(xmrOff)privateReasons.push({key:'off',text:'Monero is off in this build. Controls are unavailable here. Existing encrypted wallets and backups are preserved.',next:{label:'What this build can do',go:goBuild}});
 else if(releaseHeld&&!xmr.opened)privateReasons.push({key:'held',text:heldReason,next:{label:'What’s held',go:goBuild}});
 else if(!xmr.opened)privateReasons.push({key:'open',text:'Receiving and sending open once your Monero wallet is unlocked and its backup is verified.',next:{label:'Open Monero wallet',go:()=>openNetwork('xmr')}});
 else if(xmr.syncError)privateReasons.push({key:'sync',text:'Monero sync failed. Current balance is not checked; reconnect and sync again.',next:{label:'Open wallet to sync again',go:()=>openNetwork('xmr')}});
 const privateReady=!xmrOff&&xmr.opened;
 const goXmr=(anchor:'receive'|'send')=>{openNetwork('xmr');requestAnimationFrame(()=>document.getElementById(`silo-xmr-${anchor}`)?.scrollIntoView({behavior:'smooth',block:'start'}));};
 const publicReasons:Reason[]=[];
 if(swapMode==='held')publicReasons.push({key:'swap',text:'Token swaps are coming soon.',next:{label:'What’s held',go:goBuild}});
 if(swapMode==='held')publicReasons.push({key:'cashout',text:'Convert is held in this build.'});
 const action=(label:string,variant:'primary'|'secondary',enabled:boolean,go:()=>void,Icon:typeof ArrowUpRight,reasonId?:string)=><button type="button" className="silo-button" data-variant={enabled?variant:undefined} aria-disabled={enabled?undefined:true} aria-describedby={!enabled&&reasonId?reasonId:undefined} onClick={()=>{if(enabled)go();}}><Icon size={20} aria-hidden="true"/>{label}</button>;
 const builds:{name:string;zone:string;state:string;word:string;note:string}[]=[
  {name:'Solana · wallet and public reads',zone:'public',state:releaseHeld?'held':'ok',word:releaseHeld?'Review held':'Available',note:solanaNetwork==='devnet'?'Devnet · test funds':'Mainnet · real funds'},
  {name:'Swap',zone:'public',state:swapMode==='held'?'held':'ok',word:swapMode==='preview'?'Preview only':swapMode==='execute'?'Available':'Held in this build',note:swapMode==='preview'?'Unsigned preview':swapMode==='execute'?'Solana · Jupiter':'Review held'},
  ...(!xmrOff?[{name:'Monero · native XMR',zone:'private',state:releaseHeld?'held':'ok',word:releaseHeld?'Held in this build':'Available',note:releaseHeld?'Mainnet · review held':test?'Stagenet · test funds':'Mainnet'}]:[{name:'Monero · native XMR',zone:'soon',state:'off',word:'Off in this build',note:'Existing backups are preserved'}]),
  {name:'EVM · wallet and public reads',zone:'public',state:releaseHeld?'held':'ok',word:releaseHeld?'Review held':'Available',note:'Ethereum · Base · BNB'},
 ];
 const capabilities=<section className="silo-build-caps" aria-labelledby="silo-caps-title"><h2 id="silo-caps-title"><span className="silo-label">What this build can do</span></h2><ul>{builds.map(row=><li key={row.name}><span className="silo-zone-mark" data-zone={row.state==='off'?'soon':row.zone} aria-hidden="true"/><span>{row.name}</span>{badge(row.state,`${row.word} · ${row.note}`)}</li>)}</ul></section>;
 const betaNote=<p className="silo-beta-note" role="note"><span className="silo-beta">Beta</span><span><strong>Beta, not externally audited.</strong> Independent and adversarial review is required before release. Start with small amounts only after activation and keep your recovery backup.</span></p>;

 const activity=[...solanaActivity(activityPage),...monero(xmrHistory)].sort((a,b)=>(b.when??-1)-(a.when??-1));
 const activityRows=(items:Activity[])=>{let last='';return items.map(item=>{const day=dayLabel(item.when),heading=day!==last;last=day;return <div key={`${item.network}:${item.id}`} className="silo-activity-item">{heading&&<p className="silo-day">{day}</p>}<div className="silo-account silo-activity-row" data-state={item.state}><SiloAssetIcon asset={item.network==='sol'?'sol':'xmr'}/><span className="silo-account-name">{item.title}<small>{item.detail}</small></span><span className="silo-account-value">{item.value===null?'—':concealed?<span aria-label="Amount hidden">••••</span>:item.value}<small className="silo-state-word" data-state={item.state}>{item.word}</small></span></div></div>;});};

 const lastChecked=xmr.lastCheckedAt!=null&&Number.isSafeInteger(xmr.lastCheckedAt)&&xmr.lastCheckedAt>=0&&xmr.lastCheckedAt<=8640000000000000?<p className="silo-last-checked">Monero last checked: {new Date(xmr.lastCheckedAt).toISOString()}{!synced?' · historical check; current balance is not checked.':''}</p>:null;
 const pendingSwap=atomicEnabled?<SiloAtomicPendingCard onOpen={()=>setTask('atomic')}/>:null;
 // r8 Home: which card is open (the first opened wallet, Monero before Solana, until a person chooses), and the network filter.
 const solUnverified=backupNeeded&&!solanaOpen&&!publicReport;
 const [chosenCard,setChosenCard]=useState<string|null>(null),[filter,setFilter]=useState('all');
 const defaultCard=!xmrOff&&xmr.opened?'xmr':publicReport||solanaOpen?'sol':'xmr';
 const isOpen=(id:string)=>(chosenCard??defaultCard)===id;
 const toggle=(id:string)=>setChosenCard(isOpen(id)?'':id);
 const chips:{id:string;label:string;icon?:'xmr'|'sol'|'eth'|'base'|'bnb'|'evm';locked?:boolean}[]=[{id:'all',label:'All'},{id:'xmr',label:'Monero',icon:'xmr',locked:!xmrOff&&!xmr.opened},{id:'sol',label:'Solana',icon:'sol'},...(evm!==null?[{id:'evm',label:evm.chainName,icon:(evm.chainId===8453?'base':evm.chainId===56?'bnb':evm.chainId===1?'eth':'evm') as 'base'}]:[])];
 const shown=(network:string)=>filter==='all'||filter===network;
 const cards=['xmr','sol',...tokenRows.map(row=>row.mint),...(evm!==null?['evm']:[])];
 const home=<div className="silo-home">
  <div className="silo-home-main">
   {pendingSwap}
   {total!==null&&<section className="silo-total" aria-labelledby="silo-total-title">
    <div className="silo-total-row"><span id="silo-total-title" className="silo-label">Total</span><span className="silo-total-amt"><span className="sr-only">Estimated value </span>{concealed?<span aria-label="Amount hidden">••••••</span>:siloUsd(total)}</span><span className="silo-fine">Loaded XMR/SOL only · locked wallets, tokens and EVM excluded</span></div>
    {privateShare!==null&&!concealed&&<div className="silo-split"><div className="silo-split-bar" aria-hidden="true"><i data-zone="private" style={{flex:`${Math.max(privateShare,1)} 1 0`}}/><i data-zone="public" style={{flex:`${Math.max(100-privateShare,1)} 1 0`}}/></div><ul className="silo-split-legend"><li><span className="silo-zone-mark" data-zone="private" aria-hidden="true"/>Private <b>{privateShare}%</b></li><li><span className="silo-zone-mark" data-zone="public" aria-hidden="true"/>Public <b>{100-privateShare}%</b></li></ul></div>}
   </section>}
   {lastChecked}
   {/* r8 Home (owner, 6 Nov 2026): every asset is a card on its own colour (lib/silo/asset-look.mjs), Monero first (owner, 23 Oct).
       Each card's body says what its window said before: the same balances, notes, reasons and actions. Display only. */}
   <section className="silo-asset-stack" aria-label="Your assets" data-deck-shown={deckShown?'true':undefined}>
    {cards.length>=4&&<div className="silo-asset-filter" role="group" aria-label="Show assets on">{chips.map(chip=><button key={chip.id} type="button" aria-pressed={filter===chip.id} onClick={()=>setFilter(chip.id)}>{chip.icon&&<SiloAssetIcon asset={chip.icon}/>}{chip.label}{chip.locked&&<LockKeyhole size={14} aria-label="locked"/>}</button>)}</div>}
    <p className="silo-asset-count">{cards.length} asset{cards.length===1?'':'s'} · {chips.length-1} network{chips.length===2?'':'s'}</p>
    {shown('xmr')&&<SiloAssetCard id="xmr" look={xmrOff?SILO_FALLBACK_LOOK:SILO_ASSET_LOOKS.xmr} symbol="XMR" name="Monero" locked={!xmrOff&&!xmr.opened} summary={xmrOff?'Off':!xmr.opened?'Locked':concealed?'••••':currentXmrAmount!==null?`${siloUnits(currentXmrAmount,12)} XMR`:status} open={isOpen('xmr')} onToggle={()=>toggle('xmr')}>
     <div className="silo-window" data-zone={xmrOff?'soon':'private'}>
     <div className="silo-window-label"><span className="silo-zone-mark" data-zone={xmrOff?'soon':'private'} aria-hidden="true"/><h3 id="silo-private-title" className="silo-window-name">Private · Monero</h3></div>
     {xmr.opened&&<p className="silo-hero">{xmrOff||!xmr.opened?<span aria-label="Balance unavailable">—</span>:concealed?<span aria-label="Amount hidden">••••</span>:currentXmrAmount!==null?<span>{siloUnits(currentXmrAmount,12)}</span>:showSaved?<span className="silo-hero-saved" aria-label="Saved balance, not final until the sync finishes">{siloUnits(xmr.cachedAmount as string,12)}</span>:<span aria-label="Not checked">—</span>}<span className="silo-hero-unit">XMR</span></p>}
     {xmr.opened&&<SiloNetworkRow icon="xmr" label="Private · Monero" state={xmrOff?'Off in this build':!xmr.opened?'Locked':status} on={synced}/>}
     <p className="silo-window-sub">{xmrOff?'Off in this build':!xmr.opened?(releaseHeld?'Held in this build':'Locked. Not opened on this device.'):`${status}${xmr.syncError?'':synced?(concealed?'':` · available ${available}${lockedNote}`):showSaved&&!concealed?` · saved balance from ${savedAgo(xmr.cachedAt)}, not final until synced`:''} · ${test?'Stagenet · test funds':'Native XMR · Mainnet · real funds'}`}</p>
     {privateReady?<div className="silo-actions" role="group" aria-label="Private actions">
     {action('Receive','primary',true,()=>goXmr('receive'),ArrowDownLeft)}
     {action('Send','secondary',true,()=>navigate('send','xmr'),ArrowUpRight)}
    </div>:privateReasons[0]?.key==='open'&&<div className="silo-actions" role="group" aria-label="Private actions">{action('Open Monero wallet','primary',true,()=>openNetwork('xmr'),LockKeyhole)}</div>}
    {privateReasons.length>0&&privateReasons[0].key!=='open'&&<ul className="silo-whynot" id="silo-private-why">{privateReasons.map(reason=><li key={reason.key}>{reason.text}{reason.next&&<> <button type="button" onClick={reason.next.go}>{reason.next.label}</button></>}</li>)}</ul>}
     </div>
    </SiloAssetCard>}
    {shown('sol')&&<SiloAssetCard id="sol" look={SILO_ASSET_LOOKS.sol} symbol="SOL" name="Solana" summary={publicReport?(concealed?'••••':`${siloUnits(publicReport.lamports,9)} SOL`):solanaOpen?'Open':solUnverified?'Open · verify backup':'Not connected'} open={isOpen('sol')} onToggle={()=>toggle('sol')}>
     <div className="silo-window silo-window-public" data-zone="public">
     <div className="silo-window-label"><span className="silo-zone-mark" data-zone="public" aria-hidden="true"/><h3 id="silo-public-title-home" className="silo-window-name">Public · Solana</h3></div>
     <p className="silo-hero">{publicReport||concealed?(concealed?<span aria-label="Amount hidden">••••</span>:<span>{siloUnits(publicReport?.lamports??null,9)}</span>):<span aria-label="Not checked">—</span>}<span className="silo-hero-unit">SOL</span></p>
     <SiloNetworkRow icon="sol" label="Public · Solana" state={publicReport||solanaOpen?'Connected':solUnverified?'Open · backup not verified':'Not connected'} on={Boolean(publicReport||solanaOpen)}/>
     <p className="silo-window-sub">{publicReport?`${publicReport.holdings.length?`${publicReport.holdings.length} token${publicReport.holdings.length===1?'':'s'} · `:''}${solanaNetwork==='devnet'?'Devnet · test funds':'Mainnet · real funds'}`:solanaOpen?'Open · balance not loaded yet':solUnverified?'Open. Verify your encrypted backup to receive and send.':'Not opened on this device.'}</p>
     <div className="silo-actions" role="group" aria-label="Solana actions">{publicReport||solanaOpen?<>{action('Receive','primary',true,()=>{openNetwork('sol');requestAnimationFrame(()=>document.getElementById('silo-sol-receive')?.scrollIntoView({behavior:'smooth',block:'start'}));},ArrowDownLeft)}{action('Send','secondary',true,()=>navigate('send','sol'),ArrowUpRight)}</>:action(solUnverified?'Verify backup':'Open Solana wallet','primary',true,()=>openNetwork('sol'),LockKeyhole)}</div>
     </div>
    </SiloAssetCard>}
    {shown('sol')&&tokenRows.map((row,index)=>{const label=siloTokenLabel(row),isGrain=Boolean(grain&&row.mint===grain.mint),symbol=isGrain?'GRAIN':label.symbol??'Token',verified=isGrain||label.verified,id=`tok-${index}`,look=siloAssetLook(symbol,verified);
     const send=()=>{navigate('send','sol');requestAnimationFrame(()=>window.dispatchEvent(new CustomEvent('silo-send-asset',{detail:symbol==='USDC'&&verified?'usdc':{asset:'token',mint:row.mint,decimals:String(row.decimals)}})));};
     return <SiloAssetCard key={`${row.mint}:${index}`} id={id} look={look} symbol={symbol} name={isGrain?'Grainpad official token':verified?label.title:label.imitates?`Unverified · not official ${label.imitates}`:`Unverified · ${label.title}`} summary={concealed?'••••':isGrain?amount(row.amount,row.decimals,'GRAIN'):`${siloTokenAmount(row.shown)} ${label.symbol??'tokens'}`} open={isOpen(id)} onToggle={()=>toggle(id)}>
      <p className="silo-hero">{concealed?<span aria-label="Amount hidden">••••</span>:<span>{siloTokenAmount(row.shown)}</span>}<span className="silo-hero-unit">{symbol}</span></p>
      <SiloNetworkRow icon="sol" label="Public · Solana" state="Connected" on/>
      <p className="silo-window-sub"><span className="silo-token-title">{label.title}{label.verified?<Check className="silo-token-verified" size={14} aria-label="Verified token"/>:row.info?<SiloUnverified imitates={label.imitates}/>:null}</span>{' · '}<code>{siloShortMint(row.mint)}</code>{row.value!==null&&!concealed?` · ≈ ${siloUsd(row.value)}`:isGrain&&grain?.priceUsd!=null&&!concealed?` · ≈ ${siloUsd((siloDisplayAmount(row.amount,row.decimals)??0)*grain.priceUsd)}`:''}</p>
      <div className="silo-actions" role="group" aria-label={`${symbol} actions`}>{action('Receive','primary',true,()=>{openNetwork('sol');requestAnimationFrame(()=>document.getElementById('silo-sol-receive')?.scrollIntoView({behavior:'smooth',block:'start'}));},ArrowDownLeft)}{action('Send','secondary',true,send,ArrowUpRight)}{isGrain&&action('GRAIN details','secondary',true,openGrain,ChevronRight)}</div>
     </SiloAssetCard>;})}
    {evm!==null&&shown('evm')&&<SiloAssetCard id="evm" look={siloChainLook(evm.chainId)} symbol={evm.symbol??'ETH'} name={evm.chainName} summary={amount(evm.amount??null,evm.decimals??18,evm.symbol??'')} open={isOpen('evm')} onToggle={()=>toggle('evm')}>
     <p className="silo-hero">{amount(evm.amount??null,evm.decimals??18,'')}<span className="silo-hero-unit">{evm.symbol}</span></p>
     <SiloNetworkRow icon={evm.chainId===8453?'base':evm.chainId===56?'bnb':evm.chainId===1?'eth':'evm'} label="Public · EVM" state={`${evm.chainName} · view and receive; send where enabled`}/>
     <p className="silo-window-sub">{`${evm.tokens} listed token${evm.tokens===1?'':'s'}`}</p>
     <div className="silo-actions" role="group" aria-label={`${evm.chainName} actions`}>{action('Open wallet','primary',true,()=>openNetwork('evm'),ChevronRight)}</div>
    </SiloAssetCard>}
   </section>
   {/* Swap and Cash out appear only when this build can do them; held features are simply absent (owner, 23 October 2026). */}
   {swapOpens&&<section className="silo-section silo-sell" aria-labelledby="silo-sell-title">
    <div className="silo-section-head"><h2 id="silo-sell-title"><span className="silo-label">Sell any Solana token to XMR</span></h2></div>
    <p className="silo-fine">{swapMode==='execute'?'Pick the token you hold. Anything other than SOL or USDC is swapped to SOL first, then the SOL is converted to XMR.':'Convert SOL or USDC to XMR here. Swapping other tokens first is not live in this build.'}</p>
    <div className="silo-actions" role="group" aria-label="Sell for XMR">
     {action('Sell for XMR','primary',true,()=>navigate('swap','cashout'),ArrowLeftRight)}
     {action('Swap tokens','secondary',true,()=>navigate('swap','sol'),ArrowLeftRight)}
    </div>
    {swapMode==='preview'&&<p className="silo-fine">Swaps are an unsigned preview in this build. Convert opens its review; orders and deposits show their own holds.</p>}
   </section>}
   {activity.length>0&&<section className="silo-section" aria-labelledby="silo-recent-title">
    <div className="silo-section-head"><h2 id="silo-recent-title"><span className="silo-label">Recent activity</span></h2><button type="button" className="silo-button" data-variant="quiet" onClick={()=>showView('activity')}>See all</button></div>
    <div className="silo-account-list">{activityRows(activity.slice(0,3))}</div>
   </section>}
  </div>
 </div>;

 const group=(name:string,rows:{id:Page;title:string;sub:string}[])=><section className="silo-group" aria-labelledby={`silo-group-${name.replace(/\W+/g,'-')}`}><div className="silo-section-head"><h2 id={`silo-group-${name.replace(/\W+/g,'-')}`}><span className="silo-label">{name}</span></h2></div>{rows.map(row=><button key={row.id} type="button" className="silo-link-row" onClick={()=>navigate('settings',row.id)}><span>{row.title}<small>{row.sub}</small></span><ChevronRight size={18} aria-hidden="true"/></button>)}</section>;
 const settingsIndex=<div className="silo-settings-groups">
  {group('Wallet',[{id:'backup',title:'Back up and recover',sub:'Your encrypted wallet is kept in this browser.'},{id:'devices',title:'Account and devices',sub:'Sign in, unlock a synced vault and approve another device.'}])}
  <section className="silo-group" aria-label="Other networks"><button type="button" className="silo-link-row" onClick={()=>openNetwork('evm')}><span>Other networks<small>Ethereum, Base, BNB Chain and Robinhood Chain: view and receive; send where enabled.</small></span><ChevronRight size={18} aria-hidden="true"/></button></section>
   {group('Display',[{id:'display',title:'Appearance and hidden amounts',sub:'Dark, light or your device setting. Hide balances on every screen.'}])}
  {group('About Silo',[{id:'fees',title:'Fees, privacy and limits',sub:'What is public, what costs money and what is not promised.'},{id:'build',title:'What this build can do',sub:'Available, preview only and held.'},{id:'about',title:'About',sub:'Beta, not externally audited. Build and links.'}])}
 </div>;
 const aboutPage=<div className="silo-about">
  {betaNote}
  <dl>
   <div><dt>Slogan</dt><dd>{SILO_TAGLINE}</dd></div>
   <div><dt>Custody</dt><dd>Keys are created and encrypted on this device. Silo cannot reset a password or recover a wallet for you.</dd></div>
   <div><dt>Build</dt><dd><code>{BUILD_COMMIT??'not recorded (local build)'}</code></dd></div>
  </dl>
  <a className="silo-textlink" href={`${launchpad}/`}>Built at Grainpad<ArrowUpRight size={14} aria-hidden="true"/></a>
  <a className="silo-textlink" href={`${launchpad}/scan`}>Field Scan<ArrowUpRight size={14} aria-hidden="true"/></a>
 </div>;
 const taskNote:Partial<Record<Task,string>>={atomic:'XMR to SOL · You claim on chain; if it stalls, funds come back.'};
 // The no-bridge swap is a third task; while token swaps are held the selector offers only Convert and No bridge.
 const taskIds:Task[]=[...(swapHeld?[]:['swap' as Task]),'cashout' as Task,...(atomicEnabled?['atomic' as Task]:[])];
 const taskKeys=(event:KeyboardEvent<HTMLButtonElement>)=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();const order=taskIds;const next:Task=order[(order.indexOf(task)+(event.key==='ArrowLeft'||event.key==='ArrowUp'?order.length-1:1))%order.length];setTask(next);requestAnimationFrame(()=>document.getElementById(`silo-task-${next}`)?.focus());};
 const taskSelector=<div className="silo-task"><div className="silo-selector" role="radiogroup" aria-label="What do you want to do">{taskIds.map(id=><button key={id} id={`silo-task-${id}`} type="button" role="radio" aria-checked={task===id} tabIndex={task===id?0:-1} onKeyDown={taskKeys} onClick={()=>setTask(id)}><ArrowLeftRight size={20} aria-hidden="true"/>{id==='swap'?'Swap tokens':id==='cashout'?'Convert':<>No bridge{' '}<SiloBetaBadge/></>}</button>)}</div>{taskNote[task]&&<p className="silo-fine">{taskNote[task]}</p>}</div>;
 const subpage=view==='settings'&&page!=='index';
 return <div className="silo-app exposure-shell" data-view={view} data-network={network} data-theme={appearance} data-task={task} data-page={view==='settings'?page:undefined} data-send-open={view==='send'&&(network==='xmr'?xmr.opened:solanaOpen)?'true':undefined}><SiloAmountPad/>
  <aside className="silo-sidebar"><a href="/" className="silo-wordmark"><img className="silo-logo-full" src={appearance==='light'?'/brand/silo-connected-logo.svg':'/brand/silo-connected-logo-dark.svg'} alt="Silo" width={104} height={36}/><img className="silo-logo-compact" src={appearance==='light'?'/brand/silo-symbol.svg':'/brand/silo-symbol-dark.svg'} alt="Silo" width={30} height={32}/></a><p className="silo-sidebar-line">{SILO_TAGLINE}</p>
   <nav aria-label="Wallet navigation">{shownViews.map(({id,label,icon:Icon})=><button key={id} onClick={()=>showView(id)} aria-current={view===id||(id==='overview'&&view==='wallets')?'page':undefined}><Icon size={20} aria-hidden="true"/><span>{label}</span></button>)}</nav>
  </aside>
  <main id="main-content" className="silo-main">
   {(backupNeeded||xmr.needsBackup===true)&&<div className="silo-backup-banner" role="status"><div><strong>Back up your wallet to protect your funds.</strong><span>Until you export an encrypted backup and verify it, this wallet exists only in this browser.</span></div><button type="button" onClick={()=>openNetwork(xmr.needsBackup===true?'xmr':'sol')}>Back up now</button></div>}
   <header className="silo-page-header"><div className="silo-title"><div className="silo-brand-row"><span className="silo-mobile-logo"><img src="/brand/silo-logo.svg" alt="Silo" width={70} height={24}/></span><span className="silo-net-badge" data-mode={networkBadgeLabel==='Test network'?'test':'mainnet'} data-solana={solanaNetwork} role="note" title={networkBadgeNote} aria-label={networkBadgeNote}><i aria-hidden="true"/>{networkBadgeLabel}</span></div><div className="silo-title-text">{subpage&&<button type="button" className="silo-back" onClick={()=>navigate('settings','index')}><ChevronLeft size={18} aria-hidden="true"/>Settings</button>}{(view==='wallets'||view==='send')&&<button type="button" className="silo-back" onClick={()=>navigate('overview')}><ChevronLeft size={18} aria-hidden="true"/>Home</button>}<h1>{title}<span className="silo-stop" aria-hidden="true">.</span></h1>{stateLine&&<p className="silo-state-line">{stateLine}</p>}</div></div><div className="silo-header-right">{(xmr.opened||solanaOpen)&&<button className="silo-icon-button" onClick={()=>location.reload()} aria-label="Lock wallets"><LockKeyhole size={21} aria-hidden="true"/></button>}{/* Keys live only in this page's memory: reloading locks every wallet; saved payment records are kept. */}<button className="silo-icon-button" onClick={toggleConcealment} aria-pressed={concealed} aria-label={concealed?'Show balance amounts':'Hide balance amounts'}>{concealed?<EyeOff size={21} aria-hidden="true"/>:<Eye size={21} aria-hidden="true"/>}</button></div></header>
   {concealmentError&&persistenceFailed&&<p role="status">{concealmentError}</p>}<SiloReviewVisibilityNotice/>
   {/* Phone quick-access bar: the five things people do most, equal widths. Send is an action (it opens the same Monero Send as Home), not a place; Swap is always listed here and opens its own held or live screen. */}
   <nav className="silo-view-tabs" aria-label="Wallet navigation"><button aria-current={view==='overview'||view==='wallets'?'page':undefined} onClick={()=>showView('overview')}><House size={22} aria-hidden="true"/><span>Home</span></button><button aria-current={view==='send'?'page':undefined} onClick={()=>navigate('send',view==='send'?network:solanaOpen||!xmr.opened?'sol':'xmr')}><ArrowUpRight size={22} aria-hidden="true"/><span>Send</span></button>{views.slice(1).map(({id,label,icon:Icon})=><button key={id} aria-current={view===id?'page':undefined} onClick={()=>showView(id)}><Icon size={22} aria-hidden="true"/><span>{label}</span></button>)}</nav>
   {view==='overview'&&<SiloUnlockHome onOpenWallet={id=>openNetwork(id==='solana'?'sol':id)}/>}
   {view==='overview'&&<SiloDeviceUnlockOffer/>}
   {view==='overview'&&home}
   {view==='send'&&<SiloSendScreen test={test} zone={network==='xmr'?'xmr':'sol'} solanaOpen={solanaOpen} solanaUnverified={solUnverified} solanaNetwork={solanaNetwork} xmrOpened={xmr.opened} xmrState={status} xmrAmount={currentXmrAmount===null?null:siloUnits(currentXmrAmount,12)} publicReport={publicReport??null} concealed={concealed} go={(next,zone)=>navigate(next,zone)}/>}
   {view==='swap'&&(!swapHeld||atomicEnabled)&&taskSelector}
   {view==='wallets'&&network==='evm'&&<div className="silo-network-tabs" role="group" aria-label="Choose wallet network">{[['xmr','Monero',xmrState],['sol','Solana',publicReport?'Connected':'Not checked'],['evm','EVM',evm?'Connected':'Not checked']].map(([id,label,state])=><div className="silo-network-choice" key={id}><button aria-label={label} aria-describedby={`silo-network-status-${id}`} aria-pressed={network===id} onClick={()=>setNetwork(id)}><SiloAssetIcon asset={id==='sol'?'sol':id==='evm'?'evm':'xmr'}/><strong>{label}</strong></button><small id={`silo-network-status-${id}`} className="silo-network-status">{state}</small></div>)}</div>}
   {view==='activity'&&pendingSwap}
   {view==='activity'&&<div className="silo-activity-notes">{publicReport?<p className="silo-fine">Solana activity is public. Open a wallet from Home to see its history.</p>:<div className="silo-activity-empty"><History size={28} aria-hidden="true"/><strong>Nothing to show yet</strong><p>Solana activity is public. Open a wallet from Home to see its history.</p><button type="button" className="silo-activity-empty-go" onClick={()=>showView('overview')}>Go to Home</button></div>}</div>}
   {view==='settings'&&page==='index'&&settingsIndex}
   {view==='settings'&&page==='about'&&aboutPage}
   {view==='settings'&&page==='build'&&<div className="silo-settings-groups">{capabilities}</div>}
   <div className="silo-wallet-controls">{view==='settings'&&<>
    <section id="silo-display" className="exposure-panel silo-setting"><header className="sr-only"><h2>Display</h2><p>How the wallet looks and what it shows on screen.</p></header><div className="silo-setting-body"><div className="silo-setting-row silo-appearance-settings"><div><strong>Appearance</strong><p>Pick how the wallet looks on this device. It does not change networks, keys or saved payments.</p></div><SiloThemeControl/></div><div className="silo-setting-row"><div><strong>Hide amounts</strong><p>Hides balances and amounts on every screen until you show them again.</p></div><button type="button" aria-pressed={concealed} onClick={toggleConcealment}>{concealed?'Show amounts':'Hide amounts'}</button></div></div></section>
    <section id="silo-backup-settings" className="exposure-panel silo-setting"><header><h2>Back up and recover</h2><p>Your encrypted wallet is kept in this browser. Cross-device accounts are still under review.</p></header><div className="silo-setting-body"><div className="silo-setting-row"><div><strong>Keep a verified backup</strong><p>{xmrOff&&(zecSoon||zecOff)?'Monero controls are unavailable in this profile. This does not erase previously saved wallets or replace their backups. Keep your Solana encrypted backup and its original wallet passphrase. Account email login cannot reset or decrypt them.':'Export the encrypted backup, then check it with Verify a backup. The backup tools are inside each native wallet.'}</p></div>{xmrOff&&(zecSoon||zecOff)?badge('off','Backup controls unavailable'):<div className="exposure-actions"><button type="button" disabled={xmrOff} onClick={()=>openNetwork('xmr')}>Monero backup</button></div>}</div><SiloOnePassphrase/></div></section>
    <SiloDeviceUnlockSetting/>
   </>}{children}</div>
   {view==='swap'&&task==='cashout'&&<div className="silo-foot-notes"><p className="silo-fine">Solana trades are public. The XMR side is as private as any Monero payment.</p>{swapMode==='execute'&&<p className="silo-fine">Holding another Solana token? Swap it to SOL first.</p>}</div>}
   <footer className="silo-app-footer"><a href={`${launchpad}/`}>Built at Grainpad<ArrowUpRight size={12}/></a>{/* Testers bind every result to the exact build they used. */}<span className="silo-build">Build <code>{BUILD_COMMIT?BUILD_COMMIT.slice(0,7):'not recorded (local build)'}</code></span></footer>
  </main>
 </div>;
}
