// SPDX-License-Identifier: AGPL-3.0-only
/** ONE UNLOCK for every wallet: the state contract between the locked screen and the wallets. Pure, no cryptography and no storage.
 * The person types one passphrase; the wallets already know how to open themselves with it (each derives its own key from the same string with
 * its own salt, exactly as today). This module only decides ORDER, STATUS and MESSAGE:
 *   - one typed passphrase = one version; each wallet is tried at most once per version, silently, and never retried;
 *   - Solana and EVM open first; Monero (the heavy one: it decrypts a large cache and starts syncing) is gated until they have all settled, so the
 *     light wallets are usable at once and nothing waits behind Monero;
 *   - a report from an older version (a lock or a newer passphrase happened meanwhile) is refused, and the caller must lock what it opened;
 *   - locking any wallet locks them all: the passphrase and every status are cleared;
 *   - the typed passphrase lives only in this object (memory) until a lock, never in plain form in storage, a URL, a log or a network request (device unlock may keep it as ciphertext). */
export const ONE_UNLOCK_STATUS=Object.freeze({locked:'locked',opening:'opening',open:'open',needsOwn:'needs-own',otherTab:'other-tab'});
export const ONE_UNLOCK_MESSAGES=Object.freeze({
 none:'',
 wrong:'That passphrase did not open any wallet.',
 trouble:'A wallet could not be opened. Try again.',
});
const ZONES=Object.freeze(['solana','evm','xmr']);
const HEAVY='xmr';
const TERMINAL=new Set(['open','needs-own','other-tab','locked']);
/** outcome -> status: 'open' opened; 'wrong' the passphrase did not open THIS wallet (its own passphrase differs); 'in-use' another tab holds it;
 * 'error' anything else (storage blocked, an interrupted open): stays locked, never half-open. */
const OUTCOME={open:'open',wrong:'needs-own','in-use':'other-tab',error:'locked'};
export function createOneUnlock({onChange=()=>{},timeoutMs=30000,heavyTimeoutMs=90000,setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id)}={}){
 let version=0,typed='',message='',timer=null,heavyTimer=null;
 const present=new Map(),status=new Map(),failed=new Set(),tried=new Set();
 const emit=()=>{try{onChange();}catch{/* a subscriber's failure never changes unlock state */}};
 const zonesHere=()=>ZONES.filter(zone=>present.get(zone));
 const light=()=>zonesHere().filter(zone=>zone!==HEAVY);
 const settled=zone=>TERMINAL.has(status.get(zone));
 const lightSettled=()=>light().every(settled);
 function settleMessage(){
  const zones=zonesHere();if(!zones.length||!zones.every(settled)||!typed){return;}
  const opened=zones.some(zone=>status.get(zone)==='open'),wrong=zones.some(zone=>status.get(zone)==='needs-own'),trouble=zones.some(zone=>failed.has(zone));
  message=opened?'':wrong?ONE_UNLOCK_MESSAGES.wrong:trouble?ONE_UNLOCK_MESSAGES.trouble:'';
 }
 function clearTimerNow(){if(timer!==null){clearTimer(timer);timer=null;}if(heavyTimer!==null){clearTimer(heavyTimer);heavyTimer=null;}}
 function clearLightTimer(){if(timer!==null){clearTimer(timer);timer=null;}}
 /** Monero has its own bound: an open that never answers (or never reports) is released as locked, so nothing waits on it forever and the field is never stuck disabled. */
 function armHeavy(forVersion){if(heavyTimer!==null)clearTimer(heavyTimer);heavyTimer=setTimer(()=>{heavyTimer=null;if(forVersion!==version)return;if(status.get(HEAVY)==='opening'){status.set(HEAVY,'locked');failed.add(HEAVY);}settleMessage();emit();},heavyTimeoutMs);}
 function armTimeout(forVersion){clearTimerNow();timer=setTimer(()=>{timer=null;if(forVersion!==version)return;for(const zone of light())if(status.get(zone)==='opening'){status.set(zone,'locked');failed.add(zone);}settleMessage();emit();},timeoutMs);}
 return {
  /** A wallet of this kind exists in this browser (stored) or does not. A wallet that disappears loses its status. */
  setPresent(zone,here){if(!ZONES.includes(zone))throw Error('Unknown wallet.');const before=present.get(zone);present.set(zone,Boolean(here));if(!here)status.delete(zone);else if(!status.has(zone))status.set(zone,'locked');if(before!==Boolean(here))emit();},
  /** Marks a wallet open without an unlock attempt (created or restored here, or opened with its own passphrase). */
  setOpen(zone){if(!ZONES.includes(zone))throw Error('Unknown wallet.');present.set(zone,true);status.set(zone,'open');failed.delete(zone);settleMessage();emit();},
  /** The person typed the one passphrase. Returns the version every report must carry. Wallets that are already open are left alone. */
  submit(passphrase){
   if(typeof passphrase!=='string'||passphrase.length<12)return {version:0,accepted:false};
   version++;typed=passphrase;message='';failed.clear();tried.clear();
   for(const zone of zonesHere())if(status.get(zone)!=='open')status.set(zone,zone===HEAVY?'locked':'opening');
   armTimeout(version);
   emit();return {version,accepted:true};
  },
  /** A wallet may start its silent attempt for this version: Solana and EVM at once; Monero only after the others settled. Never twice per version. */
  canOpen(zone,forVersion){return typed!==''&&forVersion===version&&present.get(zone)===true&&status.get(zone)!=='open'&&!tried.has(zone)&&(zone!==HEAVY||lightSettled());},
  /** A wallet started its attempt (Monero shows "Opening…" from here). */
  started(zone,forVersion){if(!this.canOpen(zone,forVersion))return false;tried.add(zone);status.set(zone,'opening');if(zone===HEAVY)armHeavy(forVersion);emit();return true;},
  /** A wallet's attempt ended. Returns {accept:true} or {accept:false}: a stale report (a lock or a newer passphrase came first) is refused and the caller must lock what it opened. */
  report(zone,outcome,forVersion){
   if(!ZONES.includes(zone)||!Object.hasOwn(OUTCOME,outcome))return {accept:false};
   if(forVersion!==version||!present.get(zone))return {accept:false};
   status.set(zone,OUTCOME[outcome]);if(outcome==='error')failed.add(zone);else failed.delete(zone);
   if(lightSettled())clearLightTimer();if(zone===HEAVY&&heavyTimer!==null){clearTimer(heavyTimer);heavyTimer=null;}
   settleMessage();emit();return {accept:true};
  },
  /** Locking any wallet locks them all: statuses back to locked, the passphrase forgotten, every in-flight attempt made stale. */
  lockAll(){version++;typed='';message='';clearTimerNow();failed.clear();tried.clear();for(const zone of zonesHere())status.set(zone,'locked');emit();},
  /** The passphrase for an attempt of the CURRENT version only, else ''. */
  passphraseFor(forVersion){return forVersion===version?typed:'';},
  statuses(){return Object.fromEntries(zonesHere().map(zone=>[zone,status.get(zone)]));},
  message(){return message;},
  version(){return version;},
 };
}
