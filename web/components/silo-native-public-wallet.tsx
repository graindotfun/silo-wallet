'use client';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {SiloSecretField} from './silo-secret-field';
import {Download,LockKeyhole} from 'lucide-react';
import {siloPassphraseProblem} from '@/lib/silo/passphrase-strength.mjs';
import {bindSiloIdleLock} from '@/lib/silo/idle-lock.mjs';
import {siloEvmAddress} from '@/lib/silo/evm.mjs';
import {siloFailureReason} from '@/lib/silo/failure-reason.mjs';
import {siloBackupFileNote} from '@/lib/silo/unified-backup.mjs';
import {SiloAddressText} from './silo-address-text';
import {SiloCustodyNote} from './silo-custody-note';
import {SiloReceiveAddress} from './silo-receive-address';
import {SiloReadyMoment,SiloBackedUpMoment} from './silo-moment';
import {useSiloHydrated,siloReadyState} from './silo-hydrated';
import {useSiloSharedPassphrase} from './silo-shared-passphrase';
import {isSiloUnifiedBackup,siloBackupPart,siloBackupExportId,siloBackupFileName} from '@/lib/silo/unified-backup.mjs';
import {archiveLegacyEnvelope,listLegacyEnvelopes} from '@/lib/silo/legacy-envelopes.mjs';
import {siloPartDigest} from '@/lib/silo/one-passphrase-flow.mjs';
import {SILO_MAX_IMPORT_BYTES} from '@/lib/silo/local-envelope.mjs';
import {siloNativeOriginAllowed} from '@/lib/silo/native-origin.mjs';
import {useSiloBackupParts,prepareSiloBackupDownload,startSiloBackupDownload,SiloBackupExportStatus,type SiloBackupExport,type SiloBackupDownload} from './silo-backup-parts';
import type {NativeChain,NativeEnvelope,NativeKeyringSession,NativeKeyringStore} from '@/lib/silo/native-keyring.mjs';
export type SiloNativeSession=NativeKeyringSession;
type Kind='create'|'import'|'restore'|'unlock';
const LABELS={solana:{name:'Solana',key:'Solana private key',format:'Base58 private key in the 64-byte keypair form (about 88 characters).',network:'Solana mainnet'},evm:{name:'EVM',key:'EVM private key',format:'64 hexadecimal characters, with or without 0x.',network:'Ethereum, Base and BNB Smart Chain mainnets · one address'},btc:{name:'Bitcoin',key:'Bitcoin key',format:'Not importable: Bitcoin wallets are created in Silo and restored from a Silo backup file.',network:'Bitcoin test network (testnet or signet) · test coins only'}} as const;
const MAX_BACKUP=16*1024;
// Only a digest of the exact encrypted copy is kept, never a key, passphrase, address or ciphertext. It is local UX evidence, not proof of a restore on another device.
const proofKey=(chain:string)=>`grain-silo-native-receive-proof-v1:${chain}`;
async function fingerprint(envelope:NativeEnvelope){const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(envelope,Object.keys(envelope).sort()))));return Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join('');}
function readProof(chain:string,print:string){try{const text=localStorage.getItem(proofKey(chain));if(typeof text!=='string'||text.length>256)return false;const row=JSON.parse(text);return Boolean(row&&Object.keys(row).length===3&&row.version===1&&row.fingerprint===print&&typeof row.basis==='string');}catch{return false;}}
function recordProof(chain:string,print:string,basis:'exported-file'|'imported-key'|'restored-file'){try{const text=JSON.stringify({version:1,fingerprint:print,basis});localStorage.setItem(proofKey(chain),text);return localStorage.getItem(proofKey(chain))===text;}catch{return false;}}
function nativeBackup(value:unknown,chain:NativeChain,keyNetwork:'mainnet'|'devnet'|'testnet'|'signet'='mainnet'):NativeEnvelope{
 // A combined Silo backup (Solana and Monero in one file) yields its Solana part; a Solana-only file passes through unchanged.
 // The file itself may be large (the Monero part carries a scan cache); the size bound applies to this chain's part.
 const row=(isSiloUnifiedBackup(value)?siloBackupPart(value,chain,keyNetwork):value) as Partial<NativeEnvelope>|null;
 if(JSON.stringify(row??null).length>MAX_BACKUP)throw Error('too-large');if(!row||typeof row!=='object'||row.scope!=='silo-native-keyring-v1')throw Error('not-native');if(row.chain!==chain||row.network!==keyNetwork||typeof row.address!=='string')throw Error('other-chain');return row as NativeEnvelope;}
// One store handle per chain at a time in this tab: the store's exclusive Web Lock would refuse a second one.
const queues:Record<NativeChain,Promise<unknown>>={solana:Promise.resolve(),evm:Promise.resolve(),btc:Promise.resolve()};
function exclusive<T>(chain:NativeChain,run:()=>Promise<T>):Promise<T>{const next=queues[chain].then(run,run);queues[chain]=next.catch(()=>{});return next;}
const shown=(chain:NativeChain,address:string)=>{if(chain!=='evm')return address;try{return siloEvmAddress(address);}catch{return address;}};
// Core messages carry no key material; known ones are reworded, anything else gets the caller's fallback.
function nativeFailure(failure:unknown,name:string,fallback:string){
 const reason=failure instanceof Error?failure.message:'';
 // A combined-backup file problem (wrong network, no Solana part, not a backup) already names what is wrong, without secrets.
 if((failure as {siloBackup?:string}|null)?.siloBackup&&reason)return reason;
 // A tab opened before a release asks for a lazily loaded file that the new release replaced (older builds are not kept), which the browser reports as a failed module import.
 if(/dynamically imported module|Importing a module script failed|Loading chunk|error loading dynamically/i.test(reason))return 'Silo was updated while this page was open. Reload the page, then try again. Nothing was changed.';
 if(reason==='too-large')return `This file is too large to be a Silo ${name} wallet backup.`;
 if(reason==='stored'||reason==='A native wallet already exists or its store is closed.')return `A Silo ${name} wallet is already saved in this browser. It was not replaced. Unlock it, or remove it under \u201cCan\u2019t unlock? Remove this wallet from this browser\u201d (no passphrase needed) to import another.`;
 if(reason==='Native wallet is open in another tab.')return `This ${name} wallet is open in another Silo tab. Lock it there first. Nothing was changed.`;
 if(reason==='The passphrase or encrypted native wallet is invalid.')return 'Nothing was decrypted: this passphrase does not open this encrypted wallet, or the backup is damaged. Nothing was changed.';
 if(reason==='No native wallet is stored.')return `No Silo ${name} wallet is saved in this browser.`;
 if(reason==='Native wallet storage and exclusive tab locking are required.')return 'This browser lacks the local storage or tab locking Silo needs. Nothing was created or changed.';
 if(reason==='Native wallet storage is unavailable.'||reason==='Native wallet storage failed.')return "This browser's local wallet storage could not be used. Nothing was changed.";
 if(reason==='not-native')return `This file is not an encrypted Silo ${name} wallet backup.`;
 if(reason==='other-chain')return 'This backup is for a different network or wallet type.';
 if(reason==='Backup belongs to a different wallet.')return 'This backup opens, but it belongs to a different wallet and will not restore this one. Export a new backup.';
 if(/^(Use |Avoid |Too many |This is close |Digits alone |Invalid (EVM|Solana) key)/.test(reason))return reason;
 // Unknown failures state their real reason (error name and a cleaned, shortened message; nothing that could hold a key or passphrase) so a person can say what happened.
 return `${fallback} Reason: ${siloFailureReason(failure)}`;
}
/** Silo's own Solana or EVM wallet: create, import a private key, restore an encrypted backup or unlock, all in this browser.
 * Secrets stay in local form state and are cleared once processed; no server, cookie or log receives them. Signing is held.
 * `receive`: details to show the receive address here; null when the parent shows address and receive itself; omitted shows the address only.
 * Parents use the session's address only while onReceiveReady(true): a new wallet first needs a verified exported backup. */
export function SiloNativePublicWallet({keyNetwork='mainnet',chain,permitted,heldReason='Real-funds wallet creation is held pending release review.',reviewedOrigin,mainnetMode,receiveEnabled=true,limitedSwapSigningEnabled=false,sendEnabled=false,receive,onSession,onReceiveReady,onBackupVerified,onBackupNeeded,getAccountBackup}:{keyNetwork?:'mainnet'|'devnet'|'testnet'|'signet';getAccountBackup?:(chain:NativeChain)=>Promise<NativeEnvelope>;chain:NativeChain;permitted:boolean;heldReason?:string;reviewedOrigin:string|null;mainnetMode:boolean;receiveEnabled?:boolean;limitedSwapSigningEnabled?:boolean;sendEnabled?:boolean;receive?:{asset:string;network:string;note?:string}|null;onSession:(session:SiloNativeSession|null)=>void;onReceiveReady?:(ready:boolean)=>void;onBackupVerified?:(ready:boolean)=>void;onBackupNeeded?:(needed:boolean)=>void}){
 // One saved proof per wallet slot; a Bitcoin wallet has one slot per network, so a test-network proof can never stand for a mainnet wallet.
 const proofSlot=chain==='btc'?`btc-${keyNetwork}`:chain;
 const label=chain==='solana'&&keyNetwork==='devnet'?{...LABELS[chain],network:'Solana devnet'}:chain==='btc'&&keyNetwork==='mainnet'?{...LABELS.btc,network:'Bitcoin mainnet · real funds'}:LABELS[chain],name=label.name;
 const [stored,setStored]=useState<boolean|null>(null),[storageProblem,setStorageProblem]=useState(''),[probeEpoch,setProbeEpoch]=useState(0),[idleEpoch,setIdleEpoch]=useState(0);
 // Sol (23 Oct, Q4): the custody facts are stated before Create/Unlock instead of a mandatory tick. Q2: no creation-time
 // confirm field; the backup check re-enters the passphrase independently before the address appears.
 const accepted=true,[passphrase,setPassphrase]=useState('');
 // One passphrase for both wallets (UX only, in memory, see silo-shared-passphrase.tsx). Only the Solana wallet joins; EVM stays separate.
 const shared=useSiloSharedPassphrase(),sharing=shared.active&&(chain==='solana'||chain==='evm'||chain==='btc'),[ownPass,setOwnPass]=useState(false),autoTried=useRef(0);
 const [privateKey,setPrivateKey]=useState(''),[preview,setPreview]=useState<string|null>(null),[previewConfirmed,setPreviewConfirmed]=useState(false),[restoreFile,setRestoreFile]=useState<NativeEnvelope|null>(null);
 const [restoreSource,setRestoreSource]=useState<'file'|'account'|null>(null);
 const [address,setAddress]=useState<string|null>(null),[proven,setProven]=useState(false),[exported,setExported]=useState(false),[verifyPassphrase,setVerifyPassphrase]=useState(''),[verifyResult,setVerifyResult]=useState<{ok:boolean;text:string}|null>(null);
 const [moment,setMoment]=useState<'ready'|'backed-up'|null>(null);
 const [revealPassphrase,setRevealPassphrase]=useState(''),[revealedKey,setRevealedKey]=useState<string|null>(null),[revealBusy,setRevealBusy]=useState(false),[revealError,setRevealError]=useState('');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[removeAck,setRemoveAck]=useState(false),[restoreNote,setRestoreNote]=useState(''),[removeWord,setRemoveWord]=useState('');
 // Controls stay disabled until React has hydrated; the combined-backup registry is present only inside the full workspace.
 const hydrated=useSiloHydrated(),backupParts=useSiloBackupParts();const [lastExport,setLastExport]=useState<SiloBackupExport|null>(null),[saveLink,setSaveLink]=useState<SiloBackupDownload|null>(null);
 const session=useRef<NativeKeyringSession|null>(null),print=useRef(''),epoch=useRef(0),mounted=useRef(true),root=useRef<HTMLDivElement|null>(null);
 const revealEpoch=useRef(0);
 // Closing the "Export private key" panel (the <summary> toggle, not just the Hide button) must clear the
 // key and cancel a pending reveal just as surely as Hide does (Sol's review of 751307e0, open finding).
 function closeReveal(){revealEpoch.current++;setRevealedKey(null);setRevealPassphrase('');setRevealBusy(false);setRevealError('');}
 const onSessionRef=useRef(onSession),onReceiveRef=useRef(onReceiveReady),onBackupRef=useRef(onBackupVerified),neededRef=useRef(onBackupNeeded),lockLatest=useRef<(message:string,reload?:boolean)=>void>(()=>{});
 useEffect(()=>{onSessionRef.current=onSession;onReceiveRef.current=onReceiveReady;onBackupRef.current=onBackupVerified;neededRef.current=onBackupNeeded;lockLatest.current=ended;});
 useEffect(()=>{onReceiveRef.current?.(Boolean(address)&&proven&&receiveEnabled);onBackupRef.current?.(Boolean(address)&&proven);neededRef.current?.(Boolean(address)&&!proven);},[address,proven,receiveEnabled]);
 // Reads only whether a wallet is stored. Right after a lock the Web Lock may still be releasing, so a refusal is retried once.
 useEffect(()=>{let live=true;const read=async()=>{const {openNativeKeyringStore}=await import('@/lib/silo/native-keyring-store.mjs');const store=await openNativeKeyringStore(chain,{network:keyNetwork});try{return Boolean(await store.read());}finally{store.close();}};
  void exclusive(chain,()=>read().catch(async failure=>{if(!(failure instanceof Error&&failure.message==='Native wallet is open in another tab.'))throw failure;await new Promise(resolve=>setTimeout(resolve,300));return read();})).then(found=>{if(live){setStored(found);setStorageProblem('');}},failure=>{if(live){setStored(null);setStorageProblem(nativeFailure(failure,name,"This browser's local wallet storage could not be read. Nothing was changed."));}});
  return()=>{live=false;};},[chain,name,probeEpoch,keyNetwork]);
 // Each cleanup step wrapped on its own (Sol's review of bc7b066b): a throw from the store's close(), the session's
 // lock(), or the parent's callback must not block the others. No reload here: the component is unmounting, not the
 // page. This does not erase key material a still-running open() call is holding (Sol's review of 33dd13ec); that
 // async call keeps its own passphrase/key copies alive in JS memory until it resolves or rejects, unmount or not.
 useEffect(()=>{mounted.current=true;const version=epoch,active=session,notify=onSessionRef;return()=>{mounted.current=false;version.current++;const open=active.current;active.current=null;try{pendingStore.current?.close();}catch{/* Best-effort close. */}pendingStore.current=null;if(open){try{open.lock();}catch{/* lock failed or already locked. */}try{notify.current(null);}catch{/* Parent callback failed. */}}};},[]);
 // Locking an open wallet reloads the page, as the native zones do: zeroing the key bytes cannot erase the passphrase strings
 // and library copies left in JS memory, while a reload discards the page's whole memory (red-team pass, 26 Oct 2026, MT-2).
 // Every cleanup step below is wrapped on its own (Sol's review of 92cac22f): a throw from the store's close()
 // or from the parent's onSession callback must never skip closeReveal() or the reload that discards JS memory.
 // Clears this browser's encrypted copy without the passphrase (a person who cannot unlock must still be able to import another wallet). Only reachable while locked; typed REMOVE and the backup tick are the safeguards.
 async function removeStored(){if(!removeAck||removeWord.trim()!=='REMOVE'||busy||session.current)return;const operation=++epoch.current;setBusy(true);setError('');setNotice('');
  try{await exclusive(chain,async()=>{const {openNativeKeyringStore}=await import('@/lib/silo/native-keyring-store.mjs');const store=await openNativeKeyringStore(chain,{network:keyNetwork});try{await store.remove();}finally{store.close();}});
   try{localStorage.removeItem(proofKey(proofSlot));}catch{/* A removed wallet cannot hand its backup proof to a new one. */}
   if(operation===epoch.current&&mounted.current){setStored(false);setRemoveAck(false);setRemoveWord('');setNotice(`This browser's encrypted ${name} wallet was removed. Only your exported backup or recovery phrase can restore it.`);}
  }catch(failure){if(operation===epoch.current&&mounted.current)setError(nativeFailure(failure,name,'Nothing was removed. Try again.'));}
  finally{if(operation===epoch.current&&mounted.current)setBusy(false);}}
 function ended(message='',reload=false){shared.clear(chain);setOwnPass(false);epoch.current++;fileSelection.current++;const active=session.current;session.current=null;try{pendingStore.current?.close();}catch{/* Best-effort close. */}pendingStore.current=null;openStore.current=null;print.current='';try{active?.lock();}catch{/* lock failed or already locked. */}setAddress(null);setProven(false);setExported(false);setVerifyPassphrase('');setVerifyResult(null);setPassphrase('');setPrivateKey('');setPreview(null);setPreviewConfirmed(false);setRestoreFile(null);setRestoreSource(null);setBusy(false);setError('');setNotice(message);setIdleEpoch(value=>value+1);setProbeEpoch(value=>value+1);closeReveal();if(active){try{onSessionRef.current(null);}catch{/* Parent callback failed; still reload below. */}}if(active||reload)location.reload();}
 // Inactivity or hiding the page locks an open wallet, or one whose secrets were typed, and reloads the page, as in the native zones.
 useEffect(()=>bindSiloIdleLock({root:root.current,isActive:()=>Boolean(session.current),lock:()=>{if(mounted.current)lockLatest.current('',true);}}),[idleEpoch]);
 const pendingStore=useRef<NativeKeyringStore|null>(null),openStore=useRef<NativeKeyringStore|null>(null),fileSelection=useRef(0);
 // Unlocking the other wallet shares its passphrase: try it here once per share, silently. A refusal shows this wallet's own field and never retries or touches the other wallet.
 useEffect(()=>{if(!sharing||stored!==true||!permitted||busy||session.current||address||!hydrated)return;const value=shared.get();if(!value||autoTried.current===shared.version)return;if(!siloNativeOriginAllowed({mainnetMode,origin:location.origin,reviewedOrigin}))return;if(!shared.unlock.canOpen(chain)||!shared.unlock.started(chain))return;autoTried.current=shared.version;void open('unlock',value).finally(()=>shared.unlock.settle(chain));});
 // One unlock: when ANY wallet locks, this one disposes its session and cancels its own pending operations (ended bumps the epoch every in-flight open checks before publishing).
 useEffect(()=>{if(!sharing)return;return shared.unlock.registerDispose(chain,()=>{if(mounted.current)lockLatest.current('',false);});},[sharing,chain,shared.unlock.registerDispose]);
 // One unlock: whether this wallet exists in this browser (or is open), so the locked screen can show its status.
 // eslint-disable-next-line react-hooks/exhaustive-deps -- setPresent/setOpen are idempotent and only read the controller
 useEffect(()=>{if(!sharing)return;if(address)shared.unlock.setOpen(chain);else shared.unlock.setPresent(chain,stored===true);},[sharing,chain,stored,address]);
 const capabilityKey=JSON.stringify([chain,permitted,mainnetMode,reviewedOrigin,receiveEnabled]);
 const previousCapability=useRef(capabilityKey);
 // Reloads unconditionally (Sol's review of 92cac22f): typed secrets or an in-flight open() with no session yet
 // would otherwise survive a permission change, since ended()'s own reload only fires when a session was active.
 useLayoutEffect(()=>{if(previousCapability.current!==capabilityKey){previousCapability.current=capabilityKey;fileSelection.current++;ended('Wallet permission changed. Unlock only on the reviewed origin.',true);}},[capabilityKey]);
 const sharedValue=sharing?shared.get():'',usingShared=Boolean(sharedValue)&&stored===false&&!ownPass&&!restoreFile,effective=usingShared?sharedValue:passphrase;
 const weak=siloPassphraseProblem(effective);
 const newReady=accepted&&permitted&&!busy&&stored===false&&!weak&&effective.length>=12;
 async function open(kind:Kind,auto?:string){
  if(busy||session.current||!accepted)return;autoTried.current=shared.version;
  const secret=auto??effective;
  if(!permitted){setError(heldReason);return;}
  if(!siloNativeOriginAllowed({mainnetMode,origin:location.origin,reviewedOrigin})){setError('This is not the reviewed wallet origin. Nothing was created or unlocked.');return;}
  if(secret.length<12){setError('Enter a passphrase of at least 12 characters.');return;}
  if(kind==='create'||kind==='import'){const problem=siloPassphraseProblem(secret);if(problem){setError(`This passphrase is too easy to guess for an encrypted backup. ${problem}`);return;}}
  if(kind==='import'&&(!preview||!previewConfirmed||!privateKey)){setError('Check the private key and confirm its address first.');return;}
  if(kind==='restore'&&!restoreFile){setError('Choose an encrypted Silo backup file first.');return;}
  const generationAtStart=shared.generation(),fromShared=auto!==undefined||usingShared;
  const typed=secret,key=privateKey.trim(),expected=preview,backup=restoreFile,source=restoreSource,operation=++epoch.current,held:{store:NativeKeyringStore|null}={store:null};
  // Secret inputs are cleared as soon as they are captured; strings already in JS memory cannot be guaranteed erased.
  if(auto===undefined)setPassphrase('');setPrivateKey('');setBusy(true);setError('');setNotice('');
  let opened:NativeKeyringSession|null=null;
  // A failed lock() must not also skip closing the store (Sol's review of 33dd13ec): each is tried on its own,
  // the store close as a fallback regardless of whether lock() itself threw or already closed it.
  const discard=(session:NativeKeyringSession|null,store:NativeKeyringStore|null)=>{try{session?.lock();}catch{/* lock failed or the session was already locked. */}try{store?.close();}catch{/* store close failed or already closed. */}};
  try{
   opened=await exclusive(chain,async()=>{
    if(operation!==epoch.current||!mounted.current)throw Error('cancelled');
    const [{openNativeKeyringStore},core]=await Promise.all([import('@/lib/silo/native-keyring-store.mjs'),import('@/lib/silo/native-keyring.mjs')]);
    if(operation!==epoch.current||!mounted.current)throw Error('cancelled');
    const store=held.store=await openNativeKeyringStore(chain,{network:keyNetwork});pendingStore.current=store;
    if(operation!==epoch.current||!mounted.current){store.close();throw Error('cancelled');}
    // Creating, importing and restoring write this browser's single slot for the chain. A stored wallet is never replaced.
    if(kind!=='unlock'&&await store.read())throw Error('stored');
    // Re-checked immediately before minting key material (Sol's review of bc7b066b): a cancellation during the
    // read above must not let the keyring still be created, imported, restored or unlocked.
    if(operation!==epoch.current||!mounted.current){store.close();throw Error('cancelled');}
    return kind==='create'?core.createNativeKeyring({chain,passphrase:typed,store,network:keyNetwork}):kind==='import'?core.importNativeKeyring({chain,privateKey:key,passphrase:typed,store,network:keyNetwork}):kind==='restore'?core.restoreNativeKeyring({chain,backup:backup!,passphrase:typed,store,network:keyNetwork}):core.unlockNativeKeyring({chain,passphrase:typed,store,network:keyNetwork});
   });
   // Re-checked immediately on receiving the open session, before metadata()/exportBackup()/fingerprint (Sol's
   // review of bc7b066b): those keep key material alive longer than necessary for a session that is already stale.
   if(operation!==epoch.current||!mounted.current){discard(opened,held.store);return;}
   const meta=opened.metadata();
   if(meta.chain!==chain||meta.network!==keyNetwork||kind==='import'&&meta.address!==expected||kind==='restore'&&meta.address!==backup?.address)throw Error('identity');
   const digest=await fingerprint(opened.exportBackup());
   if(operation!==epoch.current||!mounted.current){discard(opened,held.store);return;}
   // A new wallet shows no receive address until an exported file is verified. An imported key or a restored file is already held outside this browser.
   const ready=kind==='unlock'?readProof(proofSlot,digest):kind==='import'||kind==='restore'&&source==='file';const saved=kind==='import'?recordProof(proofSlot,digest,'imported-key'):kind==='restore'&&source==='file'?recordProof(proofSlot,digest,'restored-file'):true;
   // Authority check immediately before publishing the session: a lock since this attempt started, or a rejected attempt token, discards the session.
   if(sharing&&(shared.generation()!==generationAtStart||(auto!==undefined&&!shared.unlock.report(chain,'open')))){discard(opened,held.store);return;}
   const active=opened;session.current=active;openStore.current=held.store;print.current=digest;held.store?.onClose?.(()=>{if(session.current===active&&mounted.current)ended('This wallet was locked because its local storage closed. Unlock it again.');});
   setAddress(meta.address);setProven(ready);setMoment(kind==='create'&&!ready?'ready':null);setStored(true);setExported(false);setVerifyResult(null);setPreview(null);setPreviewConfirmed(false);setRestoreFile(null);setRestoreSource(null);
   setNotice(`${kind==='create'?'Wallet created and encrypted in this browser. Export and verify its encrypted backup to show the receive address.':kind==='import'?'Private key imported and encrypted in this browser. Export an encrypted backup as well.':kind==='restore'?'Encrypted backup restored into this browser. Export and verify a separate file before receiving; account loading alone is not an offline backup check.':''}${saved?'':' The backup check could not be recorded in this browser, so it applies to this session only.'}`);
   onSessionRef.current(active);if(sharing){shared.unlock.setOpen(chain);if(!fromShared)shared.share(typed,generationAtStart);}
  }catch(failure){
   discard(opened,held.store);
   if(sharing&&auto!==undefined)shared.unlock.report(chain,failure instanceof Error&&failure.message==='The passphrase or encrypted native wallet is invalid.'?'wrong':failure instanceof Error&&/another tab/i.test(failure.message)?'in-use':'error');
   if(operation!==epoch.current||!mounted.current)return;
   if(kind==='import'){setPreview(null);setPreviewConfirmed(false);}
   setError(auto!==undefined&&failure instanceof Error&&failure.message==='The passphrase or encrypted native wallet is invalid.'?`This ${name} wallet uses a different passphrase. Enter it below. Nothing was changed.`:failure instanceof Error&&failure.message==='identity'?'The opened wallet did not match the confirmed address, so it was locked. Do not use it; report this.':nativeFailure(failure,name,kind==='unlock'?'The wallet could not be unlocked. Nothing was changed.':'Nothing was saved. The wallet could not be created, imported or restored in this browser.'));
   setProbeEpoch(value=>value+1);
  }finally{if(pendingStore.current===held.store)pendingStore.current=null;if(operation===epoch.current&&mounted.current)setBusy(false);}
 }
 // Validates the key and shows its public address before anything is encrypted or saved.
 async function checkKey(){
  if(busy||!privateKey.trim())return;const key=privateKey.trim(),operation=epoch.current;setBusy(true);setError('');setPreview(null);setPreviewConfirmed(false);
  try{const {previewNativePrivateKey}=await import('@/lib/silo/native-keyring.mjs');const result=previewNativePrivateKey({chain,privateKey:key,network:keyNetwork});if(result.chain!==chain||result.network!==keyNetwork)throw Error();if(operation===epoch.current&&mounted.current)setPreview(result.address);}
  catch(failure){if(operation===epoch.current&&mounted.current){setPrivateKey('');setError(nativeFailure(failure,name,`This is not a valid ${label.key}. Nothing was saved.`));}}
  finally{if(operation===epoch.current&&mounted.current)setBusy(false);}
 }
 function chooseRestore(file:File|undefined){setRestoreNote('');const selection=++fileSelection.current,operation=epoch.current;if(!file)return;setRestoreFile(null);setRestoreSource(null);if(file.size>SILO_MAX_IMPORT_BYTES){setError(`This file is too large to be a Silo ${name} wallet backup.`);return;}void file.text().then(text=>{if(selection!==fileSelection.current||operation!==epoch.current||!mounted.current)return;const parsed=JSON.parse(text),backup=nativeBackup(parsed,chain,keyNetwork);if(mounted.current){setRestoreFile(backup);setRestoreSource('file');setRestoreNote(siloBackupFileNote(parsed,chain));setError('');}}).catch(failure=>{if(selection===fileSelection.current&&operation===epoch.current&&mounted.current)setError(nativeFailure(failure,name,'Invalid encrypted backup file.'));});}
 async function loadAccountBackup(){
  if(!getAccountBackup||busy||stored!==false)return;
  const operation=++epoch.current,selection=++fileSelection.current;setBusy(true);setError('');setRestoreFile(null);setRestoreSource(null);
  try{const backup=nativeBackup(await getAccountBackup(chain),chain,keyNetwork);if(operation!==epoch.current||selection!==fileSelection.current||!mounted.current)return;setRestoreFile(backup);setRestoreSource('account');setNotice('Encrypted backup loaded from your unlocked account vault. Enter the original wallet backup passphrase above, review the address and explicitly restore. No local wallet was replaced.');}
  catch{if(operation===epoch.current&&mounted.current)setError('Account recovery is held or unavailable. Sign in, approve this device and unlock the synced vault in Settings. Nothing local was changed.');}
  finally{if(operation===epoch.current&&mounted.current)setBusy(false);}
 }
 // Combined backup: while this wallet is open, the workspace can ask for its sealed envelope (for an export started from the Monero zone).
 const registerBackupPart=backupParts?.register,announcePresence=backupParts?.announce;
 useEffect(()=>{if(!registerBackupPart||!address)return;return registerBackupPart(chain,{network:keyNetwork,envelope:async()=>{const active=session.current;if(!active)throw Error('Wallet locked.');return active.exportBackup();},
  // One-passphrase switch: replaces this browser's stored copy in ONE transaction through the store handle the open wallet already holds (no second lock, no reload
  // until the whole switch ends). The original is kept first (and read back); a failure to keep it replaces nothing. Rollback puts the original and its proof back.
  replace:async(incoming,context)=>{
   const {original,rollback}=context;
   const store=openStore.current;if(!session.current||!store||store.closed||typeof store.replace!=='function')throw Error('Wallet locked.');
   const next=nativeBackup(incoming,chain,keyNetwork);if(!await store.read())throw Error('No stored wallet.');
   // Bound to the exact verified preparation: only the part whose digest the switch verified may be written.
   if(!context.partDigest||await siloPartDigest(next)!==context.partDigest)throw Error('This is not the part that was checked. Nothing was changed.');
   if(!rollback){let proof:string|null=null;try{proof=localStorage.getItem(proofKey(proofSlot));}catch{/* no earlier proof to keep */}archiveLegacyEnvelope(localStorage,{zone:chain,envelope:original as NativeEnvelope,proof});}
   // Ownership: a put-back restores the original only over a copy that is still exactly the part this switch wrote.
   if(rollback&&(!context.writtenDigest||await siloPartDigest((await store.read()) as unknown as NativeEnvelope)!==context.writtenDigest))throw Error('The stored copy is no longer the one this switch wrote; it was left as it is.');
   context.written?.();await store.replace(next);
   if(JSON.stringify(await store.read())!==JSON.stringify(next))throw Error('The replaced copy did not read back.');
   if(rollback){const row=listLegacyEnvelopes(localStorage).find(item=>item.zone===chain&&item.envelope?.ciphertext===next.ciphertext);try{if(row&&row.proof===null)localStorage.removeItem(proofKey(proofSlot));else if(row)localStorage.setItem(proofKey(proofSlot),row.proof as string);}catch{/* the stored copy is already back */}}
   else recordProof(proofSlot,await fingerprint(next),'exported-file');
  }});},[registerBackupPart,chain,address,keyNetwork]);
 // Whether a Solana wallet exists in this browser at all, so a combined export that leaves it out can say so (D2).
 useEffect(()=>{if(!announcePresence)return;announcePresence(chain,address?'open':stored?'locked':'none');},[announcePresence,chain,address,stored]);
 async function exportBackup(){
  const active=session.current;if(!active||busy)return;const operation=epoch.current;
  // Membership of a combined export is fixed now; a wallet that locks meanwhile makes the export refuse (D2).
  const started=backupParts?.snapshot(),expected=started?.open??[];setBusy(true);
  try{
   // One file for the whole wallet when other zones are open; every export carries its own identifier, so no file name repeats.
   const own=active.exportBackup() as unknown as Record<string,unknown>,id=siloBackupExportId();
   const exported:SiloBackupExport=backupParts?await backupParts.exportWith(chain,own,expected,started?.revision):{exportId:id,fileName:siloBackupFileName(own,id),file:own,zones:[chain],excluded:[]};
   if(operation!==epoch.current||!mounted.current)return;
   // The save link stays available after an automatic download too: the browser never reports whether a file was saved (D5).
   setSaveLink(startSiloBackupDownload(prepareSiloBackupDownload(exported)));setExported(true);setLastExport(exported);setError('');
  }catch(failure){if(operation===epoch.current&&mounted.current)setError(failure instanceof Error&&(/busy/.test(failure.message)||(failure as {siloExport?:string}).siloExport)?failure.message:'Encrypted backup export failed. The wallet is unchanged.');}
  finally{if(operation===epoch.current&&mounted.current)setBusy(false);}
 }
 // Backup drill: an exported file must open with its passphrase and hold this wallet. This browser's own copy does not count.
 async function verifyFile(file:File|undefined){
  const active=session.current;if(!file||!active||busy)return;const typed=verifyPassphrase;setVerifyPassphrase('');
  if(file.size>SILO_MAX_IMPORT_BYTES){setVerifyResult({ok:false,text:`This file is too large to be a Silo ${name} wallet backup.`});return;}
  const operation=epoch.current;setBusy(true);setVerifyResult(null);
  try{const backup=nativeBackup(JSON.parse(await file.text()),chain,keyNetwork);await active.verifyBackup(backup,typed);if(operation!==epoch.current||!mounted.current)return;const saved=recordProof(proofSlot,print.current,'exported-file');setProven(true);setMoment('backed-up');setVerifyResult({ok:true,text:`This exported file opens with its passphrase and holds this wallet.${saved?'':' The check could not be recorded in this browser, so it applies to this session only.'} It does not prove the file is kept safely off this device.`});}
  catch(failure){if(operation===epoch.current&&mounted.current)setVerifyResult({ok:false,text:failure instanceof SyntaxError?'Invalid encrypted backup file.':nativeFailure(failure,name,'The backup could not be checked. Nothing was changed.')});}
  finally{if(operation===epoch.current&&mounted.current)setBusy(false);}
 }
 // Re-authenticates with the wallet passphrase (typed again, independent of the open session) before revealing the raw
 // signing key. Never sent anywhere; the caller (below) controls how long it stays rendered.
 async function revealKey(){
  const active=session.current;if(!active||revealBusy)return;
  const typed=revealPassphrase,operation=epoch.current,reveal=revealEpoch.current;
  setRevealPassphrase('');setRevealBusy(true);setRevealError('');
  const live=()=>operation===epoch.current&&reveal===revealEpoch.current&&mounted.current;
  try{const key=await active.revealSecretKey(typed);if(live())setRevealedKey(key);}
  catch(failure){if(live())setRevealError(nativeFailure(failure,name,'The private key could not be revealed. Nothing was changed.'));}
  finally{if(live())setRevealBusy(false);}
 }
 const hint=!stored&&passphrase.length>0?(passphrase.length<12?`${12-passphrase.length} more character${12-passphrase.length===1?'':'s'} needed (at least 12).`:weak?`For a new wallet: ${weak}`:null):null;
 const syncNote=getAccountBackup&&<p className="exposure-note">This is the encrypted local wallet copy. Account sync in Settings is separate and requires sign-in, device approval and vault unlock. Keep an exported encrypted backup; account login cannot reset its passphrase.</p>;
 const signingHeld=sendEnabled?null:chain==='btc'?<p className="silo-held silo-quiet-note" role="status">{keyNetwork==='mainnet'?'This Bitcoin wallet signs only a reviewed send that you approve, within the limit for this version.':'This Bitcoin wallet runs on a test network. It signs only a reviewed send that you approve. Its coins have no value.'}</p>:keyNetwork==='devnet'?<p className="silo-held silo-quiet-note" role="status">This devnet wallet signs only reviewed devnet sends and the test-memecoin trade, after you approve each one. Everything else stays held.</p>:limitedSwapSigningEnabled?<p className="silo-held" role="status">Limited SOL ↔ USDC trial: only an exact reviewed swap can request your approval. General sends and message signing remain held.</p>:<p className="silo-held" role="status">{receiveEnabled&&!proven?'Verify your backup first. Receive and sending open as soon as the exported file checks out.':<>Signing is held in this version. {receiveEnabled?'This Silo wallet can show its address and receive, but it cannot sign, send or swap yet.':'This private review allows wallet backup and recovery only. Receive, signing, sending and swap execution stay held.'}</>}</p>;
 const verifyFields=<><label>Passphrase of the backup<SiloSecretField name={`silo-${chain}-verify-passphrase`} value={verifyPassphrase} onChange={event=>setVerifyPassphrase(event.target.value)} autoComplete="current-password" disabled={busy}/></label><label className="silo-file">Choose the exported file<input type="file" accept="application/json,.json" disabled={busy||verifyPassphrase.length<12} onChange={event=>{void verifyFile(event.target.files?.[0]);event.target.value='';}}/></label>{verifyResult&&<p role="status" className={verifyResult.ok?'silo-verify-ok':'silo-verify-fail'}>{verifyResult.text}</p>}</>;
 return <div ref={root} data-silo-ready={siloReadyState(hydrated)}>
  {address?<div className="silo-inset">
   <div className="silo-public-connection"><span>Silo wallet · {label.network}</span><button onClick={()=>ended()}><LockKeyhole size={17} aria-hidden="true"/>Lock {name}</button></div>
   {signingHeld}
   {moment==='ready'&&!proven&&<SiloReadyMoment walletName={name} network={label.network} onBackup={()=>{setMoment(null);requestAnimationFrame(()=>root.current?.querySelector('.silo-backup-gate')?.scrollIntoView({block:'start'}));}} onLater={()=>{setMoment(null);location.hash='#overview/sol';}}/>}
   {moment==='backed-up'&&proven&&<SiloBackedUpMoment walletName={name} canShowAddress={receiveEnabled} onAddress={()=>setMoment(null)} onHome={()=>{setMoment(null);location.hash='#overview/sol';}}/>}
   {!proven?<div className="silo-backup-gate" role="status"><h3>Back up before you receive</h3><p>Prove its encrypted backup works before anyone sends funds to it. {receiveEnabled?'The address appears once the backup is verified.':'Receive remains held even after this backup check in the private review.'}</p>
    <ol className="silo-backup-steps"><li data-done={exported||undefined}><strong>Export the encrypted backup</strong> and move the file off this device.<div className="exposure-actions"><button className={exported?undefined:'silo-primary'} disabled={busy} onClick={()=>void exportBackup()}><Download size={17} aria-hidden="true"/>{exported?'Export again':chain==='solana'&&backupParts&&backupParts.registered.length>1?'Export combined backup':'Export encrypted backup'}</button><SiloBackupExportStatus lastExport={lastExport} saveLink={saveLink} onSaved={()=>setSaveLink(null)}/></div></li>
    <li><strong>Verify the exported file</strong> with its passphrase. This browser&apos;s own copy does not count.{verifyFields}</li></ol></div>
   :!receiveEnabled?<p role="status">Backup verified. Receive remains held in this private review.</p>:receive?<SiloReceiveAddress key={address} address={shown(chain,address)} asset={receive.asset} network={receive.network} note={receive.note}/>:receive===undefined?<SiloAddressText address={shown(chain,address)}/>:null}
   {proven&&<div className="silo-tools"><div className="exposure-actions"><button disabled={busy} onClick={()=>void exportBackup()}><Download size={17} aria-hidden="true"/>{backupParts&&backupParts.registered.length>1?'Export combined backup':'Export encrypted backup'}</button><SiloBackupExportStatus lastExport={lastExport} saveLink={saveLink} onSaved={()=>setSaveLink(null)}/></div><details className="silo-review silo-verify"><summary>Verify a backup</summary><p>Checks that an exported file opens with its passphrase and holds this wallet. Nothing is shown or changed.</p>{verifyFields}</details>
    {chain==='solana'&&<details className="silo-review silo-reveal" onToggle={event=>{if(!(event.target as HTMLDetailsElement).open)closeReveal();}}><summary>Export private key</summary>
     <p className="exposure-note">Whoever holds this key can move your funds. Never share it with Silo support, in chat, or in a screenshot. Use it only to import this wallet into another Solana wallet app.</p>
     {!revealedKey?<div className="silo-fields">
      <label>Wallet passphrase<SiloSecretField name={`silo-${chain}-reveal-passphrase`} value={revealPassphrase} onChange={event=>setRevealPassphrase(event.target.value)} autoComplete="current-password" disabled={revealBusy}/></label>
      <div className="exposure-actions"><button disabled={revealBusy||revealPassphrase.length<12} onClick={()=>void revealKey()}>Reveal private key</button></div>
      {revealError&&<p role="alert" className="exposure-error">{revealError}</p>}
     </div>:<div className="silo-review" role="status">
      <p>{label.key} — {label.format}</p>
      <code className="silo-secret-key">{revealedKey}</code>
      <div className="exposure-actions"><button onClick={()=>{void navigator.clipboard?.writeText(revealedKey).catch(()=>{});}}>Copy</button><button className="silo-primary" onClick={closeReveal}>Hide</button></div>
      <p className="exposure-note">This stays on screen only until you hide it, lock the wallet, or leave this page or close this panel. Copying it puts it on this device&apos;s clipboard, which Hide and Lock do not clear.</p>
     </div>}
    </details>}
   </div>}
   {syncNote}
  </div>:<>
   <div className="silo-unlock">
    <div className="silo-unlock-title"><h3>{stored?'Welcome back':`Create or import your ${name} wallet`}</h3><p>{stored?`Unlock the encrypted ${name} wallet saved in this browser.`:'Your key is created and encrypted on this device.'}</p></div>
    {!permitted&&<p role="status" className="silo-held">{heldReason}</p>}
    {!mainnetMode&&keyNetwork==='mainnet'&&<p className="exposure-note">Silo wallets use mainnet addresses only. On this test page they are still real {label.network} addresses; anything sent to them is real.</p>}
    {usingShared?<p className="silo-hint" role="status">Same passphrase as your other wallet. <button type="button" className="silo-textlink" disabled={busy} onClick={()=>setOwnPass(true)}>Use a different passphrase</button></p>:<div className="silo-fields"><label>{stored?'Wallet passphrase':'Choose a passphrase'}<SiloSecretField name={`silo-${chain}-passphrase`} value={passphrase} onChange={event=>setPassphrase(event.target.value)} autoComplete={stored?'current-password':'new-password'} disabled={busy||!hydrated}/></label></div>}
    {hint&&<p className="silo-hint" role="status" aria-live="polite">{hint}</p>}
    {/* The custody facts come before Create on every screen (Sol, baf30097, M3). */}
    {!stored&&<SiloCustodyNote testKey={keyNetwork!=='mainnet'} extra={chain==='solana'&&keyNetwork==='mainnet'?'You can export this wallet’s raw private key later to use it in another Solana wallet app.':undefined}/>}
    <div className="exposure-actions">{stored?<button className="silo-primary" disabled={!hydrated||!accepted||!permitted||busy||passphrase.length<12} onClick={()=>void open('unlock')}>Unlock {name} wallet</button>:<button className="silo-primary" disabled={!hydrated||!newReady} onClick={()=>void open('create')}>Create wallet</button>}</div>
    <p className="silo-unlock-foot"><LockKeyhole size={14} aria-hidden="true"/>Encrypted on this device. Silo never sends your key or passphrase anywhere.</p>
   </div>
   <div className="silo-more">
    {stored===true&&<details className="silo-review silo-danger"><summary>Can&apos;t unlock? Remove this wallet from this browser</summary><p>This deletes only this browser&apos;s encrypted copy. Your funds stay on the blockchain, and the wallet can be restored from your backup file, recovery phrase or private key. You do not need the passphrase. Removal cannot be undone: export and verify a backup first.</p><label><input type="checkbox" checked={removeAck} onChange={event=>setRemoveAck(event.target.checked)} disabled={busy||!hydrated}/>I have a backup of this {name} wallet, or I have its private key or recovery phrase.</label><label>Type REMOVE to confirm<input name={`silo-${chain}-remove-confirm`} value={removeWord} onChange={event=>setRemoveWord(event.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} disabled={busy||!hydrated}/></label><button disabled={!removeAck||removeWord.trim()!=='REMOVE'||busy} onClick={()=>void removeStored()}>Remove this browser&apos;s encrypted copy</button></details>}
    {stored===false&&<>
     {keyNetwork!=='devnet'&&chain!=='btc'&&<details className="silo-restore-options"><summary>Import private key</summary><div className="silo-fields">
      <label>{label.key}<SiloSecretField name={`silo-${chain}-private-key`} value={privateKey} onChange={event=>{setPreview(null);setPreviewConfirmed(false);setPrivateKey(event.target.value);}} autoComplete="off" autoCapitalize="off" spellCheck={false} disabled={busy}/></label><p className="silo-hint">{label.format} It is encrypted with your passphrase and never leaves this browser.</p>
      {!preview?<button disabled={busy||!privateKey.trim()} onClick={()=>void checkKey()}>Check address</button>:<div className="silo-review" role="status"><p>This key controls:</p><SiloAddressText address={shown(chain,preview)}/><label><input type="checkbox" checked={previewConfirmed} onChange={event=>setPreviewConfirmed(event.target.checked)} disabled={busy}/>This is the {name} address I expect.</label><div className="exposure-actions"><button className="silo-primary" disabled={!newReady||!previewConfirmed} onClick={()=>void open('import')}>Import private key</button><button disabled={busy} onClick={()=>{setPrivateKey('');setPreview(null);setPreviewConfirmed(false);}}>Cancel</button></div></div>}
     </div></details>}
     <details className="silo-restore-options"><summary>Restore encrypted backup</summary><div className="silo-fields">
      <p>Choose an encrypted Silo {name} backup file. Its passphrase field appears right under it. The restored wallet keeps that passphrase.</p>
      {getAccountBackup&&<button type="button" disabled={busy||!permitted} onClick={()=>void loadAccountBackup()}>Load encrypted backup from account</button>}
      <label className="silo-file">Choose backup file<input type="file" accept="application/json,.json" disabled={busy} onChange={event=>{chooseRestore(event.target.files?.[0]);event.target.value='';}}/></label>
      {restoreFile&&<div className="silo-review" role="status">{restoreNote&&<p className="exposure-note">{restoreNote}</p>}<label>Backup passphrase<SiloSecretField name={`silo-${chain}-restore-passphrase`} value={passphrase} onChange={event=>setPassphrase(event.target.value)} autoComplete="current-password" autoFocus disabled={busy} onKeyDown={event=>{if(event.key==='Enter'&&accepted&&permitted&&!busy&&passphrase.length>=12){event.preventDefault();void open('restore');}}}/></label><p>Backup for this address, confirmed when it opens with its passphrase:</p><SiloAddressText address={shown(chain,restoreFile.address)}/><div className="exposure-actions"><button className="silo-primary" disabled={!accepted||!permitted||busy||passphrase.length<12} onClick={()=>void open('restore')}>Restore encrypted backup</button><button disabled={busy} onClick={()=>{setRestoreFile(null);setRestoreSource(null);}}>Cancel</button></div></div>}
     </div></details>
    </>}
    {stored&&<p className="exposure-note">One Silo {name} wallet per browser. The saved wallet is never replaced, so create, import and restore stay unavailable while it is stored.</p>}
    {syncNote}
   </div>
  </>}
  {storageProblem&&<p role="alert">{storageProblem}</p>}
  {busy&&<p role="status" className="silo-busy">Encrypting on this device. This takes a few seconds.</p>}
  {notice&&<p role="status" className="exposure-note">{notice}</p>}
  {error&&<p role="alert" className="exposure-error">{error}</p>}
 </div>;
}
