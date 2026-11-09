'use client';
import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Delete,Grid3x3,Keyboard} from 'lucide-react';
import {PAD_KEYS,PAD_MODE_KEY,padEdit,padModeFor,padPaste,padRefusal} from '@/lib/silo/amount-pad.mjs';

/** Silo's own number pad for amount fields (5 Nov 2026, the r8 art direction: silo-send.html, silo-swap.html, amount.js).
 * Mounted once in the wallet; it serves every input marked data-amount-pad (data-decimals = the coin's decimals, data-symbol = its
 * ticker). UI input only: a key edits the field's text and hands it to the field's own change handler, exactly as typing would, so
 * parsing, limits and money rules are untouched. The field stays a real input (caret, selection, screen readers, hardware keys).
 * Touch screens get the pad (the phone keyboard stays closed: inputmode none); a mouse or trackpad types directly. The keyboard
 * switch brings the phone's own decimal keyboard back, and the choice is remembered. */
const FIELD='input[data-amount-pad]';
/* r8 Send (6 Nov 2026): a field with data-pad-slot gets the keys inside its own screen, in the element with that id, always shown while the
 * field is on screen (no dock, no toolbar). Optional slots `<id>-paste` and `<id>-kbd` receive the Paste and keyboard buttons. */
const INLINE='input[data-amount-pad][data-pad-slot]';
// Pressed look (display only): the key turns orange on touch-down and stays so for at least PAD_PRESS_MS, so even a quick tap shows.
function pressed(key:HTMLElement){key.dataset.pressedAt=String(performance.now());key.classList.add('is-pressed');}
function released(key:HTMLElement){const left=PAD_PRESS_MS-(performance.now()-Number(key.dataset.pressedAt??0));window.setTimeout(()=>key.classList.remove('is-pressed'),Math.max(0,left));}
const inlineField=()=>[...document.querySelectorAll<HTMLInputElement>(INLINE)].find(onScreen)??null;
const onScreen=(input:HTMLInputElement)=>input.isConnected&&!input.disabled&&input.getClientRects().length>0&&getComputedStyle(input).visibility!=='hidden';
export const PAD_PRESS_MS=140;
type Mode='pad'|'keyboard';

function writeField(input:HTMLInputElement,value:string){
 const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
 set?.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));
}
const remember=(mode:Mode)=>{try{localStorage.setItem(PAD_MODE_KEY,mode);}catch{/* the choice simply holds for this visit */}};
const decimalsOf=(input:HTMLInputElement)=>{const n=Number(input.dataset.decimals);return Number.isInteger(n)&&n>=0?n:12;};
const symbolOf=(input:HTMLInputElement)=>input.dataset.symbol||'This coin';

export function SiloAmountPad(){
 const [inline,setInline]=useState<{input:HTMLInputElement;slot:HTMLElement|null;paste:HTMLElement|null;kbd:HTMLElement|null}|null>(null),[coarse,setCoarse]=useState(false),[mode,setMode]=useState<Mode>('keyboard'),[field,setField]=useState<HTMLInputElement|null>(null);
 const [note,setNote]=useState(''),[said,setSaid]=useState(''),[switchAt,setSwitchAt]=useState<{top:number;left:number}|null>(null);
 const touched=useRef(0),last=useRef<HTMLInputElement|null>(null),dock=useRef<HTMLDivElement>(null),hold=useRef<{timer:number;held:boolean}>({timer:0,held:false}),sayTimer=useRef(0);
 useEffect(()=>{
  const query=window.matchMedia('(pointer:coarse)');
  const read=()=>{let saved:string|null=null;try{saved=localStorage.getItem(PAD_MODE_KEY);}catch{/* no storage: defaults */}setCoarse(query.matches);setMode(padModeFor({coarse:query.matches,saved}) as Mode);};
  read();query.addEventListener?.('change',read);return()=>query.removeEventListener?.('change',read);
 },[]);
 const padOn=coarse&&mode==='pad';

 // The phone keyboard must be told before focus: the inputmode is set on touch-down and again on focus (keyboard navigation).
 useEffect(()=>{
  const apply=(target:EventTarget|null)=>{const input=target instanceof Element?target.closest(FIELD):null;if(input instanceof HTMLInputElement)input.inputMode=padOn?'none':'decimal';return input;};
  // iOS cancels the focus when a field's inputmode changes during the tap itself (seen on the iPhone 16 Pro Max simulator: the first tap
  // on the amount did nothing). So every field gets its mode as soon as it appears; the touch-down pass below is only a fallback.
  const all=()=>{document.querySelectorAll(FIELD).forEach(input=>apply(input));setInline(current=>{const input=inlineField(),id=input?.dataset.padSlot??'',slot=input?document.getElementById(id):null,paste=slot?document.getElementById(`${id}-paste`):null,kbd=slot?document.getElementById(`${id}-kbd`):null;
   return !input?null:current&&current.input===input&&current.slot===slot&&current.paste===paste&&current.kbd===kbd?current:{input,slot,paste,kbd};});};all();
  let queued=0;const seen=new MutationObserver(()=>{if(!queued)queued=requestAnimationFrame(()=>{queued=0;all();});});
  // Views switch by attributes on the wallet root (data-view) and hidden panels, so those changes are watched too.
  seen.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-view','data-send-open','hidden','disabled']});
  const down=(event:PointerEvent)=>{apply(event.target);};
  const focus=(event:FocusEvent)=>{
   // The keys are not focusable (no tabindex: in WebKit a tabindex makes a tapped button take focus). Should iOS still focus a key on a
   // tap, focus goes straight back to the field (inputmode none keeps the phone keyboard closed). Only right after a touch on the dock,
   // so a hardware keyboard can still Tab through the page.
   if(event.target instanceof Node&&dock.current?.contains(event.target)){if(performance.now()-touched.current<800)last.current?.focus({preventScroll:true});return;}
   const input=apply(event.target);if(input instanceof HTMLInputElement){last.current=input;setField(input);setNote('');}};
  const blur=(event:FocusEvent)=>{const next=event.relatedTarget;if(next instanceof Node&&dock.current?.contains(next))return;
   window.setTimeout(()=>{const now=document.activeElement;if(!(now instanceof HTMLInputElement&&now.matches(FIELD)))setField(null);},0);};
  document.addEventListener('pointerdown',down,true);document.addEventListener('focusin',focus);document.addEventListener('focusout',blur);
  return()=>{seen.disconnect();cancelAnimationFrame(queued);document.removeEventListener('pointerdown',down,true);document.removeEventListener('focusin',focus);document.removeEventListener('focusout',blur);};
 },[padOn]);

 const open=padOn&&field!==null&&!field.disabled&&field.isConnected&&!field.matches(INLINE);
 // The in-screen pad serves its field whether or not it has focus yet: a key focuses it first.
 const showInline=padOn&&inline!==null&&(field===null||field===inline.input);
 const slot=showInline?inline.slot:null;
 // The field a key edits, read when the key is pressed: the focused docked field, else the in-screen one.
 const target=()=>field&&!field.matches(INLINE)?field:inlineField();

 // While the dock is up the page makes room for it and keeps the field, and the action it leads to (data-keyboard-keep, e.g. Convert),
 // above it; the tab bar and Grainy step aside (silo-themes.css).
 useLayoutEffect(()=>{
  const root=document.documentElement;
  if(!open||!field){delete root.dataset.amountPad;root.style.removeProperty('--silo-pad-h');return;}
  const height=dock.current?.getBoundingClientRect().height??0;root.dataset.amountPad='open';root.style.setProperty('--silo-pad-h',`${Math.ceil(height)}px`);
  // iOS also scrolls the focused field into view on its own, after this first pass (seen on the iPhone 16 Pro Max simulator: the field
  // ended above the screen). The same placement runs again once that settles; it corrects in both directions and the field always wins.
  const place=()=>{
   const dockTop=dock.current?.getBoundingClientRect().top??window.innerHeight-height;
   const head=field.closest('label')??field,box=head.getBoundingClientRect(),keep=field.closest('section,form')?.querySelector<HTMLElement>('[data-keyboard-keep]');
   // In a Safari tab iOS draws the page under the status bar; the wallet pads that area (.silo-app, safe-area-inset-top), so the field
   // stays below it.
   const app=field.closest('.silo-app'),top=Math.min(120,app?parseFloat(getComputedStyle(app).paddingTop)||0:0)+12;
   const bottom=dockTop-12,end=keep&&!keep.hidden?keep.getBoundingClientRect().bottom:field.getBoundingClientRect().bottom;
   let delta=0;if(end>bottom)delta=Math.min(end-bottom,box.top-top);else if(box.top<top)delta=box.top-top;
   if(Math.abs(delta)>1)window.scrollBy(0,delta);
  };
  const frame=requestAnimationFrame(place),timers=[150,500].map(ms=>window.setTimeout(place,ms));
  return()=>{cancelAnimationFrame(frame);timers.forEach(clearTimeout);};
 },[open,field]);
 useEffect(()=>()=>{const root=document.documentElement;delete root.dataset.amountPad;root.style.removeProperty('--silo-pad-h');},[]);

 // In keyboard mode on a touch screen a small switch sits at the end of the focused field to bring the pad back.
 const place=useCallback(()=>{if(!coarse||mode!=='keyboard'||!field||!field.isConnected){setSwitchAt(null);return;}const r=field.getBoundingClientRect();setSwitchAt({top:r.top+(r.height-44)/2,left:r.right-48});},[coarse,mode,field]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- the switch follows the field's position, measured from the page
 useEffect(()=>{place();const vv=window.visualViewport;window.addEventListener('scroll',place,true);window.addEventListener('resize',place);vv?.addEventListener('resize',place);vv?.addEventListener('scroll',place);
  return()=>{window.removeEventListener('scroll',place,true);window.removeEventListener('resize',place);vv?.removeEventListener('resize',place);vv?.removeEventListener('scroll',place);};},[place]);

 const announce=(input:HTMLInputElement,value:string)=>{window.clearTimeout(sayTimer.current);sayTimer.current=window.setTimeout(()=>setSaid(value?`${value} ${symbolOf(input)}`:'Amount cleared'),350);};
 const press=(key:string)=>{
  const input=target();if(!input)return;if(document.activeElement!==input)input.focus({preventScroll:true});const decimals=decimalsOf(input),start=input.selectionStart??input.value.length,end=input.selectionEnd??start;
  const result=padEdit(input.value,start,end,key,decimals) as {value:string;caret:number;refused?:string};
  if(result.refused){setNote(padRefusal(result.refused,decimals,symbolOf(input)));return;}
  setNote('');if(result.value!==input.value)writeField(input,result.value);
  requestAnimationFrame(()=>{try{input.setSelectionRange(result.caret,result.caret);}catch{/* some inputs have no selection */}});announce(input,result.value);
 };
 const paste=async()=>{
  const input=target();if(!input)return;let text='';
  try{text=await navigator.clipboard.readText();}catch{setNote('Paste is not available here. Hold the field to paste.');return;}
  const result=padPaste(text,decimalsOf(input)) as {value?:string;refused?:string};if(result.refused){setNote(padRefusal(result.refused,decimalsOf(input),symbolOf(input)));return;}
  setNote('');writeField(input,result.value!);requestAnimationFrame(()=>{try{input.setSelectionRange(result.value!.length,result.value!.length);}catch{/* no selection */}});announce(input,result.value!);
 };
 // The switch keeps the gesture: blur and focus run inside the tap so the phone opens (or closes) its keyboard straight away.
 const toKeyboard=()=>{remember('keyboard');setMode('keyboard');const input=target();if(input){input.inputMode='decimal';input.blur();input.focus();}};
 const toPad=()=>{remember('pad');setMode('pad');const now=document.activeElement,input=now instanceof HTMLInputElement&&now.matches(FIELD)?now:null;if(input){input.inputMode='none';input.blur();input.focus();}};
 const done=()=>{field?.blur();setField(null);};
 // The field must keep focus while a pad key is tapped. Chromium honours preventDefault on pointerdown; iOS Safari blurs the field on the
 // click's own mousedown (seen on the iPhone 16 Pro Max simulator: the first key closed the pad), so that is prevented as well.
 const keep=(event:React.PointerEvent|React.MouseEvent)=>event.preventDefault();

 const keys=<div className="silo-pad-keys">{PAD_KEYS.map(key=><button key={key} type="button" data-key={key}
    aria-label={key==='del'?'Delete. Hold to clear':key==='.'?'Decimal point':key}
    onPointerDown={event=>{event.preventDefault();pressed(event.currentTarget);hold.current.held=false;if(key==='del'){event.currentTarget.classList.add('is-hold');hold.current.timer=window.setTimeout(()=>{hold.current.held=true;press('clear');},550);}}}
    onPointerUp={event=>{window.clearTimeout(hold.current.timer);event.currentTarget.classList.remove('is-hold');released(event.currentTarget);}}
    onPointerLeave={event=>{window.clearTimeout(hold.current.timer);event.currentTarget.classList.remove('is-hold');released(event.currentTarget);}}
    onPointerCancel={event=>{window.clearTimeout(hold.current.timer);event.currentTarget.classList.remove('is-hold');released(event.currentTarget);}}
    onClick={()=>{if(!hold.current.held)press(key);hold.current.held=false;}}>{key==='del'?<Delete size={24} aria-hidden="true"/>:key==='.'?'.':key}</button>)}</div>;
 return <>
  {slot&&createPortal(<div className="silo-pad is-inline" role="group" aria-label="Number pad" onMouseDown={keep}>{note&&<p className="silo-pad-note" aria-live="polite">{note}</p>}{keys}</div>,slot)}
  {slot&&inline?.paste&&createPortal(<button type="button" className="silo-pad-paste" onPointerDown={keep} onMouseDown={keep} onClick={()=>void paste()}>Paste</button>,inline.paste)}
  {slot&&inline?.kbd&&createPortal(<button type="button" className="silo-pad-kbd" onPointerDown={keep} onMouseDown={keep} onClick={toKeyboard} aria-label="Type with the keyboard"><Keyboard size={22} aria-hidden="true"/></button>,inline.kbd)}
  <p className="sr-only" role="status" aria-live="polite">{said}</p>
  {switchAt&&<button type="button" className="silo-pad-switch" style={{top:switchAt.top,left:switchAt.left}} onPointerDown={keep} onMouseDown={keep} onClick={toPad} aria-label="Use the number pad"><Grid3x3 size={20} aria-hidden="true"/></button>}
  {open&&<div ref={dock} className="silo-pad" role="group" aria-label="Number pad" onMouseDown={keep} onPointerDownCapture={()=>{touched.current=performance.now();}}>
   <div className="silo-pad-bar">
    <button type="button" onPointerDown={keep} onClick={()=>void paste()}>Paste</button>
    <span className="silo-pad-note" aria-live="polite">{note}</span>
    <button type="button" onPointerDown={keep} onClick={toKeyboard} aria-label="Type with the keyboard"><Keyboard size={20} aria-hidden="true"/></button>
    <button type="button" className="silo-pad-done" onPointerDown={keep} onClick={done}>Done</button>
   </div>
   {keys}
  </div>}
 </>;
}
