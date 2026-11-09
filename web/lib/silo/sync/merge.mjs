import {assertCombinedWalletBackup,assertWalletKeyGrowth,walletKeySegments} from './combined-wallets.mjs';
import {assertLegacyJournalEntry} from './legacy-journals.mjs';
import {assertNativeSyncBackup} from './native-wallets.mjs';
import {assertVaultIdentity} from './vault-identity.mjs';
import {VAULT_NETWORK_PROFILES,profileOfKeys} from './network-profile.mjs';
/** Merge rules for synced vault state. There is no last-write-wins for keys or for the operation journal.
 *
 * Operation lifecycle (one entry per operation id, never removed by a merge):
 *   reserved -> prompt-started -> signed -> submitted -> {finalized | failed-proven}
 *   reserved -> cancelled-before-prompt   (only the reserving device, only while no signing prompt can have started)
 * Every entry is bound at reservation to {kind, network, reviewHash, binding.messageHash}. Signed evidence must name
 * that same message. A terminal state is only a *claim* ({status, network, signature, messageHash, evidence}); it
 * never closes an operation by itself. Each device closes it only after its own outcome check (outcome.mjs).
 * Merging two copies keeps the furthest state. Contradictions — different signed bytes, two different terminal
 * claims, or a cancellation that races a prompt — are kept as a held conflict, never resolved by picking a side. */
import {canonical} from './codec.mjs';

export const OP_RANK = Object.freeze({'reserved': 0, 'prompt-started': 1, 'signed': 2, 'submitted': 3, 'finalized': 4, 'failed-proven': 4, 'cancelled-before-prompt': 4});
const TERMINAL = new Set(['finalized', 'failed-proven', 'cancelled-before-prompt']);
const IDENTITY = ['opId', 'kind', 'network', 'reviewHash', 'createdBy'];
const HASH = /^[a-f0-9]{64}$/;
export const isTerminalState = (state) => TERMINAL.has(state);
/** Terminal *and* agreed by its own record. Closing still requires outcome.mjs. */
export const isTerminal = (entry) => TERMINAL.has(entry.state) && !entry.conflict;

export function assertOperation(entry) {
  if (!entry || typeof entry.opId !== 'string' || !/^[a-f0-9]{32}$/.test(entry.opId) || !(entry.state in OP_RANK)
    || !['xmr-payment', 'solana-transfer', 'jupiter-swap', 'crosschain-order'].includes(entry.kind)
    || !['mainnet', 'mainnet-beta', 'stagenet', 'devnet'].includes(entry.network) || !HASH.test(entry.reviewHash ?? '') || !HASH.test(entry.binding?.messageHash ?? '')) throw Error('sync-operation-invalid');
  if (entry.signed && (typeof entry.signed.signature !== 'string' || !entry.signed.signature || entry.signed.messageHash !== entry.binding.messageHash)) throw Error('sync-signed-binding');
  if (entry.signed?.record !== undefined && (entry.signed.record === null || typeof entry.signed.record !== 'object' || JSON.stringify(entry.signed.record).length > 262144)) throw Error('sync-signed-record');
  if (entry.legacyRecovery) assertLegacyJournalEntry(entry);
  if (entry.cancellation !== undefined) assertCancellation(entry);
  return entry;
}

/** A cancelling payment recorded for a signed Monero payment (signing-gate.mjs `xmrCancel`): exact bytes any device relays
 * instead of preparing another one. It must spend one of the payment's own inputs. */
export function assertCancellation(entry) {
  const c = entry.cancellation, keyImages = entry.signed?.record?.pending?.authorized?.keyImages;
  if (entry.kind !== 'xmr-payment' || !entry.signed || !c || Object.keys(c).sort().join(',') !== 'hash,keyImage,metadata'
    || !HASH.test(c.hash) || !HASH.test(c.keyImage) || typeof c.metadata !== 'string' || !c.metadata || c.metadata.length > 262144
    || !Array.isArray(keyImages) || !keyImages.includes(c.keyImage) || c.hash === entry.signed.signature) throw Error('sync-cancellation-invalid');
  return entry;
}

/** What an outcome claim asserts. Reader-specific evidence (slot, confirmations) is not part of it. */
const claimIdentity = (claim) => claim ? {status: claim.status, network: claim.network, signature: claim.signature, messageHash: claim.messageHash} : null;

function mergeEntry(a, b) {
  if ((a.legacyRecovery || b.legacyRecovery) && canonical(a.legacyRecovery)!==canonical(b.legacyRecovery)) return {...a,conflict:{reason:'legacy-recovery-bytes',other:b}};
  for (const field of IDENTITY) if (a[field] !== b[field]) return {...a, conflict: {reason: 'identity', other: b}};
  if (canonical(a.binding) !== canonical(b.binding)) return {...a, conflict: {reason: 'binding', other: b}};
  if (a.conflict || b.conflict) return {...(a.conflict ? a : b), conflict: a.conflict ?? b.conflict};
  if (a.signed && b.signed && canonical(a.signed) !== canonical(b.signed)) return {...a, conflict: {reason: 'signed-bytes', other: b}};
  // Two different cancelling payments for one payment: both could be relayed, so neither is chosen.
  if (a.cancellation && b.cancellation && canonical(a.cancellation) !== canonical(b.cancellation)) return {...a, conflict: {reason: 'cancellation', other: b}};
  const signed = a.signed ?? b.signed, receipt = a.receipt ?? b.receipt, cancellation = a.cancellation ?? b.cancellation;
  const extra = cancellation ? {cancellation} : {};
  if (a.state === b.state) {
    if (TERMINAL.has(a.state) && canonical(claimIdentity(a.claim)) !== canonical(claimIdentity(b.claim))) return {...a, conflict: {reason: 'terminal-claim', other: b}};
    return {...a, signed, receipt, ...extra, updatedAt: Math.max(a.updatedAt, b.updatedAt)};
  }
  const [low, high] = OP_RANK[a.state] <= OP_RANK[b.state] ? [a, b] : [b, a];
  if (TERMINAL.has(low.state) && TERMINAL.has(high.state)) return {...high, conflict: {reason: 'terminal', other: low}};
  if (high.state === 'cancelled-before-prompt' && low.state !== 'reserved') return {...low, signed, receipt, ...extra, conflict: {reason: 'cancel-after-prompt', other: high}};
  return {...high, signed, receipt, ...extra};
}

export function mergeJournal(a, b) {
  const entries = {...(a?.entries ?? {})};
  for (const [id, entry] of Object.entries(b?.entries ?? {})) entries[id] = entries[id] ? mergeEntry(entries[id], entry) : entry;
  return {schema: 'silo-sync-journal-v1', entries};
}
/** Entries that are not even *claimed* closed. A claimed-closed entry may still block (see outcome.mjs). */
export function unclaimedOperations(journal) {
  return Object.values(journal?.entries ?? {}).filter((entry) => !isTerminal(entry));
}

/** Device registry: who was enrolled, how and by whom. Grow-only; a revocation is sticky. */
export function mergeDevices(a, b) {
  const devices = {...(a?.devices ?? {})};
  for (const [id, row] of Object.entries(b?.devices ?? {})) {
    const mine = devices[id];
    devices[id] = mine ? {...mine, revokedAt: mine.revokedAt ?? row.revokedAt ?? null} : row;
  }
  return {schema: 'silo-sync-devices-v1', devices};
}

/** Coverage only grows: the earliest birthday, the highest issued/scanned subaddress index and receive index. */
export function mergeXmrState(a, b) {
  if (!a) return b; if (!b) return a;
  if (a.account !== b.account || a.network !== b.network) return {...a, conflict: {reason: 'account', other: b}};
  const max = (key) => Math.max(a[key] ?? 0, b[key] ?? 0);
  const birthdays = [a.birthday, b.birthday].filter(Number.isSafeInteger);
  return {
    schema: 'silo-sync-xmr-state-v1', network: a.network, account: a.account,
    birthday: birthdays.length ? Math.min(...birthdays) : null,
    subaddresses: max('subaddresses'), scannedSubaddresses: max('scannedSubaddresses'),
    ordinaryReceiveIndex: max('ordinaryReceiveIndex'),
    subaddressCacheRequired: Boolean(a.subaddressCacheRequired || b.subaddressCacheRequired),
  };
}

export function sameKeys(a, b) { return canonical(a) === canonical(b); }

/** Checks that `next` only advances operations already present in `previous` (the rule for evidence writes made
 * without the writer lease). Keys, slots, profile and xmr-state must be unchanged except monotone xmr-state growth. */
export function assertEvidenceOnly(previous, next, writer) {
  for (const [id, entry] of Object.entries(next.journal.entries)) {
    const before = previous.journal.entries[id];
    if (!before) throw Error('sync-evidence-new-operation');
    if (OP_RANK[entry.state] < OP_RANK[before.state] && !entry.conflict) throw Error('sync-evidence-regression');
    if (entry.state === 'cancelled-before-prompt' && before.state !== 'cancelled-before-prompt' && (before.state !== 'reserved' || writer !== entry.createdBy)) throw Error('sync-evidence-cancel');
  }
  assertJournalGrowth(previous, next, writer);
  if (!sameKeys(previous.keys, next.keys) || canonical(previous.profile) !== canonical(next.profile) || canonical(previous.devices) !== canonical(next.devices)) throw Error('sync-evidence-changed-keys');
  if (next.slotsHash !== previous.slotsHash) throw Error('sync-evidence-changed-slots');
}
/** Rules for every write (action or evidence): no operation disappears; a cancellation only by its reserving
 * device and only from `reserved`. */
export function assertJournalGrowth(previous, next, writer) {
  assertWalletKeyGrowth(previous.keys,next.keys);
  for (const id of Object.keys(previous.journal.entries)) if (!next.journal.entries[id]) throw Error('sync-journal-dropped-operation');
  for (const [id, entry] of Object.entries(next.journal.entries)) {
    const before = previous.journal.entries[id];
    if (before?.legacyRecovery && canonical(before)!==canonical(entry)) throw Error('sync-legacy-recovery-immutable');
    if (entry.legacyRecovery) assertLegacyJournalEntry(entry);
    if (entry.state === 'cancelled-before-prompt' && before?.state !== 'cancelled-before-prompt' && (before?.state !== 'reserved' || writer !== entry.createdBy)) throw Error('sync-journal-cancel');
    // A recorded cancelling payment is never dropped or swapped; a contradiction is kept as a conflict instead.
    if (before?.cancellation && !entry.conflict && canonical(before.cancellation) !== canonical(entry.cancellation)) throw Error('sync-journal-cancellation');
  }
}

/** Splits an existing Silo XMR backup payload (the plaintext inside the local envelope) into sync classes. */
/** `profile` is the vault network profile (network-profile.mjs). The default mainnet profile produces exactly the former
 * bytes; the test-network profile records Solana devnet and Monero stagenet instead and never labels them mainnet. */
export function splitWalletBackup(backup, {network, profile = network === 'stagenet' ? VAULT_NETWORK_PROFILES['test-networks'] : VAULT_NETWORK_PROFILES.mainnet, expectedSolanaOwner = null, xmrWallet = null, xmrBirthday = null, solanaStartMarker = null, legacyPendingOpId, creatorDeviceId = null, now = 0} = {}) {
  network ??= profile.xmr;
  if (network !== profile.xmr) throw Error('Monero network differs from the vault network profile.');
  // Combined native + Monero backups (first-wallet line): the same vault identity is recorded through whichever part holds it.
  if (backup?.schema === 'silo-sync-combined-wallets-v1') {
    const value=assertCombinedWalletBackup(backup,profile),native=value.wallets.length?assertNativeSyncBackup({schema:'silo-sync-native-public-v1',wallets:value.wallets},{network:profile.native}):null;
    const solana=native?.wallets.find(e=>e.chain==='solana');if(expectedSolanaOwner!==null&&expectedSolanaOwner!==solana?.address)throw Error('Native Solana owner differs from sync profile.');
    const parts=value.xmr?splitWalletBackup(value.xmr,{network,profile,expectedSolanaOwner:solana?.address??null,xmrWallet,solanaStartMarker,legacyPendingOpId,creatorDeviceId,now}):splitWalletBackup(native,{network,profile,expectedSolanaOwner:solana?.address??null,xmrWallet,xmrBirthday,solanaStartMarker,creatorDeviceId,now});
    return {...parts,keys:{schema:'silo-sync-keys-v2',zone:'combined',network:profile.label,native,xmr:value.xmr?parts.keys:null},profile:{...parts.profile,expectedSolanaOwner:solana?.address??null}};
  }
  // Native Solana/EVM keyring backups (candidate 10fcd27f): carried verbatim, already encrypted under their own passphrase.
  if (backup?.schema === 'silo-sync-native-public-v1') {
    const payload = assertNativeSyncBackup(backup, {network: profile.native}), solana = payload.wallets.find(e => e.chain === 'solana');
    if (expectedSolanaOwner !== null && expectedSolanaOwner !== solana?.address) throw Error('Native Solana owner differs from sync profile.');
    // The native vault carries no Monero keys; it still records which Monero wallet (if any) this account acts with, so a
    // recovered device must read that wallet's history (from its own restored session) before it may act.
    const identity = assertVaultIdentity({expectedSolanaOwner: solana?.address ?? null, xmrWallet, xmrBirthday, solanaStartMarker, xmrNetwork: profile.xmr});
    if ((identity.xmrWallet === null) !== (identity.xmrBirthday === null)) throw Error('Monero wallet identity needs its restore height.');
    return {keys: {schema: 'silo-sync-keys-v1', zone: 'native-public', network: profile.label, payload},
      journal: {schema: 'silo-sync-journal-v1', entries: {}},
      'xmr-state': {schema: 'silo-sync-xmr-state-v1', network: profile.xmr, account: 0, birthday: null, subaddresses: 0, scannedSubaddresses: 0, ordinaryReceiveIndex: 0, subaddressCacheRequired: false},
      profile: {schema: 'silo-sync-profile-v1', solanaNetwork: profile.solana, xmrNetwork: profile.xmr, zecAvailable: false, expectedSolanaOwner: identity.expectedSolanaOwner, xmrWallet: identity.xmrWallet, xmrBirthday: identity.xmrBirthday, createdAt: now, solanaStartMarker: identity.solanaStartMarker},
      devices: {schema: 'silo-sync-devices-v1', devices: creatorDeviceId ? {[creatorDeviceId]: {via: 'genesis', enrolledBy: null, at: now, revokedAt: null}} : {}}, scanCache: null};
  }
  if (typeof backup?.seed !== 'string' || !backup.seed) throw Error('Recovery material is unavailable.');
  const {seed, engine, keysData, cacheData, pending, height, account, subaddresses, scannedSubaddresses, ordinaryReceiveIndex, subaddressCacheRequired, cacheOmitted, ...rest} = backup;
  const entries = {};
  if (pending) {
    if (!/^[a-f0-9]{32}$/.test(legacyPendingOpId ?? '')) throw Error('sync-legacy-pending-id');
    // The existing XMR payment journal is carried verbatim; its state maps to the sync lifecycle conservatively.
    // The binding is the payment's own transaction hash when it has one. Without it no outcome check can match,
    // so the migrated hold can only be released by the existing per-wallet reconciliation, never by sync.
    const txHash = /^[a-f0-9]{64}$/.test(pending.authorized?.hash ?? '') ? pending.authorized.hash : '0'.repeat(64);
    entries[legacyPendingOpId] = {opId: legacyPendingOpId, kind: 'xmr-payment', network, reviewHash: /^[a-f0-9]{64}$/.test(pending.reviewHash ?? '') ? pending.reviewHash : '0'.repeat(64), createdBy: 'migrated',
      binding: {messageHash: txHash}, signed: {signature: txHash, messageHash: txHash},
      state: pending.status === 'failed' ? 'submitted' : pending.receipt ? 'submitted' : 'signed', legacy: pending, createdAt: 0, updatedAt: 0};
  }
  return {
    keys: {schema: 'silo-sync-keys-v1', zone: 'xmr', network, seed, engine: engine ?? null, extra: rest},
    journal: {schema: 'silo-sync-journal-v1', entries},
    'xmr-state': {schema: 'silo-sync-xmr-state-v1', network, account: Number.isSafeInteger(account) ? account : 0, birthday: Number.isSafeInteger(height) ? height : null,
      subaddresses: subaddresses ?? 0, scannedSubaddresses: scannedSubaddresses ?? 0, ordinaryReceiveIndex: ordinaryReceiveIndex ?? 0, subaddressCacheRequired: subaddressCacheRequired === true},
    // xmrWallet: the wallet's public primary address, the identity history readers must cover. createdAt: the vault's
    // start, the earliest point Solana history must cover.
    profile: {schema: 'silo-sync-profile-v1', solanaNetwork: profile.solana, xmrNetwork: network, zecAvailable: false, expectedSolanaOwner, xmrWallet: xmrWallet ?? null, createdAt: now, solanaStartMarker: assertVaultIdentity({expectedSolanaOwner, xmrWallet: xmrWallet ?? null, xmrNetwork: network, solanaStartMarker}).solanaStartMarker},
    devices: {schema: 'silo-sync-devices-v1', devices: creatorDeviceId ? {[creatorDeviceId]: {via: 'genesis', enrolledBy: null, at: now, revokedAt: null}} : {}},
    scanCache: cacheOmitted || (!keysData && !cacheData) ? null : {data: {keysData: keysData ?? null, cacheData: cacheData ?? null}},
  };
}

/** Rebuilds the existing backup payload shape so export, offline recovery and the wallet engine stay unchanged. */
export function joinWalletBackup(state) {
  const {keys, journal, scanCache} = state, xmr = state['xmr-state'];
  if (keys.zone==='combined'){
    const segments=walletKeySegments(keys);
    return assertCombinedWalletBackup({schema:'silo-sync-combined-wallets-v1',wallets:segments.native?.wallets??[],xmr:segments.xmr?joinWalletBackup({...state,keys:segments.xmr}):null},profileOfKeys(keys));
  }
  if (keys.zone === 'native-public') return assertNativeSyncBackup(keys.payload, {network: profileOfKeys(keys).native});
  // A synced terminal claim never drops the wallet's own pending payment: the existing per-wallet reconciliation
  // clears it from its own scan.
  const legacy = Object.values(journal.entries).filter((entry) => entry.kind === 'xmr-payment' && entry.legacy);
  if (legacy.length > 1) throw Error('More than one unresolved XMR payment; recovery is held for review.');
  // The split stores an absent scannedSubaddresses / ordinaryReceiveIndex as 0. The wallet engine (xmr-adapter.mjs) reads
  // absence as "the recorded count" / "unpinned" and refuses a scanned index below the recorded count or an ordinary index
  // of 0, so those stored zeros are written back as absent. Recorded values the engine accepts are returned unchanged.
  return {
    ...keys.extra, seed: keys.seed, ...(keys.engine ? {engine: keys.engine} : {}),
    ...(xmr.birthday !== null ? {height: xmr.birthday} : {}), account: xmr.account,
    subaddresses: xmr.subaddresses,
    ...(xmr.scannedSubaddresses >= xmr.subaddresses ? {scannedSubaddresses: xmr.scannedSubaddresses} : {}),
    ...(xmr.ordinaryReceiveIndex >= 1 ? {ordinaryReceiveIndex: xmr.ordinaryReceiveIndex} : {}),
    ...(xmr.subaddressCacheRequired ? {subaddressCacheRequired: true} : {}),
    ...(legacy.length ? {pending: legacy[0].legacy} : {}),
    ...(scanCache ? {keysData: scanCache.keysData, cacheData: scanCache.cacheData} : {cacheOmitted: true}),
  };
}
