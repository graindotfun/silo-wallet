'use client';
import {useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {BookUser,Check,Trash2,X} from 'lucide-react';
import {SiloAddressText} from './silo-address-text';
import {SILO_CONTACT_CHAINS,SILO_CONTACT_CHAIN_NAMES,SILO_CONTACTS_KEY,addSiloContact,mergeSiloContacts,readSiloContacts,removeSiloContact,renameSiloContact,siloContactAddress,siloContactCheck,siloContactsForChain,writeSiloContacts} from '@/lib/silo/contacts.mjs';
import {attachSiloContacts,openSiloBackupContacts,siloBackupHasContacts} from '@/lib/silo/contacts-backup.mjs';
import {isSiloUnifiedBackup,siloBackupExportId,siloBackupFileName} from '@/lib/silo/unified-backup.mjs';
import {prepareSiloBackupDownload,startSiloBackupDownload,type SiloBackupDownload,type SiloBackupExport} from './silo-backup-parts';

/** The address book. Everything lives in this browser (localStorage); no request is made and nothing is reported anywhere.
 * A saved address is only ever put into a Send field when the person taps it. */
export type SiloContactChain='solana'|'xmr'|'evm'|'btc';
export type SiloContact={id:string;name:string;chain:SiloContactChain;address:string;createdAt:number};
type Snapshot={contacts:SiloContact[];ok:boolean;dropped:number};
const EVENT='silo-contacts-changed';
const EMPTY:Snapshot={contacts:[],ok:true,dropped:0};
let cache:{raw:string|null;value:Snapshot}|null=null;
function storage():Storage|null{try{return window.localStorage;}catch{return null;}}
const BLOCKED:Snapshot={contacts:[],ok:false,dropped:0};
function snapshot():Snapshot{
 const store=storage();if(!store)return BLOCKED;
 let raw:string|null=null;try{raw=store.getItem(SILO_CONTACTS_KEY);}catch{return BLOCKED;}
 if(cache&&cache.raw===raw)return cache.value;
 cache={raw,value:readSiloContacts(store) as Snapshot};return cache.value;
}
const subscribe=(change:()=>void)=>{const on=(event:Event)=>{if(event.type!=='storage'||(event as StorageEvent).key===SILO_CONTACTS_KEY||(event as StorageEvent).key===null)change();};window.addEventListener('storage',on);window.addEventListener(EVENT,on);return()=>{window.removeEventListener('storage',on);window.removeEventListener(EVENT,on);};};
export function useSiloContacts(){
 const book=useSyncExternalStore(subscribe,snapshot,()=>EMPTY);
 const commit=useCallback((next:SiloContact[])=>{const store=storage();if(!store)throw Object.assign(Error('This browser would not save your contacts. Check storage settings and try again.'),{siloContact:'storage'});writeSiloContacts(store,next);window.dispatchEvent(new Event(EVENT));},[]);
 return {...book,commit};
}
const say=(failure:unknown)=>failure instanceof Error?failure.message:'Something went wrong. Nothing was changed.';

/** Under a Send "To" field: a Contacts button (tap a name to fill the field), the saved name when the address matches one, a clear
 * warning when it only looks like one, and a one-tap way to save a new address. Never fills the field by itself. */
export function SiloContactAssist({chain,value,onPick,disabled=false}:{chain:SiloContactChain;value:string;onPick:(address:string)=>void;disabled?:boolean}){
 const {contacts,commit}=useSiloContacts();
 const [open,setOpen]=useState(false),[saving,setSaving]=useState(false),[name,setName]=useState(''),[error,setError]=useState('');
 const close=useRef<HTMLButtonElement>(null);
 const mine=siloContactsForChain(contacts,chain) as SiloContact[];
 const check=siloContactCheck(contacts,chain,value) as {kind:'exact'|'lookalike'|'none';contact?:SiloContact};
 let valid=false;try{siloContactAddress(chain,value);valid=true;}catch{valid=false;}
 useEffect(()=>{if(!open)return;close.current?.focus();const key=(event:globalThis.KeyboardEvent)=>{if(event.key==='Escape')setOpen(false);};document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);},[open]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- a changed address closes any half-finished save
 useEffect(()=>{setSaving(false);setError('');setName('');},[value,chain]);
 function save(){try{commit(addSiloContact(contacts,{name,chain,address:value}));setSaving(false);setName('');setError('');}catch(failure){setError(say(failure));}}
 return <div className="silo-contact-assist" data-chain={chain}>
  <button type="button" className="silo-contact-open" disabled={disabled} onClick={()=>setOpen(true)}><BookUser size={18} aria-hidden="true"/>Contacts{mine.length?` (${mine.length})`:''}</button>
  {check.kind==='exact'&&check.contact&&<p className="silo-contact-known" role="status"><Check size={16} aria-hidden="true"/>Saved contact: <strong>{check.contact.name}</strong></p>}
  {check.kind==='lookalike'&&check.contact&&<div className="silo-contact-warning" role="alert"><p><strong>Check this address.</strong> It starts and ends like your saved contact <strong>{check.contact.name}</strong>, but it is a different address.</p><p>Saved:</p><SiloAddressText address={check.contact.address}/><p>This one:</p><SiloAddressText address={value.trim()}/><p>Scammers send small payments from look-alike addresses so you copy the wrong one from your history. Only continue if you meant this one.</p></div>}
  {check.kind==='none'&&valid&&!saving&&!disabled&&<button type="button" className="silo-contact-save" onClick={()=>setSaving(true)}>Save as contact</button>}
  {saving&&<div className="silo-contact-form"><label>Name<input value={name} maxLength={40} autoFocus autoComplete="off" onChange={event=>{setName(event.target.value);setError('');}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();save();}}}/></label><div className="silo-contact-actions"><button type="button" className="silo-primary" onClick={save}>Save</button><button type="button" onClick={()=>setSaving(false)}>Cancel</button></div></div>}
  {error&&<p className="exposure-note" role="alert">{error}</p>}
  {open&&<div className="silo-sheet-scrim" onClick={()=>setOpen(false)}/>}
  {open&&<div className="silo-sheet silo-contact-sheet" role="dialog" aria-modal="true" aria-labelledby="silo-contact-title">
   <header><h2 id="silo-contact-title">Contacts · {SILO_CONTACT_CHAIN_NAMES[chain]}</h2><button ref={close} type="button" className="silo-icon-button" aria-label="Close" onClick={()=>setOpen(false)}><X size={22} aria-hidden="true"/></button></header>
   <div className="silo-sheet-body">
    {mine.length===0&&<p className="exposure-note">No {SILO_CONTACT_CHAIN_NAMES[chain]} contacts yet. Paste an address in the To field, then tap Save as contact.</p>}
    {mine.map(contact=><button key={contact.id} type="button" className="silo-contact-row" onClick={()=>{onPick(contact.address);setOpen(false);}}><strong>{contact.name}</strong><SiloAddressText address={contact.address}/></button>)}
    {!storage()&&<p className="exposure-note" role="alert">This browser does not allow saving contacts.</p>}
   </div>
  </div>}
 </div>;
}

/** Settings page: add, rename, delete, and bring contacts back from a backup file (merge or replace). */
export function SiloAddressBook(){
 const {contacts,ok,dropped,commit}=useSiloContacts();
 const [chain,setChain]=useState<SiloContactChain>('solana'),[name,setName]=useState(''),[address,setAddress]=useState(''),[error,setError]=useState(''),[note,setNote]=useState('');
 const [editing,setEditing]=useState<string|null>(null),[draft,setDraft]=useState(''),[confirmDelete,setConfirmDelete]=useState<string|null>(null);
 const [target,setTarget]=useState<Record<string,unknown>|null>(null),[targetPass,setTargetPass]=useState(''),[targetPass2,setTargetPass2]=useState(''),[saving,setSaving]=useState(false),[link,setLink]=useState<SiloBackupDownload|null>(null);
 const [file,setFile]=useState<unknown>(null),[filePass,setFilePass]=useState(''),[mode,setMode]=useState<'merge'|'replace'>('merge'),[restoring,setRestoring]=useState(false);
 function add(){try{commit(addSiloContact(contacts,{name,chain,address}));setName('');setAddress('');setError('');setNote('Saved.');}catch(failure){setError(say(failure));setNote('');}}
 function rename(id:string){try{commit(renameSiloContact(contacts,id,draft));setEditing(null);setError('');}catch(failure){setError(say(failure));}}
 function remove(id:string){try{commit(removeSiloContact(contacts,id));setConfirmDelete(null);setError('');}catch(failure){setError(say(failure));}}
 function choose(picked:File|undefined){
  setFile(null);setNote('');setError('');if(!picked)return;
  if(picked.size>192*1024*1024){setError('That file is too large to be a Silo backup.');return;}
  void picked.text().then(text=>{const parsed=JSON.parse(text);if(!siloBackupHasContacts(parsed)){setError('This backup file has no saved contacts. Backups made before the address book do not include them.');return;}setFile(parsed);}).catch(()=>setError('That file could not be read as a Silo backup.'));
 }
 async function addToFile(){
  if(!target||saving)return;setSaving(true);setError('');setNote('');
  try{
   const sealed=await attachSiloContacts(target,contacts,targetPass) as Record<string,unknown>;const file={...sealed,exportId:siloBackupExportId()} as Record<string,unknown>&{exportId:string};
   const exported={exportId:file.exportId,fileName:siloBackupFileName(file),file,zones:[],excluded:[]} as unknown as SiloBackupExport;
   setLink(startSiloBackupDownload(prepareSiloBackupDownload(exported)));setNote('Done. Your contacts are sealed inside the new copy of the file. Keep it with your other backups.');setTarget(null);setTargetPass('');setTargetPass2('');
  }catch(failure){setError(say(failure));}finally{setSaving(false);}
 }
 function chooseTarget(picked:File|undefined){
  setTarget(null);setNote('');setError('');setLink(null);if(!picked)return;
  if(picked.size>192*1024*1024){setError('That file is too large to be a Silo backup.');return;}
  void picked.text().then(text=>{const parsed=JSON.parse(text);if(!isSiloUnifiedBackup(parsed)){setError('Choose a combined Silo backup file (it holds your wallets together). A single-wallet file cannot carry contacts.');return;}setTarget(parsed);}).catch(()=>setError('That file could not be read as a Silo backup.'));
 }
 async function restore(){
  if(!file||restoring)return;setRestoring(true);setError('');setNote('');
  try{
   const {contacts:incoming,dropped:skipped}=await openSiloBackupContacts(file,filePass);
   const merged=mergeSiloContacts(contacts,incoming,mode);commit(merged.contacts);
   setNote(mode==='replace'?`Replaced your ${merged.replaced} saved contact${merged.replaced===1?'':'s'} with ${merged.added} from the backup.`:`Added ${merged.added} contact${merged.added===1?'':'s'}; ${merged.skipped} already saved and left as they were.`+(skipped?` ${skipped} entr${skipped===1?'y was':'ies were'} not valid and skipped.`:''));
   setFile(null);setFilePass('');
  }catch(failure){setError(failure instanceof Error&&(failure as {siloDecrypt?:string}).siloDecrypt?'That passphrase does not open the contacts in this file. Use the passphrase of the wallet that made the backup.':say(failure));}
  finally{setRestoring(false);}
 }
 return <section className="silo-contacts exposure-panel" aria-label="Contacts">
  <p className="silo-fine">Saved on this device only. Silo never sends your contacts anywhere. The list is not encrypted on this device, so anyone who can open this browser profile can read it. Inside a backup file it is sealed with your passphrase.</p>
  {!ok&&<p className="exposure-note" role="alert">Your saved contacts could not be read in this browser, so none are shown. Nothing was deleted by this screen.</p>}
  {dropped>0&&<p className="exposure-note" role="status">{dropped} saved entr{dropped===1?'y was':'ies were'} not valid and {dropped===1?'is':'are'} hidden.</p>}
  <div className="silo-contact-form">
   <label>Network<select value={chain} onChange={event=>{setChain(event.target.value as SiloContactChain);setError('');}}>{SILO_CONTACT_CHAINS.map(id=><option key={id} value={id}>{SILO_CONTACT_CHAIN_NAMES[id as SiloContactChain]}</option>)}</select></label>
   <label>Name<input value={name} maxLength={40} autoComplete="off" onChange={event=>{setName(event.target.value);setNote('');}}/></label>
   <label>Address<input value={address} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={event=>{setAddress(event.target.value);setNote('');}}/></label>
   <button type="button" className="silo-primary" disabled={!name.trim()||!address.trim()} onClick={add}>Save contact</button>
  </div>
  {error&&<p className="exposure-note" role="alert">{error}</p>}{note&&<p className="exposure-note" role="status">{note}</p>}
  {contacts.length===0?<p className="silo-fine">No contacts yet.</p>:<ul className="silo-contact-list">{(contacts as SiloContact[]).map(contact=><li key={contact.id}>
   {editing===contact.id?<div className="silo-contact-form"><label>Name<input value={draft} maxLength={40} autoFocus autoComplete="off" onChange={event=>setDraft(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')rename(contact.id);}}/></label><div className="silo-contact-actions"><button type="button" className="silo-primary" onClick={()=>rename(contact.id)}>Save name</button><button type="button" onClick={()=>setEditing(null)}>Cancel</button></div></div>
   :<><div><strong>{contact.name}</strong> <small>{SILO_CONTACT_CHAIN_NAMES[contact.chain]}</small></div><SiloAddressText address={contact.address}/>
    <div className="silo-contact-actions">{confirmDelete===contact.id?<><button type="button" className="silo-danger" onClick={()=>remove(contact.id)}><Trash2 size={16} aria-hidden="true"/>Delete {contact.name}</button><button type="button" onClick={()=>setConfirmDelete(null)}>Keep</button></>:<><button type="button" onClick={()=>{setEditing(contact.id);setDraft(contact.name);setError('');}}>Rename</button><button type="button" onClick={()=>setConfirmDelete(contact.id)}>Delete</button></>}</div></>}
  </li>)}</ul>}
  <details className="silo-review"><summary>Save contacts into a backup file</summary>
   <p className="silo-fine">Wallet backups made from the Monero screen already include your contacts. For any other combined backup, add them here. They are sealed with the passphrase you type, never stored in plain text. Use the exact passphrase of your wallet, typed twice, so the contacts open later with it. A file made when you switch to one passphrase does not carry contacts; add them here afterwards.</p>
   <label className="silo-file">Choose combined backup file<input type="file" accept="application/json,.json" onChange={event=>{chooseTarget(event.target.files?.[0]);event.target.value='';}}/></label>
   {target!==null&&<div className="silo-contact-form"><label>Passphrase<input type="password" value={targetPass} autoComplete="current-password" onChange={event=>setTargetPass(event.target.value)}/></label><label>Type it again<input type="password" value={targetPass2} autoComplete="off" onChange={event=>setTargetPass2(event.target.value)}/></label>
    <button type="button" className="silo-primary" disabled={saving||contacts.length===0||targetPass.length<12||targetPass!==targetPass2} onClick={()=>void addToFile()}>{saving?<span role="status"><span className="silo-wait-dot" aria-hidden="true"/>Sealing…</span>:'Add contacts to a copy of this file'}</button>{contacts.length===0&&<p className="silo-fine">Save a contact first.</p>}</div>}
   {link&&<a className="silo-save-link" href={link.url} download={link.fileName}>Save the file again</a>}
  </details>
  <details className="silo-review"><summary>Bring contacts back from a backup file</summary>
   <p className="silo-fine">Use a combined backup exported from this address book. The contacts open with the passphrase of the wallet that exported the file.</p>
   <label className="silo-file">Choose backup file<input type="file" accept="application/json,.json" onChange={event=>{choose(event.target.files?.[0]);event.target.value='';}}/></label>
   {file!==null&&<div className="silo-contact-form">
    <label>Passphrase<input type="password" value={filePass} autoComplete="current-password" onChange={event=>setFilePass(event.target.value)}/></label>
    <div role="radiogroup" aria-label="How to bring them back" className="silo-contact-mode"><label><input type="radio" name="silo-contact-mode" checked={mode==='merge'} onChange={()=>setMode('merge')}/> Add to my contacts (keep what I have)</label><label><input type="radio" name="silo-contact-mode" checked={mode==='replace'} onChange={()=>setMode('replace')}/> Replace my contacts with the file&apos;s</label></div>
    <button type="button" className="silo-primary" disabled={restoring||filePass.length<12} onClick={()=>void restore()}>{restoring?<span role="status"><span className="silo-wait-dot" aria-hidden="true"/>Opening…</span>:mode==='replace'?'Replace contacts':'Add contacts'}</button>
   </div>}
  </details>
 </section>;
}
