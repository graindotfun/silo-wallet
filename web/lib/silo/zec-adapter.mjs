import {zecHistory} from './native-history.mjs';
import {paymentJournal} from './payment-journal.mjs';
import {assertSiloNetwork,encodeSiloBytes,decodeSiloBytes} from './local-envelope.mjs';
import {siloAmount,siloUnits} from './amounts.mjs';
import {zecBalances} from './zec-balances.mjs';
import {authorizeSiloNetwork} from './release-gate.mjs';
import {siloNodeUrl} from './disclosures.mjs';
import {legacySignedTransactions} from './zec-legacy.mjs';
/** Engine tag written into every backup. Backups without it (or with ZEC_LEGACY_ENGINE) were made by WebZjs a50df94 on a
 * librustzcash fork that stops at NU6.1; they are migrated (see openZecResearch), never opened by that engine again. */
export const ZEC_ENGINE='lrz-sqlite-0.23';
export const ZEC_PREVIOUS_SQLITE_ENGINE='lrz-sqlite-0.22';
export const ZEC_LEGACY_ENGINE='webzjs-nu61';
const coreNetwork=network=>network==='mainnet'?'main':'test';
/** Orchard-only unified address on the selected network, canonical as the core re-encodes it. */
export async function assertOrchardAddress(address,core,network='testnet'){
 let canonical=null;if(typeof address==='string'&&address.length<=2048){try{canonical=await core.call('address',{address,network:coreNetwork(network)});}catch{/* invalid */}}
 if(canonical!==address)throw Error('An Orchard-only Zcash address on the selected network is required.');
 return address;
}
/** Release of an unconfirmed payment rests on two facts and one assumption:
 * - consensus (ZIP 203): a transaction with expiry height E > 0 is invalid in any block above E; E = 0 never expires;
 * - E is read at signing from each signed transaction itself (transaction_expiry_heights), not derived from a tip;
 * - assumption, not finality: zcashd (MAX_REORG_LENGTH = COINBASE_MATURITY - 1 = 99, src/main.h) and Zebra (MAX_BLOCK_REORG_HEIGHT
 *   = 99, zebra-state constants) refuse reorganisations deeper than 99 blocks, so once the scanned tip is E + 100 no followed chain
 *   can re-mine a block at height E or below. A majority that ignores that rule, or a lightwalletd that misreports the chain
 *   (the light client trusts its server's chain view), defeats it. */
const ZEC_REORG_MARGIN=100;
const authorizedIds=authorized=>typeof authorized==='string'?authorized:authorized?.ids;
const txids=bytes=>Array.from({length:bytes.length/32},(_,index)=>Array.from(bytes.subarray(index*32,(index+1)*32),byte=>byte.toString(16).padStart(2,'0')).reverse().join(''));
/** No server keys or transparent receivers; local transfers require a frozen review and explicit user consent.
 * `sdk` is the loader from zec-browser-sdk.mjs: sdk.open() starts the engine (vendor/silo/zec-core) for this wallet.
 * @param {{sdk:{open:()=>Promise<any>},node:string,seed?:string|null,height?:number,cache?:any,network?:string,release?:any}} options */
export async function openZecResearch({sdk,node,seed=null,height=0,cache=null,network='testnet',release=null}){
 assertSiloNetwork('zec',network);authorizeSiloNetwork('zec',network,release);const uri=siloNodeUrl(node),net=coreNetwork(network);
 // A different phrase must never be paired with an existing account database, and the stored birthday is kept.
 if(seed&&cache)throw Error('An existing wallet opens from its encrypted backup; a recovery phrase is not accepted with it.');
 if(cache){if(typeof cache.seed!=='string'||!cache.seed)throw Error('Encrypted backup has no recovery phrase.');height=cache.height;}
 if(!Number.isSafeInteger(height)||height<0||height>4294967295)throw Error('Use a valid wallet birthday height.');
 // A legacy (WebZjs) backup: its database is engine-specific and is not opened. The account is re-derived from the stored phrase,
 // birthday and ZIP-32 account 0 (the only account Silo ever created), and rescanned; the pending journal is carried over unchanged.
 // The caller archives the original encrypted backup before the first write (migratedFrom).
 const sqliteUpgrade=Boolean(cache)&&cache.engine===ZEC_PREVIOUS_SQLITE_ENGINE;
 const legacy=Boolean(cache)&&cache.engine!==ZEC_ENGINE&&!sqliteUpgrade;
 if(legacy&&cache.engine!==undefined&&cache.engine!==ZEC_LEGACY_ENGINE)throw Error('This backup was made by an unknown wallet engine.');
 const database=cache?.database&&!cache.cacheOmitted&&!legacy?decodeSiloBytes(cache.database):null;
 const core=await sdk.open();
 let closed=false;const active=()=>{if(closed)throw Error('Wallet session is locked.');};
 const call=async(op,args)=>{active();const value=await core.call(op,args);active();return value;};
 try{
  // The engine is current when the server's consensus branch at its tip is the branch this engine computes for that height.
  const chain=await call('chainCheck',{url:uri,network:net});
  if(chain?.chainMatches!==true)throw Error('The node reports a different Zcash network.');
  if(!Number.isSafeInteger(chain.tip)||chain.tip<0)throw Error('Chain height was not checked.');
  const engine=Object.freeze({latest:chain.tip,serverBranch:chain.serverBranch,engineBranch:chain.engineBranch,nextUpgrade:chain.nextUpgrade,outdated:chain.branchMatches!==true});
  if(engine.outdated&&!cache)throw Error('engine-outdated');
  let halted=engine.outdated;
  const usable=()=>{if(halted)throw Error('engine-outdated');};
  // Upgrade compatibility is a session invariant, not only an unlock-time check. A mismatch
  // latches recovery-only until reopening; transient RPC errors also prevent the action.
  const verifyChain=async()=>{active();usable();const current=await call('chainCheck',{url:uri,network:net});
   if(current?.chainMatches!==true||current?.branchMatches!==true||!Number.isSafeInteger(current.tip)||current.tip<0||current.tip>4294967295){halted=true;throw Error('engine-outdated');}return current;};
  const phrase=cache?cache.seed:seed??await call('generate');
  if(database&&!engine.outdated)await call('open',{network:net,database});
  else if(!engine.outdated){
   // A phrase generated now cannot have received anything before the current tip, so a new wallet without a chosen birthday
   // starts there. A typed (restored) phrase with birthday 0 scans from Sapling activation.
   if(!cache&&!seed&&height===0)height=chain.tip;
   const treeState=height>0?await call('treeState',{url:uri,birthday:height}):null;
   await call('create',{network:net,phrase,treeState});
  }
  const info=!engine.outdated?await call('info'):null;
  if(info&&info.account!==0)throw Error('Invalid local account.');
  const birthday=info?info.birthday:height;
  let preparing=false,signing=false,proposalRevision=0;
  const receive=async()=>{active();await verifyChain();return assertOrchardAddress((await call('info')).address,{call},network);};
  if(!engine.outdated)await receive();
  // A journal carried over from the legacy engine is marked, and its signed transactions are carried with it: each one is read from
  // the legacy database, re-parsed by this engine, and kept only if it re-serializes to the same bytes and recomputes the journal's
  // txid (and, when the journal recorded one, the same expiry). Those exact bytes are the only thing a retry may send; no replacement
  // is ever signed. If any transaction cannot be proven this way, retry is unavailable and the hold stays (outcome() below).
  const carryLegacy=async pending=>{
   const ids=decodeSiloBytes(authorizedIds(pending.authorized)),expected=ids.length&&ids.length%32===0?txids(ids):[],recorded=pending.authorized?.expiryHeights;
   try{
    if(!expected.length||!cache.database||cache.cacheOmitted)throw Error('no signed bytes');
    const found=legacySignedTransactions(decodeSiloBytes(cache.database)),signed=[];
    for(const [index,id] of expected.entries()){
     const row=found.get(id);if(!row)throw Error('missing');const check=await call('inspectRaw',{bytes:row.raw});
     if(check?.txid!==id)throw Error('txid');if(Array.isArray(recorded)&&recorded[index]!==check.expiryHeight)throw Error('expiry');
     signed.push({raw:encodeSiloBytes(row.raw),expiryHeight:check.expiryHeight});
    }
    // The expiry read from the proven signed bytes is the transaction's own (SX-18); record it when the journal had none.
    const authorized=Array.isArray(recorded)?pending.authorized:{ids:authorizedIds(pending.authorized),expiryHeights:signed.map(row=>row.expiryHeight)};
    return {...pending,authorized,signedBy:ZEC_LEGACY_ENGINE,legacySigned:signed};
   }catch{return {...pending,signedBy:ZEC_LEGACY_ENGINE,legacySigned:null};}
  };
  const carried=cache?.pending??null,journal=paymentJournal(carried&&legacy&&info&&carried.signedBy===undefined?await carryLegacy(carried):carried);
  const broadcast=async(encoded)=>{
   active();await verifyChain();authorizeSiloNetwork('zec',network,release);const authorized=decodeSiloBytes(authorizedIds(encoded));if(!authorized.length||authorized.length%32)throw Error('Invalid authorized transaction identifiers.');
   const current=journal.snapshot();
   if(current?.signedBy===ZEC_LEGACY_ENGINE){
    if(!Array.isArray(current.legacySigned)||current.legacySigned.length!==authorized.length/32)throw Error('resend-unavailable');
    const expected=txids(authorized);
    for(const [index,row] of current.legacySigned.entries()){const bytes=decodeSiloBytes(row.raw);if((await call('inspectRaw',{bytes}))?.txid!==expected[index])throw Error('resend-unavailable');await call('sendRaw',{url:uri,bytes});}
    return expected.join(', ');
   }
   await call('send',{url:uri,ids:authorized});return txids(authorized).join(', ');
  };
  // true when every transaction meets the confirmation policy. 'failed' (releasable) only when every transaction of the payment has a
  // recorded non-zero expiry, none is mined, and the scanned tip is at least its own expiry + margin. 'reported-failed' when they are
  // past expiry but not past the margin. Unknown or zero expiry, or a partly mined payment, keeps the hold. A transaction missing
  // from the wallet keeps the hold too, except for a payment signed by the legacy engine before migration: its bytes stayed in the
  // archived backup, and the rescanned wallet records it only if it is mined (it spends this wallet's notes), so a full scan to
  // expiry + margin without it is the same proof as for any other unmined transaction.
  const outcome=async pending=>{
   await verifyChain();
   // Reconcile the store with the followed chain before using cached mining or expiry facts.
   // A lower live tip or incomplete/reorg-inconsistent scan cannot clear any reservation.
   await call('sync',{url:uri});
   const summary=await call('summary');if(!summary)return false;
   const validHeight=value=>Number.isSafeInteger(value)&&value>=0&&value<=4294967295;
   if(!validHeight(summary.chainTip)||!validHeight(summary.fullyScanned)||summary.fullyScanned!==summary.chainTip)return false;
   const scanned=summary.fullyScanned;
   const ids=decodeSiloBytes(authorizedIds(pending.authorized));if(!ids.length||ids.length%32)return false;const expected=txids(ids),states=new Map();
   for(const tx of await call('history')){if(!expected.includes(tx.txid))continue;if(tx.minedHeight!==null&&(!validHeight(tx.minedHeight)||tx.minedHeight>scanned))return false;states.set(tx.txid,Number.isSafeInteger(tx.minedHeight)?(scanned-tx.minedHeight+1>=3?'confirmed':'mined'):tx.expiredUnmined===true?'expired':'pending');}
   const current=await verifyChain();if(summary.chainTip>current.tip)return false;
   if(states.size!==expected.length){if(pending.signedBy!==ZEC_LEGACY_ENGINE)return false;for(const id of expected)if(!states.has(id))states.set(id,'unseen');}
   const values=expected.map(id=>states.get(id));
   if(values.every(state=>state==='confirmed'))return true;if(values.some(state=>state==='confirmed'||state==='mined'))return false;
   const expiries=pending.authorized?.expiryHeights;
   const recorded=Array.isArray(expiries)&&expiries.length===expected.length&&expiries.every(value=>Number.isSafeInteger(value)&&value>=0);
   if(recorded&&expiries.includes(0))return false; // never expires
   if(!recorded)return values.every(state=>state==='expired')?'reported-failed':false;
   if(expiries.every(expiry=>scanned>=expiry+ZEC_REORG_MARGIN))return 'failed';
   return expiries.every(expiry=>scanned>expiry)?'reported-failed':false;
  };
  return {get engine(){return Object.freeze({...engine,outdated:halted});},
   // false when the pending payment was signed by the previous engine and its signed bytes could not be proven: retry is then
   // unavailable (never replaced), and the hold stays until confirmation or proven expiry.
   resendAvailable:()=>{const current=journal.snapshot();return !(current?.signedBy===ZEC_LEGACY_ENGINE&&!Array.isArray(current.legacySigned));},
   migratedFrom:info&&!engine.outdated?(legacy?(cache.engine??ZEC_LEGACY_ENGINE):sqliteUpgrade?'sqlite-nu63':null):null,reconcile:persist=>{active();return journal.reconcile(outcome,persist);},release:persist=>{active();return journal.release(outcome,persist);},pending:()=>journal.snapshot()?journal.draft(journal.snapshot().review,()=>{throw Error('Pending identifiers missing.');},broadcast,true):null,receive,sync:async()=>{active();await verifyChain();return call('sync',{url:uri});},balance:async()=>{
   active();if(halted)return {amount:null,unlocked:null,status:'not checked'};
   return zecBalances(await call('summary'));
  },history:async()=>{await verifyChain();const summary=await call('summary'),rows=await call('history'),current=await verifyChain();return zecHistory(rows,summary,current.tip);},backup:async()=>{
   active();if(engine.outdated&&cache)return {...cache,pending:journal.snapshot()};
   const base={pending:journal.snapshot(),seed:phrase,height:birthday,account:0};
   if(info)return {...base,engine:ZEC_ENGINE,database:encodeSiloBytes(new Uint8Array(await call('bytes')))};
   // Recovery mode (the chain is past this engine): the stored backup's engine tag and database are kept exactly as they were.
   return {...base,...(cache.engine!==undefined?{engine:cache.engine}:{}),...(cache.database!==undefined?{database:cache.database}:{}),...(cache.cacheOmitted?{cacheOmitted:true}:{})};
  },prepare:async({address,amount})=>{
    active();journal.assertClear();if(preparing||signing)throw Error('Payment preparation already in progress.');preparing=true;const revision=++proposalRevision;try{await verifyChain();active();journal.assertClear();authorizeSiloNetwork('zec',network,release);await assertOrchardAddress(address,{call},network);
    const raw=siloAmount(amount,8),proposal=await call('propose',{to:address,amount:raw});
    const fee=proposal?.fee;if(typeof fee!=='string'||!/^\d{1,20}$/.test(fee)||BigInt(fee)>18446744073709551615n)throw Error('Network fee was not checked.');
    const review={network,asset:'ZEC',address,amount:siloUnits(raw,8),fee:siloUnits(fee,8)};
    return journal.draft(review,async()=>{
     active();if(preparing||signing||revision!==proposalRevision)throw Error('Payment review is no longer current. Prepare a new review.');signing=true;try{await verifyChain();active();const authorized=await call('authorize',{phrase});if(!(authorized instanceof Uint8Array)||!authorized.length||authorized.length%32)throw Error('Authorized transaction identifiers unavailable.');
     // Each signed transaction's committed expiry height, read back from the stored transaction. If it cannot be read the payment
     // still proceeds, but it can only ever clear by confirmation.
     let expiryHeights=null;try{const read=Array.from(await call('expiries',{ids:authorized}));if(read.length===authorized.length/32&&read.every(value=>Number.isSafeInteger(value)&&value>=0))expiryHeights=read;}catch{/* recorded as unknown */}
     active();return {ids:encodeSiloBytes(authorized),expiryHeights};}finally{signing=false;}},broadcast);
    }finally{preparing=false;}
   },close:async()=>{if(closed)return;closed=true;try{await core.call('close');}finally{core.terminate();}}};
 }catch(error){core.terminate();throw error;}
}
