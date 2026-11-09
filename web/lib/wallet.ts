import {connectWalletWithIntent,cancelWalletConnections,walletIntentRevision} from './wallet-connection-intent.mjs';
import {walletSession} from './wallet-session.mjs';
import {getWallets} from '@wallet-standard/app';
import {discoverWalletProviders} from './wallet-adapters.mjs';
import type {PublicKey,VersionedTransaction} from '@solana/web3.js';
export type Wallet={publicKey:PublicKey|null;connect:(options?:{silent?:boolean})=>Promise<unknown>;disconnect?:()=>Promise<void>;invalidateSession?:()=>void;signMessage:(m:Uint8Array,encoding?:string)=>Promise<{signature:Uint8Array}|Uint8Array>;signTransaction:(t:VersionedTransaction)=>Promise<VersionedTransaction>;transferIdentity?:()=>unknown;signReviewedTransferTransaction?:(t:VersionedTransaction,ticket:unknown)=>Promise<VersionedTransaction>;signReviewedManagedTransaction?:(t:VersionedTransaction,ticket:unknown)=>Promise<VersionedTransaction>;on?:(event:string,handler:()=>void)=>void;removeListener?:(event:string,handler:()=>void)=>void};
const observed=new WeakSet<Wallet>();
export type WalletProvider={name:string;brand:string;kind:'injected'|'standard'|'native';icon:string|null;wallet:Wallet};
export function walletProviders():WalletProvider[]{
 if(typeof window==='undefined')return [];
 const providers=discoverWalletProviders(window,[...getWallets().get()]) as WalletProvider[];
 for(const {name,wallet} of providers)if(!observed.has(wallet)){observed.add(wallet);wallet.on?.('connect',()=>{walletSession.activate(wallet,name);try{sessionStorage.setItem('grainpad-wallet-provider',name);}catch{}});}
 return providers;
}
/** Selecting/connecting identifies an account; it is not a login signature or transaction approval. */
export function watchWalletIdentity(wallet:Wallet,onInvalidated:()=>void){
 const invalidate=()=>onInvalidated();wallet.on?.('accountChanged',invalidate);wallet.on?.('disconnect',invalidate);
 return()=>{wallet.removeListener?.('accountChanged',invalidate);wallet.removeListener?.('disconnect',invalidate);};
}
/** Mobile browsers inject no Solana wallet; these universal links reopen the page in a wallet's in-app browser, which does. */
export function walletBrowseLinks(pageUrl:string){
 const page=new URL(pageUrl);if(page.protocol!=='https:'&&page.hostname!=='localhost')throw Error('Wallet browse links require an HTTPS page.');
 const url=encodeURIComponent(page.toString()),ref=encodeURIComponent(page.origin);
 return [{name:'Phantom',href:`https://phantom.app/ul/browse/${url}?ref=${ref}`},{name:'Solflare',href:`https://solflare.com/ul/v1/browse/${url}?ref=${ref}`}];
}
export function isMobileBrowser(userAgent:string,maxTouchPoints=0){
 return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)||(/Macintosh/.test(userAgent)&&maxTouchPoints>1);
}

let restoring:Promise<void>|null=null;
export function restoreWalletSession(){
 if(restoring||walletSession.getSnapshot())return restoring||Promise.resolve();
 const revision=walletIntentRevision();
 restoring=(async()=>{let name='';try{name=sessionStorage.getItem('grainpad-wallet-provider')||'';}catch{}if(!name)return;
 // Wait briefly for an installed provider to inject. Never fall back to another wallet.
 for(let i=0;i<4;i++){if(revision!==walletIntentRevision())return;const selected=walletProviders().find(p=>p.name===name);if(selected){try{await connectWalletWithIntent(selected.wallet,{silent:true});}catch{}return;}await new Promise(resolve=>setTimeout(resolve,300));}
 })().finally(()=>{restoring=null;});return restoring;
}
export async function disconnectWalletSession(){cancelWalletConnections();const selected=walletSession.getSnapshot();try{sessionStorage.removeItem('grainpad-wallet-provider');}catch{}walletSession.clear();await selected?.wallet.disconnect?.();}
export function openWalletPicker(){window.dispatchEvent(new CustomEvent('grainpad-open-wallet',{detail:{network:'solana'}}));}
