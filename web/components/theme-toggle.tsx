"use client";
import {useSyncExternalStore} from "react";
import {Moon,Sun} from "lucide-react";

type Theme="dark"|"light";
const storageKey="grainpad-theme";
const themeEvent="grainpad:theme";
function snapshot():Theme{return document.documentElement.dataset.theme==="dark"?"dark":"light";}
const skinKey="grain-skin-v1";
function apply(theme:Theme){
 document.documentElement.dataset.theme=theme;
 document.documentElement.dataset.skin=theme==="dark"?"b":"c";
 document.querySelector('meta[name="theme-color"]')?.setAttribute("content",theme==="light"?"#ffffff":"#101010");
 window.dispatchEvent(new Event(themeEvent));
}
function subscribe(update:()=>void){
 const sync=(event:StorageEvent)=>{if(event.key===storageKey||event.key===null)apply(event.newValue==="dark"?"dark":"light");};
 window.addEventListener(themeEvent,update);window.addEventListener("storage",sync);
 return()=>{window.removeEventListener(themeEvent,update);window.removeEventListener("storage",sync);};
}
/** Shared by the header switch and the footer Appearance control: current theme, and a setter that also stores it (storage may be blocked). */
export function useSiteTheme():Theme{return useSyncExternalStore(subscribe,snapshot,()=>"light" as Theme);}
export function chooseSiteTheme(next:Theme){apply(next);try{localStorage.setItem(storageKey,next);localStorage.setItem(skinKey,next==="dark"?"b":"c");}catch{/* Theme switching also works when browser storage is unavailable. */}}
export function ThemeToggle(){
 const theme=useSiteTheme();
 const label=theme==="dark"?"Switch to light mode":"Switch to dark mode";
 function toggle(){chooseSiteTheme(snapshot()==="dark"?"light":"dark");}
 return <button type="button" className="theme-toggle" aria-label={label} title={label} onClick={toggle}><Sun className="theme-sun" size={18} aria-hidden="true"/><Moon className="theme-moon" size={18} aria-hidden="true"/></button>;
}
