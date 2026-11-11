/* eslint-disable @next/next/no-img-element -- Supplied local SVG brand artwork. */
import type {Metadata,Viewport} from 'next';
import {env} from 'cloudflare:workers';
import {SiloWorkspace} from '@/components/silo-workspace';
import {siloAccountRuntimeAvailable} from '@/lib/silo/sync/account-environment.mjs';
import {siloPaymentAuthority} from '@/lib/silo/payment-authority.mjs';
import {siloAccountSender} from '@/lib/silo/sync/account-email.mjs';
import {siloConfiguration} from '@/lib/silo/config.mjs';
import {siloLaunchpadBase} from '@/lib/silo/wallet-host.mjs';
import {siloEvmChainStatus} from '@/lib/silo/evm.mjs';
import {siloUnsignedPreviewEnabled} from '@/lib/silo/jupiter-preview-unsigned.mjs';
import {BUILD_COMMIT} from '@/lib/build-commit';
import {SILO_TAGLINE,SILO_TAGLINE_LINES} from '@/lib/silo-brand';
import xmr from '@/lib/silo/xmr-sdk-manifest.json';
import zec from '@/lib/silo/zec-sdk-manifest.json';
import '../scan/exposure.css';
import './silo.css';
import './silo-mask.css';
import './silo-grainy.css';
export const metadata:Metadata={title:`silo · ${SILO_TAGLINE}`,description:SILO_TAGLINE,robots:{index:false,follow:false},referrer:'no-referrer',icons:{icon:'/brand/silo-symbol.svg',shortcut:'/brand/silo-symbol.svg'}};
/* The wallet is a fixed app screen: no pinch or focus zoom (owner, 3 November 2026). */
export const viewport:Viewport={width:'device-width',initialScale:1,maximumScale:1,userScalable:false,viewportFit:'cover'};
export const dynamic='force-dynamic';
export default function SiloPage(){
 const values=env as unknown as Record<string,string>;
 const config=siloConfiguration(values,{commit:BUILD_COMMIT,assets:{xmr,zec},origin:values.SILO_ORIGIN});
 if(!config.flags.silo)return <main className="exposure-shell exposure-main"><img src="/brand/silo-logo-dark.svg" alt="Silo" width={168} height={58}/><p className="exposure-eyebrow">Grain Silo · Beta</p><h1>{SILO_TAGLINE_LINES[0]}<br/>{SILO_TAGLINE_LINES[1]}</h1><p className="exposure-intro">A wallet for Solana and Monero, open to everyone in beta. It handles real funds, so start with small amounts.</p><p>The wallet lives on silo.trading, not on this page.</p><a href="https://silo.trading/" rel="noopener">Open Silo at silo.trading</a> <a href="/scan">Explore Field Scan</a></main>;
 // Only whether each EVM chain is configured reaches the page; endpoints and keys stay on the server.
 const accountEnv=env as unknown as Record<string,unknown>;
 const accountEnabled=siloAccountRuntimeAvailable(accountEnv,{sendOTP:siloAccountSender(accountEnv),origin:values.SILO_ORIGIN});
 const accountNewWalletEnabled=accountEnabled&&values.SILO_ACCOUNT_NEW_WALLET_REVIEW_ENABLED==='true'&&values.SILO_ORIGIN==='https://review-retired.invalid';
 // Who vouches for a mainnet payment (review N1): the account vault when sync is on, this device alone in the closed beta, otherwise nobody.
 const paymentAuthority=siloPaymentAuthority(values,{accountRuntime:accountEnabled});
 // Owner, 29 Oct 2026: a private acceptance deployment must be unmistakable in the UI itself, not only behind the
 // Basic Auth gate -- this is mainnet and real money, never a sandbox. SILO_ACCEPTANCE_ENVIRONMENT is set ONLY on
 // the separate grain-silo-acceptance Worker, never on grain-silo or silo.trading.
 const acceptanceBanner=values.SILO_ACCEPTANCE_ENVIRONMENT==='true'?<div className="silo-acceptance-banner" role="alert">⚠ Private acceptance environment — mainnet, real money. Not the public beta.</div>:null;
 return <>{acceptanceBanner}<SiloWorkspace paymentAuthority={paymentAuthority} accountNewWalletEnabled={accountNewWalletEnabled} accountEnabled={accountEnabled} configuration={config} launchpad={siloLaunchpadBase(values.SILO_ORIGIN)} evmChains={siloEvmChainStatus(values)} previewEnabled={siloUnsignedPreviewEnabled(values,values.SILO_ORIGIN)}/></>;
}
