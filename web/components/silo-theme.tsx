'use client';
import {useEffect,useSyncExternalStore} from 'react';
import '../app/app/silo-themes.css';
import {Moon,Sun} from 'lucide-react';
import {SKINS,SKIN_INFO,READY,legacyAppearance,resolveSkin,saveSkin,siloThemeColor} from '@/lib/theme/theme-core.mjs';
type Skin='b'|'a'|'c';
const CHANGED='silo-display-theme-changed',KEYS=['silo-skin-v1','silo-display-theme-v1'];
let temporary:Skin|null=null;
function skin():Skin{if(temporary!==null)return temporary;try{return resolveSkin(window.localStorage,'silo') as Skin;}catch{return 'b';}}
function snapshot(){return `${skin()}:${temporary===null?'saved':'temporary'}`;}
function subscribe(changed:()=>void){const fromStorage=(event:StorageEvent)=>{if(event.key===null||KEYS.includes(event.key)){temporary=null;changed();}};window.addEventListener('storage',fromStorage);window.addEventListener(CHANGED,changed);return()=>{window.removeEventListener('storage',fromStorage);window.removeEventListener(CHANGED,changed);};}
/** This display preference has its own keys; it never reads or changes a wallet or recovery record. */
export function useSiloTheme(){const value=useSyncExternalStore(subscribe,snapshot,()=>'b:saved');const [current,persistence]=value.split(':') as [Skin,'saved'|'temporary'];useEffect(()=>{document.documentElement.dataset.skin=current;document.querySelector('meta[name="theme-color"]')?.setAttribute('content',siloThemeColor(current));},[current]);return {skin:current,appearance:legacyAppearance(current) as 'light'|'dark',persistenceFailed:persistence==='temporary'};}
function changeTheme(next:Skin){let saved=true;if(saveSkin(window.localStorage,'silo',next))temporary=null;else{temporary=next;saved=false;}window.dispatchEvent(new Event(CHANGED));return saved;}
/** Appearance picker: one radio per skin (native radios, so arrow keys and screen readers work). Skins without finished colours are shown, disabled and labelled. */
export function SiloThemeControl(){const {skin:current,persistenceFailed}=useSiloTheme();const ready=READY.silo as string[];
 return <div className="silo-skin-picker"><fieldset><legend>Appearance</legend><div className="silo-skin-options">{(SKINS as Skin[]).map(id=>{const info=SKIN_INFO[id],usable=ready.includes(id);
  return <label key={id} className="silo-skin-option" data-usable={usable?'yes':'no'} data-skin-option={id}><input type="radio" name="silo-skin" value={id} checked={current===id} disabled={!usable} onChange={()=>changeTheme(id)}/><span className="silo-skin-strip" aria-hidden="true">{info.strip.map((color:string,index:number)=><i key={index} style={{background:color}}/>)}</span><span className="silo-skin-name">{info.name}</span><span className="silo-skin-blurb">{usable?info.blurb:'Coming soon.'}</span></label>;})}</div></fieldset>
 {persistenceFailed&&<p role="status">Appearance changed for this tab. Browser storage is unavailable; the choice may reset on reload.</p>}</div>;}

/** Compact header switch between Cold Brew and the light skin; the full choice lives in Settings. */
export function SiloThemeToggle(){const {appearance,persistenceFailed}=useSiloTheme();const next=appearance==='dark'?'light':'dark',label=next==='light'?'Switch to light mode':'Switch to dark mode';return <div className="silo-theme-control"><button type="button" className="silo-icon-button" aria-label={label} title={label} onClick={()=>changeTheme(next==='light'?'c':'b')}>{appearance==='dark'?<Sun size={21} aria-hidden="true"/>:<Moon size={21} aria-hidden="true"/>}</button>{persistenceFailed&&<p role="status">Appearance changed for this tab. Browser storage is unavailable; the choice may reset on reload.</p>}</div>;}
