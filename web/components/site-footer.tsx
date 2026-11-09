import {BUILD_COMMIT} from "@/lib/build-commit";
import {BRAND_ASSETS} from "@/lib/brand-assets";
/* eslint-disable @next/next/no-html-link-for-pages -- Preserve native site navigation. */
import Image from "next/image";
import {SITE} from "@/lib/site-config";
import {SILO_LINK_LABEL,SILO_URL} from "@/lib/grain-family";
import {AppearanceControl} from "@/components/appearance-control";

export function SiteFooter({textOnly=false,showResearchDisclaimer=true}:{textOnly?:boolean;showResearchDisclaimer?:boolean}={}) {
 return <footer className="gx-footer"><div className="gx-wrap">
  <div className="gx-footer-top">
   <div className="gx-footer-brand"><a href="/" className="gx-footer-logo" aria-label="grainpad home"><Image unoptimized className="gx-logo-light" src={BRAND_ASSETS.logoWordmark} width={375} height={96} alt=""/><Image unoptimized className="gx-logo-dark" src={BRAND_ASSETS.logoWordmarkDark} width={375} height={96} alt=""/></a><p className="gx-footer-family">grainpad is a product by grain.</p></div>
   <nav className="gx-footer-cols" aria-label="Footer">
    <div><span className="gx-label">product</span><a href="/launches">explore</a><a href="/launch">create a token</a><a href="/rooms">rooms</a><a href="/fees">creator desk</a><a href="/rewards">holder rewards</a>{!textOnly&&<a href="/lab">research lab</a>}<a className="gx-footer-sibling" href={SILO_URL} aria-label={SILO_LINK_LABEL}>silo<span className="gx-dot">.</span> wallet ↗</a></div>
    <div><span className="gx-label">proof</span><a href="/transparency">transparency</a><a href="/treasury">treasury</a><a href="/official">official addresses</a><a href="/authority">who controls what</a><a href="/platform">platform status</a><a href="/roadmap">roadmap</a></div>
    <div><span className="gx-label">elsewhere</span><a href={SITE.twitter} target="_blank" rel="noreferrer">x</a><a href={SITE.discord} target="_blank" rel="noreferrer">discord</a><a href={SITE.github} target="_blank" rel="noopener noreferrer">GitHub</a><a href="/docs">docs</a><a href="/docs#faq">wallets &amp; faq</a><a href="/markets/wxmr">wXMR market</a></div>
   </nav>
  </div>
  <div className="gx-footer-appearance"><AppearanceControl/></div>
  <div className="gx-footer-bottom">
   <span>independent by design · token launch tools · separate monero research{showResearchDisclaimer&&<> · not affiliated with the original p/xmr project</>} · charts by <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView</a></span>
   <span>{BUILD_COMMIT&&<><span title={BUILD_COMMIT}>build · {BUILD_COMMIT.slice(0,12)}</span> · </>}<a href="#main-content">back to top ↑</a></span>
  </div>
 </div></footer>;
}
