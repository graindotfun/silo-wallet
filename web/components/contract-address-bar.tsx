"use client";
import {useEffect,useState} from "react";
import {watchOfficialContract} from '@/lib/official-ca-refresh.mjs';
import {BRAND_CHAIN} from "@/lib/brand-presentation";
import {Check,Copy,ArrowUpRight} from "lucide-react";
export function ContractAddressBar(){
 const [mint,setMint]=useState<string|null>(null),[state,setState]=useState("checking"),[copied,setCopied]=useState(false),[error,setError]=useState("");
 useEffect(()=>watchOfficialContract({onResult:(result:{mint:string|null;state:string})=>{setMint(result.mint);setState(result.state);}}),[]);
 useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(false),2500);return()=>clearTimeout(timer);},[copied]);
 async function copy(){if(!mint)return;try{await navigator.clipboard.writeText(mint);setCopied(true);setError('');}catch{setError('Select the address to copy it manually.');}}
 return <aside className="contract-bar" aria-label="Official GRAIN contract address"><div className="contract-inner"><span className="contract-label"><i/>GRAIN <span>CA</span></span>{mint?<><code className="contract-address" title={mint}>{mint}</code><button className="contract-copy" onClick={copy} aria-label={copied?'Contract address copied':'Copy GRAIN contract address'}>{copied?<Check size={13}/>:<Copy size={13}/>}<span>{copied?'Copied':'Copy'}</span></button><a className="contract-explorer" href={`https://explorer.solana.com/address/${mint}`} target="_blank" rel="noreferrer" aria-label={`Verify GRAIN on ${BRAND_CHAIN.explorerLabel}`}><ArrowUpRight size={15}/></a></>:<span className="contract-pending"><span className="contract-pending-full">{state==='pending'?'Official contract will appear here after launch.':state==='unavailable'?'Contract verification temporarily unavailable.':'Checking official contract…'}</span><span className="contract-pending-short">· {state==='pending'?'after launch':state==='unavailable'?'verification unavailable':'checking…'}</span></span>}{mint&&<a className="contract-market" href={`/token/${mint}`}>Open GRAIN <ArrowUpRight size={12}/></a>}<span className="contract-network">{BRAND_CHAIN.label}</span><span className="sr-only" role="status">{error|| (copied?'Full contract address copied.':'')}</span></div></aside>;
}
