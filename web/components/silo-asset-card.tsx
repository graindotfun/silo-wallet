'use client';
import type {CSSProperties,ReactNode} from 'react';
import {ChevronDown,LockKeyhole} from 'lucide-react';
import {SiloAssetIcon} from './silo-asset-icon';

/** r8 Home (owner, 6 Nov 2026): one card per asset, on the asset's colour from lib/silo/asset-look.mjs. The header is a button that opens
 * the card; the body holds what that asset's screen already said (balance, network row, notes, actions). Display only. */
export type SiloLook={key:string;fill:string;ink:string;icon:string};
type Icon=Parameters<typeof SiloAssetIcon>[0]['asset'];
export const siloLookStyle=(look:SiloLook)=>({'--af':look.fill,'--ai':look.ink} as CSSProperties);

export function SiloAssetCard({id,look,symbol,name,summary,locked=false,open,onToggle,children}:{id:string;look:SiloLook;symbol:string;name:string;summary:ReactNode;locked?:boolean;open:boolean;onToggle:()=>void;children:ReactNode}){
 return <section className="silo-asset-card" data-asset={look.key} data-open={open||undefined} style={siloLookStyle(look)} aria-labelledby={`silo-ac-${id}`}>
  <h2 className="silo-asset-card-title" id={`silo-ac-${id}`}><button type="button" aria-expanded={open} aria-controls={`silo-ac-body-${id}`} onClick={onToggle}>
   <SiloAssetIcon asset={look.icon as Icon}/><span className="silo-asset-card-name"><strong>{symbol}</strong><small>{name}</small></span>
   {!open&&<span className="silo-asset-card-sum">{locked&&<LockKeyhole size={14} aria-hidden="true"/>}{summary}</span>}<ChevronDown className="silo-asset-card-chev" size={20} aria-hidden="true"/>
  </button></h2>
  <div className="silo-asset-card-body" id={`silo-ac-body-${id}`} hidden={!open}>{children}</div>
 </section>;
}

/** A network inside an asset card: a dark chip with its mark, zone and name, and a state (a filled dot means connected). */
export function SiloNetworkRow({icon,label,state,on=false}:{icon:Icon;label:string;state:ReactNode;on?:boolean}){
 return <div className="silo-asset-net"><SiloAssetIcon asset={icon}/><span><strong>{label}</strong><small data-state={on?'on':undefined}>{state}</small></span></div>;
}
