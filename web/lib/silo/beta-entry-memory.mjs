/** Remembers, on this device only, that the beta gate was passed (owner decision, 21 Nov 2026).
 *
 * Why: the gate asks the server. With no network, or with Silo's server down, a person could not get past the first screen to
 * their own wallet, although the wallet code and the encrypted keys are on the device. A wallet must open without its server.
 *
 * What it is: one small record in this device's storage, written only after the server accepted the entry (terms included).
 * It carries the terms version that was accepted and the time; nothing else, and nothing is sent anywhere.
 *
 * What it is not: it is not the server's entry proof and it grants nothing on the server. Solana, Convert and swap routes still
 * check their own proof; Monero sends, which do not pass through the server, wait for a fresh live beta status
 * (beta-live-state.mjs). It only decides whether this page shows the gate or the wallet while the
 * server has NOT answered. Whenever a live answer says this device is not let in, the gate shows (candidate review N4 stays
 * true); the record itself is kept, because the server's proof expires within hours and a refusal is therefore the normal
 * state of a later visit. New terms make an old record worthless: the new terms need a fresh acceptance. */
export const SILO_BETA_ENTRY_KEY='grain-silo-beta-entered-v1';
const store=storage=>{try{return storage??globalThis.localStorage??null;}catch{return null;}};

/** Called once the server accepted the entry. Failing to save only means the gate asks again next time. */
export function rememberBetaEntry(terms,{storage,now=Date.now()}={}){
 if(typeof terms!=='string'||!terms)return false;
 try{const s=store(storage);if(!s)return false;s.setItem(SILO_BETA_ENTRY_KEY,JSON.stringify({terms,at:now}));return true;}catch{return false;}
}
/** True only for a well-formed record of exactly these terms. */
export function betaEntryRemembered(terms,{storage}={}){
 try{const raw=store(storage)?.getItem(SILO_BETA_ENTRY_KEY);if(!raw)return false;const record=JSON.parse(raw);
  return typeof terms==='string'&&terms.length>0&&record!==null&&typeof record==='object'&&record.terms===terms&&Number.isFinite(record.at);}
 catch{return false;}
}
export function forgetBetaEntry({storage}={}){try{store(storage)?.removeItem(SILO_BETA_ENTRY_KEY);}catch{/* nothing to remove */}}

/** Does the wallet show instead of the gate?
 * `invited`: true = the server let this device in; false = a live answer refused it; null = no answer yet (first load, offline,
 * server down). `accepted`: the gate was passed in this page. `remembered`: betaEntryRemembered() for the current terms.
 * A remembered entry counts only while there is no answer; a live refusal always wins. */
export function betaGateOpen({invited,accepted=false,remembered=false}){
 if(invited===true||accepted===true)return true;
 return invited===null&&remembered===true;
}
