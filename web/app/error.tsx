'use client';
/* eslint-disable @next/next/no-html-link-for-pages -- Native navigation, as in the site header. */
import {SiteHeader} from '@/components/site-header';
import {SiteFooter} from '@/components/site-footer';

/** Route error state, in the same voice as the 404: the header and footer stay, one retry, two ways out. Display only. */
export default function RouteError({reset}:{error:Error&{digest?:string};reset:()=>void}){
 return <main className="shell product-page"><SiteHeader/><header className="product-title"><div><p className="eyebrow">error / this view stopped</p><h1>something went wrong<span className="gx-dot">.</span></h1><p>This view hit an error while loading. Try again, or open the launches.</p></div></header>
 <div className="product-actions"><button type="button" className="token-chip" onClick={()=>reset()}>Try again</button><a className="token-chip" href="/launches">Browse launches</a><a className="token-chip" href="/">Home</a></div><SiteFooter/></main>;
}
