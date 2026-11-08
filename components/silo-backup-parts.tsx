// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import {createContext,useContext,useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {packSiloUnifiedBackup,siloBackupFileName,SILO_BACKUP_ZONES} from '@/lib/silo/unified-backup.mjs';

/** One backup file for the whole wallet. Each open zone registers how to produce its own sealed envelope; an export from any
 * zone collects every registered part into one file (product decision). Collection runs one export at a time,
 * so two exports started together get two files with two identifiers, never one file written twice.
 *
 * Review of the V1 test-network stage, part 4 (D2): an export's membership is fixed when it starts. If a wallet locks (or
 * opens) while the export is being prepared, the export is refused rather than silently producing a different file. Each zone
 * also announces whether a wallet of its kind exists in this browser, so a file that leaves out a locked wallet says so.
 *
 * Candidate review (D2, 21 October 2026): names are not enough. The registry keeps a monotonic revision that every register,
 * unregister and presence change advances; an export captures the revision, the exact source object of every part and the
 * locked set when it starts, and refuses if any of them differs before, between or after the parts are collected. A wallet
 * that disappears and returns between two checks therefore cannot hand a replacement source to the export. */
export type SiloBackupZone=(typeof SILO_BACKUP_ZONES)[number];
export type SiloBackupPresence='open'|'locked'|'none';
export type SiloBackupReplaceContext={original:unknown;rollback:boolean;partDigest?:string;preparationId?:string;recoveryDigest?:string;written?:()=>void;writtenDigest?:string};
/** `replace` is offered only by wallets that can switch their stored copy (the one-passphrase switch): it keeps the original before replacing and,
 * with `rollback`, puts the original back. */
export type SiloBackupPartSource={network:string;envelope:()=>Promise<unknown>;replace?:(envelope:unknown,context:SiloBackupReplaceContext)=>Promise<void>};
export type SiloBackupExport={exportId:string;fileName:string;file:Record<string,unknown>;zones:SiloBackupZone[];excluded:SiloBackupZone[]};
export type SiloBackupParts={
 /** Stable for the provider's lifetime: a zone's effect may depend on it without re-running when another zone opens. */
 register(zone:SiloBackupZone,source:SiloBackupPartSource):()=>void;
 /** Stable. A zone says whether a wallet of its kind is open, stored but locked, or absent in this browser. */
 announce(zone:SiloBackupZone,presence:SiloBackupPresence):void;
 /** Stable. The zones open right now, the locked ones, and the registry revision, read synchronously when an export starts. */
 snapshot():{open:SiloBackupZone[];locked:SiloBackupZone[];revision:number};
 /** Builds the combined file with `own` (already sealed by the caller) plus every other part that was open when the export
 * started (`expected`). Refuses if the set of open zones changed meanwhile. Stable. */
 exportWith(zone:SiloBackupZone,own:unknown,expected:SiloBackupZone[],revision?:number):Promise<SiloBackupExport>;
 /** Stable. The open wallets' sources by zone (envelope reader and, where offered, the switch's replacer), read at the moment of use. */
 sources():Partial<Record<SiloBackupZone,SiloBackupPartSource>>;
 /** The zones open right now; a React state, so a zone re-renders (its button label) when another one opens or locks. */
 registered:SiloBackupZone[];
};
const Context=createContext<SiloBackupParts|null>(null);
export const useSiloBackupParts=()=>useContext(Context);
const sameSet=(a:readonly string[],b:readonly string[])=>a.length===b.length&&a.every(item=>b.includes(item));

export function SiloBackupPartsProvider({children}:{children:ReactNode}){
 const sources=useRef(new Map<SiloBackupZone,SiloBackupPartSource>()),presence=useRef(new Map<SiloBackupZone,SiloBackupPresence>()),queue=useRef<Promise<unknown>>(Promise.resolve()),revision=useRef(0);
 const [registered,setRegistered]=useState<SiloBackupZone[]>([]);
 // Created once: registering must not change the functions, or every zone's effect would re-register in a loop.
 const actions=useMemo(()=>{
  const open=()=>SILO_BACKUP_ZONES.filter(zone=>sources.current.has(zone));
  const locked=()=>SILO_BACKUP_ZONES.filter(zone=>!sources.current.has(zone)&&presence.current.get(zone)==='locked');
  const refresh=()=>setRegistered(open());
  return {
   register(zone:SiloBackupZone,source:SiloBackupPartSource){sources.current.set(zone,source);revision.current++;refresh();return ()=>{if(sources.current.get(zone)===source){sources.current.delete(zone);revision.current++;refresh();}};},
   announce(zone:SiloBackupZone,state:SiloBackupPresence){if(presence.current.get(zone)!==state){presence.current.set(zone,state);revision.current++;refresh();}},
   snapshot(){return {open:open(),locked:locked(),revision:revision.current};},
   sources(){return Object.fromEntries(open().map(zone=>[zone,sources.current.get(zone)])) as Partial<Record<SiloBackupZone,SiloBackupPartSource>>;},
   exportWith(zone:SiloBackupZone,own:unknown,expected:SiloBackupZone[],startRevision?:number){
    const changed=(detail:string)=>Object.assign(Error(`A wallet ${detail} while the combined backup was being prepared, so this export was not written. Export again.`),{siloExport:'membership-changed'});
    const run=async():Promise<SiloBackupExport>=>{
     const wanted=expected.includes(zone)?expected:[zone,...expected];
     // Fixed at initiation: the revision the caller saw, the exact source of every part, and the locked set.
     if(startRevision!==undefined&&startRevision!==revision.current)throw changed('locked or opened');
     const fixedRevision=revision.current,fixedSources=new Map(wanted.filter(z=>z!==zone).map(z=>[z,sources.current.get(z)] as const)),fixedLocked=locked();
     const same=()=>{if(revision.current!==fixedRevision||!sameSet(open(),wanted)||!sameSet(locked(),fixedLocked))throw changed('locked or opened');for(const [z,source] of fixedSources)if(!source||sources.current.get(z)!==source)throw changed('locked, opened or was replaced');};
     same();
     const parts:Partial<Record<SiloBackupZone,unknown>>={[zone]:own};
     for(const other of wanted){if(other===zone)continue;const source=fixedSources.get(other);if(!source)throw changed('locked');
      // A part that fails because its wallet locked meanwhile is reported as a membership change, not as a generic failure.
      try{parts[other]=await source.envelope();}catch(failure){if(revision.current!==fixedRevision||!sameSet(open(),wanted)||/locked/i.test(String((failure as Error)?.message)))throw Object.assign(changed('locked'),{cause:failure});throw failure;}
      same();}
     same();
     const file=packSiloUnifiedBackup(parts) as Record<string,unknown>&{exportId:string};
     return {exportId:file.exportId,fileName:siloBackupFileName(file),file,zones:SILO_BACKUP_ZONES.filter(z=>parts[z]!==undefined),excluded:fixedLocked};
    };
    const next=queue.current.then(run,run);queue.current=next.catch(()=>{});return next;
   },
  };
 },[]);
 const value=useMemo<SiloBackupParts>(()=>({...actions,registered}),[actions,registered]);
 return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** A prepared file: one object URL per export with an explicit expiry (ten minutes; a backup file is small). The URL is revoked
 * by the status component when the link expires or goes away, never by a timer behind a link that is still shown (D5). */
export const SILO_BACKUP_LINK_TTL_MS=10*60*1000;
export type SiloBackupDownload={url:string;fileName:string;exportId:string;autoStarted:boolean;expiresAt:number};
export function prepareSiloBackupDownload(exported:SiloBackupExport,{ttlMs=SILO_BACKUP_LINK_TTL_MS,now=Date.now()}:{ttlMs?:number;now?:number}={}):SiloBackupDownload{
 const url=URL.createObjectURL(new Blob([JSON.stringify(exported.file)],{type:'application/json'}));
 return {url,fileName:exported.fileName,exportId:exported.exportId,autoStarted:false,expiresAt:now+ttlMs};
}
/** Browsers allow a page one download without a fresh click; later ones need the click's activation to still be live. Sealing
 * a backup can outlast that window, after which an automatic download is dropped silently. So: start the download at once
 * only while the click is known to be live; when the browser cannot say (no `userActivation`), do not guess. Either way the
 * person keeps a link to save the file by a direct click (part 4, D5). Returns the download with `autoStarted` set. */
export function startSiloBackupDownload(download:SiloBackupDownload):SiloBackupDownload{
 const activation=(navigator as Navigator&{userActivation?:{isActive:boolean}}).userActivation;
 if(!activation||activation.isActive!==true)return {...download,autoStarted:false};
 const link=document.createElement('a');link.href=download.url;link.download=download.fileName;link.click();return {...download,autoStarted:true};
}
/** What an export contained, for the status line under the button. Names any wallet that exists here but was left out. */
export function describeSiloBackupExport(exported:SiloBackupExport){
 const names:Record<SiloBackupZone,string>={solana:'Solana',evm:'Ethereum, Base and BNB',xmr:'Monero'};
 const left=exported.excluded.filter(zone=>!exported.zones.includes(zone));
 return `${exported.zones.length>1?'Combined backup':'Backup'} exported: ${exported.zones.map(zone=>names[zone]).join(' + ')} · file id ${exported.exportId}.${left.length?` Not included: ${left.map(zone=>names[zone]).join(', ')} (locked in this browser). Unlock it and export again for one file with both.`:''}`;
}
/** The export status and the link that saves the prepared file: the only way to save when no download started, and a way
 * to save a copy again after one did. */
export function SiloBackupExportStatus({lastExport,saveLink,onSaved}:{lastExport:SiloBackupExport|null;saveLink:SiloBackupDownload|null;onSaved:()=>void}){
 const [expired,setExpired]=useState(false);
 // The link and its URL live exactly as long as each other: expiry (or a new export, or unmount) revokes the URL and the link says so.
 // eslint-disable-next-line react-hooks/set-state-in-effect -- the expiry is a timer on the link's own deadline
 useEffect(()=>{setExpired(false);if(!saveLink)return;const url=saveLink.url;const timer=setTimeout(()=>{setExpired(true);URL.revokeObjectURL(url);},Math.max(0,saveLink.expiresAt-Date.now()));return()=>{clearTimeout(timer);URL.revokeObjectURL(url);};},[saveLink]);
 return <>{lastExport&&<span role="status" className="exposure-note">{describeSiloBackupExport(lastExport)}</span>}{saveLink&&!expired&&<a className="silo-save-link" href={saveLink.url} download={saveLink.fileName} data-auto-started={saveLink.autoStarted?'true':'false'} data-expires-at={saveLink.expiresAt} onClick={()=>setTimeout(onSaved,0)}>{saveLink.autoStarted?'Save a copy again':'Save backup file'}</a>}{saveLink&&!expired&&!saveLink.autoStarted&&<span className="exposure-note">The download did not start by itself; use the link.</span>}{saveLink&&expired&&<span className="exposure-note" role="status" data-save-link-expired="true">The link to this file expired{saveLink.autoStarted?'':' before it was saved'}; export again for a fresh file.</span>}</>;
}
