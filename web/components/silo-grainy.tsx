'use client';
import {useCallback,useEffect,useId,useRef,useState,useSyncExternalStore,type FormEvent} from 'react';
import {GRAINY_TOUR,GRAINY_TOPICS,GRAINY_SECRET_WARNING,GRAINY_NO_EMAIL_NOTE,GRAINY_SUPPORT_EMAIL,GRAINY_MESSAGE_MAX,GRAINY_CONTACT_MAX,grainyTopicForHash,grainyTourSeen,grainyMarkTourSeen,grainySupportRequest,grainyMailto} from '@/lib/silo/grainy-content.mjs';
type Panel='closed'|'tour'|'help'|'support';
type SupportState={kind:'idle'}|{kind:'sending'}|{kind:'sent'}|{kind:'fallback';message:string}|{kind:'error';reason:string};
const BOX_W=60,BOX_H=45,ROLL_MS=480;
const subscribeHash=(changed:()=>void)=>{window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);};
const dot=<i className="grainy-dot">.</i>;
/** Grainy: the orange Grain from Grainpet (grain-core.js, mori silhouette) with happy closed eyes, blush and a smile. No outline. */
export function GrainyFace({size=40,heart=false}:{size?:number;heart?:boolean}){
 const clip=useId().replace(/:/g,'');
 const body='M181.3 106.4Q196 96 212.0 104.2L336.0 167.8Q352 176 360.7 191.8L421.3 302.2Q430 318 414.4 327.0L297.6 395.0Q282 404 264.0 402.8L154.0 395.2Q136 394 126.5 378.7L87.5 315.3Q78 300 82.9 282.7L115.1 167.3Q120 150 134.7 139.6Z';
 return <svg className="grainy-face" width={size} height={size*0.9} viewBox="50 70 420 360" aria-hidden="true" focusable="false">
  <defs><clipPath id={clip}><path d={body}/></clipPath></defs>
  <path d={body} fill="rgb(from var(--grain-orange) calc(r*217/255) calc(g*78/102) 0)"/>
  <g clipPath={`url(#${clip})`}><path d={body} fill="var(--grain-orange)" transform="translate(-6 -16)"/></g>
  <path d="M104 190 L132 150 L196 112" fill="none" stroke="rgb(from var(--grain-orange) r calc(g*148/102) 71)" strokeWidth="14" strokeLinecap="round" strokeLinejoin="round"/>
  <g fill="none" stroke="#1a1714" strokeWidth="13" strokeLinecap="round"><path d="M178 262Q204 232 230 262"/><path d="M290 262Q316 232 342 262"/><path d="M236 305Q262 330 288 305"/></g>
  <g fill="#ff8a9a"><ellipse cx="172" cy="306" rx="26" ry="15"/><ellipse cx="348" cy="306" rx="26" ry="15"/></g>
  {heart&&<path d="M424 100c-18-22-46-4-30 18 8 10 20 18 30 26 10-8 22-16 30-26 16-22-12-40-30-18z" fill="#ff6f9c" transform="translate(-4 -6) scale(.95)"/>}
 </svg>;
}
type Cue={name:string;n:number};
type Runtime={R:Art;g:{play:(name:string,options?:object)=>boolean;can:(name:string)=>boolean;state:string;destroy:()=>void}};
type Art={tick:(dt:number)=>void;create:(el:SVGGElement,options:object)=>Runtime['g']};
type Spot={x:number;y:number;rot:number;go:boolean};
type Rect={top:number;left:number;right:number;bottom:number};
let artLoad:Promise<Art>|null=null;
const loadArt=()=>artLoad??(artLoad=import('@/lib/silo/grainy-art.generated.mjs').then(module=>module.loadGrainRuntime() as unknown as Art));
const reducedMotion=()=>{try{return matchMedia('(prefers-reduced-motion: reduce)').matches;}catch{return false;}};
/** A grain from Grainpet: grain-core.js and grain-runtime.js (runtime 2.1.0; mori, nori, pip, rolo or peb), bundled with the app by
 * scripts/silo/build-grainy-art.mjs. It rests with its own idle loop and plays the cue it is given (hop, happy, curious, refuse,
 * tired, wake). With reduced motion it shows the resting frame and plays nothing; if the art cannot load, the still face stays. */
function GrainyCharacter({characterId,cue,heart}:{characterId:string;cue:Cue;heart:boolean}){
 const group=useRef<SVGGElement|null>(null),runtime=useRef<Runtime|null>(null),reduced=useRef(false),[art,setArt]=useState<Art|null>(null),[drawn,setDrawn]=useState('');
 useEffect(()=>{let stopped=false;reduced.current=reducedMotion();loadArt().then(loaded=>{if(!stopped)setArt(loaded);}).catch(()=>{/* the still face stays */});return()=>{stopped=true;};},[]);
 useEffect(()=>{
  if(!art||!group.current)return;
  const g=art.create(group.current,{characterId,x:0,ground:0,scale:1,layers:{shadow:false}});runtime.current={R:art,g};setDrawn(characterId);
  return()=>{g.destroy();runtime.current=null;};
 },[art,characterId]);
 useEffect(()=>{
  if(!art||reduced.current)return;
  let raf=0,last=0;const loop=(ts:number)=>{raf=requestAnimationFrame(loop);const dt=Math.min(0.05,(ts-(last||ts))/1000);last=ts;if(!document.hidden)art.tick(dt);};
  raf=requestAnimationFrame(loop);return()=>cancelAnimationFrame(raf);
 },[art]);
 useEffect(()=>{
  const current=runtime.current;if(!current||cue.n===0||reduced.current)return;
  const g=current.g;
  if(g.state==='asleep'){g.play('wake');return;}
  if(g.can(cue.name))g.play(cue.name,cue.name==='hop'?{dx:0}:{});
 },[cue]);
 return <>{!drawn&&<GrainyFace size={44} heart={heart}/>}<svg className="grainy-face" data-ready={drawn?'true':undefined} data-char={drawn||undefined} width={BOX_W} height={BOX_H} viewBox="-230 -300 460 330" aria-hidden="true" focusable="false" style={drawn?undefined:{display:'none'}}><g ref={group}/></svg></>;
}
const THEME_TOKENS:[string,string][]=[['--g-panel','--silo-panel'],['--g-field','--silo-field'],['--g-line','--silo-line-strong'],['--g-control','--silo-control-line'],['--g-text','--silo-text'],['--g-text-2','--silo-text-2'],['--g-ink','--silo-on-primary'],['--g-warn-bg','--silo-warn-bg'],['--g-warn-line','--silo-warn-line'],['--g-danger','--silo-danger']];
/** Grainy sits beside the wallet, outside its themed element, so it reads the wallet's own colours (light or dark, as the person
 * chose) and falls back to the dark defaults in the stylesheet. */
function useWalletColours(){
 const [style,setStyle]=useState<Record<string,string>>({});
 useEffect(()=>{
  const read=()=>{const app=document.querySelector('.silo-app');if(!app){setStyle({});return;}const computed=getComputedStyle(app),next:Record<string,string>={};for(const [mine,theirs] of THEME_TOKENS){const value=computed.getPropertyValue(theirs).trim();if(value)next[mine]=value;}const primary=computed.getPropertyValue('--silo-primary').trim();if(primary)next['--g-primary']=primary;setStyle(next);};
  read();const changed=()=>requestAnimationFrame(read);
  window.addEventListener('silo-display-theme-changed',changed);window.addEventListener('storage',changed);
  let media:MediaQueryList|null=null;try{media=matchMedia('(prefers-color-scheme: light)');media.addEventListener('change',changed);}catch{/* no media query */}
  const app=document.querySelector('.silo-app');const watch=app?new MutationObserver(changed):null;if(app&&watch)watch.observe(app,{attributes:true,attributeFilter:['data-theme']});
  return()=>{window.removeEventListener('silo-display-theme-changed',changed);window.removeEventListener('storage',changed);media?.removeEventListener('change',changed);watch?.disconnect();};
 },[]);
 return style;
}
/** Finds the wallet menu Grainy rolls up to, by what the menu says. A missing menu returns null and Grainy goes to its corner. */
function menuFor(target:string):HTMLElement|null{
 if(target==='corner'||(target==='swap'&&window.innerWidth<700))return null;
 const label=target==='home'?'Home':target==='swap'?'Swap':target==='settings'?'Settings':'';
 const items=Array.from(document.querySelectorAll<HTMLElement>('nav button, nav a, [role=tablist] button'));
 return items.find(item=>item.textContent?.trim()===label&&item.getBoundingClientRect().width>0)??null;
}
/** A banner or card a target sits inside: Grainy is masked to it, so it comes out of its edge instead of appearing from nowhere. */
function maskFor(item:HTMLElement):Rect|null{
 const holder=item.closest<HTMLElement>('[data-grainy-mask],.silo-beta-banner,.silo-network-band,.silo-hold');
 if(!holder)return null;const box=holder.getBoundingClientRect();return {top:box.top,left:box.left,right:box.right,bottom:box.bottom};
}
/** How far above the bottom edge Grainy's corner sits: above the phone's tab bar (measured, so a taller bar or the iPhone bottom inset is cleared). */
function cornerBottom(){const bar=document.querySelector('.silo-view-tabs');return window.innerWidth<700?(bar?Math.max(0,window.innerHeight-bar.getBoundingClientRect().top)+8:76):16;}
function cornerPosition(){return {x:window.innerWidth<700?Math.max(8,window.innerWidth-BOX_W-16):16,y:Math.max(8,window.innerHeight-BOX_H-cornerBottom()-8)};}
const wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const frames=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
/** The Silo helper. During the first-visit tour a different grain rolls out of the screen (or out of the banner it stands in) and
 * rolls in beside each wallet menu it talks about; Grainy then settles in the bottom left corner as the help and support button.
 * It reads only the page's own hash and menu positions, never wallet data, and it never blocks a money flow: it hides behind any
 * open dialog, and closes with one tap or Escape. */
export function SiloGrainy(){
 const colours=useWalletColours();
 const [panel,setPanel]=useState<Panel>('closed'),[step,setStep]=useState(0),[topic,setTopic]=useState('start'),[support,setSupport]=useState<SupportState>({kind:'idle'});
 const [message,setMessage]=useState(''),[contact,setContact]=useState(''),[spot,setSpot]=useState<Spot|null>(null),[mask,setMask]=useState<Rect|null>(null),[who,setWho]=useState('mori'),[cue,setCue]=useState<Cue>({name:'idle',n:0});
 const [,setResized]=useState(0),[hidden,setHidden]=useState(()=>{try{return sessionStorage.getItem('silo-grainy-hidden')==='1';}catch{return false;}});
 const hide=useCallback(()=>{try{sessionStorage.setItem('silo-grainy-hidden','1');}catch{/* storage blocked: hidden for this view only */}setHidden(true);},[]);
 const hash=useSyncExternalStore(subscribeHash,()=>location.hash,()=>''),mounted=useSyncExternalStore(()=>()=>{},()=>true,()=>false);
 const shown=spot??(mounted?{...cornerPosition(),rot:0,go:false}:null),lift=mounted?cornerBottom():16;
 const button=useRef<HTMLButtonElement|null>(null),sheet=useRef<HTMLDivElement|null>(null),firstHash=useRef(true),spotRef=useRef<Spot|null>(null),maskRef=useRef<Rect|null>(null),whoRef=useRef('mori'),token=useRef(0);
 // The helper never covers a tappable control (6 Nov 2026: it sat over the SOL pill of the Convert card on a phone). While it would overlap
 // any control of the page it steps out of sight, and it returns when the spot is free; the sheet and its own dock are untouched.
 useEffect(()=>{
  if(!mounted)return;let frame=0;
  const check=()=>{frame=0;const fab=button.current;if(!fab)return;
   const box=fab.getBoundingClientRect(),narrow=window.innerWidth<700;let covering=false;
   if(narrow&&box.width>0&&panel==='closed')for(const node of document.querySelectorAll('.silo-main a,.silo-main button,.silo-main input,.silo-main select,.silo-main textarea,.silo-main summary,.silo-main [role=radio],.silo-main [role=option]')){
    if(node.closest('.silo-view-tabs,[inert],.sr-only'))continue;const r=node.getBoundingClientRect();
    if(r.width>0&&r.height>0&&r.left<box.right-6&&r.right>box.left+6&&r.top<box.bottom-6&&r.bottom>box.top+6){covering=true;break;}
   }
   if(covering)fab.setAttribute('data-covering','true');else fab.removeAttribute('data-covering');};
  const queue=()=>{if(!frame)frame=requestAnimationFrame(check);};
  window.addEventListener('scroll',queue,true);window.addEventListener('resize',queue);const timer=window.setInterval(queue,400);queue();
  return()=>{window.removeEventListener('scroll',queue,true);window.removeEventListener('resize',queue);window.clearInterval(timer);if(frame)cancelAnimationFrame(frame);};
 },[mounted,panel,hash]);
 const say=useCallback((name:string)=>setCue(previous=>({name,n:previous.n+1})),[]);
 const put=useCallback((next:Spot)=>{spotRef.current=next;setSpot(next);},[]);
 /** Resting place: anchored by CSS to the viewport corner (right and bottom), so a moving iOS toolbar or a changed height never leaves it floating mid-page. */
 const rest=useCallback(()=>{spotRef.current=null;setSpot(null);},[]);
 const holdMask=useCallback((next:Rect|null)=>{maskRef.current=next;setMask(next);},[]);
 const holdWho=useCallback((next:string)=>{whoRef.current=next;setWho(next);},[]);
 /** Roll out of the frame (or the banner), swap grains while out of sight, roll in to the target. Resolves false when a newer move took over. */
 const moveTo=useCallback(async(target:{x:number;y:number},options:{mask?:Rect|null;grain?:string}={}):Promise<boolean>=>{
  const mine=++token.current,from=spotRef.current??{...cornerPosition(),rot:0,go:false},grain=options.grain??whoRef.current,nextMask=options.mask??null;
  const same=from&&Math.abs(from.x-target.x)<3&&Math.abs(from.y-target.y)<3&&grain===whoRef.current&&!nextMask&&!maskRef.current;
  if(same)return true;
  if(reducedMotion()){holdMask(nextMask);holdWho(grain);put({x:target.x,y:target.y,rot:0,go:false});return true;}
  const view={top:0,left:0,right:window.innerWidth,bottom:window.innerHeight},out=maskRef.current??view;
  const outDir=from.x+BOX_W/2<(out.left+out.right)/2?-1:1,outX=outDir<0?out.left-BOX_W-12:out.right+12;
  put({x:outX,y:from.y,rot:from.rot+outDir*(Math.abs(outX-from.x)/BOX_W)*130,go:true});
  await wait(ROLL_MS);if(token.current!==mine)return false;
  const entry=nextMask??view,inDir=target.x+BOX_W/2<(entry.left+entry.right)/2?-1:1,inX=inDir<0?entry.left-BOX_W-12:entry.right+12,rolled=spotRef.current?.rot??0;
  holdMask(nextMask);holdWho(grain);put({x:inX,y:target.y,rot:rolled,go:false});
  await frames();if(token.current!==mine)return false;
  /* Grainy rolls in proportion to the distance, so he used to stop at any angle (even upside down): finish on a whole turn so he always stands upright. */
  put({x:target.x,y:target.y,rot:Math.round((rolled+(target.x>=inX?1:-1)*(Math.abs(target.x-inX)/BOX_W)*130)/360)*360,go:true});
  await wait(ROLL_MS+60);return token.current===mine;
 },[put,holdMask,holdWho]);
 const settle=useCallback(()=>{void moveTo(cornerPosition(),{grain:'mori'}).then(arrived=>{if(arrived){rest();say('hop');}});},[moveTo,say,rest]);
 const close=useCallback(()=>{setPanel('closed');settle();button.current?.focus({preventScroll:true});},[settle]);
 const startTour=useCallback(()=>{setStep(0);setPanel('tour');},[]);
 // After a resize Grainy goes back to its corner, unless the tour has a grain beside a menu.
 useEffect(()=>{const resize=()=>{setResized(count=>count+1);if(panel==='tour')return;holdMask(null);rest();};window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[panel,rest,holdMask]);
 // Each tour step: that step's grain rolls in beside the menu it talks about.
 useEffect(()=>{
  if(panel!=='tour')return;
  const def=GRAINY_TOUR[step],item=menuFor(def.target),mood=step===0||step===GRAINY_TOUR.length-1?'happy':'hop';
  let target=cornerPosition(),held:Rect|null=null;
  if(item){
   const box=item.getBoundingClientRect(),wide=box.width>180;held=maskFor(item);
   target={x:wide?Math.min(window.innerWidth-BOX_W-8,box.right+8):Math.max(8,Math.min(window.innerWidth-BOX_W-8,box.left+box.width/2-BOX_W/2)),y:wide?Math.max(8,box.top+box.height/2-BOX_H*0.5):Math.max(8,box.top-BOX_H-4)};
   if(held)target={x:Math.max(held.left+8,Math.min(held.right-BOX_W-8,target.x)),y:held.top+Math.max(0,(held.bottom-held.top-BOX_H)/2)};
  }
  const timer=setTimeout(()=>{void moveTo(target,{mask:held,grain:def.grain}).then(arrived=>{if(arrived)say(mood);});},0);
  return()=>clearTimeout(timer);
 },[panel,step,moveTo,say]);
 // A small hop whenever the wallet moves to another screen.
 useEffect(()=>{if(firstHash.current){firstHash.current=false;return;}say('hop');},[hash,say]);
 // Left alone for a minute, Grainy dozes; any tap or key wakes it.
 useEffect(()=>{let timer:ReturnType<typeof setTimeout>;const rest=()=>{clearTimeout(timer);timer=setTimeout(()=>say('tired'),60000);};const touched=()=>{rest();setCue(previous=>({name:'wake',n:previous.n+1}));};rest();window.addEventListener('pointerdown',touched);window.addEventListener('keydown',touched);return()=>{clearTimeout(timer);window.removeEventListener('pointerdown',touched);window.removeEventListener('keydown',touched);};},[say]);
 // First visit: once the welcome moment is over, show the tour. It is marked seen as soon as it is shown, so a reload never loops it.
 useEffect(()=>{
  let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,tries=0;
  const seen=(()=>{try{return grainyTourSeen(localStorage);}catch{return false;}})();
  if(seen)return;
  const attempt=()=>{if(stopped)return;if(document.querySelector('.silo-opening')&&tries++<30){timer=setTimeout(attempt,400);return;}
   try{grainyMarkTourSeen(localStorage);}catch{/* storage blocked: the tour may show again next visit */}
   setStep(0);setPanel('tour');};
  timer=setTimeout(attempt,700);
  return()=>{stopped=true;if(timer)clearTimeout(timer);};
 },[]);
 useEffect(()=>{if(panel==='closed')return;const node=sheet.current;if(node){node.scrollTop=0;node.focus({preventScroll:true});}},[panel,step]);
 useEffect(()=>{if(panel==='closed')return;const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')close();};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);},[panel,close]);
 function openHelp(){if(panel!=='closed'){close();return;}setTopic(grainyTopicForHash(hash));setSupport({kind:'idle'});setPanel('help');void moveTo(cornerPosition(),{grain:'mori'}).then(arrived=>{if(arrived){rest();say('curious');}});}
 async function submit(event:FormEvent){
  event.preventDefault();if(support.kind==='sending')return;
  const checked=grainySupportRequest({message,contact});
  if(!checked.ok){setSupport({kind:'error',reason:checked.reason??'Please check your message.'});say('refuse');return;}
  setSupport({kind:'sending'});
  try{
   const response=await fetch('/api/silo/support',{method:'POST',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:checked.message,contact:checked.contact})});
   if(response.status===400||response.status===429){const body=await response.json().catch(()=>null) as {error?:string}|null;setSupport({kind:'error',reason:body?.error??'The request was not accepted.'});return;}
   const body=response.ok?await response.json().catch(()=>null) as {sent?:boolean}|null:null;
   if(body?.sent===true){setMessage('');setContact('');setSupport({kind:'sent'});say('happy');}else setSupport({kind:'fallback',message:checked.message});
  }catch{setSupport({kind:'fallback',message:checked.message});}
 }
 const current=GRAINY_TOPICS.find(item=>item.id===topic)??GRAINY_TOPICS[0];
 const last=step>=GRAINY_TOUR.length-1;
 if(hidden)return null;
 return <div className="grainy" data-panel={panel} style={{...colours,'--grainy-lift':`${lift}px`} as React.CSSProperties}>
  <div className="grainy-stage" style={mask?{clipPath:`inset(${mask.top}px ${window.innerWidth-mask.right}px ${window.innerHeight-mask.bottom}px ${mask.left}px round 12px)`}:undefined}>
   <button ref={button} type="button" className="grainy-fab" data-go={shown?.go?'true':undefined} data-char={who} data-corner={spot?undefined:'true'} style={spot?{left:spot.x,top:spot.y}:mounted?undefined:{visibility:'hidden'}} onClick={openHelp} aria-label={panel==='closed'?'Help from Grainy':'Close Grainy'} aria-expanded={panel!=='closed'} aria-controls="grainy-sheet"><span className="grainy-hop" style={{transform:`rotate(${shown?.rot??0}deg)`}}><GrainyCharacter characterId={who} cue={cue} heart={panel==='tour'}/></span></button>
   {panel==='closed'&&!spot&&<button type="button" className="grainy-fab-x" onClick={hide} aria-label="Hide Grainy">×</button>}
  </div>
  {panel!=='closed'&&<div id="grainy-sheet" ref={sheet} tabIndex={-1} className="grainy-sheet" role="dialog" aria-label={panel==='tour'?'Grainy tour':panel==='support'?'Write to the team':'Grainy help'}>
   <header className="grainy-head"><strong>{panel==='tour'?GRAINY_TOUR[step].title:panel==='support'?'Write to the team':'Help'}{dot}</strong><button type="button" className="grainy-x" onClick={close} aria-label="Close">×</button></header>
   {panel==='tour'&&<>
    <p className="grainy-body">{GRAINY_TOUR[step].body}</p>
    <div className="grainy-dots" aria-hidden="true">{GRAINY_TOUR.map((_,index)=><span key={index} data-on={index===step?'true':undefined}/>)}</div>
    <div className="grainy-actions"><button type="button" className="grainy-link" onClick={close}>Skip</button>{step>0&&<button type="button" className="grainy-link" onClick={()=>setStep(step-1)}>Back</button>}<button type="button" className="grainy-primary" onClick={()=>last?close():setStep(step+1)}>{last?'Done':'Next'}</button></div>
   </>}
   {panel==='help'&&<>
    <div className="grainy-chips" role="tablist" aria-label="Help topics" onKeyDown={event=>{if(event.key!=="ArrowRight"&&event.key!=="ArrowLeft")return;event.preventDefault();const index=GRAINY_TOPICS.findIndex(item=>item.id===current.id),next=GRAINY_TOPICS[(index+(event.key==="ArrowRight"?1:GRAINY_TOPICS.length-1))%GRAINY_TOPICS.length];setTopic(next.id);requestAnimationFrame(()=>document.getElementById(`grainy-tab-${next.id}`)?.focus());}}>{GRAINY_TOPICS.map(item=><button key={item.id} id={`grainy-tab-${item.id}`} type="button" role="tab" tabIndex={item.id===current.id?0:-1} aria-selected={item.id===current.id} className="grainy-chip" onClick={()=>setTopic(item.id)}>{item.label}</button>)}</div>
    <div className="grainy-body" role="tabpanel"><h3>{current.label}</h3>{current.lines.map(line=><p key={line}>{line}</p>)}</div>
    <div className="grainy-actions"><button type="button" className="grainy-link" onClick={startTour}>Replay the tour</button><button type="button" className="grainy-primary" onClick={()=>{setSupport({kind:'idle'});setPanel('support');}}>Still stuck? Write to the team</button></div>
   </>}
   {panel==='support'&&<form className="grainy-form" onSubmit={submit} noValidate>
    <p className="grainy-warning" role="note"><strong>{GRAINY_SECRET_WARNING}</strong> We do not attach your wallet, addresses or balances to this message, and we do not keep it beyond forwarding it to the team.</p>
    {support.kind==='sent'?<p className="grainy-ok" role="status">Sent. The team reads every message.</p>:<>
     <label htmlFor="grainy-message">What do you need help with?</label>
     <textarea id="grainy-message" name="message" rows={4} maxLength={GRAINY_MESSAGE_MAX} value={message} onChange={event=>setMessage(event.target.value)} disabled={support.kind==='sending'}/>
     <label htmlFor="grainy-contact">Email for a reply (optional)</label>
     <input id="grainy-contact" name="contact" type="email" autoComplete="off" maxLength={GRAINY_CONTACT_MAX} value={contact} onChange={event=>setContact(event.target.value)} disabled={support.kind==='sending'}/>
     <p className="grainy-fine">{GRAINY_NO_EMAIL_NOTE}</p>
     {support.kind==='error'&&<p role="alert" className="grainy-error">{support.reason}</p>}
     {support.kind==='fallback'&&<p role="status" className="grainy-fallback">We could not send this from here. Email us at <a href={grainyMailto(support.message)}>{GRAINY_SUPPORT_EMAIL}</a> instead.</p>}
     <div className="grainy-actions"><button type="button" className="grainy-link" onClick={()=>setPanel('help')}>Back</button><button type="submit" className="grainy-primary" disabled={support.kind==='sending'}>{support.kind==='sending'?'Sending…':'Send to the team'}</button></div>
    </>}
    {support.kind==='sent'&&<div className="grainy-actions"><button type="button" className="grainy-primary" onClick={close}>Close</button></div>}
   </form>}
  </div>}
 </div>;
}
