import {SITE} from "@/lib/site-config";
import {BRAND_CHAIN} from "@/lib/brand-presentation";
import {BRAND_ASSETS} from "@/lib/brand-assets";
import type { Metadata } from "next";
import "./globals.css";
import "./brand.css";
import "./genesis.css";
import "./claim-wallet.css";
import "./token-tape.css";
import "./theme.css";
import "./themes.css";
import "./premium.css";
import "./token-market.css";
import "./token-discovery.css";
import "./product-workspace.css";
import "./grain-system.css";
import "./token-page.css";
import "./wallet-ux.css";
import "./wallet-picker.css";
import "./readability.css";
import "./profile.css";
import "./rewards-calculator.css";
import "./price-tab.css";
import "./grains.css";
import {ChainContextChrome} from "@/components/chain-context-chrome";
import {trackerReleased} from "@/lib/utility-rewards-tracker/server";

export const metadata: Metadata = {
  title: "grainpad. ideas into existence.",
  description: `A considered start for your next token. Explore clear ${BRAND_CHAIN.label} launch conditions and create from your own wallet.`,
  metadataBase: new URL(SITE.origin),
  openGraph: {title:"grainpad. ideas into existence.", description:`Create your token on ${BRAND_CHAIN.label}. Review the conditions. Your wallet. Your call.`, type:"website", url:SITE.origin, images:[{url:"/brand/grainpad-social-ideas-20261103.jpeg",width:1500,height:500,alt:"grainpad logo and wordmark with the tagline ideas into existence, beside Monero, Solana and USDC coins."}]},
  twitter: {card:"summary_large_image", site:"@GrainXMR", title:"grainpad. ideas into existence.", description:`A considered start for your next token on ${BRAND_CHAIN.label}.`, images:["/brand/grainpad-social-ideas-20261103.jpeg"]},
  icons: {
    icon: BRAND_ASSETS.favicon,
    shortcut: BRAND_ASSETS.favicon,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="light" data-rewards-tracker={trackerReleased()?"v1":undefined} suppressHydrationWarning>
      <head>
        <link rel="preload" href="/fonts/albert-sans-latin-variable.woff2" as="font" type="font/woff2" crossOrigin="anonymous" fetchPriority="high"/>
        <meta name="theme-color" content="#ffffff"/>
        {/* eslint-disable-next-line @next/next/no-sync-scripts -- Tiny same-origin theme initializer must run before paint to prevent theme flash. */}
        <script src="/theme-init.js"/>
        <script src="/kernel.js" defer/>
      </head>
      <body className="antialiased"><ChainContextChrome slot="contract"/>{children}<ChainContextChrome slot="prices"/></body>
    </html>
  );
}
