"use client";
import {SiteWallet} from "./site-wallet";
import {BRAND_ASSETS} from "@/lib/brand-assets";
/* eslint-disable @next/next/no-html-link-for-pages -- Native navigation avoids the deployed vinext RSC client-router failure. */
import Image from "next/image";
import {useEffect, useMemo, useState, useSyncExternalStore, type ReactNode} from "react";
import {siteWalletSession,openSiteWallet} from "@/lib/site-wallet-session.mjs";
import {createGrainpetEntry,GRAINPET_PATH} from "@/lib/grainpet-entry.mjs";
import {ArrowUpRight, Menu, X} from "lucide-react";
import {XLink} from "@/components/x-link";
import {DiscordLink} from "@/components/discord-link";
import {GitHubLink} from "@/components/github-link";
import {SITE} from "@/lib/site-config";
import {ThemeToggle} from "@/components/theme-toggle";
import {AppearanceControl} from "@/components/appearance-control";
import {SILO_LINK_LABEL,SILO_URL} from "@/lib/grain-family";

function subscribeToPath(onChange:()=>void) {
 window.addEventListener("popstate",onChange);
 return ()=>window.removeEventListener("popstate",onChange);
}
/* The Rewards Tracker routes 404 unless the server enables them; the root layout mirrors that switch on <html>. */
const current=(path:string,href:string)=>href==="/launches"?path==="/launches"||path.startsWith("/token/"):href==="/rewards"?path==="/rewards"||path.startsWith("/rewards-tracker"):href==="/launch"?path==="/launch"||path.startsWith("/launch/"):path===href;

export function SiteHeader({walletAction,textOnly=false,showWallet=true}:{walletAction?:ReactNode;textOnly?:boolean;showWallet?:boolean}) {
 const [open,setOpen]=useState(false);
 const path=useSyncExternalStore(subscribeToPath,()=>window.location.pathname,()=>"");
 const entry=useMemo(()=>createGrainpetEntry({session:siteWalletSession,open:()=>openSiteWallet("solana"),go:(to:string)=>window.location.assign(to)}),[]);
 useEffect(()=>{const cancel=()=>entry.cancel();window.addEventListener("grainpad-wallet-closed",cancel);return()=>{window.removeEventListener("grainpad-wallet-closed",cancel);entry.cancel();};},[entry]);
 useEffect(()=>{if(!open)return;const close=(e:KeyboardEvent)=>{if(e.key==="Escape")setOpen(false)};window.addEventListener("keydown",close);return()=>window.removeEventListener("keydown",close)},[open]);
 const link=(href:string,label:ReactNode)=><a href={href} aria-current={current(path,href)?"page":undefined} onClick={()=>setOpen(false)}>{label}</a>;
 const petLink=(label:ReactNode)=><a href={GRAINPET_PATH} aria-current={path==="/pet"||path==="/pet/"?"page":undefined} onClick={e=>{e.preventDefault();setOpen(false);entry.enter();}}>{label}</a>;
 return <header className={`site-header gx-header${walletAction?" has-wallet-action":""}${open?" is-open":""}`}>
  <div className="gx-header-inner">
   {/* The symbol and wordmark keep the existing site spacing. Only the symbol turns on hover. */}
   <a href="/" className="site-brand gx-logo" aria-label="grainpad home">{textOnly?<><Image unoptimized priority className="gx-logo-light" src={BRAND_ASSETS.logoWordmark} width={122} height={31} alt=""/><Image unoptimized priority className="gx-logo-dark" src={BRAND_ASSETS.logoWordmarkDark} width={122} height={31} alt=""/></>
    :[["gx-logo-light",BRAND_ASSETS.logoWordmark],["gx-logo-dark",BRAND_ASSETS.logoWordmarkDark]].map(([theme,src])=><span key={theme} className={`gx-logo-lockup ${theme}`}><Image unoptimized priority className="gx-logo-word" src={src} width={114} height={29} alt=""/><Image unoptimized priority className="gx-logo-mark" src={BRAND_ASSETS.logoSymbol} width={28} height={28} alt=""/></span>)}</a>
   <nav className="desktop-nav gx-nav" aria-label="Main navigation">{link("/launches","explore")}{link("/launch","create a token")}{link("/rooms","rooms")}{link("/fees","creator desk")}{link("/rewards","rewards")}{link("/treasury","treasury")}{petLink("grainpet")}<a className="gx-family-link" href={SILO_URL} rel="noopener" aria-label={SILO_LINK_LABEL}>silo<span className="gx-dot">.</span> <ArrowUpRight size={12} aria-hidden="true"/></a></nav>
   <div className="site-header-actions gx-header-actions"><XLink/><DiscordLink/><GitHubLink/><ThemeToggle/>{showWallet&&<SiteWallet/>}<button className="mobile-menu-toggle gx-icon" aria-label={open?"Close navigation":"Open navigation"} aria-expanded={open} aria-controls="mobile-navigation" onClick={()=>setOpen(!open)}>{open?<X size={20}/>:<Menu size={20}/>}</button></div>
  </div>
  {open&&<nav id="mobile-navigation" className="mobile-navigation gx-mobile-nav" aria-label="Mobile navigation">
   <div className="gx-mobile-primary">{link("/launches",<>explore launches <ArrowUpRight size={18}/></>)}{link("/launch",<>create a token <ArrowUpRight size={18}/></>)}{link("/rooms","rooms")}{link("/fees","creator desk")}{link("/rewards","holder rewards")}{link("/treasury","treasury")}{petLink("grainpet")}</div>
   <div className="gx-mobile-family"><span className="gx-label">grain family</span><a href={SILO_URL} rel="noopener" aria-label={SILO_LINK_LABEL} onClick={()=>setOpen(false)}><span><b>silo<span className="gx-dot">.</span></b><small>wallet by grain</small></span><ArrowUpRight size={18} aria-hidden="true"/></a></div>
   <div className="gx-mobile-secondary"><span className="gx-label">more</span>{link("/markets/wxmr","wXMR market")}{link("/lab","research lab")}{link("/transparency","transparency")}{link("/platform","platform status")}<a href={SITE.discord} target="_blank" rel="noreferrer" onClick={()=>setOpen(false)}>discord community <ArrowUpRight size={14}/></a><a href={SITE.github} target="_blank" rel="noopener noreferrer" onClick={()=>setOpen(false)}>GitHub source <ArrowUpRight size={14}/></a></div>
   <div className="gx-mobile-appearance"><AppearanceControl/></div>
  </nav>}
 </header>;
}
