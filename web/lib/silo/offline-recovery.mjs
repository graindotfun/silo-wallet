import {openSilo} from './local-envelope.mjs';
// Mirrors SILO_XMR_SUBADDRESS_LOOKAHEAD in xmr-adapter.mjs (this module must not load the wallet engine); tests/silo-xmr-export-verify-drift.test.mjs keeps them equal.
export const SILO_RECOVERY_XMR_LOOKAHEAD = 200;

/** Recovery without a node or wallet engine: decrypts an encrypted Silo backup with its passphrase and returns what a person needs
 * to restore elsewhere. It loads no SDK, opens no network connection and writes nothing, so the stored backup, its scan cache and
 * any pending payment journal stay exactly as they were. A pending payment is reported because its signed bytes live only in the
 * backup (and, for ZEC, the wallet database): a phrase restore alone does not recover them. */
async function recoveryPayload(envelope,passphrase,{zone,network}){
 if(!envelope||typeof envelope!=='object')throw Error('No encrypted backup.');
 if(envelope.zone!==zone||envelope.network!==network)throw Error('Backup network mismatch.');
 const payload=await openSilo(envelope,passphrase);
 if(typeof payload?.seed!=='string'||!payload.seed)throw Error('This backup holds no recovery phrase.');
 return payload;
}
function recoverySummary(payload,{zone,network}){
 return Object.freeze({zone,network,phrase:payload.seed,birthday:Number.isSafeInteger(payload.height)?payload.height:null,account:Number.isSafeInteger(payload.account)?payload.account:zone==='zec'?0:null,
  conversionAttempts:Array.isArray(payload.conversionRecovery?.entries)?payload.conversionRecovery.entries.length:0,
  pendingPayment:Boolean(payload.pending),pendingNeedsBackup:Boolean(payload.pending),scanCacheIncluded:Boolean(payload.cacheData||payload.database)&&payload.cacheOmitted!==true,engine:typeof payload.engine==='string'?payload.engine:null,
  // XMR SDK high-water mark, including scanned addresses beyond the issuance ceiling.
  receiveAddresses:Number.isSafeInteger(payload.scannedSubaddresses)&&payload.scannedSubaddresses>=0?payload.scannedSubaddresses:Number.isSafeInteger(payload.subaddresses)&&payload.subaddresses>=0?payload.subaddresses:null,subaddressCacheRequired:payload.subaddressCacheRequired===true});
}

export async function recoverSiloOffline(envelope,passphrase,target){return recoverySummary(await recoveryPayload(envelope,passphrase,target),target);}

/** Backup drill: checks recovery identity and recorded coverage against the wallet that is open now, without showing its recovery phrase,
 * loading a wallet engine, contacting a node or writing anything. `current` is the open wallet's own backup payload.
 * Only booleans and the birthday leave this function. */
export async function verifySiloBackup(envelope,passphrase,{zone,network,current}){
 const payload=await recoveryPayload(envelope,passphrase,{zone,network});
 const recovered=recoverySummary(payload,{zone,network});
 const words=value=>typeof value==='string'?value.trim().split(/\s+/).join(' '):'';
 const expected=words(current?.seed);if(!expected)throw Error('The open wallet has no recovery phrase to compare.');
 const samePhrase=words(recovered.phrase)===expected;
 // Both wallet engines open account 0 when a backup records none (the XMR engine never writes the field), so an absent
 // account and an explicit 0 are the same account here; an account-synced copy records the 0 explicitly.
 const accountOf=value=>Number.isSafeInteger(value)?value:0;
 const sameAccount=accountOf(payload.account)===accountOf(current?.account);
 const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
 const samePendingPayment=Boolean(current?.pending)&&Boolean(payload.pending)&&canonical(current.pending)===canonical(payload.pending);
 const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
 const currentCoverage=Math.max(count(current?.subaddresses),count(current?.scannedSubaddresses));
 const backupCoverage=Math.max(count(payload.subaddresses),count(payload.scannedSubaddresses));
 // Which part of the receive-address recovery state this backup does not cover (null when all of it is). The check stays exact: a backup that
 // omits even one newer address is stale (tests/silo-backup-drill.test.mjs); the reason only says WHAT is out of date, so the person is told what to do.
 const receiveGap=zone!=='xmr'?null:backupCoverage<currentCoverage?'addresses':!(current?.ordinaryReceiveIndex===undefined||current.ordinaryReceiveIndex===null||payload.ordinaryReceiveIndex===current.ordinaryReceiveIndex)?'receive-address':(current?.subaddressCacheRequired&&!recovered.scanCacheIncluded)?'scan-cache':null;
 const sameReceiveState=receiveGap===null;
 const currentConversions=current?.conversionRecovery?.entries??[];
 const backupConversions=new Map(payload.conversionRecovery?.entries??[]);
 const sameConversionRecovery=zone!=='xmr'||currentConversions.every(([key,saved])=>canonical(backupConversions.get(key))===canonical(saved));
 const currentBirthday=Number.isSafeInteger(current?.height)&&current.height>=0?current.height:null;
 const safeBirthday=recovered.birthday!==null&&recovered.birthday>=0&&currentBirthday!==null&&recovered.birthday<=currentBirthday;
 return Object.freeze({samePhrase,sameAccount,samePendingPayment,sameReceiveState,receiveGap,backupAddresses:backupCoverage,walletAddresses:currentCoverage,sameConversionRecovery,safeBirthday,sameBirthday:samePhrase&&recovered.birthday!==null&&recovered.birthday===currentBirthday,birthday:recovered.birthday,
  pendingPayment:recovered.pendingPayment,openWalletPending:Boolean(current?.pending),scanCacheIncluded:recovered.scanCacheIncluded});
}

/** Whether the receive-address state of a backup counts as current. Exact by default. The one allowed exception covers a person who
 * exports and then takes a while to choose the file: the file is the very one this session exported, the wallet issued NO new receive
 * address since (no Receive, no Convert quote, no new address), and the wallet only DISCOVERED further addresses while scanning, no more
 * than the lookahead a phrase restore re-derives by itself. Any other file, any address issued after the export, a bigger gap, a changed
 * ordinary receive address or a missing required cache stays stale. */
export function siloAcceptReceiveState(result,{sameFileAsLastExport=false,issuedSinceExport=0}={}){
 if(result?.sameReceiveState===true)return true;
 return result?.receiveGap==='addresses'&&sameFileAsLastExport===true&&issuedSinceExport===0&&Number.isSafeInteger(result.walletAddresses)&&Number.isSafeInteger(result.backupAddresses)&&result.walletAddresses-result.backupAddresses<=SILO_RECOVERY_XMR_LOOKAHEAD;
}

/** The single rule for "this backup proves recovery for this wallet": same phrase and account, a birthday no later than the wallet's, a
 * current receive state (see siloAcceptReceiveState), the conversion recovery attempts present, and a pending payment that matches. Used
 * by the backup drill and by a restore from a backup FILE (the file that just opened the wallet is the proof, bound to the exact copy). */
export function siloBackupProvesRecovery(result, receiveOk) {
  return Boolean(result?.samePhrase && result.sameAccount && result.safeBirthday && receiveOk === true && result.sameConversionRecovery && !(result.openWalletPending && !result.samePendingPayment));
}
