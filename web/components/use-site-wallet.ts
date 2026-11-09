'use client';
import {useEffect,useEffectEvent,useSyncExternalStore,type RefObject} from 'react';
import {siteWalletSession} from '@/lib/site-wallet-session.mjs';
import type {MainnetWalletSession} from '@/lib/chain/robinhood-mainnet-wallet.ts';
import type {Wallet} from '@/lib/wallet';
export type SiteWalletConnection={family:'solana';networkId:'solana:mainnet-beta';name:string;owner:string;wallet:Wallet}|{family:'evm';networkId:string;name:string;owner:string;session:Omit<MainnetWalletSession,'networkId'|'chainId'>&{networkId:string;chainId:number}};
const empty=()=>null;
export function useSiteWallet(){return useSyncExternalStore(siteWalletSession.subscribe,siteWalletSession.getSnapshot,empty) as SiteWalletConnection|null;}
export function mainnetSiteSession():MainnetWalletSession|null{const s=siteWalletSession.getSnapshot();return s?.family==='evm'&&s.session.chainId===4663&&s.networkId==='robinhood:mainnet'?s.session:null;}
/** The ref changes inside the store callback, before a pending wallet operation can continue. */
export function useSharedMainnetWallet(ref:RefObject<MainnetWalletSession|null>,changed:(next:MainnetWalletSession|null)=>void){
 const publish=useEffectEvent(changed);
 useEffect(()=>{const sync=()=>{const next=mainnetSiteSession();if(ref.current===next)return;ref.current=next;publish(next);};const remove=siteWalletSession.subscribe(sync);sync();return remove;},[ref]);
}
