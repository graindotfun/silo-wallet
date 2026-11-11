/** Product account controller: cookie identity is separate from vault decryption.
 * Only encrypted original native backups leave this module. Signing and provider
 * execution are not APIs here. Versioned combined recovery preserves original
 * native ciphertext and the historical XMR payload without signing authority. */
import {openBrowserSyncClient} from './local-store.mjs';
import {assertNativeSyncBackup} from './native-wallets.mjs';
import {restoreSyncedNativeWallet} from './native-wallet-restore.mjs';
import {createNativeKeyring,restoreNativeKeyring} from '../native-keyring.mjs';
import {siloPassphraseProblem} from '../passphrase-strength.mjs';
import {openNativeKeyringStore} from '../native-keyring-store.mjs';
import {captureLegacyJournals} from './legacy-journals.mjs';
import {createSigningGate} from './signing-gate.mjs';
import {assertVaultIdentity} from './vault-identity.mjs';
import {siloBrowserVerifiers} from './browser-verifiers.mjs';
import {assertCombinedWalletBackup} from './combined-wallets.mjs';
import {openSilo} from '../local-envelope.mjs';
import {canonical,sha256Hex} from './codec.mjs';
import {vaultNetworkProfile} from './network-profile.mjs';
const held=()=>Error('Account action is held or was cancelled.');
// HTTP 401 alone cannot tell an expired or signed-out session from a removed device; this copy is true for each.
const SIGNED_OUT='This device is no longer signed in to the account, or it was removed from the account. Sign in again; a removed device then needs approval from a device you already use. Local wallets and backups were not changed.';
const LOCKED='Account vault locked. Local wallets were not changed.';
function failure(error){
 const code=error?.syncCode;
 if(['enrollment-capacity','account-device-capacity'].includes(code))return 'Device approval capacity has been reached. Keep your existing approved device and recovery file; account service capacity needs review.';
 if(code==='vault-exists')return 'An account vault already exists. Unlock it; nothing was replaced.';
 if(['approval-required','enrollment-pending','not-trusted'].includes(code))return 'This device needs approval from a device you already use.';
 if(code==='wrong-secret')return 'This passphrase does not open the account vault.';
 if(code==='recovery-code-held')return 'Only the device that created this vault, or an approved device, fully synced, can replace the recovery code. Nothing was changed.';
 if(code==='recovery-slots-changed')return 'The account unlock methods changed on another device. Nothing was replaced, and the new code shown does not work. Sync, then make a new code.';
 if(code==='no-replacement')return 'No new recovery code is waiting. Nothing was changed.';
 if(code==='xmr-export-passphrase')return 'Use the original Monero wallet passphrase: the one that opened the Monero backup added to this account. A different passphrase was refused and no file was created.';
 if(code==='code-mismatch')return 'That code does not match a device still waiting for approval. If you already approved it, use Check device approval on the new device. Nothing was shared.';
 if(code==='account-email-budget')return 'Too many sign-in codes were sent to this address. Wait an hour, then try again. Nothing was changed.';
 if(code==='code-invalid')return 'This code is not valid. Check it for typing mistakes. Nothing was changed.';
 if(code==='recovery-code-given')return 'This is your account recovery code. Never give it to another device or to anyone: it can open your account vault. Type the APPROVE code the other device shows. Nothing was shared.';
 if(code==='approval-code-given')return 'This is a device approval code, not your account recovery code. Nothing was changed.';
 if(code==='recovery-proof-required')return 'This device was recovered but has not yet shown it holds the recovery code. Unlock with the recovery code; until then it can only read the account. Nothing was changed.';
 if(code==='no-enrollment')return 'No pending approval request is stored in this browser. Existing wallets and backups were not changed.';
 if(code==='revoked'||error?.syncSessionRejected)return SIGNED_OUT;
 if(error?.syncCancelled||code==='cancelled')return LOCKED;
 if(error?.syncOffline)return 'The account service is unavailable. Existing local wallets and backups were not replaced.';
 if(code==='conflict')return 'Sync needs recovery review. New actions remain held.';
 return 'The account action could not be verified. Local wallets and backups were not replaced.';
}
/** `vaultIdentity({solanaOwner})` resolves what a new vault (or an added wallet) records about the wallets it acts for
 * (vault-identity.mjs): {solanaStartMarker, xmrWallet?, xmrBirthday?}. Nothing with a Solana wallet is created or added
 * without its start marker. Readers are attached with `attachDeviceReaders` when the wallets they read are open.
 * @param {{enabled?: boolean, legacyStorage?: any, newWalletReviewEnabled?: boolean, reviewedOrigin?: string|null, vaultIdentity?: (input: {solanaOwner: string|null, network?: string}) => Promise<any>, networkProfile?: "mainnet"|"test-networks", [option: string]: any}} [options] */
export async function openProductAccountController({enabled=false,legacyStorage=globalThis.localStorage,newWalletReviewEnabled=false,reviewedOrigin=/** @type {string|null} */(null),vaultIdentity,networkProfile='mainnet',...options}={}){
 if(enabled!==true)throw Error('Account sync is held on this build.');
 const verifiers={};
 return createProductAccountController({binding:{...await openBrowserSyncClient({...options,networkProfile,verifiers}),verifiers},legacyStorage,newWalletReviewEnabled,reviewedOrigin,vaultIdentity,networkProfile});
}
export function createProductAccountController({binding,legacyStorage,newWalletReviewEnabled=false,reviewedOrigin=/** @type {string|null} */(null),currentOrigin=()=>globalThis.location?.origin,nativeStoreFactory=openNativeKeyringStore,vaultIdentity,networkProfile='mainnet'}={}){
 // The vault network profile (network-profile.mjs): 'mainnet' everywhere in the product; 'test-networks' only for a site in
 // test mode with Solana on devnet. Wallet labels, the Monero backup network and history reads all follow it.
 const profile=vaultNetworkProfile(networkProfile),nativeNetwork=chain=>chain==='solana'?profile.native:'mainnet',openStore=chain=>nativeStoreFactory(chain,{network:nativeNetwork(chain)});
 if(!binding?.client||!binding.local||typeof binding.close!=='function')throw Error('Durable account binding required.');
 const client=binding.client,listeners=new Set(),temporary=new Set();let replacement=null,generation=0,closed=false,active=null,codeWaiter=null,login=null,restoreAbort=null,signing=null,signingEpoch=0;
 const gate=()=>{
  if(signing)return signing;
  const revision=generation,localEpoch=binding.local.epoch,permissionEpoch=signingEpoch;
  return signing=createSigningGate({client,captureContext:()=>{
   const trust=state.deviceTrust;
   const check=()=>{if(closed||revision!==generation||permissionEpoch!==signingEpoch||localEpoch!==binding.local.epoch||binding.local.closed||
     !state.authenticated||!state.vaultUnlocked||state.busy||!['synced','recovery-held'].includes(state.phase)||state.deviceTrust!==trust||!['genesis','approval','recovery'].includes(trust))throw held();};
   check();return check;
  }});
 };
 let state={phase:'signed-out',busy:false,authenticated:false,vaultUnlocked:false,deviceTrust:null,blockingCount:0,vaultExistence:'unknown',reason:null,recoveryCodeAttention:false,recoveryProtectionMissing:false};
 /** What the vault records for these wallets; a Solana wallet is refused without its start marker. */
 async function identityFor(solanaOwner,revision){
  const recorded=typeof vaultIdentity==='function'?await vaultIdentity({solanaOwner,network:profile.solana}):{};assert(revision);
  const identity=assertVaultIdentity({expectedSolanaOwner:solanaOwner,xmrWallet:recorded?.xmrWallet??null,xmrBirthday:recorded?.xmrBirthday??null,solanaStartMarker:recorded?.solanaStartMarker??null,xmrNetwork:profile.xmr});
  if(solanaOwner&&!identity.solanaStartMarker)throw Error('The Solana history start could not be read. Nothing was created.');
  return identity;
 }
 const snapshot=()=>structuredClone(state);
 const notify=patch=>{state={...state,...patch};for(const listener of listeners)listener(snapshot());};
 const assert=revision=>{if(closed||revision!==generation||binding.local.closed||active?.revision===revision&&active.localEpoch!==binding.local.epoch)throw held();};
 function cancelLocal(){generation++;signing=null;replacement=null;codeWaiter?.reject(held());codeWaiter=null;restoreAbort?.abort();restoreAbort=null;for(const store of temporary)store.close();temporary.clear();client.lock();notify({busy:false,vaultUnlocked:false,blockingCount:0,phase:state.authenticated?'signed-in':'signed-out',reason:LOCKED});}
 async function run(phase,action,{keepVerifiedPhase=false}={}){
  if(closed||active||login)throw held();const revision=generation;let finished;const token={revision,localEpoch:binding.local.epoch,done:new Promise(resolve=>{finished=resolve;})};active=token;
  // An encrypted-copy load does not discard a previously verified session.
  // Busy still excludes concurrent account actions; sync, identity and lock
  // failures retain the same cancellation path and clear that session.
  const retainedPhase=keepVerifiedPhase&&state.vaultUnlocked&&state.phase==='synced';
  notify({busy:true,...(retainedPhase?{}:{phase}),reason:null});
  try{const result=await action(revision);assert(revision);return result;}
  catch(error){if(revision===generation&&!closed){client.lock();notify({vaultUnlocked:false,phase:state.authenticated?'signed-in':'signed-out',reason:failure(error)});}throw Object.assign(Error(revision===generation?failure(error):'Account action was cancelled.'),revision===generation&&error?.syncCode==='xmr-export-passphrase'?{syncCode:error.syncCode}:{});}
  finally{if(active===token)active=null;if(revision===generation&&!closed)notify({busy:false});finished();}
 }
 async function discoverVault(revision){
  try{const identity=await binding.local.get('session');assert(revision);const me=await client.me();assert(revision);if(!identity||me.deviceId!==identity.deviceId||me.accountId!==undefined&&me.accountId!==identity.accountId||typeof me.hasVault!=='boolean')throw held();notify({vaultExistence:me.hasVault?'existing':'missing'});}
  catch{assert(revision);notify({vaultExistence:'unknown'});}
  return state.vaultExistence;
 }
 function newWalletPermission(){return newWalletReviewEnabled===true&&reviewedOrigin==='https://review-retired.invalid'&&currentOrigin()===reviewedOrigin;}
 async function localEncryptedBackup(chain,revision){
  if(chain!=='solana')throw held();const store=await openStore(chain);temporary.add(store);
  try{assert(revision);const envelope=await store.read();assert(revision);if(!envelope)throw Error('No staged encrypted wallet exists.');return assertNativeSyncBackup({schema:'silo-sync-native-public-v1',wallets:[envelope]},{network:profile.native}).wallets[0];}
  finally{store.close();temporary.delete(store);}
 }
 async function vaultState(revision){
  const trust=await client.trust();assert(revision);const blocking=await client.blockingOperations();assert(revision);
  // Offered automatically: this device showed a recovery code its owner never confirmed writing down (client.mjs).
  const recoveryCode=await client.recoveryCodeCheck();assert(revision);
  const trusted=Boolean(trust&&['genesis','approval','recovery'].includes(trust.via)&&(trust.via!=='recovery'||trust.reconciled===true));
  const synced=client.status?.status==='synced';
  notify({vaultExistence:'existing',vaultUnlocked:true,deviceTrust:trust?.via??null,blockingCount:blocking.length,recoveryCodeAttention:recoveryCode.attention===true,recoveryProtectionMissing:recoveryCode.protection==='missing',phase:!synced?'recovery-required':!trusted?'recovery-required':blocking.length?'recovery-held':'synced',reason:!synced?'Sync conflicts or unavailable evidence keep actions held.':!trusted?'Recovery requires independent activity readers.':blocking.length?'Saved recovery records remain held until their protocols are verified.':null});
  return snapshot();
 }
 async function preserve(revision){
  if(!legacyStorage?.getItem)throw Error('Local recovery storage is unavailable.');
  // Records the signing gate already tracks as account operations are not legacy; every other local record is preserved.
  const captured=captureLegacyJournals(legacyStorage);assert(revision);const snapshot=captured.records.length?gate().unexplainedLegacy(captured,await client.operations()):captured;assert(revision);
  if(snapshot.records.length)await client.importLegacyJournals(snapshot);assert(revision);
 }
 function incompleteCreation(created,revision){
  assert(revision);const before=binding.local.epoch;client.lock();if(active?.revision===revision&&generation===revision&&(binding.local.epoch===before||binding.local.epoch===before+1))active.localEpoch=binding.local.epoch;
  notify({vaultExistence:state.vaultExistence==='existing'?'existing':'unknown',phase:'recovery-required',vaultUnlocked:false,reason:'Account creation may have succeeded but initialization is incomplete. Keep original encrypted backups and the one-time code. Unlock this same account to resume; do not create again.'});return {...created,initializationComplete:false};
 }
 async function combinedInput({wallets=[],walletPassphrases={},passphrase,xmrBackup=null,xmrPassphrase},revision){
  const native=wallets.length?assertNativeSyncBackup({schema:'silo-sync-native-public-v1',wallets},{network:profile.native}):null;
  for(const envelope of native?.wallets??[]){let saved=null,done=false;const callbacks=new Set();const store={get closed(){return done||revision!==generation;},read:async()=>saved,create:async value=>{assert(revision);if(done||saved)return false;saved=structuredClone(value);return true;},close(){if(done)return;done=true;for(const callback of callbacks)callback();callbacks.clear();},onClose(callback){callbacks.add(callback);}};temporary.add(store);let restored;try{restored=await restoreNativeKeyring({backup:envelope,passphrase:walletPassphrases[envelope.chain]??passphrase,store,network:nativeNetwork(envelope.chain)});assert(revision);}finally{restored?.lock();store.close();temporary.delete(store);}}
  let xmr=null;
  if(xmrBackup){const envelope=structuredClone(xmrBackup);if(envelope.zone!=='xmr'||envelope.network!==profile.xmr)throw Error(profile.xmr==='mainnet'?'Only an original Monero mainnet backup may be added.':'Only an original Monero stagenet backup may be added to a test-network account.');xmr=await openSilo(envelope,xmrPassphrase);assert(revision);}
  const backup=assertCombinedWalletBackup({schema:'silo-sync-combined-wallets-v1',wallets:native?.wallets??[],xmr},profile);
  const legacyPendingOpId=xmr?.pending?(await sha256Hex('xmr-original-pending:'+canonical(xmr.pending))).slice(0,32):undefined;assert(revision);return {backup,legacyPendingOpId};
 }
 const api={snapshot,subscribe(listener){listeners.add(listener);listener(snapshot());return()=>listeners.delete(listener);},
  restoreSession:()=>run('checking-account',async revision=>{
   const saved=await binding.local.get('session');assert(revision);if(!saved){notify({vaultExistence:'unknown',phase:'signed-out',authenticated:false,deviceTrust:null});return snapshot();}
   const me=await client.me();assert(revision);if(me.accountId!==saved.accountId||me.deviceId!==saved.deviceId)throw held();
   notify({phase:'signed-in',authenticated:true,deviceTrust:me.trust??null,vaultUnlocked:false,reason:'Account connected. Unlock the encrypted vault separately.'});await discoverVault(revision);return snapshot();
  }),
  async beginSignIn(email){
   if(closed||active||login||typeof email!=='string'||email.length>254||!/^\S+@\S+\.\S+$/.test(email))throw held();
   const revision=++generation;signing=null;client.lock();notify({vaultExistence:'unknown',phase:'sending-code',busy:true,authenticated:false,vaultUnlocked:false,deviceTrust:null,blockingCount:0,reason:null});
   let readyResolve,readyReject;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
   const pending=client.signIn(email,()=>{assert(revision);notify({phase:'code-required',busy:false});return new Promise((resolve,reject)=>{codeWaiter={resolve,reject};readyResolve(snapshot());});});
   login=pending.then(async()=>{assert(revision);notify({phase:'signed-in',busy:false,authenticated:true,reason:'Account connected. Unlock the encrypted vault separately.'});await discoverVault(revision);return snapshot();},error=>{readyReject(Error(failure(error)));if(revision===generation&&!closed){client.lock();notify({phase:'signed-out',busy:false,reason:failure(error)});}throw Error(revision===generation?failure(error):'Account action was cancelled.');}).finally(()=>{if(revision===generation)codeWaiter=null;login=null;});
   // Keep a handler attached while the UI waits for the code; errors are surfaced
   // by ready/submitCode rather than an unhandled promise or raw error rendering.
   login.catch(()=>{});return ready;
  },
  async submitCode(code){if(!codeWaiter||!login||!/^[0-9]{6}$/.test(code))throw held();const pending=login,waiter=codeWaiter;codeWaiter=null;notify({phase:'verifying-code',busy:true,reason:null});waiter.resolve(code);return pending;},
  async cancelSignIn(){const pending=login;cancelLocal();await pending?.catch(()=>{});},
  lock(){cancelLocal();},async signOut(){const pending=login,prior=active;cancelLocal();await pending?.catch(()=>{});await prior?.done;return run('signing-out',async revision=>{try{await client.signOut();if(active?.revision===revision)active.localEpoch=binding.local.epoch;assert(revision);notify({vaultExistence:'unknown',phase:'signed-out',authenticated:false,deviceTrust:null,vaultUnlocked:false,reason:'Signed out of this account.'});return {serverSignedOut:true};}catch{if(revision!==generation||closed)throw held();if(await binding.local.get('session')===null&&active?.revision===revision)active.localEpoch=binding.local.epoch;notify({vaultExistence:'unknown',phase:'signed-out',authenticated:false,deviceTrust:null,vaultUnlocked:false,reason:'Local account vault locked. Server logout could not be confirmed.'});return {serverSignedOut:false};}});},close(){if(closed)return;cancelLocal();closed=true;binding.close();unsubscribe?.();listeners.clear();},
  refreshVaultExistence:()=>run('checking-vault',async revision=>{await discoverVault(revision);return snapshot();}),
  stagedWalletEncryptedBackup:chain=>run('exporting-staged-recovery',revision=>localEncryptedBackup(chain,revision)),
  createNewWalletAndVault:/** @param {{passphrase:string,walletPassphrase?:string,chain?:'solana'}} options */ options=>run('creating-new-wallet',async revision=>{
   const {passphrase,walletPassphrase=passphrase,chain='solana'}=options??{};
   if(!newWalletPermission()||chain!=='solana'||!state.authenticated)throw held();const passProblem=siloPassphraseProblem(passphrase);if(passProblem)throw Error(passProblem);
   if(await discoverVault(revision)!=='missing')throw Error('Account vault absence is not verified. Unlock or check the existing account; no wallet was generated.');
   if(await binding.local.get('genesis-intent')||await binding.local.get('outbox'))throw Error('Existing initialization must be resumed. No wallet was generated.');assert(revision);
   const store=await openStore(chain);temporary.add(store);let session,envelope;
   try{
    assert(revision);if(await store.read())throw Error('A local wallet already exists. Export its original encrypted backup; no replacement was made.');assert(revision);
    session=await createNativeKeyring({chain,passphrase:walletPassphrase,store,network:nativeNetwork(chain)});assert(revision);envelope=session.exportBackup();
    const stored=await store.read();assert(revision);if(canonical(stored)!==canonical(envelope))throw Error('The staged encrypted wallet could not be read back.');
   }finally{session?.lock();store.close();temporary.delete(store);}
   const recovery={encryptedBackup:structuredClone(envelope),address:envelope.address,chain,network:nativeNetwork(chain),backupVerification:'not-verified'};
   let created;
   try{assert(revision);if(!newWalletPermission())throw held();const identity=await identityFor(envelope.address,revision);if(!newWalletPermission())throw held();created=await client.createVault({passphrase,backup:{schema:'silo-sync-native-public-v1',wallets:[envelope]},...identity});assert(revision);}
   catch{assert(revision);await discoverVault(revision);return {...incompleteCreation({initializationComplete:false,warning:'The new encrypted local wallet is preserved. Export it. Account initialization could not be confirmed; do not generate another wallet.'},revision),...recovery};}
   if(created.initializationComplete===false){await discoverVault(revision);return {...incompleteCreation(created,revision),...recovery};}
   notify({vaultExistence:'existing'});
   try{await preserve(revision);await vaultState(revision);}catch{assert(revision);return {...incompleteCreation(created,revision),...recovery};}
   return {...created,...recovery,initializationComplete:true};
  }),
  createVaultFromEncryptedBackups:({passphrase,wallets,walletPassphrases={}})=>run('creating-vault',async revision=>{
   const backup=assertNativeSyncBackup({schema:'silo-sync-native-public-v1',wallets},{network:profile.native});
   for(const envelope of backup.wallets){
    let saved=null,done=false;const callbacks=new Set();const store={get closed(){return done||revision!==generation;},read:async()=>saved,create:async value=>{assert(revision);if(done||saved)return false;saved=structuredClone(value);return true;},close(){if(done)return;done=true;for(const callback of callbacks)callback();callbacks.clear();},onClose(callback){callbacks.add(callback);}};temporary.add(store);
    let restored;try{restored=await restoreNativeKeyring({backup:envelope,passphrase:walletPassphrases[envelope.chain]??passphrase,store,network:nativeNetwork(envelope.chain)});assert(revision);}finally{restored?.lock();store.close();temporary.delete(store);}
   }
   assert(revision);const created=await client.createVault({passphrase,backup,...await identityFor(backup.wallets.find(e=>e.chain==='solana')?.address??null,revision)});assert(revision);
   if(created.initializationComplete===false)return incompleteCreation(created,revision);
   try{await preserve(revision);await vaultState(revision);}catch{assert(revision);const before=binding.local.epoch;client.lock();if(active?.revision===revision&&generation===revision&&(binding.local.epoch===before||binding.local.epoch===before+1))active.localEpoch=binding.local.epoch;notify({phase:'recovery-required',vaultUnlocked:false,reason:'The account vault was created, but recovery initialization is incomplete. Keep the recovery code and original encrypted backups.'});return {...created,initializationComplete:false,warning:'Account vault created; recovery initialization remains held.'};}
   // One-time recovery code belongs only to the explicit caller, never controller
   // state or local persistence. UI must show it transiently and clear on lock.
   return {...created,initializationComplete:true};
  }),
  createCombinedVaultFromEncryptedBackups:options=>run('creating-combined-vault',async revision=>{
   const {backup,legacyPendingOpId}=await combinedInput(options,revision),created=await client.createVault({passphrase:options.passphrase,backup,legacyPendingOpId,...await identityFor(backup.wallets.find(e=>e.chain==='solana')?.address??null,revision)});assert(revision);
   if(created.initializationComplete===false)return incompleteCreation(created,revision);
   try{await preserve(revision);await vaultState(revision);}catch{assert(revision);const before=binding.local.epoch;client.lock();if(active?.revision===revision&&generation===revision&&(binding.local.epoch===before||binding.local.epoch===before+1))active.localEpoch=binding.local.epoch;notify({phase:'recovery-required',vaultUnlocked:false,reason:'Combined account recovery was created but initialization remains held. Keep original backup files and the one-time code.'});return {...created,initializationComplete:false};}
   return {...created,initializationComplete:true};
  }),
  addWalletsFromEncryptedBackups:options=>run('adding-encrypted-recovery',async revision=>{
   const {backup,legacyPendingOpId}=await combinedInput(options,revision),identity=await identityFor(backup.wallets.find(e=>e.chain==='solana')?.address??null,revision);await client.addWalletBackup(backup,{legacyPendingOpId,xmrWallet:identity.xmrWallet,xmrBirthday:identity.xmrBirthday,solanaStartMarker:identity.solanaStartMarker});assert(revision);await preserve(revision);return vaultState(revision);
  }),
  xmrEncryptedBackup:passphrase=>run('exporting-encrypted-xmr-recovery',async revision=>{
   await client.sync();assert(revision);await preserve(revision);const trust=await client.trust();assert(revision);if(client.status?.status!=='synced'||!trust||!['genesis','approval','recovery'].includes(trust.via)||trust.via==='recovery'&&trust.reconciled!==true)throw held();const envelope=await client.exportXmrBackup(passphrase);assert(revision);await vaultState(revision);return envelope;
  }),
  /** Replacing the account recovery code takes two steps, so its owner writes the new code down before it works (client.mjs).
   * The code goes only to the caller and is never kept in controller state or storage; locking drops a prepared code. */
  prepareRecoveryCodeReplacement:passphrase=>run('preparing-recovery-code',async revision=>{replacement=null;const prepared=await client.prepareRecoveryCodeReplacement({passphrase});assert(revision);replacement={ticket:prepared.ticket,revision};return {recoveryCode:prepared.recoveryCode,waitingRecoveries:prepared.waitingRecoveries};},{keepVerifiedPhase:true}),
  activateRecoveryCodeReplacement:()=>run('replacing-recovery-code',async revision=>{const pending=replacement;replacement=null;if(!pending||pending.revision!==revision)throw Object.assign(held(),{syncCode:'no-replacement'});const result=await client.activateRecoveryCodeReplacement(pending.ticket);assert(revision);await vaultState(revision);return {status:result.status,safetyCode:result.safetyCode};},{keepVerifiedPhase:true}),
  discardRecoveryCodeReplacement(){replacement=null;client.discardRecoveryCodeReplacement();},
  /** The owner confirmed writing down the code shown at creation; only this device's note changes. */
  async confirmRecoveryCodeSaved(){if(closed)throw held();await client.confirmRecoveryCodeSaved();notify({recoveryCodeAttention:false});return snapshot();},
  unlockVault:secret=>run('unlocking-vault',async revision=>{await client.unlock(secret);assert(revision);await preserve(revision);return vaultState(revision);}),
  sync:()=>run('syncing',async revision=>{await client.sync();assert(revision);await preserve(revision);return vaultState(revision);}),
  preserveLegacyJournals:()=>run('syncing-recovery',async revision=>{await preserve(revision);return vaultState(revision);}),
  requestEnrollment:()=>run('requesting-approval',async revision=>{const result=await client.requestEnrollment();assert(revision);notify({phase:'approval-required',reason:'Compare this enrollment code on an already approved device.'});return result;}),
  approveEnrollment:(code,passphrase)=>run('approving-device',async revision=>{const result=await client.approveEnrollment(code,{passphrase});assert(revision);notify({phase:state.vaultUnlocked?'synced':'signed-in'});return result;}),
  completeEnrollment:()=>run('completing-approval',async revision=>{
   let result;
   try{result=await client.completeEnrollment();}
   catch(error){
    // A successfully consumed grant removes its pending request. Checking again
    // is not another enrollment: require fresh server approval and, while open,
    // the existing cryptographic trust anchor plus a fully verified sync.
    if(error?.syncCode!=='no-enrollment')throw error;
    const me=await client.me();assert(revision);
    if(me.trust!=='approved')throw error;
    if(!state.vaultUnlocked){notify({phase:'signed-in',vaultUnlocked:false,reason:'This device is already approved. Unlock the synced vault with its passphrase to resume; recovery checks still apply.'});return snapshot();}
    const trust=await client.trust();assert(revision);
    if(trust?.via!=='approval')throw error;
    await client.sync();assert(revision);result={status:'approved'};
   }
   assert(revision);
   if(result.status==='waiting'){notify({phase:'approval-required',reason:'This device is still waiting for approval.'});return result;}
   await preserve(revision);return vaultState(revision);
  }),
  /** Every trusted device is lost: ask for delayed recovery of this account on this device. Any trusted device can see and
   * cancel it during the delay; afterwards the recovery code unlocks it and recoveryStatus must still pass every check. */
  startRecovery:()=>run('starting-recovery',async revision=>{const result=await client.startRecovery();assert(revision);notify({phase:'recovery-required',reason:`Recovery for this device can continue after ${new Date(result.recoveryAt).toISOString()} unless a trusted device cancels it. Then unlock with the recovery code.`});return {recoveryAt:result.recoveryAt};}),
  /** Owner remedy during another device's recovery wait: list and cancel recoveries waiting on other devices. A trusted
   * device sees them; cancelling removes that device. */
  waitingRecoveries:()=>run('checking-recoveries',async revision=>{const list=(await client.devices()).filter(device=>device.trust==='recovery-wait'&&device.revokedAt===null);assert(revision);return list.map(({deviceId,recoveryAt})=>({deviceId,recoveryAt}));},{keepVerifiedPhase:true}),
  cancelWaitingRecoveries:()=>run('cancelling-recoveries',async revision=>{const list=(await client.devices()).filter(device=>device.trust==='recovery-wait'&&device.revokedAt===null);assert(revision);for(const device of list){await client.cancelRecovery(device.deviceId);assert(revision);}return {cancelled:list.length};},{keepVerifiedPhase:true}),
  recoveryStatus:()=>run('checking-recovery',async revision=>{const result=await client.reconcileRecovery();assert(revision);if(result.status!=='reconciled'){notify({phase:'recovery-required',reason:'Independent recovery readers or unresolved records keep this device held.'});return {status:'held'};}return vaultState(revision);}),
  nativeEncryptedBackup:chain=>run('loading-encrypted-backup',async revision=>{
   if(!['solana','evm'].includes(chain))throw held();await client.sync();assert(revision);await preserve(revision);const trust=await client.trust();assert(revision);
   if(client.status?.status!=='synced'||!trust||!['genesis','approval','recovery'].includes(trust.via)||trust.via==='recovery'&&trust.reconciled!==true)throw held();
   const source=client.walletBackup(),payload=assertNativeSyncBackup(source.schema==='silo-sync-combined-wallets-v1'?{schema:'silo-sync-native-public-v1',wallets:source.wallets}:source,{network:profile.native}),envelope=payload.wallets.find(e=>e.chain===chain);if(!envelope)throw held();await vaultState(revision);assert(revision);return structuredClone(envelope);
  },{keepVerifiedPhase:true}),
  /** The signing gate while the vault is unlocked on a trusted device (open operations are refused by the gate itself, with
   * their reasons); otherwise null and signing is held. */
  signingGate:()=>state.vaultUnlocked&&['synced','recovery-held'].includes(state.phase)?gate():null,
  /** Attach this device's outcome/history readers (readers.mjs, readers-variants.mjs) as wallets open; null removes one. */
  setVerifiers(map){if(!binding.verifiers)throw held();for(const [kind,verifier] of Object.entries(map??{})){if(verifier)binding.verifiers[kind]=verifier;else delete binding.verifiers[kind];}},
  /** This device's readers from the browser factory (browser-verifiers.mjs), with Solana history checkpoints kept in this
   * device's durable account storage. Called again when the Monero wallet opens or closes; whatever is unavailable holds.
   * @param {{origin?: string, fetcher?: any, xmrSession?: any, orders?: any}} [options] */
  attachDeviceReaders({origin,fetcher,xmrSession=null,orders=null}={}){
   if(!binding.verifiers)throw held();
   const checkpoints={get:async key=>binding.local.get('history:'+await sha256Hex(key)),set:async(key,value)=>{await binding.local.set('history:'+await sha256Hex(key),value);},delete:async key=>{await binding.local.delete('history:'+await sha256Hex(key));}};
   const next=siloBrowserVerifiers({...(origin?{origin}:{}),...(fetcher?{fetcher}:{}),xmrSession,orders,solanaCheckpoints:checkpoints});
   for(const kind of Object.keys(binding.verifiers))if(!next[kind])delete binding.verifiers[kind];
   Object.assign(binding.verifiers,next);
   return Object.keys(next).sort();
  },
  /** Finish this device's records after reconnecting or reloading (signing-gate.mjs `resume`), then refresh the state. */
  resumeSigning:storages=>run('syncing',async revision=>{const result=await gate().resume(storages);assert(revision);await vaultState(revision);return result;}),
  restoreNativeWallet:({chain,passphrase,store})=>run('restoring-native-wallet',async revision=>{
   restoreAbort=new AbortController();const restored=await restoreSyncedNativeWallet({client,chain,passphrase,store,signal:restoreAbort.signal,network:nativeNetwork(chain)});try{assert(revision);return restored;}catch(error){restored.lock();throw error;}finally{restoreAbort=null;}
  }),
 };
 const unsubscribe=client.onStatus?.(({status,reason})=>{if(closed)return;if(!['synced','syncing'].includes(status)){signing=null;signingEpoch++;}if(status==='local-only'&&reason==='locked')notify({vaultUnlocked:false,...(!active&&!login?{phase:state.authenticated?'signed-in':'signed-out',reason:'Account vault locked.'}:{})});else if(status==='offline')notify({vaultUnlocked:false,phase:'offline',reason:'Account service unavailable. Original backups and local wallets remain available.'});else if(reason==='session-revoked')notify({vaultUnlocked:false,deviceTrust:null,phase:'signed-out',authenticated:false,reason:SIGNED_OUT});
 // The session is valid; this device is waiting for approval or for its recovery period. Keep it signed in so it can continue.
 else if(reason==='approval-required')notify({vaultUnlocked:false,deviceTrust:null,phase:'approval-required',reason:'This device is waiting for approval from a trusted device, or for its recovery period to end.'});});
 return Object.freeze(api);
}
