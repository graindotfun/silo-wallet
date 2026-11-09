/** Account-sync verifiers and history readers built on the existing reviewed Silo readers.
 *
 * Outcome verifiers (`checkOutcome`) — each validates the protocol's own saved record with that protocol's own
 * journal reader, binds it to the operation's signature and reserved message hash, then asks the existing outcome
 * reader. Anything other than a positive finalized/failed answer for exactly that record is 'unknown':
 *   solana-transfer  readSiloTransferJournal + reconcileSiloTransferJournal (solana-transfer-journal.mjs)
 *   jupiter-swap     readSiloJupiterJournal + checkSiloJupiterOutcome (jupiter-journal.mjs, jupiter-execution-service.mjs);
 *                    finalized also requires minimumReceivedVerified
 *   xmr-payment      the open wallet session's outcomeOf (xmr-adapter.mjs): 10-deep confirmation, or a 10-deep cancelling
 *                    spend of one of its own key images
 * The existing readers already never treat an expired blockhash or a missing receipt as failure.
 *
 * History readers (`history`) follow the strict contract in coverage.mjs and fail closed:
 *   Solana   pages the existing bounded activity reader (readSolanaActivity: finalized anchor, 20 per page, 5 pages per
 *            cursor chain). Complete only if it reaches a row older than the required start or the provider's end of
 *            history, with no unavailable or malformed receipt. An owner with more activity since the vault started
 *            than that bound stays 'history-partial' — recovery is held, not guessed.
 *   XMR      the open wallet session's outgoingHistory: complete only when the wallet is synced and its scan started at or
 *            before the vault's birthday; an item is final at 10 confirmations and not reported failed. */
import {Buffer} from 'buffer';
import {sha256} from '@noble/hashes/sha256';
import {VersionedTransaction} from '@solana/web3.js';
import {readSiloTransferJournal, reconcileSiloTransferJournal, SILO_TRANSFER_JOURNAL_KEY} from '../solana-transfer-journal.mjs';
import {readSiloJupiterJournal, SILO_JUPITER_JOURNAL_KEY} from '../jupiter-journal.mjs';
import {checkSiloJupiterOutcome} from '../jupiter-execution-service.mjs';
import {createSolanaHistoryReader} from './solana-history.mjs';
import {XMR_RECORD, xmrIntentHash, xmrRecordMatches} from './xmr-intent.mjs';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
/** A one-record, in-memory storage, so the existing journal readers validate exactly this record and nothing else. */
function recordStorage(key, record) {
  const map = new Map([[key, JSON.stringify(record)]]);
  return {getItem: (k) => map.has(k) ? map.get(k) : null, setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); }};
}
const unknown = (request, extra = {}) => ({status: 'unknown', network: request.network, signature: request.signature, messageHash: request.messageHash, ...extra});

export function solanaTransferVerifier({connection, network = 'mainnet-beta', read = readSiloTransferJournal, reconcile = reconcileSiloTransferJournal}) {
  return {
    async checkOutcome(request) {
      if (request.network !== network) return unknown(request, {network});
      const record = request.record;
      if (!record || record.signature !== request.signature || record.network !== network || (request.owner && record.owner !== request.owner)) return unknown(request, {reason: 'record-binding'});
      const storage = recordStorage(SILO_TRANSFER_JOURNAL_KEY, record);
      const row = read(storage);
      const messageHash = hex(sha256(VersionedTransaction.deserialize(Buffer.from(row.wire, 'base64')).message.serialize()));
      if (messageHash !== request.messageHash) return unknown(request, {messageHash});
      const result = await reconcile(storage, connection, {network});
      if (['finalized', 'failed'].includes(result?.state) && result.signature === request.signature) return {status: result.state, network, signature: request.signature, messageHash, evidence: {slot: result.slot ?? null}};
      return unknown(request, {reason: result?.state ?? 'no-result'});
    },
  };
}

export function jupiterSwapVerifier({connection, network = 'mainnet-beta', read = readSiloJupiterJournal, check = checkSiloJupiterOutcome}) {
  return {
    async checkOutcome(request) {
      if (request.network !== network) return unknown(request, {network});
      const record = request.record;
      if (!record || record.signature !== request.signature || (request.owner && record.owner !== request.owner)) return unknown(request, {reason: 'record-binding'});
      const row = read(recordStorage(SILO_JUPITER_JOURNAL_KEY, record));
      if (!row || !['silo-jupiter-signed-v1', 'silo-jupiter-build-signed-v1'].includes(row.kind) || row.network !== network || row.signature !== request.signature) return unknown(request, {reason: 'record-binding'});
      if (row.messageHash !== request.messageHash) return unknown(request, {messageHash: row.messageHash});
      const result = await check(row, {connection});
      if (result?.signature !== request.signature) return unknown(request, {reason: 'result-binding'});
      if (result.status === 'finalized' && result.minimumReceivedVerified === true) return {status: 'finalized', network, signature: request.signature, messageHash: row.messageHash, evidence: {slot: result.slot ?? null, receivedOutputRaw: result.receivedOutputRaw ?? null}};
      if (result.status === 'failed') return {status: 'failed', network, signature: request.signature, messageHash: row.messageHash, evidence: {slot: result.slot ?? null}};
      return unknown(request, {reason: 'outcome-unknown'});
    },
  };
}

export function xmrPaymentVerifier({session, network = 'mainnet'}) {
  return {
    async checkOutcome(request) {
      if (request.network !== network) return unknown(request, {network});
      // Account records (signing-gate.mjs): {schema, intent, pending}, bound to the reserved intent hash; the earlier form bound
      // the transaction hash itself. A cancelling payment recorded on the account is part of the outcome rule.
      const wrapped = request.record?.schema === XMR_RECORD, pending = wrapped ? request.record.pending : request.record;
      const hash = pending?.authorized?.hash;
      if (!/^[a-f0-9]{64}$/.test(hash ?? '') || hash !== request.signature) return unknown(request, {reason: 'record-binding'});
      if (wrapped ? (request.record.intent?.network !== network || await xmrIntentHash(request.record.intent) !== request.messageHash || !xmrRecordMatches(request.record.intent, pending)) : hash !== request.messageHash) return unknown(request, {reason: 'record-binding'});
      if (request.cancellation && pending.conflict && JSON.stringify({hash: pending.conflict.hash, keyImage: pending.conflict.keyImage, metadata: pending.conflict.metadata}) !== JSON.stringify(request.cancellation)) return unknown(request, {reason: 'cancellation-differs'});
      const conflict = request.cancellation ?? pending.conflict;
      const result = await session.outcomeOf(conflict ? {...pending, conflict} : pending);
      if (result === true) return {status: 'finalized', network, signature: hash, messageHash: request.messageHash, evidence: {confirmationsAtLeast: 10}};
      if (result === 'failed') return {status: 'failed', network, signature: hash, messageHash: request.messageHash, evidence: {conflict: conflict?.hash ?? null}};
      return unknown(request, {reason: result === 'reported-failed' ? 'reported-failed-is-not-proof' : 'not-deep'});
    },
  };
}

/** `fetchPage({owner, cursor})` returns one readSolanaActivity response (directly, or via the existing activity route). */
export function solanaHistoryReader({fetchPage, network = 'mainnet-beta', maxPages = 5}) {
  return async function history({network: wanted, protocol, wallet, from}) {
    const identity = {network, protocol, wallet};
    if (wanted !== network) return {...identity, complete: false, throughTip: false, coveredFrom: from + 1, items: []};
    const items = [];
    let cursor = null;
    for (let page = 0; page < maxPages; page++) {
      const response = await fetchPage({owner: wallet, cursor});
      if (response?.network !== network || response.owner !== wallet) return {network: response?.network ?? null, protocol, wallet: response?.owner ?? null, complete: false, throughTip: false, coveredFrom: from + 1, items: []};
      const coverage = response.coverage ?? {};
      if (coverage.unavailable || coverage.malformed || !Array.isArray(response.rows)) return {...identity, complete: false, throughTip: true, coveredFrom: from + 1, items};
      let reached = null;
      for (const row of response.rows) {
        const at = Number.isSafeInteger(row.blockTime) ? row.blockTime * 1000 : null;
        if (at !== null && at < from) { reached = reached === null ? at : Math.min(reached, at); continue; }
        items.push({signature: row.signature, final: row.status === 'finalized' || row.status === 'failed'});
      }
      if (reached !== null) return {...identity, complete: true, throughTip: true, coveredFrom: reached, items};
      if (coverage.providerPageEnded === true) return {...identity, complete: true, throughTip: true, coveredFrom: 0, items};
      if (!response.nextCursor) break; // five-page bound or cursor expiry: not complete
      cursor = response.nextCursor;
    }
    return {...identity, complete: false, throughTip: true, coveredFrom: from + 1, items};
  };
}

export function xmrHistoryReader({session, network = 'mainnet'}) {
  // The wallet identity returned is the session's own primary address; coverage.mjs compares it with the vault's.
  return async function history({network: wanted, protocol, from}) {
    const result = await session.outgoingHistory();
    const items = result.txs.map((tx) => ({signature: tx.hash, final: tx.confirmed === true && Number.isSafeInteger(tx.confirmations) && tx.confirmations >= 10 && tx.failed !== true}));
    const complete = wanted === network && result.synced === true && Number.isSafeInteger(result.restoreHeight) && result.restoreHeight >= 0;
    return {network, protocol, wallet: result.primaryAddress, complete, throughTip: result.synced === true, coveredFrom: complete ? result.restoreHeight : from + 1, items};
  };
}

/** Assembles the verifier map the sync client expects. Missing pieces stay missing, which keeps holds and recovery held. */
/** `solanaRead` (the device's RPC reader) enables the complete, resumable history reader (solana-history.mjs) used for
 * recovery coverage; `fetchSolanaActivityPage` (the bounded display reader) is only a fallback and can never prove more
 * than its bound. */
export function siloSyncVerifiers({solanaConnection, solanaRead, solanaCheckpoints, fetchSolanaActivityPage, xmrSession} = {}) {
  const verifiers = {};
  if (solanaConnection) {
    verifiers['solana-transfer'] = solanaTransferVerifier({connection: solanaConnection});
    verifiers['jupiter-swap'] = jupiterSwapVerifier({connection: solanaConnection});
  }
  if (solanaRead || fetchSolanaActivityPage) {
    const history = solanaRead ? createSolanaHistoryReader({read: solanaRead, ...(solanaCheckpoints ? {checkpoints: solanaCheckpoints} : {})}) : solanaHistoryReader({fetchPage: fetchSolanaActivityPage});
    for (const protocol of ['solana-transfer', 'jupiter-swap']) verifiers[protocol] = {...verifiers[protocol], history};
  }
  if (xmrSession) verifiers['xmr-payment'] = {...xmrPaymentVerifier({session: xmrSession}), history: xmrHistoryReader({session: xmrSession})};
  return verifiers;
}
