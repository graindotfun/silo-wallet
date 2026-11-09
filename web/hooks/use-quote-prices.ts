'use client';
import {useSyncExternalStore} from 'react';
import {quotePriceClientStore} from '@/lib/quote-price-client-store.mjs';
export type QuotePrice={price:number;updatedAt:number;freshness:'fresh'|'stale'|'expired';source:string;note:string};
export type QuotePrices={SOL:QuotePrice|null;wXMR:QuotePrice|null};
export function useQuotePrices(){return useSyncExternalStore(quotePriceClientStore.subscribe,quotePriceClientStore.getSnapshot,quotePriceClientStore.getServerSnapshot) as {prices:QuotePrices|null;now:number;loading:boolean;error:boolean};}
