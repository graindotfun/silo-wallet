'use client';
/* eslint-disable @next/next/no-img-element -- Packaged wallet logos, no external image optimizer. */
/**
 * Full-screen money animation (send / transfer and conversion). COSMETIC ONLY: it renders from state and never drives it.
 *
 * Props contract
 *   kind    'send' | 'conversion' | 'entry'   caption verb: "sending." or "exchanging."; 'entry' is the first-visit welcome (no payment, phase 'pending' only drives the dot)
 *   assets  string[]                ONLY the assets involved (['sol','xmr'] for SOL to XMR, ['usdc'] for a USDC send)
 *   phase   'pending' | 'done' | 'error'
 *   onDismiss  () => void           called on tap, tap-outside or Escape; the parent unmounts it. The real status view stays.
 *
 * Phase mapping (computed by lib/silo/money-animation.mjs, from the states the existing views already use)
 *   conversion: conversionMoneyPhase(record.state, {receiptConfirmed, destinationIsXmr})
 *     done    only when conversionProgress(...).done (settled; XMR payout also needs the wallet's own receipt)
 *     error   expired, provider-failed, refund-reported, refund-confirmed, wallet-retired
 *     pending everything else (waiting, deposit-*, provider-*, payout-reported, unknown)
 *   Solana send (silo-solana-transfer.tsx, wired): solanaSendMoneyPhase({sent,pending,outcome,status})
 *   Monero send (silo-native-zone.tsx, NOT wired here): xmrSendMoneyPhase({attempted:draft.attempted, failed:draft.failed,
 *     checkedInclusion:submission.checkedInclusion, error:Boolean(error)}); mount when draft.attempted turns true in this
 *     session, next to the existing `draft&&sent` section; 'done' only for submission.checkedInclusion.
 * A parent should keep its own "dismissed" flag (see useSiloMoneyAnimationDismiss) so a dismissed overlay does not return.
 */
import {useCallback,useEffect,useRef,useState} from 'react';
import {moneyCaption,moneyCoins,type MoneyPhaseName} from '@/lib/silo/money-animation.mjs';

/* Root cause of the 3 Nov iPhone dark ellipse: the wallet shell's `.silo-app .silo-wallet-controls button` rule (and its hover fill) restyled the full-screen dismiss button. Fixed in silo.css and covered by tests/silo-money-animation-shell-ui.test.mjs. */
export const MONEY_ANIMATION_ENABLED=true;
export type SiloMoneyAnimationProps={kind:'send'|'conversion'|'entry';assets:string[];phase:'pending'|'done'|'error';onDismiss:()=>void};
// Fixed layout of six coins: horizontal slot, size (px), fall time (s), start delay (s), spin time (s), resting tilt (deg).
const SLOTS=[[14,64,9,0,6,-14],[70,84,11,1.2,7,10],[42,52,8,3.1,5,-6],[86,60,10,4.4,6.5,16],[26,76,12,5.6,7.5,-18],[58,56,9.5,7,5.5,8]] as const;
const RIM=[-3,-2,-1,0,1,2,3];
// Two coins are not on rails: they fall under gravity, land on the headline and caption and bounce off them (soft, one or
// two bounces, then they roll off and leave). Same feel as the video toolkit's physics.js (one gravity, squash on landing,
// no repeated oscillation). They are cosmetic, pointer-events none, capped at two, and not run at all under reduced motion.
const HITTERS=[4,5] as const;
const PHYS={g:2600,restitution:.5,slide:70,respawn:[0,900],drops:[.3,.62]} as const;

export function useSiloMoneyAnimationDismiss(key:string|null){
 const [dismissedKey,setDismissed]=useState<string|null>(null);
 const dismiss=useCallback(()=>setDismissed(key),[key]);
 return {visible:key!==null&&dismissedKey!==key,dismiss};
}

function useCoinCollisions(root:React.RefObject<HTMLDivElement|null>,count:number,active:boolean){
 useEffect(()=>{
  const box=root.current;if(!box||!active||count===0)return;
  if(typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const coins=[...box.querySelectorAll<HTMLElement>('[data-hitter]')];if(!coins.length)return;
  const word=box.querySelector<HTMLElement>('.silo-money-word'),hint=box.querySelector<HTMLElement>('.silo-money-hint');
  const state=coins.map((el,i)=>({el,r:parseFloat(el.dataset.size??'56')/2,x:0,y:0,vx:0,vy:0,wait:PHYS.respawn[i%2]/1000,live:false,hits:0,i}));
  let last=0,raf=0,nudge=0;
  const place=(c:typeof state[number],width:number)=>{c.x=width*PHYS.drops[c.i%2];c.y=-c.r*2;c.vx=(c.i%2?-1:1)*PHYS.slide*.4;c.vy=0;c.live=true;c.hits=0;};
  const bump=()=>{if(!word)return;word.style.translate='0 5px';clearTimeout(nudge);nudge=window.setTimeout(()=>{word.style.translate='';},110);};
  const frame=(now:number)=>{
   raf=requestAnimationFrame(frame);
   if(document.hidden){last=now;return;}
   const dt=Math.min(.033,last?(now-last)/1000:.016);last=now;
   const b=box.getBoundingClientRect(),rects=[word,hint].filter(Boolean).map(el=>{const r=el!.getBoundingClientRect();return {l:r.left-b.left,t:r.top-b.top,r:r.right-b.left,b:r.bottom-b.top};});
   for(const c of state){
    if(!c.live){c.wait-=dt;if(c.wait<=0)place(c,b.width);else{c.el.style.opacity='0';continue;}}
    c.vy+=PHYS.g*dt;c.x+=c.vx*dt;c.y+=c.vy*dt;
    for(const r of rects){
     if(c.vy>0&&c.x>r.l-c.r*.4&&c.x<r.r+c.r*.4&&c.y+c.r>=r.t&&c.y+c.r-c.vy*dt<=r.t+4&&c.hits<2){
      c.y=r.t-c.r;c.vy=-c.vy*PHYS.restitution;c.vx+=(c.i%2?-1:1)*PHYS.slide;c.hits+=1;bump();break;
     }
    }
    if(c.y>b.height+c.r*2){c.live=false;c.wait=1.6+c.i*.7;}
    c.el.style.opacity='1';c.el.style.transform=`translate3d(${c.x-c.r}px,${c.y-c.r}px,0)`;
   }
  };
  raf=requestAnimationFrame(frame);
  return()=>{cancelAnimationFrame(raf);clearTimeout(nudge);if(word)word.style.translate='';};
 },[root,count,active]);
}

/** The typographic apostrophe gets its own span so the gap to the next letter can be tightened (the font spaces it widely). */
function withApostrophe(text:string){return text.split('\u2019').flatMap((part,index)=>index===0?[part]:[<span key={index} className="silo-money-apos">{'\u2019'}</span>,part]);}

function SiloMoneyAnimationView({kind,assets,phase,onDismiss}:SiloMoneyAnimationProps){
 const root=useRef<HTMLDivElement>(null);
 const caption=moneyCaption(kind,phase as MoneyPhaseName);
 const words=caption.text.split(' ');
 const coins=phase==='error'?[]:moneyCoins(assets,6);
 useCoinCollisions(root,coins.length,phase!=='error');
 useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==='Escape')onDismiss();};document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);},[onDismiss]);
 const layer=(front:boolean)=><div className="silo-money-coins" data-layer={front?'front':'back'} aria-hidden="true">{coins.filter(coin=>!(HITTERS as readonly number[]).includes(coin.index)&&(coin.index%2===1)===front).map(coin=>{const [x,size,fall,delay,spin,tilt]=SLOTS[coin.index];
   return <span key={coin.index} className="silo-money-coin" data-asset={coin.asset} style={{'--x':`${x}%`,'--s':`${size}px`,'--fall':`${fall}s`,'--delay':`${delay}s`,'--spin':`${spin}s`,'--tilt':`${tilt}deg`,'--y':`${8+coin.index*15}%`} as React.CSSProperties}>
    <span className="silo-money-disc">
     {RIM.map(k=><i key={k} className="silo-money-rim" style={{'--k':k} as React.CSSProperties}/>)}
     <span className="silo-money-face silo-money-front"><img src={coin.src??''} alt="" width={64} height={64} draggable={false}/></span>
     <span className="silo-money-face silo-money-back"><img src={coin.src??''} alt="" width={64} height={64} draggable={false}/></span>
    </span></span>;})}</div>;
 return <div className="silo-money" ref={root} data-phase={phase} data-kind={kind} role="status" aria-live="polite">
  {layer(false)}
  <p className="silo-money-text" key={phase}><span className="silo-money-word">{withApostrophe(words.slice(0,-1).join(' '))}{words.length>1?' ':''}<span className="silo-money-last">{words[words.length-1]}{kind==='entry'?<span className="silo-money-bang" role="img" aria-label="!"><svg viewBox="0 0 24 100" focusable="false" aria-hidden="true"><rect className="silo-money-stem" x="3" y="0" width="18" height="64" rx="9"/><circle className="silo-money-bang-dot" cx="12" cy="88" r="11"/></svg></span>:phase==='pending'?<span className="silo-money-wait" aria-hidden="true">{[0,1,2].map(index=><i key={index} className="silo-money-dot silo-money-wait-dot" data-n={index}>.</i>)}</span>:<i className="silo-money-dot">.</i>}</span></span><span className="silo-money-hint">{caption.hint}</span></p>
  <div className="silo-money-coins" data-layer="hit" aria-hidden="true">{coins.filter(coin=>(HITTERS as readonly number[]).includes(coin.index)).map(coin=>{const size=SLOTS[coin.index][1];
   return <span key={coin.index} data-hitter="" data-size={size} className="silo-money-coin silo-money-coin-phys" data-asset={coin.asset} style={{'--s':`${size}px`,'--spin':`${SLOTS[coin.index][4]}s`,'--tilt':`${SLOTS[coin.index][5]}deg`,opacity:0} as React.CSSProperties}>
    <span className="silo-money-disc">
     {RIM.map(k=><i key={k} className="silo-money-rim" style={{'--k':k} as React.CSSProperties}/>)}
     <span className="silo-money-face silo-money-front"><img src={coin.src??''} alt="" width={64} height={64} draggable={false}/></span>
     <span className="silo-money-face silo-money-back"><img src={coin.src??''} alt="" width={64} height={64} draggable={false}/></span>
    </span></span>;})}</div>
  {layer(true)}
  <button type="button" className="silo-money-dismiss" onClick={onDismiss} aria-label={kind==='entry'?'Welcome to the Silo beta. Continue':phase==='pending'?'Close animation. Your payment status stays on the page.':'Close animation and see the status'}/>
 </div>;
}

export function SiloMoneyAnimation(props:SiloMoneyAnimationProps&{forceEnabled?:boolean}){
 const {forceEnabled,...rest}=props;
 return MONEY_ANIMATION_ENABLED||forceEnabled?<SiloMoneyAnimationView {...rest}/>:null;
}
