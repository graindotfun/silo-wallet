'use client';
/* eslint-disable @next/next/no-img-element -- Packaged GRAIN mark, no external image optimizer. */
import {useEffect,useState,type ReactNode} from 'react';
import {SiloHiddenAmount} from './silo-balance-visibility';
import {SILO_REWARDS_IDLE,siloRewardsStart,siloRewardsDone,siloRewardsFail,siloRewardsView} from '@/lib/silo/grain-rewards-state.mjs';
import {sessionRpcFetch} from '@/lib/browser-rpc-session.mjs';
export type SiloPriceRange='1D'|'1W'|'1M'|'1Y'|'ALL';
export type SiloAssetPrice={usd:number|null;change24h:number|null;series:[number,number][]|null;updatedAt:number|null;stale:boolean};
type Prices={range:string;source:string;assets:{XMR:SiloAssetPrice|null;SOL:SiloAssetPrice|null}};
const RANGES:SiloPriceRange[]=['1D','1W','1M','1Y','ALL'];
const RANGE_LABEL:Record<SiloPriceRange,string>={'1D':'past day','1W':'past week','1M':'past month','1Y':'past year','ALL':'all time'};
// One request per range per minute for the whole page; the server holds the shared copy.
const requests=new Map<string,{at:number;value:Promise<Prices>}>();
function loadPrices(range:SiloPriceRange):Promise<Prices>{
 const hit=requests.get(range);if(hit&&Date.now()-hit.at<60_000)return hit.value;
 const value=sessionRpcFetch('/api/silo/prices',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({range})}).then(async(response:Response)=>{if(!response.ok)throw Error('Prices unavailable.');return await response.json() as Prices;});
 value.catch(()=>requests.delete(range));requests.set(range,{at:Date.now(),value});return value;
}
export function useSiloPrices(range:SiloPriceRange,enabled:boolean){
 const [state,setState]=useState<{range:SiloPriceRange;data:Prices|null;failed:boolean}>({range,data:null,failed:false});
 useEffect(()=>{if(!enabled)return;let live=true;
  const run=()=>{loadPrices(range).then(data=>{if(live)setState({range,data,failed:false});},()=>{if(live)setState(previous=>({range,data:previous.range===range?previous.data:null,failed:true}));});};
  run();const timer=setInterval(run,range==='1D'?60_000:300_000);return()=>{live=false;clearInterval(timer);};
 },[range,enabled]);
 return state.range===range?state:{range,data:null,failed:false};
}
export function siloUsd(value:number){
 if(value>=1)return '$'+value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
 return '$'+value.toLocaleString('en-US',{maximumSignificantDigits:4});
}
/** Atomic units to a display number. Display only: never used for amounts that are signed or sent. */
export function siloDisplayAmount(atomic:string|null|undefined,decimals:number){
 if(atomic==null||!/^\d+$/.test(atomic))return null;
 const text=atomic.padStart(decimals+1,'0');return Number(`${text.slice(0,-decimals)}.${text.slice(-decimals)}`);
}
const when=(time:number,range:SiloPriceRange)=>new Date(time).toLocaleString('en-US',range==='1D'?{hour:'numeric',minute:'2-digit'}:range==='1Y'||range==='ALL'?{month:'short',day:'numeric',year:'numeric'}:{month:'short',day:'numeric',hour:'numeric'});

type ChartPrice={usd:number|null;series:[number,number][]|null;stale:boolean};
/** One price card: headline, scrubbable chart, range chips and an estimate note. Shared by native assets and GRAIN. */
function PriceChartView({id,name,price,failed,source,range,onRange,note,children}:{id:string;name:string;price:ChartPrice|null;failed:boolean;source:string|null;note?:string|null;range:SiloPriceRange;onRange:(range:SiloPriceRange)=>void;children?:ReactNode}){
 const [point,setPoint]=useState<number|null>(null);
 const series=price?.series??null;
 if(!price){return <section className="silo-inset silo-price" aria-label={`${name} price`}><span className="silo-zone-network">{name} price</span><p className="silo-empty">{failed?'Price is unavailable right now. Balances and payments are not affected.':'Loading price…'}</p>{children}</section>;}
 const values=series?.map(row=>row[1])??[],min=values.length?Math.min(...values):0,max=values.length?Math.max(...values):0;
 const at=point!==null&&series?Math.min(point,series.length-1):null,shown=at!==null&&series?series[at][1]:price.usd;
 const first=series?.[0]?.[1]??null,change=shown!==null&&first?((shown-first)/first)*100:null;
 const X=(index:number)=>series&&series.length>1?(index/(series.length-1))*600:0,Y=(value:number)=>184-((value-min)/(max-min||1))*168;
 const line=series?series.map(([,value],index)=>`${index?'L':'M'}${X(index).toFixed(1)} ${Y(value).toFixed(1)}`).join(' '):'';
 const scrub=(clientX:number,target:HTMLElement)=>{if(!series)return;const box=target.getBoundingClientRect(),share=Math.min(1,Math.max(0,(clientX-box.left)/box.width));setPoint(Math.round(share*(series.length-1)));};
 return <section className="silo-inset silo-price" aria-label={`${name} price`}>
  <div className="silo-price-head"><span className="silo-zone-network">{name} price</span><strong className="silo-price-value">{shown===null?'—':siloUsd(shown)}</strong>
   <span className="silo-price-change" data-trend={change===null?undefined:change>=0?'up':'down'}>{change===null?'':`${change>=0?'+':'−'}${Math.abs(change).toFixed(2)}%`} <span>{at!==null&&series?when(series[at][0],range):RANGE_LABEL[range]}</span></span></div>
  {series&&<div className="silo-chart" onPointerMove={event=>scrub(event.clientX,event.currentTarget)} onPointerDown={event=>scrub(event.clientX,event.currentTarget)} onPointerLeave={()=>setPoint(null)} onPointerUp={event=>{if(event.pointerType!=='mouse')setPoint(null);}} role="img" aria-label={`${name} price over the ${RANGE_LABEL[range]}: from ${siloUsd(series[0][1])} to ${siloUsd(series[series.length-1][1])}, low ${siloUsd(min)}, high ${siloUsd(max)}`}>
   <span className="silo-chart-label" data-edge="high">{siloUsd(max)}</span><span className="silo-chart-label" data-edge="low">{siloUsd(min)}</span>
   <svg viewBox="0 0 600 200" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id={`silo-fill-${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" style={{stopColor:'var(--silo-zone)',stopOpacity:.26}}/><stop offset="1" style={{stopColor:'var(--silo-zone)',stopOpacity:0}}/></linearGradient></defs><path d={`${line} L600 200 L0 200 Z`} fill={`url(#silo-fill-${id})`}/><path d={line} fill="none" style={{stroke:'var(--silo-zone)'}} strokeWidth="2.2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round"/></svg>
   {at!==null&&<><span className="silo-chart-rule" style={{left:`${(X(at)/600)*100}%`}}/><span className="silo-chart-dot" style={{left:`${(X(at)/600)*100}%`,top:`${(Y(series[at][1])/200)*100}%`}}/></>}
  </div>}
  <div className="silo-range-chips" role="group" aria-label="Chart range">{RANGES.map(value=><button key={value} type="button" aria-pressed={range===value} onClick={()=>{onRange(value);setPoint(null);}}>{value}</button>)}</div>
  {!series&&note&&<p className="silo-chart-note">{note}</p>}
  {children}
  <p className="exposure-note silo-price-note">Estimate from {source??'a public price feed'}{price.stale?' · may be delayed':''}. Not used for any payment.</p>
 </section>;
}

export function SiloPriceChart({asset,name,enabled,holding,realFunds}:{asset:'XMR'|'SOL';name:string;enabled:boolean;holding?:{atomic:string|null;decimals:number};realFunds:boolean}){
 const [range,setRange]=useState<SiloPriceRange>('1W');
 const {data,failed}=useSiloPrices(range,enabled);
 if(!enabled)return null;
 const price=data?.assets[asset]??null,amount=holding?siloDisplayAmount(holding.atomic,holding.decimals):null;
 return <PriceChartView id={asset} name={name} price={price} failed={failed} source={data?.source??null} range={range} onRange={setRange}>
  {price&&amount!==null&&price.usd!==null&&<p className="silo-price-holding">{realFunds?<>Your {asset} ≈ <SiloHiddenAmount><strong>{siloUsd(amount*price.usd)}</strong></SiloHiddenAmount></>:<>Test funds have no value.</>}</p>}
 </PriceChartView>;
}

type Grain={mint:string;symbol:string;name:string;quote:string;transferTaxBps:number|null;priceUsd:number|null;change24h:number|null;marketCapUsd:number|null;liquidityUsd:number|null;series:[number,number][]|null;stale:boolean;source:string;chart?:'ok'|'stale'|'unavailable';priceStale?:boolean;reasons?:string[]};
type RewardState={result:{owner:string;data:unknown}|null;busy:string|null;failed:string|null};
type GrainRewards={rewards:{payoutGroups:{payoutSymbol:string|null;payoutDecimals:number|null;amountRaw:string;paymentCount:number}[];payments:number;more:boolean;coverage:string}|null;reason?:string};
const grainRequests=new Map<string,{at:number;value:Promise<Grain>}>();
const grainPost=(body:object)=>sessionRpcFetch('/api/silo/grain',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(async(response:Response)=>{if(!response.ok)throw Error('GRAIN data unavailable.');return await response.json();});
function loadGrain(range:SiloPriceRange):Promise<Grain>{
 const hit=grainRequests.get(range);if(hit&&Date.now()-hit.at<60_000)return hit.value;
 const value=grainPost({range}) as Promise<Grain>;value.catch(()=>grainRequests.delete(range));grainRequests.set(range,{at:Date.now(),value});return value;
}
/** GRAIN market data for the wallet; null until loaded or when unavailable. */
export function useSiloGrain(range:SiloPriceRange,enabled:boolean){
 const [state,setState]=useState<{range:SiloPriceRange;data:Grain|null;failed:boolean}>({range,data:null,failed:false});
 useEffect(()=>{if(!enabled)return;let live=true;
  const run=()=>{loadGrain(range).then(data=>{if(live)setState({range,data,failed:false});},()=>{if(live)setState(previous=>({range,data:previous.range===range?previous.data:null,failed:true}));});};
  run();const timer=setInterval(run,range==='1D'?60_000:300_000);return()=>{live=false;clearInterval(timer);};
 },[range,enabled]);
 return state.range===range?state:{range,data:null,failed:false};
}
const compactUsd=(value:number|null)=>value===null?'—':value>=1e6?`$${(value/1e6).toFixed(2)}M`:value>=1e3?`$${(value/1e3).toFixed(1)}K`:siloUsd(value);

/** The official GRAIN token: price, chart, market figures, the holder's balance and, on request, their reward payments. */
export function SiloGrainPanel({enabled,owner,holdings,launchpad,realFunds}:{enabled:boolean;owner:string|null;holdings:{mint:string;amount:string;decimals:number}[];launchpad:string;realFunds:boolean}){
 const [range,setRange]=useState<SiloPriceRange>('1D'),[rewardState,setRewardState]=useState<RewardState>(SILO_REWARDS_IDLE);
 const {rewards,busy:rewardsBusy,failed:rewardsFailed}=siloRewardsView(rewardState,owner) as {rewards:GrainRewards|null;busy:boolean;failed:boolean};
 const {data,failed}=useSiloGrain(range,enabled);
 if(!enabled)return null;
 const holding=data?holdings.find(row=>row.mint===data.mint)??null:null,amount=holding?siloDisplayAmount(holding.amount,holding.decimals):null;
 const price=data?{usd:data.priceUsd,series:data.series,stale:data.stale}:null;
 async function checkRewards(){const asked=owner;if(!asked||rewardsBusy)return;setRewardState(state=>siloRewardsStart(state,asked));try{const data=await grainPost({rewardsFor:asked}) as GrainRewards;setRewardState(state=>siloRewardsDone(state,asked,data));}catch{setRewardState(state=>siloRewardsFail(state,asked));}}
 return <div className="silo-grain" id="silo-grain">
  <div className="silo-grain-head"><span className="silo-asset-icon" aria-hidden="true"><img src="/silo-icons/grain.svg" alt="" width={40} height={40}/></span><span><strong>GRAIN</strong><small>Grainpad&apos;s official token · public on Solana</small></span></div>
  <PriceChartView id="GRAIN" name="GRAIN" price={price} failed={failed} source={data?.source??null} range={range} onRange={setRange} note={data?.chart==='unavailable'?'Chart unavailable right now. The price is shown.':null}>
   {amount!==null&&<p className="silo-price-holding">Your GRAIN: <SiloHiddenAmount><strong>{amount.toLocaleString('en-US',{maximumFractionDigits:2})}</strong>{data?.priceUsd!=null&&realFunds?<> ≈ <strong>{siloUsd(amount*data.priceUsd)}</strong></>:null}</SiloHiddenAmount></p>}
  </PriceChartView>
  {data&&<dl className="silo-grain-stats"><div><dt>Market cap</dt><dd>{compactUsd(data.marketCapUsd)}</dd></div><div><dt>24h</dt><dd data-trend={data.change24h===null?undefined:data.change24h>=0?'up':'down'}>{data.change24h===null?'—':`${data.change24h>=0?'+':'−'}${Math.abs(data.change24h).toFixed(1)}%`}</dd></div><div><dt>Transfer tax</dt><dd>{data.transferTaxBps===null?'—':`${(data.transferTaxBps/100).toFixed(1)}%`}</dd></div><div><dt>Paired with</dt><dd>{data.quote}</dd></div></dl>}
  {owner&&<div className="silo-inset silo-grain-rewards"><h3>Holder rewards</h3>
   {rewards?.rewards?rewards.rewards.payoutGroups.length?rewards.rewards.payoutGroups.map(group=><p key={`${group.payoutSymbol}`} className="silo-price-holding"><SiloHiddenAmount><strong>{group.payoutDecimals===null?group.amountRaw:siloDisplayAmount(group.amountRaw,group.payoutDecimals)?.toLocaleString('en-US',{maximumFractionDigits:6})} {group.payoutSymbol??'tokens'}</strong></SiloHiddenAmount> in {group.paymentCount} verified payment{group.paymentCount===1?'':'s'}{rewards.rewards?.more?' (latest 50)':''}</p>):<p className="silo-empty">No verified reward payments to this wallet yet.</p>:rewards?<p className="silo-empty">{rewards.reason}</p>:<p className="exposure-note">Rewards are paid in wXMR to GRAIN holders. Checking sends this wallet&apos;s public address to Grainpad for this one read.</p>}
   {rewardsFailed&&<p role="alert" className="exposure-error">Rewards could not be checked. Try again shortly.</p>}
   {!rewards&&<button type="button" disabled={rewardsBusy} onClick={()=>void checkRewards()}>{rewardsBusy?'Checking…':'Check my rewards'}</button>}
  </div>}
  {data&&<a className="silo-grain-link" href={`${launchpad}/token/${data.mint}`} target="_blank" rel="noopener noreferrer">Open GRAIN on Grainpad<span aria-hidden="true">↗</span></a>}
 </div>;
}
