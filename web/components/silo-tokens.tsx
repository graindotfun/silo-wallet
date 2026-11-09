'use client';
import {useEffect,useState} from 'react';
import {Check,Copy} from 'lucide-react';
import {sessionRpcFetch} from '@/lib/browser-rpc-session.mjs';
import {siloImitatedSymbol} from '@/lib/silo/known-tokens.mjs';
import {SiloAssetIcon} from './silo-asset-icon';
import {siloDisplayAmount,siloUsd} from './silo-price';
import {SiloHiddenAmount} from './silo-balance-visibility';
type Network='mainnet-beta'|'devnet';
export type SiloTokenInfo={mint:string;name:string|null;symbol:string|null;decimals:number;program:'spl'|'token-2022';usd:number|null;verified:boolean};
export type SiloHolding={mint:string;amount:string;decimals:number};
export type SiloTokenRow=SiloHolding&{info:SiloTokenInfo|null;value:number|null;shown:number|null};
// Grain's server is asked for token mints only (never the wallet address); one request per mint set per minute.
const requests=new Map<string,{at:number;value:Promise<Map<string,SiloTokenInfo>>}>();
function loadTokens(network:Network,mints:string[]){
 const key=`${network}:${mints.join(',')}`,hit=requests.get(key);if(hit&&Date.now()-hit.at<60_000)return hit.value;
 const value=sessionRpcFetch('/api/silo/tokens',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({network,mints})}).then(async(response:Response)=>{
  if(!response.ok)throw Error('Token details unavailable.');
  const data=await response.json() as {tokens?:SiloTokenInfo[]};
  return new Map((Array.isArray(data.tokens)?data.tokens:[]).filter(row=>mints.includes(row?.mint)).map(row=>[row.mint,row]));
 });
 value.catch(()=>requests.delete(key));requests.set(key,{at:Date.now(),value});return value;
}
/** Names, symbols and display-only USD values for the holdings' mints; null until loaded or when unavailable. */
export function useSiloTokens(network:Network,holdings:SiloHolding[]|null|undefined,enabled:boolean){
 const mints=[...new Set((holdings??[]).map(row=>row.mint))].sort().slice(0,50),key=`${network}:${mints.join(',')}`;
 const [state,setState]=useState<{key:string;data:Map<string,SiloTokenInfo>|null}>({key,data:null});
 useEffect(()=>{if(!enabled||!mints.length)return;let live=true;
  const run=()=>{loadTokens(network,mints).then(data=>{if(live)setState({key,data});},()=>{/* Rows keep their generic labels. */});};
  run();const timer=setInterval(run,60_000);return()=>{live=false;clearInterval(timer);};
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` names the mint set.
 },[key,enabled]);
 return enabled&&state.key===key?state.data:null;
}
/** Holdings with their token details, highest USD value first, then largest amount. */
export function siloTokenRows(holdings:SiloHolding[],tokens:Map<string,SiloTokenInfo>|null,priced:boolean):SiloTokenRow[]{
 return holdings.map(row=>{const info=tokens?.get(row.mint)??null,shown=siloDisplayAmount(row.amount,row.decimals),value=priced&&info?.usd!=null&&shown!==null?shown*info.usd:null;return {...row,info,shown,value};})
  .sort((a,b)=>(b.value??-1)-(a.value??-1)||(b.shown??0)-(a.shown??0));
}
export function siloTokenAmount(value:number|null){
 if(value===null)return '—';
 return value>=1?value.toLocaleString('en-US',{maximumFractionDigits:4}):value.toLocaleString('en-US',{maximumSignificantDigits:6});
}
export const siloShortMint=(mint:string)=>`${mint.slice(0,4)}…${mint.slice(-4)}`;
/** Display label. Names written on chain are anyone's: only verified mints are presented without a marker. */
export function siloTokenLabel(row:SiloTokenRow){
 const info=row.info,symbol=info?.symbol??null;
 return {title:info?.name??symbol??'Solana token',symbol,verified:info?.verified===true,imitates:info&&!info.verified?siloImitatedSymbol(symbol):null};
}
export function SiloUnverified({imitates}:{imitates:string|null}){
 return <span className="silo-unverified" title="Name and symbol are set by the token's creator and are not checked by Silo.">{imitates?`Unverified · not official ${imitates}`:'Unverified'}</span>;
}
function CopyMint({mint}:{mint:string}){
 const [copied,setCopied]=useState(false);
 return <button type="button" className="silo-token-copy" onClick={()=>{navigator.clipboard.writeText(mint).then(()=>setCopied(true),()=>setCopied(false));}} aria-label={copied?'Mint address copied':'Copy mint address'}>{copied?<Check size={14} aria-hidden="true"/>:<Copy size={14} aria-hidden="true"/>}</button>;
}
/** Token rows for the public Solana zone. */
export function SiloTokenList({holdings,tokens,priced}:{holdings:SiloHolding[];tokens:Map<string,SiloTokenInfo>|null;priced:boolean}){
 const rows=siloTokenRows(holdings,tokens,priced);
 return <ul className="silo-tx-list silo-token-list">{rows.map((row,index)=>{const label=siloTokenLabel(row);
  return <li key={`${row.mint}:${index}`} className="silo-tx" data-verified={label.verified||undefined}>
   <SiloAssetIcon asset={label.verified&&label.symbol==='GRAIN'?'grain':'token'}/>
   <span className="silo-tx-main"><strong>{label.title}{label.symbol&&label.symbol!==label.title?<small className="silo-token-symbol">{label.symbol}</small>:null}{label.verified?<Check className="silo-token-verified" size={14} aria-label="Verified token"/>:row.info?<SiloUnverified imitates={label.imitates}/>:null}</strong>
    <small className="silo-token-mint">Mint <code title={row.mint}>{siloShortMint(row.mint)}</code><CopyMint mint={row.mint}/>{row.info?.program==='token-2022'?' · Token-2022':''}</small></span>
   <span className="silo-tx-amount silo-token-amount"><SiloHiddenAmount>{siloTokenAmount(row.shown)}{label.symbol?` ${label.symbol}`:''}{row.value!==null&&<small>≈ {siloUsd(row.value)}</small>}</SiloHiddenAmount></span>
  </li>;})}</ul>;
}
