'use client';
/* eslint-disable @next/next/no-img-element -- Packaged wallet logos, no external image optimizer. */
import {useEffect,useId,useRef,useState,type KeyboardEvent} from 'react';
import {moneyCoinSrc} from '@/lib/silo/money-animation.mjs';

/** A native <select> cannot show a logo, so this is a small listbox: the full-colour packaged coin logo next to the symbol,
 * in the button and in every option. Keyboard: Enter/Space/ArrowDown open, arrows move, Enter/Space choose, Escape and Tab
 * close. A tap outside closes it. The logo is decoration (alt empty); the symbol is the accessible name. */
export function SiloCoinPicker({label,value,options,names,disabled,onChange}:{label:string;value:string;options:readonly string[];names:Record<string,string>;disabled?:boolean;onChange:(coin:string)=>void}){
 const [open,setOpen]=useState(false),[active,setActive]=useState(0),root=useRef<HTMLDivElement>(null),id=useId();
 const list=[value,...options.filter(coin=>coin!==value)].filter((coin,index,all)=>all.indexOf(coin)===index);
 useEffect(()=>{if(!open)return;const away=(event:PointerEvent)=>{if(root.current&&!root.current.contains(event.target as Node))setOpen(false);};document.addEventListener('pointerdown',away);return()=>document.removeEventListener('pointerdown',away);},[open]);
 const logo=(coin:string)=>{const src=moneyCoinSrc(coin);return src?<img className="silo-coin-logo" src={src} alt="" width={24} height={24} draggable={false}/>:null;};
 const choose=(coin:string)=>{setOpen(false);if(coin!==value)onChange(coin);};
 const onKey=(event:KeyboardEvent)=>{
  if(!open){if(['Enter',' ','ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();setActive(Math.max(0,list.indexOf(value)));setOpen(true);}return;}
  if(event.key==='Escape'){event.preventDefault();setOpen(false);}
  else if(event.key==='ArrowDown'){event.preventDefault();setActive(index=>(index+1)%list.length);}
  else if(event.key==='ArrowUp'){event.preventDefault();setActive(index=>(index+list.length-1)%list.length);}
  else if(event.key==='Enter'||event.key===' '){event.preventDefault();choose(list[active]);}
  else if(event.key==='Tab')setOpen(false);
 };
 return <div className="silo-coin-picker" ref={root} data-open={open?'':undefined}>
  <button type="button" className="silo-chip silo-coin-button" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-list`} disabled={disabled} onClick={()=>{setActive(Math.max(0,list.indexOf(value)));setOpen(current=>!current);}} onKeyDown={onKey}>
   {logo(value)}<span>{names[value]??value.toUpperCase()}</span><svg className="silo-coin-chevron" viewBox="0 0 12 8" width="12" height="8" aria-hidden="true"><path d="M1 1.5 6 6.5 11 1.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
  </button>
  {open&&<ul id={`${id}-list`} className="silo-coin-list" role="listbox" aria-label={label}>{list.map((coin,index)=><li key={coin} role="option" aria-selected={coin===value} data-active={index===active?'':undefined} onPointerEnter={()=>setActive(index)} onClick={()=>choose(coin)}>{logo(coin)}<span>{names[coin]??coin.toUpperCase()}</span></li>)}</ul>}
 </div>;
}
