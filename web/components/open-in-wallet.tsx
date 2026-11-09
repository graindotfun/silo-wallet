"use client";
import {useSyncExternalStore} from "react";
import {ArrowUpRight} from "lucide-react";
import {isMobileBrowser,walletBrowseLinks} from "@/lib/wallet";

const noSubscription=()=>()=>{};
function mobileLinks(){
 if(!isMobileBrowser(navigator.userAgent,navigator.maxTouchPoints))return null;
 try{return walletBrowseLinks(window.location.href);}catch{return null;}
}
const cache=new Map<string,ReturnType<typeof mobileLinks>>();
function snapshot(){const key=window.location.href+navigator.userAgent;if(!cache.has(key))cache.set(key,mobileLinks());return cache.get(key)!;}

/** Shown when no wallet is injected. On mobile, reopen this exact page inside a wallet app. */
export function OpenInWallet({mobileOnly=false}:{mobileOnly?:boolean}){
 const links=useSyncExternalStore(noSubscription,snapshot,()=>null);
 if(!links&&mobileOnly)return null;
 if(!links)return <p>No supported wallet detected. Open this site in a browser with <a className="inline-link" href="https://phantom.com/" target="_blank" rel="noreferrer">Phantom</a> or <a className="inline-link" href="https://solflare.com/" target="_blank" rel="noreferrer">Solflare</a>.</p>;
 return <div className="open-in-wallet" role="group" aria-label="Open this page in a wallet app">
  <p>This browser has no Solana wallet. Open this page in your wallet app to connect and sign there.</p>
  <div className="download-links">{links.map(link=><a key={link.name} href={link.href} rel="noreferrer">Open in {link.name}<ArrowUpRight size={15}/></a>)}</div>
  <p className="small muted">Unsaved drafts and in-progress reviews stay in this browser. Nothing is signed until you approve it in the wallet.</p>
 </div>;
}
