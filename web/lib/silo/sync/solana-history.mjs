/** Complete Solana account history for recovery coverage (coverage.mjs contract).
 *
 * The existing activity reader (solana-activity-read.mjs) is deliberately bounded (5 pages × 20) for display. Recovery
 * needs every signature of the owner since the vault started, so this reader pages getSignaturesForAddress to the end,
 * reading signatures only (no receipts), and never guesses:
 *
 *  - Anchored: the first run fixes a finalized slot; every page is requested with minContextSlot at that anchor.
 *  - Strict pages: at most `pageLimit` rows; every row finalized (else the item is not final → held); slots never increase
 *    within or across pages; the `before` cursor must not reappear; no signature twice in the whole scan; well-formed
 *    signatures. Any violation throws (→ 'history-error'), keeping the checkpoint for a later retry.
 *  - Complete only when one of these proves the start was passed:
 *      a) a row whose blockTime is before the vault start;
 *      b) the vault's recorded start marker {owner, slot, signature|null} (vault-identity.mjs): reaching its signature, or
 *         any row in a slot before its slot (that row predates the vault);
 *      c) the provider ran out of rows AND proves it holds the ledger from before the vault start
 *         (getFirstAvailableBlock → getBlockTime ≤ start, or with a marker: first available slot ≤ marker slot).
 *    Running out of rows without (c) is not proof — a pruned provider looks the same — so it stays 'history-partial'.
 *  - Resumable: each run uses at most `maxCallsPerRun` RPC calls and stores a checkpoint (anchor, cursor, last slot,
 *    signatures so far) through `checkpoints`, so an owner with any amount of activity finishes over several runs.
 *    `maxSignatures` (default 500,000) is a memory bound; beyond it the run stays partial rather than truncating.
 *
 * `read(method, params)` is the device's own reviewed RPC reader (the same shape the existing Silo readers use). */
import {SILO_SOLANA_GENESIS} from '../solana-transfer.mjs';

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

export function memoryCheckpoints() {
  const map = new Map();
  return {get: async (key) => structuredClone(map.get(key) ?? null), set: async (key, value) => { map.set(key, structuredClone(value)); }, delete: async (key) => { map.delete(key); }};
}

export function createSolanaHistoryReader({read, network = 'mainnet-beta', pageLimit = 1000, maxCallsPerRun = 60, maxSignatures = 500000, checkpoints = memoryCheckpoints(), reuseMs = 60000, now = () => Date.now()}) {
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 1000) throw Error('Solana history page limit must be 1–1000.');
  const finished = new Map(); // wallet:from:marker → {at, result}; transfers and swaps share one owner history
  return async function history({network: wanted, protocol, wallet, from, marker = null}) {
    const identity = {network, protocol, wallet};
    if (wanted !== network) return {...identity, complete: false, throughTip: false, coveredFrom: from + 1, items: []};
    // A marker recorded for another owner proves nothing about this one.
    if (marker !== null && (typeof marker !== 'object' || marker.owner !== wallet || !Number.isSafeInteger(marker.slot) || marker.slot < 1 || (marker.signature !== null && !SIGNATURE.test(marker.signature ?? '')))) marker = null;
    const key = `solana-history-v2:${network}:${wallet}:${from}:${marker ? `${marker.slot}:${marker.signature ?? ''}` : ''}`;
    const cached = finished.get(key);
    if (cached && now() - cached.at < reuseMs) return {...cached.result, protocol};
    let calls = 0;
    const call = async (method, params) => { if (++calls > maxCallsPerRun) throw Object.assign(Error('budget'), {budget: true}); return read(method, params); };
    let state = await checkpoints.get(key);
    try {
      if (!state) {
        if (await call('getGenesisHash', []) !== SILO_SOLANA_GENESIS[network]) throw Error('Solana genesis differs.');
        const anchor = await call('getSlot', [{commitment: 'finalized'}]);
        if (!Number.isSafeInteger(anchor) || anchor < 1) throw Error('Finalized anchor unavailable.');
        state = {anchor, before: null, lastSlot: Number.MAX_SAFE_INTEGER, signatures: [], pending: [], done: null};
        await checkpoints.set(key, state);
      }
      const seen = new Set(state.signatures);
      while (!state.done) {
        const page = await call('getSignaturesForAddress', [wallet, {commitment: 'finalized', minContextSlot: state.anchor, limit: pageLimit, ...(state.before ? {before: state.before} : {})}]);
        if (!Array.isArray(page) || page.length > pageLimit) throw Error('Malformed signature page.');
        for (const row of page) {
          if (!SIGNATURE.test(row?.signature ?? '') || !Number.isSafeInteger(row.slot) || row.slot < 0 || (row.blockTime !== null && row.blockTime !== undefined && !Number.isSafeInteger(row.blockTime))) throw Error('Malformed signature row.');
          if (row.signature === state.before || seen.has(row.signature)) throw Error('Signature page repeated a row; cursor did not advance.');
          if (row.slot > state.lastSlot) throw Error('Signature page order is not newest-first.');
          state.lastSlot = row.slot;
          if (marker && (row.signature === marker.signature || row.slot < marker.slot)) { state.done = {reason: 'marker', coveredFrom: from}; break; }
          const at = Number.isSafeInteger(row.blockTime) ? row.blockTime * 1000 : null;
          if (at !== null && at < from) { state.done = {reason: 'start-passed', coveredFrom: at}; break; }
          seen.add(row.signature); state.signatures.push(row.signature);
          if (row.confirmationStatus !== 'finalized') state.pending.push(row.signature);
          if (state.signatures.length > maxSignatures) throw Error('Owner history exceeds the signature bound.');
        }
        if (state.done) break;
        if (page.length < pageLimit) {
          const first = await call('getFirstAvailableBlock', []);
          if (marker && Number.isSafeInteger(first) && first >= 0 && first <= marker.slot) { state.done = {reason: 'archive-proven-end', coveredFrom: from}; break; }
          const firstTime = Number.isSafeInteger(first) ? await call('getBlockTime', [first]) : null;
          state.done = Number.isSafeInteger(firstTime) && firstTime * 1000 <= from ? {reason: 'archive-proven-end', coveredFrom: firstTime * 1000} : {reason: 'end-unproven'};
          break;
        }
        state.before = page.at(-1).signature;
        await checkpoints.set(key, state);
      }
      await checkpoints.set(key, state);
    } catch (error) {
      if (state) await checkpoints.set(key, state);
      if (error.budget) return {...identity, complete: false, throughTip: true, coveredFrom: from + 1, items: [], progress: {signatures: state?.signatures.length ?? 0, resumable: true}};
      throw error;
    }
    const pending = new Set(state.pending);
    const items = state.signatures.map((signature) => ({signature, final: !pending.has(signature)}));
    if (state.done.reason === 'end-unproven') {
      await checkpoints.delete(key); // a later run starts again and may get proof
      return {...identity, complete: false, throughTip: true, coveredFrom: from + 1, items, reason: 'end-unproven'};
    }
    const result = {...identity, complete: true, throughTip: true, coveredFrom: state.done.coveredFrom, items, anchorSlot: state.anchor, proof: state.done.reason};
    finished.set(key, {at: now(), result});
    await checkpoints.delete(key);
    return result;
  };
}
