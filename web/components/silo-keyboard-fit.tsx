'use client';
import {useEffect} from 'react';

const TYPING='input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]),textarea';

/** Phone keyboard fit (5 Nov 2026). When a wallet field is focused and the on-screen keyboard shrinks the visible area, scroll so the field
 * and the action it leads to (the element marked data-keyboard-keep in the same section, e.g. Convert) sit above the keyboard. The field
 * itself always wins: the page never scrolls it out of sight to reach the button. The native keyboard stays (paste, accessibility,
 * hardware keyboards); while it is open the tab bar and Grainy step aside (silo-themes.css). Display only. */
export function useSiloKeyboardFit(){
 useEffect(()=>{
  const vv=window.visualViewport;if(!vv)return;
  let frame=0,timers:number[]=[];
  // iOS scrolls the focused field itself while the keyboard animates, after our first pass; a second pass once it settles keeps Convert in view.
  const later=()=>{timers.forEach(clearTimeout);timers=[120,480].map(ms=>window.setTimeout(fit,ms));};
  const fit=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{
   const field=document.activeElement;
   if(!(field instanceof HTMLElement)||!field.matches(TYPING)||!field.closest('.silo-app'))return;
   if(document.documentElement.dataset.amountPad==='open')return; // Silo's own number pad is up: it places the field itself (silo-amount-pad.tsx).
   const head=field.closest('label')??field,room=vv.height-24,box=head.getBoundingClientRect();
   const keep=field.closest('section,form')?.querySelector<HTMLElement>('[data-keyboard-keep]');
   const end=keep&&!keep.hidden?keep.getBoundingClientRect().bottom:box.bottom;
   // iOS pans its visual viewport while the keyboard is up, so scrollIntoView (which WebKit resolves against that viewport) is used rather
   // than window.scrollBy. Both fit: show the field and the action together. Too tall for the space left: the field goes to the top,
   // with what it changes (the receive amount) right below, and the action is one tap away on Done.
   const fits=end-box.top<=room;
   const shownTop=box.top-vv.offsetTop,shownEnd=end-vv.offsetTop;
   if(fits&&shownTop>=12&&shownEnd<=vv.height-12)return;
   if(fits&&keep)keep.scrollIntoView({block:'end',inline:'nearest'});
   else head.scrollIntoView({block:'start',inline:'nearest'});
  });};
  const focused=(event:FocusEvent)=>{if(event.target instanceof HTMLElement&&event.target.matches(TYPING))later();};
  vv.addEventListener('resize',later);document.addEventListener('focusin',focused);
  return()=>{vv.removeEventListener('resize',later);document.removeEventListener('focusin',focused);cancelAnimationFrame(frame);timers.forEach(clearTimeout);};
 },[]);
}
