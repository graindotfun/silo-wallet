'use client';
import {useEffect,useRef,useState} from 'react';
import {useSiloBackupParts,prepareSiloBackupDownload,startSiloBackupDownload,SiloBackupExportStatus,type SiloBackupExport,type SiloBackupDownload,type SiloBackupZone} from './silo-backup-parts';
import {prepareOnePassphraseSwitch,verifySavedSwitchFile,commitOnePassphraseSwitch,siloInventoryDigest} from '@/lib/silo/one-passphrase-flow.mjs';
import {siloPassphraseProblem} from '@/lib/silo/passphrase-strength.mjs';
import {siloBackupFileName} from '@/lib/silo/unified-backup.mjs';
import {listLegacyEnvelopes,removeLegacyEnvelopes} from '@/lib/silo/legacy-envelopes.mjs';
import {defaultRevocation,openDeviceUnlockStore,removeDeviceUnlock} from '@/lib/silo/device-unlock.mjs';
const NAMES:Record<SiloBackupZone,string>={solana:'Solana',evm:'Ethereum, Base and BNB',btc:'Bitcoin',xmr:'Monero'};
type Prepared=Awaited<ReturnType<typeof prepareOnePassphraseSwitch>>;
type Step='intro'|'form'|'working'|'save'|'ready'|'switching'|'done';
const control={minHeight:44,fontSize:16} as const;
const failure=(error:unknown,fallback:string)=>{const e=error as {message?:string;siloSwitch?:string;siloMigration?:string};return e?.siloSwitch||e?.siloMigration?String(e.message):fallback;};

/** Settings > Backup: "Switch to one passphrase". Re-seals every open wallet under ONE passphrase, all or nothing; nothing on this device changes until the
 * new file was saved AND picked again to prove it opens; every original is kept until the person deletes it; a failure puts every wallet back. */
export function SiloOnePassphrase(){
 const parts=useSiloBackupParts();
 const [step,setStep]=useState<Step>('intro'),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [current,setCurrent]=useState<Partial<Record<SiloBackupZone,string>>>({}),[fresh,setFresh]=useState(''),[again,setAgain]=useState(''),[understood,setUnderstood]=useState(false);
 const passes=useRef<Partial<Record<SiloBackupZone,string>>>({}),prepared=useRef<Prepared|null>(null),verified=useRef<{preparationId:string}|null>(null),generation=useRef(0),newPass=useRef(''),[saveLink,setSaveLink]=useState<SiloBackupDownload|null>(null),[exported,setExported]=useState<SiloBackupExport|null>(null);
 const [legacy,setLegacy]=useState(0),[deleteAck,setDeleteAck]=useState(false),mounted=useRef(true);
 const snapshot=parts?.snapshot(),open=(snapshot?.open??[]) as SiloBackupZone[],locked=(snapshot?.locked??[]) as SiloBackupZone[];
 useEffect(()=>{mounted.current=true;try{setLegacy(listLegacyEnvelopes(localStorage).length);}catch{/* nothing kept or storage unavailable */}return()=>{mounted.current=false;prepared.current=null;newPass.current='';passes.current={};};},[]);
 const weak=fresh?siloPassphraseProblem(fresh):'',mismatch=Boolean(again)&&again!==fresh;
 const canPrepare=open.length>0&&locked.length===0&&open.every(zone=>(current[zone]??'').length>=12)&&fresh.length>=12&&!weak&&again===fresh&&understood;
 function reset(message=''){generation.current++;verified.current=null;prepared.current=null;newPass.current='';passes.current={};setCurrent({});setFresh('');setAgain('');setUnderstood(false);setSaveLink(null);setExported(null);setError('');setNotice(message);setStep('intro');}
 async function prepare(){
  if(!parts||!canPrepare)return;setError('');setNotice('');setStep('working');
  // A new preparation invalidates everything asynchronous that belongs to an earlier one (a file check still running, a cancelled attempt).
  const mine=++generation.current;verified.current=null;prepared.current=null;
  try{
   const sources=parts.sources(),result=await prepareOnePassphraseSwitch({sources:sources as never,locked:parts.snapshot().locked.map(zone=>NAMES[zone as SiloBackupZone]),passphrases:current,newPassphrase:fresh});
   if(!mounted.current||mine!==generation.current)return;
   prepared.current=result;newPass.current=fresh;passes.current={...current};
   const file=result.file as Record<string,unknown>&{exportId:string};
   const out:SiloBackupExport={exportId:file.exportId,fileName:siloBackupFileName(file),file,zones:result.zones as SiloBackupZone[],excluded:[]};
   setExported(out);setSaveLink(startSiloBackupDownload(prepareSiloBackupDownload(out)));setStep('save');
  }catch(problem){if(mounted.current&&mine===generation.current){setError(failure(problem,'Could not prepare the switch. Nothing was changed.'));setStep('form');}}
 }
 async function pickSaved(file:File|undefined){
  const target=prepared.current;if(!file||!target)return;setError('');verified.current=null;const mine=generation.current;
  // The result of this check counts only if the SAME preparation is still the current one when it finishes: a cancel, a re-prepare or a lock meanwhile makes it void.
  const current=()=>mounted.current&&mine===generation.current&&prepared.current===target;
  if(file.size>192*1024*1024){setError('That file is too large to be this backup.');return;}
  try{
   const text=await file.text();if(!current())return;
   const proof=await verifySavedSwitchFile({text,prepared:target,newPassphrase:newPass.current});if(!current())return;
   verified.current=proof;setNotice('The saved file opens with the new passphrase. You can switch this device now.');setStep('ready');
  }catch(problem){if(current())setError(failure(problem,'That file could not be checked.'));}
 }
 async function commit(){
  const target=prepared.current,proof=verified.current;if(!parts||!target||!proof||step!=='ready')return;setError('');setStep('switching');
  try{
   const sources=parts.sources(),replacers=Object.fromEntries(Object.entries(sources).map(([zone,source])=>[zone,{replace:(source as {replace?:(e:unknown,c:{original:unknown;rollback:boolean})=>Promise<void>}).replace}]));
   await commitOnePassphraseSwitch({prepared:target,verification:proof,replacers:replacers as never,currentInventory:async()=>{const snap=parts.snapshot(),open=parts.sources();const digests:Record<string,string>={};for(const zone of snap.open as SiloBackupZone[]){const source=open[zone];if(!source)throw Error('locked');digests[zone]=await siloInventoryDigest(zone,await source.envelope(),passes.current[zone]);}return {zones:snap.open,locked:snap.locked,digests};}});
   // Device unlock holds the OLD passphrase (encrypted on this device): it must go with the switch. The deletion is confirmed; if it cannot be, the revocation marker keeps it unusable and the person is told.
   let deviceNote='';
   try{await removeDeviceUnlock(openDeviceUnlockStore());}
   catch{defaultRevocation().mark();deviceNote=' Device unlock could not be removed and is turned off here: open Settings and turn it off before you rely on it again.';}
   if(!mounted.current)return;
   setStep('done');setNotice('Switched. Every wallet in this browser now opens with your new passphrase. The wallets lock now: unlock with the new passphrase. The old copies are still kept, and your old passphrases still open them until you delete them below.'+deviceNote);
   generation.current++;verified.current=null;prepared.current=null;newPass.current='';passes.current={};setCurrent({});setFresh('');setAgain('');
   window.setTimeout(()=>location.reload(),2500);
  }catch(problem){if(mounted.current){setError(failure(problem,'The switch stopped. Your wallets were put back as they were.'));setStep('ready');}}
 }
 function deleteOld(){
  if(!deleteAck)return;try{const rows=listLegacyEnvelopes(localStorage);removeLegacyEnvelopes(localStorage,rows.map(row=>row.key));setLegacy(listLegacyEnvelopes(localStorage).length);setDeleteAck(false);setNotice('The old Solana and Ethereum copies were deleted from this browser.');}catch{setError('Could not delete the old copies. They are still kept.');}
 }
 return <div className="silo-setting-row" id="silo-one-passphrase"><div style={{flex:1,minWidth:0}}>
  <strong>Use one passphrase for every wallet</strong>
  {step==='intro'&&<>
   <p>Today each wallet can have its own passphrase. This switches Solana, Ethereum, Base, BNB and Monero to one passphrase, so one passphrase and one backup file restore everything.</p>
   <p className="exposure-note">One passphrase opens all of them, and one lost backup file means all of them. Your old copies are kept until you delete them, and your OLD passphrases still open those old copies until you do.</p>
   {locked.length>0&&<p role="status" className="exposure-note">Unlock {locked.map(zone=>NAMES[zone]).join(' and ')} first. Every wallet in this browser must be open to switch together.</p>}
   {open.length===0&&locked.length===0&&<p role="status" className="exposure-note">Unlock your wallets first (open each one from Home).</p>}
   <div className="exposure-actions"><button type="button" style={control} disabled={open.length===0||locked.length>0} onClick={()=>{setNotice('');setError('');setStep('form');}}>Switch to one passphrase</button></div>
  </>}
  {(step==='form'||step==='working')&&<>
   <p>Type each wallet's current passphrase, then the one passphrase to use from now on. Nothing is changed on this device yet.</p>
   {open.map(zone=><label key={zone} style={{display:'block',marginTop:16}}>Current passphrase for {NAMES[zone]}<input type="password" autoComplete="off" spellCheck={false} style={{...control,width:'100%'}} value={current[zone]??''} disabled={step==='working'} onChange={event=>setCurrent(value=>({...value,[zone]:event.target.value}))}/></label>)}
   <label style={{display:'block',marginTop:24}}>New passphrase (12 to 256 characters)<input type="password" autoComplete="new-password" spellCheck={false} style={{...control,width:'100%'}} value={fresh} disabled={step==='working'} onChange={event=>setFresh(event.target.value)}/></label>
   {weak&&<p role="alert" className="exposure-error">{weak}</p>}
   <label style={{display:'block',marginTop:16}}>Type the new passphrase again<input type="password" autoComplete="new-password" spellCheck={false} style={{...control,width:'100%'}} value={again} disabled={step==='working'} onChange={event=>setAgain(event.target.value)}/></label>
   {mismatch&&<p role="alert" className="exposure-error">The two new passphrases are different.</p>}
   <label style={{display:'flex',gap:8,alignItems:'flex-start',marginTop:16,minHeight:44}}><input type="checkbox" checked={understood} disabled={step==='working'} onChange={event=>setUnderstood(event.target.checked)} style={{width:24,height:24,flex:'none'}}/><span>I understand one passphrase opens all of these wallets, and one lost backup file means all of them. Silo cannot reset it.</span></label>
   <div className="exposure-actions" style={{marginTop:16}}><button type="button" className="silo-primary" style={control} disabled={!canPrepare||step==='working'} onClick={()=>void prepare()}>{step==='working'?'Preparing…':'Prepare the new backup'}</button><button type="button" style={control} disabled={step==='working'} onClick={()=>reset()}>Cancel</button></div>
  </>}
  {(step==='save'||step==='ready'||step==='switching')&&<>
   <p><strong>Step 1.</strong> Save the new backup file somewhere only you can reach, off this device. It opens with the new passphrase only.</p>
   <SiloBackupExportStatus lastExport={exported} saveLink={saveLink} onSaved={()=>setSaveLink(null)}/>
   <p style={{marginTop:16}}><strong>Step 2.</strong> Pick the file you saved, so Silo can prove it opens with the new passphrase. Nothing on this device changes before this check passes.</p>
   <label style={{display:'block'}}>Saved backup file<input type="file" accept="application/json,.json" style={control} disabled={step==='switching'} onChange={event=>{void pickSaved(event.target.files?.[0]);event.target.value='';}}/></label>
   <p style={{marginTop:16}}><strong>Step 3.</strong> Switch this device. Your current copies are kept, and if anything fails every wallet is put back.</p>
   <div className="exposure-actions"><button type="button" className="silo-primary" style={control} disabled={step!=='ready'} onClick={()=>void commit()}>{step==='switching'?'Switching…':'Switch this device'}</button><button type="button" style={control} disabled={step==='switching'} onClick={()=>reset('Cancelled. Nothing on this device was changed.')}>Cancel</button></div>
  </>}
  {legacy>0&&<div style={{marginTop:24}}><p className="exposure-note">Old copies of your Solana and Ethereum wallets (their previous passphrases) are still kept in this browser. Monero keeps its previous copy in its own archive. Your old passphrases still open these old copies until you delete them. Delete them once you have restored from the new file at least once.</p>
   <label style={{display:'flex',gap:8,alignItems:'flex-start',minHeight:44}}><input type="checkbox" checked={deleteAck} onChange={event=>setDeleteAck(event.target.checked)} style={{width:24,height:24,flex:'none'}}/><span>I have the new backup file and I know its passphrase.</span></label>
   <div className="exposure-actions"><button type="button" style={control} disabled={!deleteAck} onClick={deleteOld}>Delete the old copies</button></div></div>}
  {notice&&<p role="status" className="exposure-note">{notice}</p>}
  {error&&<p role="alert" className="exposure-error">{error}</p>}
 </div></div>;
}
