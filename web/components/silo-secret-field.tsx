'use client';
import {useLayoutEffect,useRef,useState,type FocusEvent,type InputHTMLAttributes} from 'react';

/* The owner's asterisk (supplied SVG, 3 November 2026) replaces the browser's round bullets. The real input stays a password
   field (keyboard, autofill and paste behave as usual) with transparent text; the stars are drawn over it. Show reveals the
   plain text for anyone who wants to see what they typed. The toggle has no text of its own (CSS draws Show / Hide) so the
   label of the field stays exactly its name. */
const STAR_PATH='M1665.29,1747.02c1344.86-2329.36-1430.7-2329.36-85.84,0-1344.86-2329.36-2732.64,74.34-42.92,74.34-2689.72,0-1301.94,2403.7,42.92,74.34-1344.86,2329.36,1430.7,2329.36,85.84,0,1344.86,2329.36,2732.64-74.34,42.92-74.34,2689.72,0,1301.94-2403.7-42.92-74.34Z';

export function SiloSecretField({value,onFocus,onBlur,...rest}:Omit<InputHTMLAttributes<HTMLInputElement>,'type'|'value'>&{value:string}){
 const [shown,setShown]=useState(false),[focused,setFocused]=useState(false);
 const text=String(value),input=useRef<HTMLInputElement>(null),stars=useRef<HTMLSpanElement>(null);
 /* The star row starts at the field's own text inset (CSS) and never shows a cut star: a long passphrase scrolls in whole
    stars so the end and the caret stay in view and the first visible glyph is always complete. */
 useLayoutEffect(()=>{const el=stars.current,field=input.current;if(!el)return;if(field)el.style.setProperty('--silo-secret-inset',getComputedStyle(field).paddingLeft);
  el.style.paddingRight='0px';el.scrollLeft=0;const items=[...el.querySelectorAll('svg')],caret=el.querySelector('i');if(items.length<2||!caret)return;
  const base=el.getBoundingClientRect().left,at=(node:Element)=>node.getBoundingClientRect().left-base;
  const overflow=at(caret)+caret.getBoundingClientRect().width+4-el.clientWidth;if(overflow<=0)return;
  /* The first whole star at or after the overflow: the end and caret stay in view and no star is cut at the left. */
  const first=items.find(item=>at(item)>=overflow-.5)??items[items.length-1],target=at(first);
  const slack=target-(el.scrollWidth-el.clientWidth);if(slack>0)el.style.paddingRight=`${Math.ceil(slack)}px`;el.scrollLeft=target;},[text,shown]);
 return <span className="silo-secret" data-shown={shown?'':undefined} data-focused={focused?'':undefined}>
  <input ref={input} autoCapitalize="off" autoCorrect="off" spellCheck={false} {...rest} value={text} type={shown?'text':'password'}
   onFocus={(event:FocusEvent<HTMLInputElement>)=>{setFocused(true);onFocus?.(event)}} onBlur={(event:FocusEvent<HTMLInputElement>)=>{setFocused(false);onBlur?.(event)}}/>
  {!shown&&<span ref={stars} className="silo-secret-stars" aria-hidden="true">{Array.from(text).map((_,index)=><svg key={index} viewBox="0 0 3244.74 3642.73" focusable="false"><path d={STAR_PATH}/></svg>)}<i className="silo-secret-caret"/></span>}
  <button type="button" className="silo-secret-toggle" aria-label={shown?'Hide passphrase':'Show passphrase'} aria-pressed={shown} onMouseDown={event=>event.preventDefault()} onClick={()=>setShown(current=>!current)}/>
 </span>;
}
