'use client';
import {useEffect} from 'react';

/* iOS Safari lifts position:fixed bars above the on-screen keyboard. While a text field is focused the bottom bar steps
   out of the way (html[data-silo-keyboard]), and returns when the field loses focus. */
const FIELD='input:not([type=button]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=range]),textarea,select';

export function useSiloKeyboardGuard(){
 useEffect(()=>{
  const root=document.documentElement;let timer:ReturnType<typeof setTimeout>|undefined;
  const on=(event:FocusEvent)=>{if(event.target instanceof Element&&event.target.matches(FIELD)){clearTimeout(timer);root.setAttribute('data-silo-keyboard','')}};
  const off=()=>{clearTimeout(timer);timer=setTimeout(()=>root.removeAttribute('data-silo-keyboard'),120)};
  document.addEventListener('focusin',on);document.addEventListener('focusout',off);
  return()=>{clearTimeout(timer);document.removeEventListener('focusin',on);document.removeEventListener('focusout',off);root.removeAttribute('data-silo-keyboard')};
 },[]);
}
