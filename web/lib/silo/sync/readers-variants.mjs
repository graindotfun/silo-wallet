/** Outcome verifiers for the other Jupiter execution variants and for SOL→XMR conversion orders, built on the existing
 * reviewed Silo validators and receipt verifiers. Same rules as readers.mjs: validate the protocol's own record with its
 * own reader, bind it to the operation's signature and reserved hash, accept only a positive, verified terminal answer;
 * anything else is 'unknown' and the hold stays.
 *
 *   Jupiter shared   readSiloSharedJournal → raw finalized receipt (server route, injected) → decodeSiloSharedRawReceipt
 *                    → verifySiloSharedFinalizedReceipt, all re-run on this device. A server can withhold a receipt; it
 *                    cannot make this device accept one that does not verify against the signed message.
 *   Jupiter direct   same with the direct readers.
 *   Jupiter managed  readSiloManagedJournal → the existing managed outcome (server route, injected); accepted only when
 *                    terminalAuthenticated and its reviewHash equals the record's captureHash (the variant's identity;
 *                    it has no message hash), and finalized only with minimumReceivedVerified.
 *   SOL→XMR order    the existing cross-chain coordinator's reconcile (injected); 'settled' and 'refund-confirmed' are its
 *                    only terminal states. xmrArrivalVerifier supplies the missing XMR arrival proof for 'settled'.
 * The legacy/core Jupiter record keeps using jupiterSwapVerifier in readers.mjs. */
import {Buffer} from 'buffer';
import {sha256} from '@noble/hashes/sha256';
import {VersionedTransaction} from '@solana/web3.js';
import {readSiloSharedJournal, SILO_SHARED_JUPITER_KEY} from '../jupiter-shared-journal.mjs';
import {readSiloDirectJournal, SILO_DIRECT_JUPITER_KEY} from '../jupiter-direct-journal.mjs';
import {readSiloManagedJournal, SILO_MANAGED_JUPITER_KEY} from '../jupiter-managed-journal.mjs';
import {decodeSiloSharedRawReceipt} from '../jupiter-shared-receipt-broker.mjs';
import {decodeSiloDirectRawReceipt} from '../jupiter-direct-receipt-broker.mjs';
import {verifySiloSharedFinalizedReceipt} from '../jupiter-shared-historical.mjs';
import {verifySiloDirectFinalizedReceipt} from '../jupiter-direct-historical.mjs';
import {jupiterSwapVerifier, siloSyncVerifiers} from './readers.mjs';

const HEX64 = /^[a-f0-9]{64}$/;
const hex = (bytes) => Buffer.from(bytes).toString('hex');
function recordStorage(key, record) {
  const map = new Map([[key, JSON.stringify(record)]]);
  return {getItem: (k) => map.has(k) ? map.get(k) : null, setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); }};
}
const unknown = (request, extra = {}) => ({status: 'unknown', network: request.network, signature: request.signature, messageHash: request.messageHash, ...extra});
/** The sync binding for a managed swap: its captureHash (hashed to 64 hex if it is not already). */
export const managedBindingHash = (captureHash) => HEX64.test(captureHash ?? '') ? captureHash : hex(sha256(new TextEncoder().encode(String(captureHash))));

function terminal(request, network, messageHash, result, extra) {
  if (result?.signature !== request.signature) return unknown(request, {reason: 'result-binding'});
  if (result.status === 'finalized' && result.minimumReceivedVerified === true) return {status: 'finalized', network, signature: request.signature, messageHash, evidence: {slot: result.slot ?? null, receivedOutputRaw: result.receivedOutputRaw ?? null, ...extra}};
  if (result.status === 'failed') return {status: 'failed', network, signature: request.signature, messageHash, evidence: {slot: result.slot ?? null, ...extra}};
  return unknown(request, {reason: 'outcome-unknown'});
}

/** Dispatches on the saved record's kind. Injected server-route callers: `sharedRawReceipt(row)`, `directRawReceipt(row)`
 * (the existing shared-receipt route; may return null) and `managedOutcome(row)` (the existing outcome route). */
export function jupiterVariantsVerifier({connection, network = 'mainnet-beta', sharedRawReceipt, directRawReceipt, managedOutcome, impl = {}}) {
  const fn = {readSiloSharedJournal, readSiloDirectJournal, readSiloManagedJournal, decodeSiloSharedRawReceipt, decodeSiloDirectRawReceipt, verifySiloSharedFinalizedReceipt, verifySiloDirectFinalizedReceipt, ...impl};
  const core = jupiterSwapVerifier({connection, network});
  return {
    async checkOutcome(request) {
      if (request.network !== network) return unknown(request, {network});
      const record = request.record, kind = record?.kind;
      if (!record || record.signature !== request.signature) return unknown(request, {reason: 'record-binding'});
      if (kind === 'silo-jupiter-shared-signed-v1' || kind === 'silo-jupiter-direct-signed-v1') {
        const shared = kind === 'silo-jupiter-shared-signed-v1';
        const row = shared ? fn.readSiloSharedJournal(recordStorage(SILO_SHARED_JUPITER_KEY, record)) : fn.readSiloDirectJournal(recordStorage(SILO_DIRECT_JUPITER_KEY, record));
        if (!row || row.kind !== kind || row.network !== network || row.signature !== request.signature || (request.owner && row.context?.derived?.owner !== request.owner)) return unknown(request, {reason: 'record-binding'});
        if (row.context?.messageHash !== request.messageHash) return unknown(request, {messageHash: row.context?.messageHash ?? null});
        const fetchRaw = shared ? sharedRawReceipt : directRawReceipt;
        if (typeof fetchRaw !== 'function') return unknown(request, {reason: 'no-receipt-route'});
        const raw = await fetchRaw(structuredClone(row));
        const landed = raw ? (shared ? fn.decodeSiloSharedRawReceipt(row, raw) : fn.decodeSiloDirectRawReceipt(row, raw)) : null;
        if (!landed) return unknown(request, {reason: 'outcome-unknown'});
        const verified = shared ? fn.verifySiloSharedFinalizedReceipt(row, landed) : fn.verifySiloDirectFinalizedReceipt(row, landed);
        return terminal(request, network, row.context.messageHash, verified, {variant: shared ? 'shared' : 'direct', contextHash: verified?.contextHash ?? null});
      }
      if (kind === 'silo-jupiter-managed-signed-v1') {
        const row = fn.readSiloManagedJournal(recordStorage(SILO_MANAGED_JUPITER_KEY, record));
        const captureHash = row?.review?.capture?.captureHash;
        if (!row || row.kind !== kind || row.network !== network || row.signature !== request.signature || !captureHash || (request.owner && row.review.contract?.owner !== request.owner)) return unknown(request, {reason: 'record-binding'});
        const messageHash = managedBindingHash(captureHash);
        if (messageHash !== request.messageHash) return unknown(request, {messageHash});
        if (typeof managedOutcome !== 'function') return unknown(request, {reason: 'no-outcome-route'});
        const result = await managedOutcome(structuredClone(row));
        if (result?.terminalAuthenticated !== true || result.reviewHash !== captureHash) return unknown(request, {reason: 'not-authenticated'});
        return terminal(request, network, messageHash, result, {variant: 'managed'});
      }
      if (['silo-jupiter-signed-v1', 'silo-jupiter-build-signed-v1'].includes(kind)) return core.checkOutcome(request);
      return unknown(request, {reason: 'unsupported-record'}); // signing reservations and unknown kinds never close
    },
  };
}

/** XMR arrival proof for a SOL→XMR order (the coordinator's adapter.verifyArrival). True only when this device's synced
 * XMR wallet holds the payout transaction at 10+ confirmations, not reported failed, paying at least the minimum to
 * exactly the order's destination address. */
export function xmrArrivalVerifier({session}) {
  return async function verifyArrival(destination, address, minimumAtomic, payoutTxid) {
    if (destination?.chain !== 'monero' || destination?.network !== 'mainnet') return false;
    let incoming;
    try { incoming = await session.incomingOf(payoutTxid); } catch { return false; }
    if (!incoming || incoming.hash !== payoutTxid || incoming.confirmed !== true || !Number.isSafeInteger(incoming.confirmations) || incoming.confirmations < 10 || incoming.failed === true) return false;
    const received = incoming.transfers.filter((t) => t.address === address).reduce((sum, t) => sum + BigInt(t.amount), 0n);
    return received >= BigInt(minimumAtomic);
  };
}

/** SOL→XMR order outcome. The operation's signature is the Solana deposit's; its reserved hash is that deposit's message.
 * `reconcileOrder(id)` is the existing coordinator's reconcile (provider status + chain arrival proofs). */
export function crosschainOrderVerifier({reconcileOrder, network = 'mainnet-beta'}) {
  return {
    async checkOutcome(request) {
      if (request.network !== network) return unknown(request, {network});
      const record = request.record;
      if (!record?.id || record.deposit?.txid !== request.signature || typeof record.deposit.bytes !== 'string') return unknown(request, {reason: 'record-binding'});
      const messageHash = hex(sha256(VersionedTransaction.deserialize(Buffer.from(record.deposit.bytes, 'base64')).message.serialize()));
      if (messageHash !== request.messageHash) return unknown(request, {messageHash});
      const current = await reconcileOrder(record.id);
      if (current?.id !== record.id || current.deposit?.txid !== request.signature) return unknown(request, {reason: 'result-binding'});
      if (current.state === 'settled') return {status: 'finalized', network, signature: request.signature, messageHash, evidence: {order: current.id, payoutTxid: current.providerObservation?.payoutTxid ?? null}};
      if (current.state === 'refund-confirmed') return {status: 'failed', network, signature: request.signature, messageHash, evidence: {order: current.id, refunded: true}};
      return unknown(request, {reason: current.state});
    },
  };
}

/** Full verifier map: core readers.mjs pieces plus the Jupiter variants (one verifier dispatching by record kind) and
 * SOL→XMR orders. Anything not supplied stays missing, which keeps holds and recovery held. */
export function siloSyncAllVerifiers({solanaConnection, sharedRawReceipt, directRawReceipt, managedOutcome, reconcileOrder, ...rest} = {}) {
  const verifiers = siloSyncVerifiers({solanaConnection, ...rest});
  if (solanaConnection) verifiers['jupiter-swap'] = {...verifiers['jupiter-swap'], checkOutcome: jupiterVariantsVerifier({connection: solanaConnection, sharedRawReceipt, directRawReceipt, managedOutcome}).checkOutcome};
  if (reconcileOrder) verifiers['crosschain-order'] = {...verifiers['crosschain-order'], ...crosschainOrderVerifier({reconcileOrder})};
  return verifiers;
}
