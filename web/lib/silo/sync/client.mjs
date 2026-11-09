/** Silo sync client (prototype). One instance per browser profile/device.
 *
 * Guarantees inside Silo:
 *  - Nothing secret leaves the device: the server gets wrap slots, encrypted objects, MACed manifests and
 *    enrollment grants encrypted to a device key.
 *  - No last-write-wins for keys or the journal: every commit is a conditional write on the head revision; a
 *    stale writer pulls, merges with merge.mjs and retries. Journal entries never disappear.
 *  - A new operation is reserved before any signing prompt, only on a trusted device, only when no operation on
 *    any device still blocks (outcome.mjs), under the writer lease (fencing epoch). A lost acknowledgement is
 *    replayed with the same idempotency key, never reserved again.
 *  - A terminal state written by any device is only a claim. This device closes an operation only after its own
 *    protocol verifier confirms the same outcome for the same network, signature and bound message.
 *  - Trust anchors: the creating device (genesis); a device approved by a trusted device, whose freshness starts at
 *    the approver's checkpoint (enroll.mjs); or a device recovered after every device was lost, which must reconcile
 *    against the chain before its first action. Unlocking ciphertext alone never makes a device trusted.
 * Not guaranteed: anything a device does with a key copy outside Silo. Removing a device stops its sync access;
 * it cannot erase or disable a seed already copied to it. */
import {b64u, canonical, fromB64u, randomId, sameText, sha256Hex} from './codec.mjs';
import {createRecoveryCode, createVaultKeyBytes, deriveVaultKeys, unwrapVaultKey, wrapVaultKey} from './vault-keys.mjs';
import {recoveryAuthorityPublicKey, signRecoveryProof} from './authority.mjs';
import {openObject, openScanCache, scanCacheRef, sealObject, sealScanCache, SYNC_DEFAULT_CHUNK_BYTES} from './objects.mjs';
import {safetyCode, signManifest, slotsHash, verifyManifest} from './manifest.mjs';
import {assertVaultIdentity} from './vault-identity.mjs';
import {assertEvidenceOnly, assertJournalGrowth, assertOperation, isTerminalState, joinWalletBackup, mergeDevices, mergeJournal, mergeXmrState, splitWalletBackup} from './merge.mjs';
import {blockingOperations, checkOperationOutcome} from './outcome.mjs';
import {readCoverage} from './coverage.mjs';
import {createEnrollmentKey, enrollmentCode, normalizeEnrollmentCode, openGrant, publicKeyHash, sealGrant} from './enroll.mjs';
import {sealSilo} from '../local-envelope.mjs';
import {createSiloConversionRecovery} from '../conversion-recovery.mjs';
import {assertLegacyJournalSnapshot,legacyJournalEntries,legacyJournalSnapshot} from './legacy-journals.mjs';
import {appendWalletKeys,walletKeySegments} from './combined-wallets.mjs';
import {profileMatches,vaultNetworkProfile} from './network-profile.mjs';

export const SYNC_STATUSES = Object.freeze(['local-only', 'syncing', 'synced', 'offline', 'conflict', 'recovery-required']);
const SMALL = ['keys', 'journal', 'xmr-state', 'profile', 'devices'];
const EMPTY_DEVICES = {schema: 'silo-sync-devices-v1', devices: {}};
class Offline extends Error { constructor() { super('Offline. Nothing new was sent.'); this.syncOffline = true; } }
const fail = (message, code, extra = {}) => Object.assign(Error(message), {syncCode: code, ...extra});
/** This device's own note about the recovery code it last showed: never the code, only whether its owner confirmed writing it
 * down, or which new recovery slot an activation in doubt sent. */
const RECOVERY_NOTE = 'recovery-code-note', RECOVERY_NOTE_SCHEMA = 'silo-recovery-code-note-v1';

export function memoryLocal() {
  const map = new Map();
  return {get: async (key) => structuredClone(map.get(key) ?? null), set: async (key, value) => { map.set(key, structuredClone(value)); }, delete: async (key) => { map.delete(key); }, map};
}

/** @param {{transport: (request: any) => Promise<{status: number, body: any}>, local?: {get: (key: string) => Promise<any>, set: (key: string, value: any) => Promise<unknown>, delete: (key: string) => Promise<unknown>}, now?: () => number, chunkBytes?: number, verifiers?: Record<string, any>}} options */
/** `networkProfile`: 'mainnet' (default, product) or 'test-networks' (owner decision Q2; staging runtimes only). A client never
 * unwraps, syncs or writes a vault of another profile. */
export function createSyncClient({transport, local = memoryLocal(), now = () => Date.now(), chunkBytes = SYNC_DEFAULT_CHUNK_BYTES, verifiers = {}, networkProfile = 'mainnet'} = {}) {
  const PROFILE = vaultNetworkProfile(networkProfile);
  let keys = null, state = null, head = null, slots = null, status = 'local-only', reason = 'signed-out', lease = null;
  // Decrypted state for an in-flight commit lives in memory only; the durable outbox holds ciphertext alone.
  let inflight = null, unpublished = null, keyEpoch=0, recoveryAcknowledgement=null, pendingReplacement=null, activatingReplacement=false;
  const listeners = new Set();
  const setStatus = (next, why = null) => { status = next; reason = why; for (const listener of listeners) listener({status, reason}); };

  async function call(method, path, {body, query} = {}) {
    const session = await local.get('session');
    let response;
    try { response = await transport({method, path, query, body, headers: session ? {authorization: 'Bearer ' + session.token,...(session.authEpoch?{'x-silo-auth-epoch':session.authEpoch}:{})} : {}}); }
    catch (error) {
      // Classification only: every branch throws the same Offline error, so queuing and retraction are unchanged.
      // A transport cancelled by a local lock, close or account change is not an outage; lock already set the status.
      if (error?.syncCancelled) throw Object.assign(new Offline(), {syncCancelled: true});
      // The authenticating transport saw HTTP 401 for this device's session: classified like a direct 401 below.
      if (error?.syncSessionRejected && session) { setStatus('local-only', 'session-revoked'); throw Object.assign(new Offline(), {syncSessionRejected: true}); }
      setStatus('offline', 'network'); throw new Offline();
    }
    if (response.status === 401 && session) { setStatus('local-only', 'session-revoked'); throw fail('This device can no longer sync. Anything already on it was not erased.', 'revoked'); }
    if (response.status === 403 && response.body?.error === 'device-not-approved') { setStatus('local-only', 'approval-required'); throw fail('Approve this device from a device you already use, or start recovery if you lost every device.', 'approval-required', {trust: response.body.trust}); }
    if(response.status===429&&response.body?.error==='sync-storage-held')throw fail('Encrypted sync storage is held. Existing local wallets and backups were not erased; keep your separate recovery file.','sync-storage-held');
    if(response.status===429&&response.body?.error==='sync-active-limit')throw fail('Sync is busy or an earlier request is still unresolved. Local wallets and backups were not erased.','sync-active-limit');
    if(response.status===429&&response.body?.error==='sync-request-budget')throw fail('Too many sync requests. Wait up to one minute before trying again; local wallets and backups were not erased.','sync-request-budget');
    if(response.status===429&&['enrollment-capacity','account-device-capacity'].includes(response.body?.error))throw fail('Device approval capacity has been reached. Keep your existing approved device and recovery file; account service capacity needs review.',response.body.error);
    return response;
  }
  const ok = (response, code) => { if (response.status !== 200) throw fail(response.body?.error ?? code, response.body?.error ?? code); return response.body; };
  const session = () => local.get('session');
  const fetchObject = async (id) => ok(await call('GET', '/vault/object', {query: {id}}), 'object');
  const conflictOn = (code, message) => { setStatus('conflict', code); return fail(message, code); };

  async function openSmall(manifest) {
    const out = {};
    for (const cls of SMALL) {
      const ref = manifest.body.objects[cls];
      out[cls] = ref ? await openObject(keys, ref, await fetchObject(ref.id)) : cls === 'devices' ? EMPTY_DEVICES : null;
    }
    out.slotsHash = manifest.body.slotsHash;
    return out;
  }
  const knownJournal = async () => {
    const shadow = await local.get('journal-shadow');
    return shadow?.vaultId === keys.vaultId ? mergeJournal(state.journal, await openObject(keys, shadow.ref, shadow.upload)) : state.journal;
  };
  /** Encrypted local copy of every operation this device knows, so an operation never vanishes from it. */
  async function saveShadow(journal = state.journal) {
    const sealed = await sealObject(keys, 'journal', journal);
    await local.set('journal-shadow', {vaultId: keys.vaultId, ref: sealed.ref, upload: sealed.upload});
  }
  const saveHighwater = () => local.set('highwater', {vaultId: keys.vaultId, revision: head.body.revision, hash: head.hash, keyCheck: keys.keyCheck});

  /** Pulls, verifies chain and freshness from the local high-water mark, merges local knowledge, sets state. */
  async function pull() {
    if (!keys) throw fail('Unlock the vault first.', 'locked');
    setStatus('syncing');
    const hw = await local.get('highwater');
    const vault = ok(await call('GET', '/vault'), 'vault');
    if (vault.vaultId !== keys.vaultId) throw conflictOn('vault-replaced', 'The server returned a different vault.');
    if ((vault.networkProfile ?? 'mainnet') !== PROFILE.label) throw conflictOn('network-profile', 'This vault belongs to a different network profile. Nothing was changed.');
    slots = vault.slots;
    if (!vault.head) { setStatus('recovery-required', 'no-head'); throw fail('The vault has no saved state.', 'no-head'); }
    const anchor = await local.get('anchor'), me = await session();
    let mine = hw?.vaultId === keys.vaultId ? hw : null;
    if (anchor?.vaultId === keys.vaultId && anchor.via === 'approval') {
      const checkpoint = anchor.approvalCheckpoint;
      if (anchor.accountId !== me?.accountId || anchor.deviceId !== me?.deviceId ||
          !/^[a-f0-9]{64}$/.test(anchor.publicKeyHash ?? '') || typeof anchor.approvedBy !== 'string' || !anchor.approvedBy ||
          !Number.isSafeInteger(checkpoint?.revision) || checkpoint.revision < 0 || !/^[a-f0-9]{64}$/.test(checkpoint?.hash ?? ''))
        throw conflictOn('approval-anchor-incomplete', 'The original device approval identity is incomplete. Keep existing backups; new actions remain held.');
      if (!mine) mine = {vaultId: keys.vaultId, ...checkpoint, keyCheck: keys.keyCheck};
      if (mine.revision < checkpoint.revision || mine.revision === checkpoint.revision && mine.hash !== checkpoint.hash)
        throw conflictOn('approval-checkpoint', 'Local freshness differs from the original approval checkpoint. New actions remain held.');
    }
    if (mine && vault.head.revision < mine.revision) throw conflictOn('rollback', 'The server returned an older vault state than this device has seen. New actions are held.');
    const {manifests} = ok(await call('GET', '/vault/manifests', {query: {from: mine ? mine.revision : vault.head.revision}}), 'manifests');
    let previous = null, previousState = null;
    for (const manifest of manifests) {
      if (previous) await verifyManifest(keys, manifest, {parent: previous});
      else {
        await verifyManifest(keys, manifest, manifest.body.revision === 0 ? {parent: null} : {});
        if (mine && (manifest.body.revision !== mine.revision || manifest.hash !== mine.hash)) throw conflictOn('fork', 'The server history does not extend what this device saw. New actions are held.');
      }
      const current = await openSmall(manifest);
      if (previousState) {
        try {
          assertJournalGrowth(previousState, current, manifest.body.writer);
          if (manifest.body.kind === 'evidence') assertEvidenceOnly(previousState, current, manifest.body.writer);
        } catch (error) { throw conflictOn(error.message === 'sync-journal-dropped-operation' ? 'journal-dropped' : error.message, error.message === 'sync-journal-dropped-operation' ? 'A synced operation record disappeared. New actions are held.' : `A synced change broke the vault rules (${error.message}). New actions are held.`); }
      }
      previous = manifest; previousState = current;
    }
    if (!previous || previous.hash !== vault.head.hash) throw conflictOn('head-mismatch', 'Server head and history differ.');
    if (!profileMatches(previousState.profile, PROFILE)) throw conflictOn('network-profile', 'This vault belongs to a different network profile. Nothing was changed.');
    if (previous.body.slotsHash !== await slotsHash(slots)) throw conflictOn('slots-changed', 'Unlock slots on the server differ from the authenticated vault state.');
    const shadow = await local.get('journal-shadow');
    let known = previousState.journal;
    if (shadow?.vaultId === keys.vaultId) known = mergeJournal(known, await openObject(keys, shadow.ref, shadow.upload));
    unpublished = canonical(known) === canonical(previousState.journal) ? null : known;
    const prior = state?.scanCacheData;
    state = {...previousState, scanCacheRef: previous.body.objects['scan-cache'], scanCacheData: prior && prior.height === previous.body.objects['scan-cache']?.scannedHeight ? prior : undefined};
    head = previous;
    await saveHighwater();
    await saveShadow(known);
    if (anchor?.vaultId === keys.vaultId && anchor.via === 'approval') {
      const row = state.devices.devices[me.deviceId];
      if (row?.via !== 'approval' || row.revokedAt !== null || row.enrolledBy !== anchor.approvedBy || row.publicKeyHash !== anchor.publicKeyHash)
        throw conflictOn('not-in-registry', 'The authenticated device registry differs from the original approval. New actions remain held.');
    }
    const conflicted = Object.values(known.entries).some((entry) => entry.conflict) || state['xmr-state'].conflict;
    if (conflicted) setStatus('conflict', 'operation-conflict');
    else if (await local.get('outbox')) setStatus('syncing', 'outbox');
    else setStatus('synced');
    return view();
  }

  const upload = async (item) => ok(await call('PUT', '/vault/object', {body: item}), 'upload');

  /** Builds and sends one commit on the current head. `change(state)` returns {next, kind, slots?, scanCache?}. */
  async function attempt(change) {
    const {next, kind, slots: newSlots, authorityPublicKey: newAuthority, scanCache} = await change(state);
    const body = {v: 1, vaultId: keys.vaultId, revision: head.body.revision + 1, parent: head.hash, kind, writer: (await session()).deviceId,
      leaseEpoch: kind === 'evidence' ? null : lease?.epoch ?? null, createdAt: now(), slotsHash: await slotsHash(newSlots ?? slots), objects: {...head.body.objects}};
    const uploads = [];
    for (const cls of SMALL) {
      if (body.objects[cls] && canonical(next[cls]) === canonical(state[cls])) continue;
      const sealed = await sealObject(keys, cls, next[cls]); uploads.push(sealed.upload); body.objects[cls] = sealed.ref;
    }
    if (scanCache) { uploads.push(...scanCache.uploads); body.objects['scan-cache'] = scanCache.ref; }
    const manifest = await signManifest(keys, body);
    // A slot change names the slots it replaces; the server applies it only while they are still exactly those.
    const request = {manifest, expectedRevision: head.body.revision, idempotencyKey: randomId(16), ...(newSlots ? {slots: newSlots, expectedSlotsHash: await slotsHash(slots), ...(newAuthority ? {authorityPublicKey: newAuthority} : {})} : {})};
    // The outbox is durable before anything is sent: a crash or lost response replays this exact commit.
    await local.set('outbox', {request, uploads, slots: newSlots ?? null});
    inflight = {hash: manifest.hash, next: {...next, slotsHash: body.slotsHash}, cacheData: next.scanCacheData};
    return flushOutbox();
  }
  /** Explicit create/unlock recovery only; never creates/replaces a remote vault. */
  async function resumeGenesis(){
    const intent=await local.get('genesis-intent');if(!intent)return;
    const me=await session(),opened=keys;
    const fence=async()=>{const latest=await session();if(!opened||keys!==opened||local.closed||latest?.accountId!==intent.accountId||latest?.deviceId!==intent.deviceId)throw fail('Vault initialization cancelled.','cancelled');};
    if(me?.accountId!==intent.accountId||me?.deviceId!==intent.deviceId||keys?.vaultId!==intent.vaultId)throw fail('Initialization belongs to another account/device/vault.','initialization');
    await verifyManifest(keys,intent.box.request.manifest);await fence();
    const vault=ok(await call('GET','/vault'),'vault');await fence();
    if(vault.vaultId!==intent.vaultId||await slotsHash(vault.slots)!==intent.box.request.manifest.body.slotsHash)throw fail('Initialization vault or unlock slots differ.','initialization');
    if(vault.head){
      await pull();await fence();if(head.body.revision!==0||canonical(head.body.objects)!==canonical(intent.box.request.manifest.body.objects))throw fail('Existing genesis differs; recovery review required.','initialization');
      await local.delete('genesis-intent');return;
    }
    const prior=await local.get('outbox');await fence();
    if(prior&&(prior.request?.manifest?.body?.vaultId!==intent.vaultId||prior.request.manifest.body.kind!=='genesis'||canonical(prior.request.manifest.body.objects)!==canonical(intent.box.request.manifest.body.objects)))throw fail('Existing outbox differs; nothing was replaced.','initialization');
    await local.set('anchor',{vaultId:intent.vaultId,via:'genesis'});await fence();await acquireLease();await fence();
    const body={...intent.box.request.manifest.body,leaseEpoch:lease.epoch};const box={...intent.box,request:{...intent.box.request,manifest:await signManifest(keys,body)},slots:null};await fence();
    await local.set('outbox',box);await fence();await flushOutbox();await fence();await releaseLease();await fence();await pull();await fence();
    if(canonical(head.body.objects)!==canonical(body.objects))throw fail('Genesis readback differs.','initialization');await local.delete('genesis-intent');
  }
  async function flushOutbox() {
    const box = await local.get('outbox');
    if (!box) return null;
    setStatus('syncing', 'outbox');
    for (const item of box.uploads) await upload(item);
    const response = await call('POST', '/vault/commit', {body: box.request});
    if (response.status === 409) { await local.delete('outbox'); return {stale: true}; }
    if (response.status === 423) { await local.delete('outbox'); throw fail('Another device is making a change. Try again when it finishes.', 'lease'); }
    const result = ok(response, 'commit');
    if (result.head.hash !== box.request.manifest.hash) throw fail('Commit acknowledgement differs.', 'commit');
    await local.delete('outbox');
    if (box.slots) slots = box.slots;
    if (inflight?.hash === box.request.manifest.hash && keys) {
      head = box.request.manifest;
      state = {...state, ...inflight.next, scanCacheRef: head.body.objects['scan-cache'], scanCacheData: inflight.cacheData ?? state?.scanCacheData};
      inflight = null;
      await saveHighwater();
      await saveShadow(await knownJournal());
      setStatus('synced');
    } else if (keys) await pull(); // replayed after a restart: rebuild state from the authenticated head
    return {head: result.head, replayed: Boolean(result.replayed)};
  }
  /** Conditional commit with pull-merge-retry. The change function re-validates on the newest state each time. */
  async function commit(change, attempts = 5) {
    if (await local.get('outbox')) {
      const replay = await flushOutbox();
      if (replay && !replay.stale) await pull();
    }
    for (let i = 0; i < attempts; i++) {
      const result = await attempt(change);
      if (!result.stale) return result;
      await pull();
    }
    throw fail('The vault kept changing; nothing was overwritten. Try again.', 'contention');
  }
  async function acquireLease() {
    const response = await call('POST', '/vault/lease');
    if (response.status === 423) throw fail('Another device is making a change. Try again when it finishes.', 'lease');
    lease = ok(response, 'lease').lease;
    return lease;
  }
  async function releaseLease() {
    if (!lease) return;
    const epoch = lease.epoch; lease = null;
    ok(await call('POST', '/vault/lease/release', {body: {epoch}}),'lease-release');
  }
  async function underLease(work) {
    await acquireLease();
    try { return await work(); } finally { await releaseLease().catch(() => {}); }
  }

  async function trustedAnchor() {
    const anchor = await local.get('anchor');
    if (anchor?.vaultId !== keys.vaultId) return null;
    return anchor.via === 'genesis' || anchor.via === 'approval' || (anchor.via === 'recovery' && anchor.reconciled) ? anchor : null;
  }
  /** Replacing the recovery code: only on an unlocked device that is synced and conflict-free right now, and that created the
   * vault or was approved by a trusted device. A device that got in by recovery is refused (the server refuses it too). */
  async function recoveryReplacementAllowed() {
    if (!keys || !state || !head) throw fail('Unlock the vault first.', 'locked');
    await pull();
    const anchor = await trustedAnchor();
    if (status !== 'synced' || !anchor || !['genesis', 'approval'].includes(anchor.via) || await local.get('outbox'))
      throw fail('Only the device that created this vault or an approved device, fully synced, can replace the recovery code. Nothing was changed.', 'recovery-code-held');
  }
  /** Settles this device's recovery-code note against the slots of the latest authenticated pull. */
  async function settleRecoveryNote() {
    const note = await local.get(RECOVERY_NOTE);
    if (!keys || note?.vaultId !== keys.vaultId) return null;
    if (note.state !== 'replacing' || activatingReplacement) return note.state;
    // The activation's answer was lost: its slot on the server means it was applied (the code had been confirmed first).
    if (Array.isArray(slots) && slots.some((slot) => slot.kind === 'recovery' && slot.slotId === note.slotId)) { await local.delete(RECOVERY_NOTE); return null; }
    if (note.prior === 'unconfirmed') { await local.set(RECOVERY_NOTE, {schema: RECOVERY_NOTE_SCHEMA, vaultId: note.vaultId, state: 'unconfirmed'}); return 'unconfirmed'; }
    await local.delete(RECOVERY_NOTE); return null;
  }

  async function blocking(journal) {
    const verified = (await local.get('verified-outcomes')) ?? {};
    const result = await blockingOperations(journal, {verifiers, verified});
    await local.set('verified-outcomes', verified);
    if (result.some((item) => item.reason === 'outcome-contradiction')) setStatus('conflict', 'outcome-contradiction');
    return result;
  }

  async function openWithRaw(raw, vaultId) {
    const openingEpoch=keyEpoch;
    try {
      const derived = await deriveVaultKeys(raw, vaultId);
      const hw = await local.get('highwater');
      if (hw && hw.vaultId === vaultId && hw.keyCheck !== derived.keyCheck) throw conflictOn('vault-key-changed', 'This vault key differs from the one this device used before.');
      if(keyEpoch!==openingEpoch||local.closed)throw fail('Vault unlock cancelled.','cancelled');
      keys = derived;
    } finally { raw.fill(0); }
  }
  /** Recovery ownership proof (authority.mjs): a recovered device that unlocks with the current recovery code signs its
   * device-bound statement, so it may write. Unlocking a recovered device with anything else leaves it read-only. */
  async function prepareAuthority(secret, vault, me) {
    if (vault.trust !== 'recovered' || vault.recoveryProven === true || !vault.authorityPublicKey || secret?.recoveryCode === undefined) return {};
    return {prove: await signRecoveryProof(secret.recoveryCode, {accountId: me.accountId, deviceId: me.deviceId, vaultId: vault.vaultId})};
  }
  async function sendAuthority(work) {
    if (work.prove) ok(await call('POST', '/recovery/prove', {body: work.prove}), 'recovery-proof');
  }
  /** Replacing the recovery code, step 1 (api.prepareRecoveryCodeReplacement): the lock state is re-checked after every await. */
  async function prepareReplacement(passphrase, epoch) {
    const vaultId = keys?.vaultId;
    pendingReplacement = null;
    // Re-checked after every await (security review round 4): a lock, sign-out or close stops the preparation at the next
    // step, and the vault key unwrapped here is zeroed on the way out.
    const still = () => { if (keyEpoch !== epoch || keys?.vaultId !== vaultId || local.closed) throw fail('Vault locked. Nothing was changed.', 'cancelled'); };
    await recoveryReplacementAllowed(); still();
    const me = await session(); still();
    const binding = {accountId: me.accountId, vaultId}, base = await slotsHash(slots), keyCheck = keys.keyCheck; still();
    const raw = await unwrapWith({passphrase}, slots, binding);
    const recoveryCode = createRecoveryCode();
    let slot;
    try { still(); slot = await wrapVaultKey(raw, 'recovery', recoveryCode, binding); still(); } finally { raw.fill(0); }
    const opened = await unwrapVaultKey(slot, recoveryCode, binding);
    try { still(); if ((await deriveVaultKeys(opened, vaultId)).keyCheck !== keyCheck) throw fail('The new recovery code could not be checked. Nothing was changed.', 'recovery-code-check'); still(); }
    finally { opened.fill(0); }
    // Visible to the owner before activation: a recovery waiting on another device is not stopped by a new code alone.
    const waitingRecoveries = (await api.devices()).filter((device) => device.trust === 'recovery-wait' && device.revokedAt === null).length; still();
    // The anchor derived from the new code replaces the old one in the same write, and ends every earlier proof.
    const authorityPublicKey = await recoveryAuthorityPublicKey(recoveryCode, vaultId);
    still();
    const ticket = Object.freeze({vaultId});
    pendingReplacement = {ticket, slot, base, epoch, vaultId, authorityPublicKey};
    return {recoveryCode, ticket, waitingRecoveries};
  }
  async function unwrapWith(secret, vaultSlots, binding) {
    const kind = secret.passphrase !== undefined ? 'passphrase' : secret.recoveryCode !== undefined ? 'recovery' : 'prf';
    const candidates = vaultSlots.filter((slot) => slot.kind === kind && (kind !== 'prf' || slot.credentialIdHash === secret.credentialIdHash));
    if (!candidates.length) throw fail('No matching unlock method for this vault.', 'no-slot');
    for (const slot of candidates) {
      try { return await unwrapVaultKey(slot, secret.passphrase ?? secret.recoveryCode ?? secret.prfOutput, binding); } catch (error) { if (error.syncUnlock !== 'auth') throw error; }
    }
    throw fail('The unlock secret is wrong.', 'wrong-secret');
  }

  function view() {
    if (!state) return null;
    return {
      status, reason, revision: head?.body.revision ?? null, safetyCode: head ? safetyCode(head.hash) : null,
      network: {xmr: state.profile.xmrNetwork, solana: state.profile.solanaNetwork, zecAvailable: state.profile.zecAvailable},
      expectedSolanaOwner: state.profile.expectedSolanaOwner,
      // Public identifiers recorded at creation (vault-identity.mjs); shown so a recovered device can confirm what it must read.
      identity: {xmrWallet: state.profile.xmrWallet ?? null, xmrBirthday: state.keys?.zone === 'native-public' ? state.profile.xmrBirthday ?? null : state['xmr-state']?.birthday ?? null, solanaStartMarker: state.profile.solanaStartMarker ?? null, createdAt: state.profile.createdAt ?? null},
      operations: Object.values(state.journal.entries).map(({opId, kind, network, state: opState, conflict, createdBy}) => ({opId, kind, network, state: opState, conflict: Boolean(conflict), createdBy})),
      claimedOpen: Object.values(state.journal.entries).filter((entry) => !isTerminalState(entry.state) || entry.conflict).map((entry) => entry.opId),
      devices: Object.entries(state.devices.devices).map(([deviceId, row]) => ({deviceId, ...row})),
      xmr: {birthday: state['xmr-state'].birthday, subaddresses: state['xmr-state'].subaddresses, scannedSubaddresses: state['xmr-state'].scannedSubaddresses},
      scanCache: state.scanCacheRef ? {scannedHeight: state.scanCacheRef.scannedHeight, chunks: state.scanCacheRef.chunks.length} : null,
    };
  }

  /** Evidence that must be on the server before the caller acts (a prompt, a commit, a relay). Never queued: offline, the
   * unsent commit is retracted and this throws. If the server applied it and only the answer was lost, the next pull shows
   * it: held, never lost. */
  async function publishEvidence(opId, transform) {
    if (!keys) throw fail('Unlock the vault first.', 'locked');
    const apply = async (current) => {
      const before = current.journal.entries[opId];
      if (!before) throw fail('Unknown operation.', 'unknown-operation');
      return {kind: 'evidence', next: {...current, journal: mergeJournal(current.journal, {entries: {[opId]: assertOperation({...before, ...(await transform(before)), updatedAt: now()})}})}};
    };
    try { return await commit(apply); }
    catch (error) {
      if (error.syncOffline) {
        const box = await local.get('outbox');
        if (box && inflight && box.request.manifest.hash === inflight.hash) { await local.delete('outbox'); inflight = null; }
      }
      throw error;
    }
  }
  /** Records progress for an existing operation. Local encrypted copy first, so evidence survives a lost network. */
  async function evidence(opId, transform) {
    if (!keys) throw fail('Unlock the vault first.', 'locked');
    const me = (await session()).deviceId;
    const apply = async (current) => {
      const before = current.journal.entries[opId];
      if (!before) throw fail('Unknown operation.', 'unknown-operation');
      const after = assertOperation({...before, ...(await transform(before, me)), updatedAt: now()});
      return {kind: 'evidence', next: {...current, journal: mergeJournal(current.journal, {entries: {[opId]: after}})}};
    };
    const known = await knownJournal();
    await saveShadow((await apply({...state, journal: known})).next.journal);
    try { return await commit(apply); }
    catch (error) { if (error.syncOffline) return {queued: true}; throw error; }
  }

  function sessionRecord(result){const row={token:result.token,accountId:result.accountId,deviceId:result.deviceId};if(result.authEpoch!==undefined){if(!/^[a-f0-9]{32}$/.test(result.authEpoch))throw fail('Invalid authenticated session marker.','session');row.authEpoch=result.authEpoch;}return row;}
  async function finishSignIn(result) {
    api.lock();
    await local.set('session', sessionRecord(result));
    if (result.deviceSecret) await local.set('device-secret', {accountId: result.accountId, secret: result.deviceSecret});
    return {accountId: result.accountId, deviceId: result.deviceId, resumed: Boolean(result.resumed)};
  }

  const api = {
    onStatus(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get status() { return {status, reason}; },
    get lease() { return lease; },
    view,

    // ---- Account (who) — separate from vault decryption -------------------------------------------------------
    async signIn(email, readCode, {encryptedLabel = null} = {}) {
      api.lock();
      const started = ok(await call('POST', '/auth/start', {body: {email}}), 'auth');
      const code = await readCode(started);
      const verified = ok(await call('POST', '/auth/verify', {body: {email, code, encryptedLabel}}), 'auth');
      api.lock();
      await local.set('session', sessionRecord(verified));
      return {accountId: verified.accountId, deviceId: verified.deviceId};
    },
    /** Passkey sign-up / sign-in. `webauthn` is @simplewebauthn/browser's {startRegistration, startAuthentication}
     * (injected so the client stays testable). The account proves who you are; the vault still needs approval or
     * recovery and an unlock secret. */
    async signUpWithPasskey(webauthn) {
      const {challengeId, options} = ok(await call('POST', '/auth/passkey/register/options', {body: {}}), 'passkey');
      const response = withoutPrfOutput(await webauthn.startRegistration({optionsJSON: options}));
      return finishSignIn(ok(await call('POST', '/auth/passkey/register/verify', {body: {challengeId, response, deviceSecret: (await local.get('device-secret'))?.secret}}), 'passkey'));
    },
    async signInWithPasskey(webauthn) {
      const {challengeId, options} = ok(await call('POST', '/auth/passkey/login/options', {body: {}}), 'passkey');
      const response = withoutPrfOutput(await webauthn.startAuthentication({optionsJSON: options}));
      return finishSignIn(ok(await call('POST', '/auth/passkey/login/verify', {body: {challengeId, response, deviceSecret: (await local.get('device-secret'))?.secret}}), 'passkey'));
    },
    async addPasskey(webauthn) {
      const {challengeId, options} = ok(await call('POST', '/account/passkey/options', {body: {}}), 'passkey');
      const response = withoutPrfOutput(await webauthn.startRegistration({optionsJSON: options}));
      return ok(await call('POST', '/account/passkey/verify', {body: {challengeId, response}}), 'passkey');
    },
    /** Email code sign-in for an account that linked an email. The code arrives by email only. */
    async startEmailSignIn(email) { return ok(await call('POST', '/auth/email/start', {body: {email}}), 'email'); },
    async finishEmailSignIn(email, code) { return finishSignIn(ok(await call('POST', '/auth/email/verify', {body: {email, code, deviceSecret: (await local.get('device-secret'))?.secret}}), 'code')); },
    async linkEmail(email, readCode) {
      ok(await call('POST', '/account/email/start', {body: {email}}), 'email');
      return ok(await call('POST', '/account/email/verify', {body: {email, code: await readCode()}}), 'code');
    },
    async me() { return ok(await call('GET', '/me'), 'me'); },
    async signOut() { api.lock();try { ok(await call('POST', '/auth/logout'),'logout'); } finally { try{await local.delete('session');}finally{api.lock();} } },

    // ---- Vault creation and unlock ----------------------------------------------------------------------------
    /** Create the account's vault from an existing wallet backup payload. Returns the one-time recovery code. */
    async createVault({passphrase, backup, expectedSolanaOwner = null, xmrWallet = null, xmrBirthday = null, solanaStartMarker = null, legacyPendingOpId}) {
      const creationEpoch=keyEpoch;const epochFence=()=>{if(keyEpoch!==creationEpoch||local.closed)throw fail('Vault initialization cancelled.','cancelled');};
      const me = await session();
      if (!me) throw fail('Sign in first.', 'signed-out');
      const vaultId = randomId(16), raw = createVaultKeyBytes(), recoveryCode = createRecoveryCode(), binding = {accountId: me.accountId, vaultId};
      let newSlots, authorityPublicKey;
      try {
        newSlots = [await wrapVaultKey(raw, 'passphrase', passphrase, binding), await wrapVaultKey(raw, 'recovery', recoveryCode, binding)];
        authorityPublicKey = await recoveryAuthorityPublicKey(recoveryCode, vaultId);
        epochFence();await openWithRaw(raw.slice(), vaultId);epochFence();
      } finally { raw.fill(0); }
      const split = splitWalletBackup(backup, {profile: PROFILE, expectedSolanaOwner, xmrWallet, xmrBirthday, solanaStartMarker, legacyPendingOpId, creatorDeviceId: me.deviceId, now: now()});
      // Validate and encrypt every recovery class before mutating the account.
      // Oversized/corrupt input cannot leave a newly created empty remote vault.
      const prepared=[];for(const cls of SMALL)prepared.push(await sealObject(keys,cls,split[cls]));
      const preparedCache=split.scanCache?await sealScanCache(keys,split.scanCache,{chunkBytes}):null;
      const body={v:1,vaultId,revision:0,parent:null,kind:'genesis',writer:me.deviceId,leaseEpoch:null,createdAt:now(),slotsHash:await slotsHash(newSlots),objects:{}};
      const uploads=[];for(const sealed of prepared){uploads.push(sealed.upload);body.objects[sealed.ref.cls]=sealed.ref;}body.objects['scan-cache']=null;
      if(preparedCache){uploads.push(...preparedCache.uploads);body.objects['scan-cache']=scanCacheRef(preparedCache,split['xmr-state'].birthday??0);}
      const intent={schema:'silo-sync-genesis-intent-v1',accountId:me.accountId,deviceId:me.deviceId,vaultId,authorityPublicKey,...(PROFILE.label==='mainnet'?{}:{networkProfile:PROFILE.label}),box:{request:{manifest:await signManifest(keys,body),expectedRevision:-1,idempotencyKey:randomId(16)},uploads,slots:newSlots}};
      const openingKeys=keys;const current=async()=>{const identity=await session();epochFence();if(keys!==openingKeys||identity?.accountId!==me.accountId||identity?.deviceId!==me.deviceId||local.closed)throw fail('Vault initialization cancelled.','cancelled');};
      if(await local.get('genesis-intent')||await local.get('outbox'))throw fail('Existing recovery initialization must be resumed; nothing was replaced.','initialization-pending');
      await current();await local.set('genesis-intent',intent);await current();if(canonical(await local.get('genesis-intent'))!==canonical(intent))throw fail('Initialization persistence could not be verified.','initialization');
      // Before anything is sent: until its owner confirms writing the code down, this device offers to replace it.
      await local.set(RECOVERY_NOTE,{schema:RECOVERY_NOTE_SCHEMA,vaultId,state:'unconfirmed'});await current();
      let attempted=false;
      try{
        await current();attempted=true;ok(await call('POST','/vault/create',{body:{vaultId,slots:newSlots,authorityPublicKey,...(PROFILE.label==='mainnet'?{}:{networkProfile:PROFILE.label})}}),'create');await current();
        await resumeGenesis();await current();
        return {recoveryCode,safetyCode:safetyCode(head.hash),revision:head.body.revision,initializationComplete:true};
      }catch(error){
        await current();
        // A definite server refusal created nothing: an existing vault, or a network profile this runtime does not serve.
        if(error.syncCode==='vault-exists'||error.syncCode==='network-profile'){await local.delete('genesis-intent');if((await local.get(RECOVERY_NOTE))?.vaultId===vaultId)await local.delete(RECOVERY_NOTE);throw error;}
        if(!attempted)throw error;
        setStatus('recovery-required','initialization-incomplete');
        return {recoveryCode,safetyCode:null,revision:null,initializationComplete:false,warning:'Account creation may have succeeded. Keep original encrypted backups and this one-time code. Unlock this same account to resume; do not create again.'};
      }
    },
    /** True while this device holds a vault creation that did not finish (security review round 1). */
    async initializationPending() { return Boolean(await local.get('genesis-intent')); },
    /** Finishes a vault creation that did not complete, with the vault passphrase (or the recovery code shown at creation).
     * If the account service already has this vault, this is an ordinary unlock, which resumes it. If the create request
     * never reached the service, the same vault (same id, unlock slots and anchor) is created now; the recovery code shown
     * earlier is the one that opens it. A different vault on the account is never replaced. */
    async resumeVaultCreation(secret) {
      const intent = await local.get('genesis-intent'), me = await session();
      if (!intent) throw fail('No unfinished account vault creation is stored on this device.', 'no-initialization');
      if (me?.accountId !== intent.accountId || me?.deviceId !== intent.deviceId) throw fail('The unfinished creation belongs to another account or device. Nothing was changed.', 'initialization');
      if (ok(await call('GET', '/me'), 'me').hasVault) {
        // A vault this device cannot open (it is not its creator) is another device's vault.
        const existing = await call('GET', '/vault').catch((error) => { if (error.syncOffline || error.syncCancelled) throw error; return null; });
        if (existing?.status !== 200 || existing.body.vaultId !== intent.vaultId) throw fail('This account has a different vault. Nothing was replaced; the unfinished creation is kept for review.', 'initialization');
        return api.unlock(secret);
      }
      const raw = await unwrapWith(secret, intent.box.slots, {accountId: intent.accountId, vaultId: intent.vaultId});
      // The anchor was derived from the recovery code at creation and kept with the intent; the code itself never was.
      if (secret.recoveryCode !== undefined && intent.authorityPublicKey && await recoveryAuthorityPublicKey(secret.recoveryCode, intent.vaultId).catch(() => null) !== intent.authorityPublicKey) { raw.fill(0); throw fail('Initialization anchor differs.', 'initialization'); }
      await openWithRaw(raw, intent.vaultId);
      ok(await call('POST', '/vault/create', {body: {vaultId: intent.vaultId, slots: intent.box.slots, authorityPublicKey: intent.authorityPublicKey ?? null, ...(PROFILE.label === 'mainnet' ? {} : {networkProfile: PROFILE.label})}}), 'create');
      await resumeGenesis();
      return api.sync();
    },
    /** secret: {passphrase} | {recoveryCode} | {prfOutput, credentialIdHash}. Only for a device the server already
     * lets read the vault (creator, approved, or recovered after the delay). */
    async unlock(secret) {
      const me = await session();
      if (!me) throw fail('Sign in first.', 'signed-out');
      const vault = ok(await call('GET', '/vault'), 'vault');
      if ((vault.networkProfile ?? 'mainnet') !== PROFILE.label) throw fail('This vault belongs to a different network profile. It was not opened.', 'network-profile');
      const raw = await unwrapWith(secret, vault.slots, {accountId: me.accountId, vaultId: vault.vaultId});
      let authority;
      try { authority = await prepareAuthority(secret, vault, me); } catch (error) { raw.fill(0); throw error; }
      await openWithRaw(raw, vault.vaultId);
      // A recovered device proves it holds the current recovery code before anything it does can write.
      await sendAuthority(authority);
      const anchor = await local.get('anchor');
      if (anchor?.vaultId !== vault.vaultId) await local.set('anchor', {vaultId: vault.vaultId, via: 'recovery', reconciled: false, reason: vault.trust === 'recovered' ? 'all-devices-lost' : 'local-anchor-missing'});
      try { await resumeGenesis();return await api.sync(); }
      catch (error) { if (/^sync-object|sync-chunk/.test(error.message)) setStatus('recovery-required', error.message); throw error; }
    },
    lock() { keyEpoch++;recoveryAcknowledgement=null;pendingReplacement=null;keys = null; state = null; head = null; lease = null; inflight = null; unpublished = null; setStatus('local-only', 'locked'); },
    pull,
    /** Pull, then publish any operation evidence this device holds that the server head lacks. */
    async sync() {
      if (await local.get('outbox')) await api.flushOutbox();
      await pull();
      // Operation evidence — including a detected contradiction — is always published so every device holds.
      // A freshness conflict (rollback, fork, replaced key) publishes nothing.
      if (unpublished && (status !== 'conflict' || reason === 'operation-conflict')) {
        const known = unpublished;
        const added=Object.values(known.entries).filter(entry=>!state.journal.entries[entry.opId]);
        if (added.some(entry=>entry.legacyRecovery)) {
          // A failed legacy import may have saved a local hold before it acquired
          // the lease. New recovery entries are actions, never evidence writes.
          if (added.some(entry=>!entry.legacyRecovery) || !await trustedAnchor()) throw fail('Legacy recovery publication remains held.', 'legacy-recovery-held');
          added.forEach(assertOperation);
          await underLease(()=>commit(async current=>({kind:'action',next:{...current,journal:mergeJournal(current.journal,known)}})));
        } else await commit(async (current) => ({kind: 'evidence', next: {...current, journal: mergeJournal(current.journal, known)}}));
        unpublished = null;
      }
      return view();
    },
    async flushOutbox() { const result = await flushOutbox(); if (result?.stale) await pull(); return result; },
    async trust() { const anchor = await local.get('anchor'); return keys && anchor?.vaultId === keys.vaultId ? anchor : null; },

    // ---- Adding a device by approval ----------------------------------------------------------------------------
    /** On the new device. Returns the enrollment code to carry to an existing device. */
    async requestEnrollment() {
      const {privateKey, publicKey} = await createEnrollmentKey();
      const {requestId} = ok(await call('POST', '/enroll/request', {body: {publicKey}}), 'enroll');
      await local.set('enroll', {requestId, privateKey, publicKey});
      return {requestId, code: await enrollmentCode(requestId, publicKey)};
    },
    /** On the new device, after approval. Opens the vault with the granted key and anchors freshness at the
     * approver's checkpoint. */
    async completeEnrollment() {
      const pending = await local.get('enroll'), me = await session();
      if (!pending) throw fail('No enrollment request on this device.', 'no-enrollment');
      const grant = ok(await call('GET', '/enroll/grant', {query: {requestId: pending.requestId}}), 'grant');
      if (grant.state === 'pending') return {status: 'waiting'};
      if (grant.state !== 'approved') { await local.delete('enroll'); throw fail('This device was not approved.', 'enrollment-denied'); }
      const vault = ok(await call('GET', '/vault'), 'vault');
      // Like unlock: a vault of another network profile is refused before its grant is opened.
      if ((vault.networkProfile ?? 'mainnet') !== PROFILE.label) throw fail('This vault belongs to a different network profile. It was not opened.', 'network-profile');
      const payload = await openGrant(pending.privateKey, {requestId: pending.requestId, deviceId: me.deviceId, accountId: me.accountId, vaultId: vault.vaultId, devicePublicKey: pending.publicKey}, grant.grant);
      if (payload.vaultId !== vault.vaultId || payload.deviceId !== me.deviceId || typeof payload.approverDeviceId !== 'string' || !payload.approverDeviceId || !Number.isSafeInteger(payload.checkpoint?.revision) || payload.checkpoint.revision < 0 || !/^[a-f0-9]{64}$/.test(payload.checkpoint?.hash ?? '')) throw fail('The approval does not match this device.', 'grant-binding');
      const grantedKey = fromB64u(payload.vaultKey, 64);
      await openWithRaw(grantedKey, vault.vaultId);
      await local.set('highwater', {vaultId: vault.vaultId, revision: payload.checkpoint.revision, hash: payload.checkpoint.hash, keyCheck: keys.keyCheck});
      await local.set('anchor', {vaultId: vault.vaultId, via: 'approval', accountId: me.accountId, deviceId: me.deviceId,
        publicKeyHash: await publicKeyHash(pending.publicKey), approvedBy: payload.approverDeviceId, approvalCheckpoint: structuredClone(payload.checkpoint)});
      await local.delete('enroll');
      return {status: 'approved', view: await api.sync()};
    },
    /** On a trusted, unlocked device. `code` is what the new device shows; `secret` re-confirms the person. */
    async approveEnrollment(code, secret) {
      const approvalKeys=keys,approvalEpoch=keyEpoch,approvalLocalEpoch=local.epoch;
      const current=()=>{if(!approvalKeys||keys!==approvalKeys||keyEpoch!==approvalEpoch||local.epoch!==approvalLocalEpoch||local.closed||!state||!head||!Array.isArray(slots)||status!=='synced')throw fail('Only a trusted, fully synced and unlocked device can approve a new device.','not-trusted');};
      current();if(!await trustedAnchor())throw fail('Only a trusted, unlocked device can approve a new device.','not-trusted');current();
      const wanted = normalizeEnrollmentCode(code), me = await session();
      const {requests} = ok(await call('GET', '/enroll/requests'), 'requests');
      let request = null;
      for (const row of requests) if (sameText(await enrollmentCode(row.requestId, row.publicKey), wanted)) request = row;
      if (!request) throw fail('That code does not match any device waiting for approval. Nothing was shared.', 'code-mismatch');
      current();
      const raw = await unwrapWith(secret, slots, {accountId: me.accountId, vaultId: keys.vaultId});
      try {
        current();
        const keyHash = await publicKeyHash(request.publicKey);
        await underLease(() => commit(async (current) => {
          if (current.devices.devices[request.deviceId]?.revokedAt) throw fail('That device was removed.', 'device-revoked');
          return {kind: 'action', next: {...current, devices: mergeDevices(current.devices, {devices: {[request.deviceId]: {via: 'approval', enrolledBy: me.deviceId, at: now(), publicKeyHash: keyHash, revokedAt: null}}})}};
        }));
        const grant = await sealGrant({requestId: request.requestId, deviceId: request.deviceId, accountId: me.accountId, vaultId: keys.vaultId, devicePublicKey: request.publicKey},
          {vaultKey: b64u(raw), vaultId: keys.vaultId, deviceId: request.deviceId, checkpoint: {revision: head.body.revision, hash: head.hash}, approverDeviceId: me.deviceId});
        ok(await call('POST', '/enroll/approve', {body: {requestId: request.requestId, grant}}), 'approve');
        return {approved: request.deviceId};
      } finally { raw.fill(0); }
    },
    async denyEnrollment(code) {
      const wanted = normalizeEnrollmentCode(code);
      const {requests} = ok(await call('GET', '/enroll/requests'), 'requests');
      for (const row of requests) if (sameText(await enrollmentCode(row.requestId, row.publicKey), wanted)) return ok(await call('POST', '/enroll/deny', {body: {requestId: row.requestId}}), 'deny');
      throw fail('That code does not match any device waiting for approval.', 'code-mismatch');
    },

    // ---- Recovery when every trusted device is lost -------------------------------------------------------------
    async startRecovery() { return ok(await call('POST', '/recovery/start'), 'recovery'); },
    async cancelRecovery(deviceId) { return ok(await call('POST', '/recovery/cancel', {body: {deviceId}}), 'recovery-cancel'); },
    /** Before a recovered device may start anything: every open operation must be closed by this device's own
     * outcome check, and the complete history of every (network, protocol, wallet) the vault can act on must be read
     * by this device's own readers (coverage.mjs). Missing, failed, partial, mismatched or pending history keeps
     * recovery held; acknowledging cannot replace a missing check. Only fully covered, final activity the journal does
     * not explain may be acknowledged by the person. */
    async reconcileRecovery({acknowledgeUnknownActivity = false} = {}) {
      const anchor = await local.get('anchor');
      if (!keys || anchor?.vaultId !== keys.vaultId || anchor.via !== 'recovery') throw fail('Nothing to reconcile on this device.', 'not-recovering');
      await api.sync();
      for (const item of await blocking(state.journal)) if (['signed', 'submitted', 'outcome-unknown'].includes(item.reason)) await api.settleOperation(item.entry.opId).catch(() => {});
      // Coverage and the person's acknowledgment belong to one authenticated
      // head. Copy only coverage inputs, never the seed or scan-cache payload.
      const coverageInput = current => ({profile: current.profile, journal: current.journal,
        keys: {zone: current.keys.zone, ...(current.keys.xmr ? {xmr: {}} : {})}, 'xmr-state': current['xmr-state']});
      const checkedState = structuredClone(coverageInput(state)), checkedHead = head.hash, checkedEpoch = keyEpoch;
      const checkedSnapshot = canonical(checkedState);
      const assertSnapshot = current => {
        if (keyEpoch !== checkedEpoch || head?.hash !== checkedHead || canonical(coverageInput(current)) !== checkedSnapshot)
          throw fail('The vault changed during recovery checks. Review its current history before trying again.', 'recovery-state-changed');
      };
      const held = await blocking(checkedState.journal);
      if (held.length) return {status: 'held', blocking: held.map(({entry, reason: why}) => ({opId: entry.opId, reason: why})), coverage: []};
      const coverage = await readCoverage(checkedState, verifiers);
      if (coverage.held.length) return {status: 'held', blocking: [], coverage: coverage.held};
      const explained = new Set(Object.values(checkedState.journal.entries).flatMap((entry) => [entry.signed?.signature, entry.claim?.signature]).filter(Boolean));
      // Solana transfers and Jupiter swaps read the same owner history: show each unexplained signature once.
      const seen = new Set(), unknown = coverage.items.filter((item) => !explained.has(item.signature) && !seen.has(`${item.network}:${item.signature}`) && seen.add(`${item.network}:${item.signature}`));
      const unknownIdentity = canonical(unknown);
      if (unknown.length && acknowledgeUnknownActivity !== true) {
        recoveryAcknowledgement = {head: checkedHead, snapshot: checkedSnapshot, epoch: checkedEpoch, unknown: unknownIdentity};
        return {status: 'unknown-activity', unknown};
      }
      if (unknown.length && (recoveryAcknowledgement?.head !== checkedHead || recoveryAcknowledgement.snapshot !== checkedSnapshot ||
          recoveryAcknowledgement.epoch !== checkedEpoch || recoveryAcknowledgement.unknown !== unknownIdentity))
        throw fail('Recovery history changed. Review the current unknown activity before acknowledging it.', 'recovery-acknowledgement-changed');
      const me = (await session()).deviceId;
      await underLease(() => commit(async current => {
        assertSnapshot(current);
        if ((await blocking(current.journal)).length) throw fail('Recovery operations changed. Resolve them before trying again.', 'recovery-state-changed');
        assertSnapshot(current);
        return {kind: 'action', next: {...current, devices: mergeDevices(current.devices, {devices: {[me]: {via: 'recovery', enrolledBy: null, at: now(), revokedAt: null, coverage: coverage.keys.map(({network, protocol, wallet, from}) => ({network, protocol, wallet, from}))}}})}};
      }));
      if (keyEpoch !== checkedEpoch) throw fail('Recovery was cancelled before local trust could be saved.', 'cancelled');
      recoveryAcknowledgement = null;
      await local.set('anchor', {...anchor, reconciled: true, reconciledAt: now()});
      return {status: 'reconciled', unknownAcknowledged: unknown.length, coverage: coverage.keys};
    },

    // ---- Operations -----------------------------------------------------------------------------------------------
    /** Reserve a new operation. Resolves only once the reservation is committed; then (and only then) the caller may
     * open a signing prompt. Throws while any operation on any device still blocks on this device. */
    async reserveOperation({kind, network, review, binding}) {
      if (!keys) throw fail('Unlock the vault first.', 'locked');
      await api.sync();
      if (status === 'conflict') throw fail('Resolve the vault conflict before a new action.', 'conflict');
      if (!await trustedAnchor()) throw fail('This device is not trusted for new actions yet. Approve it from another device, or finish recovery checks.', 'not-trusted');
      if (network !== (kind === 'xmr-payment' ? state.profile.xmrNetwork : state.profile.solanaNetwork)) throw fail('Network differs from the vault.', 'network');
      const reviewHash = await sha256Hex(canonical(review)), opId = randomId(16), me = (await session()).deviceId;
      const held = async (journal) => { const list = await blocking(journal); if (list.length) throw fail('An unresolved operation exists. Resolve it before starting another.', 'pending-operation', {blocking: list.map(({entry, reason: why}) => ({opId: entry.opId, reason: why}))}); };
      await held(await knownJournal());
      await underLease(() => commit(async (current) => {
        await held(current.journal);
        const entry = assertOperation({opId, kind, network, reviewHash, binding: {messageHash: binding?.messageHash, ...(binding?.owner ? {owner: binding.owner} : {}), ...(binding?.intent ? {intent: binding.intent} : {})}, createdBy: me, state: 'reserved', createdAt: now(), updatedAt: now()});
        return {kind: 'action', next: {...current, journal: {...current.journal, entries: {...current.journal.entries, [opId]: entry}}}};
      }));
      return {opId, reviewHash};
    },
    /** Must be recorded before the signer is invoked, and must be on the server: unlike other evidence it is never queued.
     * Offline, the unsent commit is retracted and this throws, so the caller cancels its reservation and opens no prompt.
     * (If the server applied it and only the answer was lost, the next pull shows the prompt as recorded: held, never lost.) */
    markPromptStarted: (opId) => publishEvidence(opId, (before) => { if (before.state !== 'reserved') throw fail('Prompt already recorded.', 'state'); return {state: 'prompt-started'}; }),
    /** An in-memory guard for the immediate native key boundary, not a persisted
     * signing grant. No await occurs when the returned guard is checked. */
    async promptGuard(opId) {
      const epoch=keyEpoch,localEpoch=local.epoch;
      if(!keys||status!=='synced')throw fail('Current synced vault required.','locked');
      const me=await session(),anchor=await trustedAnchor();
      const entry=state?.journal.entries[opId],device=state?.devices.devices[me?.deviceId];
      if(epoch!==keyEpoch||localEpoch!==local.epoch||local.closed||!keys||status!=='synced'||!anchor||
          !me||entry?.createdBy!==me.deviceId||entry.state!=='prompt-started'||entry.conflict||!device||device.revokedAt!==null)
        throw fail('Current trusted prompt reservation required.','not-trusted');
      const vaultId=keys.vaultId,headHash=head?.hash,entryIdentity=canonical(entry),registryIdentity=canonical(state.devices);
      return ()=>{
        if(epoch!==keyEpoch||localEpoch!==local.epoch||local.closed||!keys||keys.vaultId!==vaultId||status!=='synced'||head?.hash!==headHash||
            canonical(state?.journal.entries[opId]??null)!==entryIdentity||canonical(state?.devices??null)!==registryIdentity)
          throw fail('Account prompt context changed. Nothing was signed.','locked');
      };
    },
    /** Current native owner must be present in this account's encrypted key
     * set and immutable profile before any native transfer preparation. */
    transferOwnerGuard(owner){
      const epoch=keyEpoch,localEpoch=local.epoch,vaultId=keys?.vaultId;
      const guard=()=>{const native=state?.keys?walletKeySegments(state.keys).native:null,wallet=native?.wallets.find(row=>row.chain==='solana');
        if(!keys||keyEpoch!==epoch||localEpoch!==local.epoch||local.closed||keys.vaultId!==vaultId||status!=='synced'||typeof owner!=='string'||!owner||state?.profile.expectedSolanaOwner!==owner||state?.profile.solanaStartMarker?.owner!==owner||wallet?.address!==owner||wallet.network!=='mainnet')
          throw fail('Add and verify this native wallet in the account vault before transferring.','owner');};guard();return guard;
    },
    /** Exact published submission intent, not a queued local shadow. The
     * returned synchronous guard fences the final dispatch, never a signature. */
    async transferSubmissionGuard(opId,{network,messageHash,owner,signature,record}={}){
      const epoch=keyEpoch,localEpoch=local.epoch,recordIdentity=canonical(record);
      await api.sync();const ownerGuard=api.transferOwnerGuard(owner);ownerGuard();const me=await session(),anchor=await trustedAnchor(),entry=state?.journal.entries[opId],device=state?.devices.devices[me?.deviceId];
      const receipt={kind:'silo-exact-transfer-attempt-v1',network,signature,messageHash};
      if(!keys||status!=='synced'||!anchor||!me||!device||device.revokedAt!==null||epoch!==keyEpoch||localEpoch!==local.epoch||local.closed||canonical(record)!==recordIdentity||
          !entry||entry.legacyRecovery||entry.conflict||entry.kind!=='solana-transfer'||entry.state!=='submitted'||entry.network!==network||
          entry.binding?.owner!==owner||entry.binding?.messageHash!==messageHash||entry.signed?.signature!==signature||entry.signed?.messageHash!==messageHash||
          canonical(entry.receipt)!==canonical(receipt)||canonical({...entry.signed.record,submissionApproved:false})!==canonical({...record,submissionApproved:false}))
        throw fail('Published exact transfer attempt required. Submission stays held.','submission-held');
      const vaultId=keys.vaultId,headHash=head?.hash,identity=canonical(entry),registry=canonical(state.devices);
      return ()=>{ownerGuard();if(epoch!==keyEpoch||localEpoch!==local.epoch||local.closed||!keys||keys.vaultId!==vaultId||status!=='synced'||head?.hash!==headHash||
          canonical(state?.journal.entries[opId]??null)!==identity||canonical(state?.devices??null)!==registry||canonical(record)!==recordIdentity)
        throw fail('Transfer submission context changed.','submission-held');};
    },
    /** Fresh authenticated terminal readback plus this device's own proof, before
     * discarding a local recovery record. A queued shadow is never sufficient. */
    async terminalGuard(opId,{kind,network,messageHash,owner,signature,status:outcome}={}) {
      const epoch=keyEpoch,localEpoch=local.epoch;
      await api.sync();
      const me=await session(),anchor=await trustedAnchor();
      const entry=state?.journal.entries[opId],device=state?.devices.devices[me?.deviceId],reader=verifiers?.[kind],check=reader?.checkOutcome,
        policy=reader?.cachePolicyVersion,source=reader?.cacheSource;
      if(!keys||status!=='synced'||!anchor||!me||!device||device.revokedAt!==null||epoch!==keyEpoch||localEpoch!==local.epoch||local.closed||
          !entry||entry.legacyRecovery||entry.conflict||entry.kind!==kind||entry.network!==network||
          entry.binding?.messageHash!==messageHash||entry.binding?.owner!==owner||entry.signed?.signature!==signature||
          entry.signed?.messageHash!==messageHash||!['finalized','failed'].includes(outcome)||
          entry.state!==(outcome==='finalized'?'finalized':'failed-proven'))
        throw fail('Published exact terminal operation required. Recovery stays saved.','retirement-held');
      const vaultId=keys.vaultId,headHash=head?.hash,identity=canonical(entry),registry=canonical(state.devices);
      const guard=()=>{
        if(epoch!==keyEpoch||localEpoch!==local.epoch||local.closed||!keys||keys.vaultId!==vaultId||status!=='synced'||
            head?.hash!==headHash||canonical(state?.journal.entries[opId]??null)!==identity||canonical(state?.devices??null)!==registry||
            verifiers?.[kind]!==reader||reader?.checkOutcome!==check||reader?.cachePolicyVersion!==policy||reader?.cacheSource!==source)
          throw fail('Terminal verification context changed. Recovery stays saved.','retirement-held');
      };
      const proof=await checkOperationOutcome(structuredClone(entry),verifiers);guard();
      if(proof.status!==outcome||!entry.claim||['status','network','signature','messageHash'].some(field=>proof.claim?.[field]!==entry.claim[field]))
        throw fail('This device could not verify the published terminal claim. Recovery stays saved.','retirement-held');
      return guard;
    },
    /** Monero: the wallet engine has already produced the signed payment when it is committed, so the prompt and the signed
     * record are one fact. Published in one commit or not at all (reserved → signed), before the payment is saved or sent. */
    recordPromptAndSigned: (opId, {signature, messageHash, record}) => publishEvidence(opId, (before) => {
      if (!['reserved', 'prompt-started', 'signed'].includes(before.state)) throw fail('No open reservation.', 'state');
      if (messageHash !== before.binding.messageHash) throw fail('Signed payment differs from the reserved one.', 'signed-binding');
      return {state: 'signed', signed: {signature, messageHash, record}};
    }),
    /** A cancelling payment for a signed Monero payment, published before it is relayed. One per payment, for every device. */
    recordCancellation: (opId, cancellation) => publishEvidence(opId, (before) => {
      if (before.kind !== 'xmr-payment' || !before.signed || isTerminalState(before.state)) throw fail('No open signed payment to cancel.', 'state');
      if (before.cancellation && canonical(before.cancellation) !== canonical(cancellation)) throw fail('Another cancelling payment is already recorded. Relay that one.', 'cancellation-differs', {recorded: before.cancellation});
      return {cancellation: {hash: cancellation.hash, keyImage: cancellation.keyImage, metadata: cancellation.metadata}};
    }),
    /** `record` is the protocol's own saved recovery record (e.g. the Solana transfer or Jupiter journal row), so any
     * device's reader can check the outcome of exactly these signed bytes. */
    recordSigned: (opId, {signature, messageHash, record}) => evidence(opId, (before) => {
      if (!['prompt-started', 'signed'].includes(before.state)) throw fail('Record the signing prompt first.', 'state');
      if (messageHash !== before.binding.messageHash) throw fail('Signed message differs from the reserved one.', 'signed-binding');
      return {state: 'signed', signed: {signature, messageHash, ...(record !== undefined ? {record} : {})}};
    }),
    recordSubmitted: (opId, {receipt}) => evidence(opId, (before) => { if (!before.signed || isTerminalState(before.state)) throw fail('No open signed operation.', 'state'); return {state: 'submitted', receipt}; }),
    /** Close an operation from this device's own verifier result. 'unknown' keeps the hold. */
    async settleOperation(opId) {
      if (!keys) throw fail('Unlock the vault first.', 'locked');
      await api.sync().catch((error) => { if (!error.syncOffline) throw error; });
      const entry = (await knownJournal()).entries[opId];
      if (!entry) throw fail('Unknown operation.', 'unknown-operation');
      const result = await checkOperationOutcome(entry, verifiers);
      if (result.status === 'unknown') return {status: 'unknown', reason: result.reason};
      if (isTerminalState(entry.state)) {
        // Already claimed by some device: verify it here, never overwrite it.
        const [still] = (await blocking({entries: {[opId]: entry}}));
        return still ? {status: 'unknown', reason: still.reason} : {status: result.status, written: null};
      }
      const verified = (await local.get('verified-outcomes')) ?? {};
      verified[opId] = result.proofHash; await local.set('verified-outcomes', verified);
      const written = await evidence(opId, () => ({state: result.status === 'finalized' ? 'finalized' : 'failed-proven', claim: result.claim}));
      return {status: result.status, written};
    },
    /** Only the reserving device, only while no prompt was recorded anywhere this device knows. */
    async cancelBeforePrompt(opId) {
      const me = (await session()).deviceId, known = (await knownJournal()).entries[opId];
      if (!known || known.createdBy !== me || known.state !== 'reserved') throw fail('A signing prompt may have started. The hold remains.', 'cancel-refused');
      return evidence(opId, (before) => { if (before.state !== 'reserved') throw fail('A signing prompt may have started. The hold remains.', 'cancel-refused'); return {state: 'cancelled-before-prompt'}; });
    },
    /** Generic non-terminal progress (kept for compatibility). Terminal states are refused here: use settleOperation. */
    async advanceOperation(opId, patch) {
      if (isTerminalState(patch?.state)) throw fail('A finished, failed or cancelled outcome is recorded only after this device checks it. Nothing was changed.', 'terminal-refused');
      if (patch?.state === 'prompt-started') return api.markPromptStarted(opId);
      if (patch?.state === 'signed') return api.recordSigned(opId, patch.signed);
      if (patch?.state === 'submitted') return api.recordSubmitted(opId, patch);
      throw fail('Unsupported operation change.', 'state');
    },
    /** Non-secret fields of one operation as this device knows it. */
    async operation(opId) {
      const entry = (await knownJournal()).entries[opId];
      return entry ? {opId, kind: entry.kind, network: entry.network, state: entry.state, binding: entry.binding, createdBy: entry.createdBy, conflict: Boolean(entry.conflict), signature: entry.signed?.signature ?? null, cancellation: entry.cancellation ?? null, record: entry.signed?.record ?? null} : null;
    },
    /** Non-secret fields of every operation this device knows, plus whether this device reserved it. */
    async operations() {
      if (!keys) throw fail('Unlock the vault first.', 'locked');
      const me = (await session())?.deviceId;
      return Object.values((await knownJournal()).entries).map((entry) => ({opId: entry.opId, kind: entry.kind, network: entry.network, state: entry.state, binding: entry.binding, createdBy: entry.createdBy, own: entry.createdBy === me, legacy: Boolean(entry.legacyRecovery), conflict: Boolean(entry.conflict), signature: entry.signed?.signature ?? null, cancellation: entry.cancellation ?? null}));
    },
    async blockingOperations() { return (await blocking(await knownJournal())).map(({entry, reason: why}) => ({opId: entry.opId, reason: why})); },

    // ---- Wallet state --------------------------------------------------------------------------------------------
    /** Append exact legacy bytes as permanent holds; no legacy slot is altered. */
    async importLegacyJournals(snapshot) {
      if (!keys) throw fail('Unlock the vault first.', 'locked');
      snapshot = assertLegacyJournalSnapshot(snapshot);
      if (!snapshot.records.length) return {status:'empty',preserved:0,protocolVerified:false};
      await api.sync();
      if (status === 'conflict' || !await trustedAnchor()) throw fail('Trusted conflict-free sync is required to preserve legacy journals.', 'legacy-recovery-held');
      const entries = legacyJournalEntries(snapshot, {createdBy:(await session()).deviceId,now:now()});
      const append = current => {
        const merged = {...current.journal.entries};
        for (const [id,entry] of Object.entries(entries)) {
          if (merged[id] && canonical(merged[id].legacyRecovery)!==canonical(entry.legacyRecovery)) throw fail('Legacy recovery identity conflicts. Nothing was discarded.', 'legacy-recovery-conflict');
          if (!merged[id]) merged[id]=assertOperation(entry);
        }
        const journal={schema:'silo-sync-journal-v1',entries:merged};
        legacyJournalSnapshot(journal); // Refuse growth beyond the portable recovery budget, never truncate.
        return {...current,journal};
      };
      await saveShadow(append({...state,journal:await knownJournal()}).journal);
      await underLease(()=>commit(async current=>({kind:'action',next:append(current)})));
      return {status:'held',preserved:snapshot.records.length,protocolVerified:false};
    },
    async legacyJournalSnapshot() { if (!keys) throw fail('Unlock the vault first.', 'locked'); return legacyJournalSnapshot(await knownJournal()); },

    /** Append recovery for missing chains. No signing authority follows. */
    /** Identity of an added wallet is recorded once, like at creation (vault-identity.mjs): the Solana start marker when the
     * first Solana owner is added, the Monero primary address (and restore height for a vault without Monero keys). */
    async addWalletBackup(backup,{legacyPendingOpId,xmrWallet=null,xmrBirthday=null,solanaStartMarker=null}={}){
      if(!keys)throw fail('Unlock the vault first.','locked');
      await api.sync();if(status==='conflict'||!await trustedAnchor())throw fail('Trusted conflict-free device required for wallet additions.','not-trusted');
      const me=await session(),incoming=splitWalletBackup(backup,{profile:PROFILE,creatorDeviceId:me.deviceId,legacyPendingOpId,now:now()});
      let scanned=null;
      await underLease(()=>commit(async current=>{
        const before=walletKeySegments(current.keys),add=walletKeySegments(incoming.keys),nextKeys=appendWalletKeys(current.keys,incoming.keys);
        if(before.xmr&&add.xmr)throw fail('XMR recovery already exists. A replacement import is held; no old keys, cache or coverage were changed.','xmr-exists');
        const solana=walletKeySegments(nextKeys).native?.wallets.find(e=>e.chain==='solana');
        if(current.profile.expectedSolanaOwner!==null&&current.profile.expectedSolanaOwner!==solana?.address)throw fail('Account Solana owner differs. Nothing was replaced.','owner');
        const addingXmr=!before.xmr&&Boolean(add.xmr);
        const owner=solana?.address??current.profile.expectedSolanaOwner,identity=assertVaultIdentity({expectedSolanaOwner:owner,xmrWallet,xmrBirthday,solanaStartMarker,xmrNetwork:PROFILE.xmr});
        const profile={...current.profile,expectedSolanaOwner:owner,
          ...(current.profile.solanaStartMarker==null&&identity.solanaStartMarker?{solanaStartMarker:identity.solanaStartMarker}:{}),
          ...(current.profile.xmrWallet==null&&identity.xmrWallet?{xmrWallet:identity.xmrWallet,...(identity.xmrBirthday!==null?{xmrBirthday:identity.xmrBirthday}:{})}:{})};
        if(current.profile.xmrWallet&&identity.xmrWallet&&identity.xmrWallet!==current.profile.xmrWallet)throw fail('Account Monero wallet differs. Nothing was replaced.','owner');
        const next={...current,keys:nextKeys,journal:mergeJournal(current.journal,incoming.journal),profile,'xmr-state':addingXmr?incoming['xmr-state']:current['xmr-state']};
        if(addingXmr&&incoming.scanCache){const sealed=await sealScanCache(keys,incoming.scanCache,{chunkBytes});scanned={sealed,data:incoming.scanCache.data,height:incoming['xmr-state'].birthday??0};return {kind:'action',next:{...next,scanCacheData:{...scanned.data,height:scanned.height}},scanCache:{uploads:sealed.uploads,ref:scanCacheRef(sealed,scanned.height)}};}
        return {kind:'action',next};
      }));
      return {status:'added-recovery',newXmrCache:Boolean(scanned),signingEnabled:false};
    },
    async exportXmrBackup(passphrase){
      if(!keys||!walletKeySegments(state.keys).xmr)throw fail('No XMR recovery exists in this vault.','xmr-unavailable');
      if(state.scanCacheRef&&!state.scanCacheData)await api.loadScanCache();
      const joined=api.walletBackup(),payload=joined.schema==='silo-sync-combined-wallets-v1'?joined.xmr:joined;
      if(!payload)throw fail('XMR recovery is unavailable.','xmr-unavailable');
      // Conversion-recovery entries inside the payload stay encrypted under the original Monero wallet passphrase, and a
      // restore opens them with the passphrase of the file. Run that same check before sealing: a passphrase that does not
      // open them is refused and no file is produced. Exporting under a new passphrase needs a re-encryption design.
      if(payload.conversionRecovery!==undefined&&payload.conversionRecovery!==null){
        let journal=null;
        try{journal=await createSiloConversionRecovery({passphrase,snapshot:payload.conversionRecovery});}
        catch{throw fail('Use the original Monero wallet passphrase. This passphrase does not open the conversion recovery records in this backup; no file was created.','xmr-export-passphrase');}
        finally{journal?.close();}
      }
      return sealSilo('xmr',state.profile.xmrNetwork,payload,passphrase);
    },

    async updateXmrState(update) {
      return commit(async (current) => ({kind: 'evidence', next: {...current, 'xmr-state': mergeXmrState(current['xmr-state'], {...current['xmr-state'], ...update})}}));
    },
    /** Replace the scan cache only with a further-scanned copy; unchanged chunks are not uploaded again. */
    async updateScanCache(data, scannedHeight) {
      return commit(async (current) => {
        if (current.scanCacheRef && scannedHeight < current.scanCacheRef.scannedHeight) throw fail('This device has scanned less than the saved cache. Kept the saved cache.', 'cache-older');
        const known = new Set(), ids = current.scanCacheRef?.chunks.map((chunk) => chunk.id) ?? [];
        for (let i = 0; i < ids.length; i += 64) for (const id of ok(await call('POST', '/vault/chunks/known', {body: {ids: ids.slice(i, i + 64)}}), 'chunks').known) known.add(id);
        const sealed = await sealScanCache(keys, {data}, {chunkBytes, known});
        return {kind: 'evidence', next: {...current, scanCacheData: {...data, height: scannedHeight}}, scanCache: {uploads: sealed.uploads, ref: scanCacheRef(sealed, scannedHeight, current.scanCacheRef)}};
      });
    },
    async loadScanCache() {
      if (!state?.scanCacheRef) return null;
      const data = await openScanCache(keys, state.scanCacheRef, fetchObject);
      state.scanCacheData = {...data, height: state.scanCacheRef.scannedHeight};
      return data;
    },

    // ---- Unlock secrets and devices ------------------------------------------------------------------------------
    /** Rewrap the vault key under a new passphrase. Exported backup files keep opening with the old passphrase. */
    async changePassphrase(oldPassphrase, newPassphrase) {
      const me = await session(), binding = {accountId: me.accountId, vaultId: keys.vaultId};
      const raw = await unwrapVaultKey(slots.find((slot) => slot.kind === 'passphrase'), oldPassphrase, binding);
      let replacement;
      try { replacement = await wrapVaultKey(raw, 'passphrase', newPassphrase, binding); } finally { raw.fill(0); }
      return underLease(() => commit(async (current) => ({kind: 'action', next: current, slots: [...slots.filter((slot) => slot.kind !== 'passphrase'), replacement]})));
    },
    /** Optional WebAuthn PRF unlock slot; unsupported authenticators never add one. */
    async addPrfSlot(passphrase, prfOutput, credentialIdHash) {
      const me = await session(), binding = {accountId: me.accountId, vaultId: keys.vaultId};
      const raw = await unwrapVaultKey(slots.find((slot) => slot.kind === 'passphrase'), passphrase, binding);
      let slot;
      try { slot = await wrapVaultKey(raw, 'prf', prfOutput, binding, {credentialIdHash}); } finally { raw.fill(0); }
      return underLease(() => commit(async (current) => ({kind: 'action', next: current, slots: [...slots, slot]})));
    },

    // ---- Account recovery code ---------------------------------------------------------------------------------------
    /** Whether this device should offer to replace the recovery code: the code it showed at creation (or a replacement it
     * showed) was never confirmed as written down. Reads only this device's note and the slots of the latest pull. */
    async recoveryCodeCheck() {
      if (!keys) throw fail('Unlock the vault first.', 'locked');
      const pending = await settleRecoveryNote();
      // Recovery protection (authority.mjs): a vault from before ownership anchors has none until an owner or approved device
      // replaces the recovery code. Until then the recovery code alone gives read access only. Advisory: unknown when offline.
      let protection = null, proofMissing = false;
      try { const vault = ok(await call('GET', '/vault'), 'vault'); protection = vault.authorityPublicKey ? 'present' : 'missing'; proofMissing = vault.trust === 'recovered' && vault.recoveryProven !== true; } catch { /* advisory */ }
      return {attention: pending === 'unconfirmed' || pending === 'replacing', reason: pending === 'unconfirmed' ? 'not-confirmed' : pending === 'replacing' ? 'replacement-unsettled' : null, protection, proofMissing};
    },
    /** Its owner confirmed writing down the code this device showed when the vault was created. Nothing is sent. */
    async confirmRecoveryCodeSaved() {
      const note = await local.get(RECOVERY_NOTE);
      if (note?.state === 'unconfirmed') await local.delete(RECOVERY_NOTE);
      return {confirmed: true};
    },
    /** Step 1 of replacing the recovery code. The vault passphrase unwraps the vault key on this device; a new code is wrapped
     * into a new recovery slot, which must open this same vault. Nothing is sent and nothing changes until step 2, so the
     * caller shows the code and asks its owner to write it down first. The recovery ownership anchor changes with the code;
     * the vault key itself is not changed, so this replaces an unlock method and does not take away data someone already
     * copied with the vault key (authority.mjs). */
    async prepareRecoveryCodeReplacement({passphrase} = {}) {
      const epoch = keyEpoch;
      // Any failure after a lock is reported as the lock it is, never as a passphrase or check error.
      try { return await prepareReplacement(passphrase, epoch); }
      catch (error) { if (keyEpoch !== epoch || local.closed) { pendingReplacement = null; throw fail('Vault locked. Nothing was changed.', 'cancelled'); } throw error; }
    },

    /** Step 2, after the owner confirmed writing the new code down. One action commit removes the old recovery slot and adds
     * the new one, keeping every other slot as it is, under the head compare-and-swap, the writer lease and the server's slot
     * check. If any unlock slot changed since step 1 (another device replaced the code or the passphrase), nothing is written
     * and the new code never works. After success the old code no longer opens the vault. */
    async activateRecoveryCodeReplacement(ticket) {
      const pending = pendingReplacement;
      if (!pending || pending.ticket !== ticket) throw fail('No new recovery code is waiting. Nothing was changed.', 'no-replacement');
      pendingReplacement = null;
      const still = () => { if (keyEpoch !== pending.epoch || keys?.vaultId !== pending.vaultId || local.closed) throw fail('Vault locked. Nothing was changed.', 'cancelled'); };
      still();
      await recoveryReplacementAllowed(); still();
      if (await slotsHash(slots) !== pending.base) throw fail('The account unlock methods changed on another device. Nothing was replaced, and the new code shown does not work.', 'recovery-slots-changed');
      still();
      const before = await local.get(RECOVERY_NOTE), own = before?.vaultId === pending.vaultId; still();
      const prior = own && (before.state === 'unconfirmed' || before.state === 'replacing' && before.prior === 'unconfirmed') ? 'unconfirmed' : 'confirmed';
      // Durable before anything is sent: if the answer is lost, the next check settles it by the slot's presence on the server.
      // Written only while still unlocked (round 4), so a lock before this point leaves no note and sends nothing.
      await local.set(RECOVERY_NOTE, {schema: RECOVERY_NOTE_SCHEMA, vaultId: pending.vaultId, state: 'replacing', slotId: pending.slot.slotId, prior});
      still();
      activatingReplacement = true;
      try {
        await underLease(() => commit(async (current) => {
          if (await slotsHash(slots) !== pending.base) throw fail('The account unlock methods changed on another device. Nothing was replaced, and the new code shown does not work.', 'recovery-slots-changed');
          return {kind: 'action', next: current, slots: [...slots.filter((slot) => slot.kind !== 'recovery'), pending.slot], authorityPublicKey: pending.authorityPublicKey};
        }));
      } catch (error) {
        if (error.syncOffline) {
          // Never replayed later: a code activated long after its owner was told it failed would surprise them.
          const box = await local.get('outbox');
          if (box && inflight && box.request.manifest.hash === inflight.hash) { await local.delete('outbox'); inflight = null; }
        }
        activatingReplacement = false;
        if (!error.syncOffline && keys?.vaultId === pending.vaultId) await pull().then(settleRecoveryNote, () => {});
        throw error;
      } finally { activatingReplacement = false; }
      if (!slots.some((slot) => slot.kind === 'recovery' && slot.slotId === pending.slot.slotId) || slots.filter((slot) => slot.kind === 'recovery').length !== 1)
        throw fail('The replacement could not be read back. Check again after the next sync.', 'recovery-code-readback');
      await local.delete(RECOVERY_NOTE);
      return {status: 'replaced', revision: head.body.revision, safetyCode: safetyCode(head.hash)};
    },
    /** The owner did not write the new code down: it is dropped from memory and never sent. */
    discardRecoveryCodeReplacement() { pendingReplacement = null; return {discarded: true}; },
    /** Whether a prepared recovery code is waiting for activation on this device (nothing secret is returned). */
    hasPendingRecoveryCodeReplacement() { return pendingReplacement !== null; },
    async devices() { return ok(await call('GET', '/devices'), 'devices').devices; },
    /** Stops the device's sessions and sync access at once, then records the removal in the vault's device list.
     * It cannot erase, lock or disable anything already copied to that device, including the seed. */
    async revokeDevice(deviceId) {
      const result = ok(await call('POST', '/devices/revoke', {body: {deviceId}}), 'revoke');
      if (keys) await underLease(() => commit(async (current) => ({kind: 'action', next: {...current, devices: mergeDevices(current.devices, {devices: {[deviceId]: {...(current.devices.devices[deviceId] ?? {via: 'unknown', enrolledBy: null, at: null}), revokedAt: now()}}})}})));
      return result;
    },

    // ---- Backups, unchanged format -------------------------------------------------------------------------------
    async exportBackup(passphrase) {
      if (state?.keys.zone === 'combined') throw Error('Export the XMR encrypted backup and original native backups separately.');
      if (state?.keys.zone === 'native-public') throw Error('Export the original encrypted native wallet backup; the XMR export format does not apply.');
      if (state.scanCacheRef && !state.scanCacheData) await api.loadScanCache();
      return sealSilo('xmr', state.profile.xmrNetwork, api.walletBackup(), passphrase);
    },
    walletBackup() {
      if(!keys||!state)throw fail('Unlock the vault before exporting its decrypted backup.','locked');
      const scanCache = state.scanCacheData ? {keysData: state.scanCacheData.keysData, cacheData: state.scanCacheData.cacheData} : null;
      return joinWalletBackup({...state, scanCache});
    },
    _acquireLease: acquireLease,
    _commitAction: (change) => commit(change),
  };
  return api;
}

/** A WebAuthn PRF output is a vault-unlock secret: it never leaves the device, not even to the account server. */
export function withoutPrfOutput(response) {
  const copy = {...response, clientExtensionResults: {...(response?.clientExtensionResults ?? {})}};
  if (copy.clientExtensionResults.prf) copy.clientExtensionResults.prf = {enabled: copy.clientExtensionResults.prf.enabled === true};
  return copy;
}

/** Fetch transport. `prefix` is '/api/silo/account' on the Silo Worker and '/api/silo-sync' in the local demo. */
export function httpTransport(base, prefix = '/api/silo-sync') {
  return async ({method, path, query, body, headers, signal}) => {
    const url = new URL(base.replace(/\/$/, '') + prefix + path, globalThis.location?.href);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
    const response = await fetch(url, {method, signal, headers: {...headers, ...(body !== undefined ? {'content-type': 'application/json'} : {})}, body: body !== undefined ? JSON.stringify(body) : undefined, cache: 'no-store'});
    return {status: response.status, body: await response.json().catch(() => null)};
  };
}
