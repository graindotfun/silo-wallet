// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import {useCallback,useEffect,useMemo,useSyncExternalStore} from 'react';
import {useSiloSharedPassphrase} from './silo-shared-passphrase';
import {defaultRevocation,deviceUnlockEnabled,enrolDeviceUnlock,openDeviceUnlockStore,removeDeviceUnlock,siloDeviceUnlockMaybeSupported,unlockWithDevice} from '@/lib/silo/device-unlock.mjs';
import {ONE_UNLOCK_MESSAGES} from '@/lib/silo/one-unlock.mjs';
/** Device unlock (Face ID, fingerprint, Windows Hello, device PIN): the offer after a successful passphrase unlock, the button on the locked screen and the switch in
 * Settings. The passphrase stays the root of recovery. The device unlock only fills in the passphrase the person already proved: it is offered only while the wallets
 * are open with it (so a mistyped passphrase can never be wrapped), and it hands the passphrase to the same one-unlock submit that typing uses (same attempt tokens,
 * same lock generation). A device-check result that arrives after a lock is discarded. Nothing here is sent anywhere. */
const DISMISS='silo-device-unlock-offer-dismissed-v1';
/** Wording only, never used to decide support: what the device check is called on this device. */
export function siloDeviceLockLabel(agent:string=typeof navigator==='undefined'?'':navigator.userAgent):string{
 if(/iPhone|iPad|iPod/i.test(agent))return 'Face ID or Touch ID';
 if(/Android/i.test(agent))return 'your fingerprint or face';
 if(/Macintosh|Mac OS X/i.test(agent))return 'Touch ID';
 if(/Windows/i.test(agent))return 'Windows Hello';
 return 'your device lock';
}
export type SiloDeviceUnlock={maybeSupported:boolean;enabled:boolean|null;busy:boolean;message:string;info:boolean;label:string;canOffer:boolean;dismissed:boolean;enable():Promise<void>;disable():Promise<void>;unlock():Promise<void>;dismiss():void};
// One shared state for the offer, the locked-screen button and the Settings row, so they always agree (a message set by one is seen by the others).
type Shared={enabled:boolean|null;busy:boolean;message:string;info:boolean;dismissed:boolean;maybeSupported:boolean;usedDevice:boolean;loaded:boolean};
let shared:Shared={enabled:null,busy:false,message:'',info:false,dismissed:false,maybeSupported:false,usedDevice:false,loaded:false};
const listeners=new Set<()=>void>();
const patch=(next:Partial<Shared>)=>{shared={...shared,...next};for(const listener of [...listeners])listener();};
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
const snapshot=()=>shared;
let store:ReturnType<typeof openDeviceUnlockStore>|null=null;
const getStore=()=>store??(store=openDeviceUnlockStore());
// The ceremony in flight (enrolment or unlock). A lock or the disposal of the provider aborts it, so it cannot finish afterwards.
let ceremony:AbortController|null=null;
let instances=0;
const startCeremony=()=>{ceremony?.abort();ceremony=new AbortController();return ceremony;};
const endCeremony=(controller:AbortController)=>{if(ceremony===controller)ceremony=null;};
/** Tests reset the module state between mounts. */
export function resetSiloDeviceUnlockState(){ceremony?.abort();ceremony=null;instances=0;shared={enabled:null,busy:false,message:'',info:false,dismissed:false,maybeSupported:false,usedDevice:false,loaded:false};store=null;}
export function useSiloDeviceUnlock():SiloDeviceUnlock{
 const unlockState=useSiloSharedPassphrase(),state=useSyncExternalStore(subscribe,snapshot,snapshot);
 // Every instance leaving (the provider's children unmounting included) aborts the ceremony when it was the last one; a lock aborts it too.
 useEffect(()=>{instances++;return()=>{instances--;if(instances<=0){ceremony?.abort();ceremony=null;}};},[]);
 useEffect(()=>{ceremony?.abort();},[unlockState.lockGeneration]);
 useEffect(()=>{
  if(shared.loaded)return;patch({loaded:true});
  // A revocation marker left by an interrupted enrolment: finish the cleanup quietly (device unlock is reported off while it is set).
  if(defaultRevocation().marked())void removeDeviceUnlock(getStore()).catch(()=>{});
  let dismissed=false;try{dismissed=sessionStorage.getItem(DISMISS)==='1';}catch{/* the offer simply shows again */}
  patch({maybeSupported:siloDeviceUnlockMaybeSupported(),dismissed});
  void deviceUnlockEnabled(getStore()).then(value=>patch({enabled:value}));
 },[]);
 const label=useMemo(()=>siloDeviceLockLabel(),[]);
 const enable=useCallback(async()=>{
  // Only the passphrase that just opened a wallet in this lock generation may be wrapped, and the whole enrolment (including the storage commit) is bound to that generation.
  const passphrase=unlockState.provenPassphrase();if(!passphrase){patch({info:true,message:'Unlock your wallets first, then turn this on.'});return;}
  const generation=unlockState.generation(),controller=startCeremony();patch({busy:true,message:'',info:false});
  try{await enrolDeviceUnlock({passphrase,rpId:location.hostname,store:getStore(),isCurrent:()=>unlockState.generation()===generation&&!controller.signal.aborted,signal:controller.signal});patch({enabled:true,busy:false});}
  catch(error){
   const reason=(error as {siloDeviceUnlock?:string;stuck?:boolean}).siloDeviceUnlock,stuck=(error as {stuck?:boolean}).stuck===true;
   // Say what is TRUE: re-read the stored state (a pending, revoked or half-finished record is off; only an activated one is on).
   const real=await deviceUnlockEnabled(getStore()).catch(()=>false);
   if(stuck){patch({busy:false,enabled:real,info:false,message:'Device unlock could not be turned on. Open Settings and turn it off to retry.'});return;}
   patch({busy:false,enabled:real,info:reason==='cancelled'||reason==='stale',message:reason==='stale'?'':reason==='cancelled'?'Device unlock was not turned on.':'Device unlock is not available in this browser. Use your passphrase.'});
    }finally{endCeremony(controller);}
 },[unlockState]);
 // OFF is reported only after the stored data is confirmed deleted; otherwise the failure is shown, device unlock stays on, and the same button retries.
 const disable=useCallback(async()=>{
  patch({busy:true,message:'',info:false});
  try{await removeDeviceUnlock(getStore());patch({busy:false,enabled:false,usedDevice:false,info:true,dismissed:true,message:'Device unlock is off. Type your passphrase to unlock.'});try{sessionStorage.setItem(DISMISS,'1');}catch{/* the offer may show again next session */}}
  catch{patch({busy:false,enabled:true,info:false,message:'Device unlock could not be turned off. Try again.'});}
 },[]);
 // Removal for a blob that stopped working: same rule, never claim it is gone unless it is.
 const dropBroken=async()=>{
  try{await removeDeviceUnlock(getStore());patch({enabled:false,info:false,message:'Device unlock stopped working. Type your passphrase, then turn it on again.'});}
  catch{patch({enabled:true,info:false,message:'Device unlock stopped working and could not be removed. Open Settings and turn it off.'});}
 };
 const unlock=useCallback(async()=>{
  if(shared.busy)return;const generation=unlockState.generation(),controller=startCeremony();patch({busy:true,message:'',info:false});
  try{
   const passphrase=await unlockWithDevice({store:getStore(),isCurrent:()=>unlockState.generation()===generation&&!controller.signal.aborted,signal:controller.signal});
   patch({usedDevice:true});unlockState.unlock.submit(passphrase);
  }catch(error){
   const reason=(error as {siloDeviceUnlock?:string}).siloDeviceUnlock;
   if(reason==='stale'||reason==='cancelled')return;
   if(reason==='corrupt'||reason==='missing')await dropBroken();
   else patch({info:false,message:'Device unlock is not available in this browser. Use your passphrase.'});
  }finally{endCeremony(controller);patch({busy:false});}
 },[unlockState]);
 // A device-supplied passphrase that no wallet accepts (for example the passphrase was changed): remove it so it cannot keep failing. Only the first instance acts.
 useEffect(()=>{
  if(!shared.usedDevice||unlockState.unlock.message!==ONE_UNLOCK_MESSAGES.wrong)return;patch({usedDevice:false});void dropBroken();
 // eslint-disable-next-line react-hooks/exhaustive-deps -- dropBroken only uses module state
 },[unlockState.unlock.message]);
 const dismiss=useCallback(()=>{patch({dismissed:true});try{sessionStorage.setItem(DISMISS,'1');}catch{/* shown again next time */}},[]);
 const anyOpen=Object.values(unlockState.unlock.statuses).some(status=>status==='open');
 // A message about a failed device unlock clears itself once the wallets are open.
 useEffect(()=>{if(anyOpen&&shared.message&&!shared.busy&&/stopped working|not available/.test(shared.message))patch({message:''});},[anyOpen]);
 return {maybeSupported:state.maybeSupported,enabled:state.enabled,busy:state.busy,message:state.message,info:state.info,label,dismissed:state.dismissed,canOffer:state.maybeSupported&&state.enabled===false&&anyOpen&&Boolean(unlockState.provenPassphrase()),enable,disable,unlock,dismiss};
}
const control={minHeight:44,fontSize:16} as const;
/** After a successful passphrase unlock: one tap to turn it on, or "Not now". Never silent. */
export function SiloDeviceUnlockOffer(){
 const device=useSiloDeviceUnlock();
 if(!device.canOffer||device.dismissed)return null;
 return <section id="silo-device-unlock-offer" aria-label="Device unlock" className="exposure-panel" style={{padding:16}}>
  <h2 style={{margin:'0 0 8px',fontSize:18}}>Unlock with {device.label} next time?</h2>
  <p className="exposure-note">Use your phone or computer lock instead of typing your passphrase. Your passphrase still protects your backup and is the only way to restore on a new device.</p>
  <div className="exposure-actions"><button type="button" className="silo-primary" style={control} disabled={device.busy} onClick={()=>void device.enable()}>{device.busy?'Turning on…':'Turn on'}</button><button type="button" style={control} disabled={device.busy} onClick={device.dismiss}>Not now</button></div>
  {device.message&&!device.info&&<p role="alert" className="exposure-error">{device.message}</p>}
 </section>;
}
/** On the locked screen, when device unlock is on. The passphrase field stays as the fallback. */
export function SiloDeviceUnlockButton(){
 const device=useSiloDeviceUnlock();
 if(!device.maybeSupported)return null;
 if(device.enabled!==true)return device.message&&!device.info?<p role="alert" className="exposure-error">{device.message}</p>:null;
 return <div id="silo-device-unlock-button"><button type="button" className="silo-primary" style={{...control,width:'100%'}} disabled={device.busy} onClick={()=>void device.unlock()}>{device.busy?'Waiting for your device…':`Unlock with ${device.label}`}</button>{device.message&&<p role="alert" className="exposure-error">{device.message}</p>}</div>;
}
/** Settings: the switch, what it does and the warning. */
export function SiloDeviceUnlockSetting(){
 const device=useSiloDeviceUnlock();
 if(!device.maybeSupported)return null;
 return <section id="silo-device-unlock-setting" className="exposure-panel silo-setting"><header><h2>Unlock with device lock</h2><p>Opens your wallets with Face ID, a fingerprint or your device PIN. You still need your passphrase to restore your backup on a new device.</p></header>
  <div className="silo-setting-body"><div className="silo-setting-row"><div>
   <p className="exposure-note">If someone can unlock this device and approve the prompt, they can open your wallets here. If your passkey syncs to other devices (iCloud or Google), anyone who gets both your passkey and a copy of this browser's stored data could open them too. A short device PIN is weaker than your passphrase. Turn this off on shared devices.</p>
   {device.enabled===true
    ?<div className="exposure-actions"><button type="button" style={control} disabled={device.busy} onClick={()=>void device.disable()}>Turn off device unlock</button></div>
    :<div className="exposure-actions"><button type="button" className="silo-primary" style={control} disabled={device.busy||device.enabled===null} onClick={()=>void device.enable()}>{device.busy?'Turning on…':`Turn on with ${device.label}`}</button></div>}
   {device.message&&<p role="status" className="exposure-note">{device.message}</p>}
  </div></div></div></section>;
}
