/** This device's outcome and history readers in the browser, over the existing same-origin routes only:
 *   Solana transfer and Jupiter core — the Solana read route (/api/silo/solana/transfer, reads only);
 *   Jupiter shared and direct      — the authenticated historical receipt route (/api/silo/swap/shared-receipt), checked
 *                                    for runtime, network and review seal exactly as the flows check it, then decoded and
 *                                    verified on this device (readers-variants.mjs);
 *   Jupiter managed                — the authenticated outcome route (/api/silo/swap/outcome);
 *   Monero                         — the open wallet session on this device (xmr-adapter.mjs), when one is open.
 * History for recovery (SYNC-WIRING-01): the complete, anchored, resumable Solana owner history reader
 * (solana-history.mjs) over the read-only history route (/api/silo/solana/history), with checkpoints in this device's
 * durable account storage; Monero history from the open wallet. SOL→XMR orders: an order reader when an order store and
 * status route exist; otherwise an explicit verifier that holds ('order-route-unavailable').
 * Anything not available stays held. No wallet is opened, nothing is signed or sent. */
import {Connection} from '@solana/web3.js';
import {sessionRpcFetch} from '../../browser-rpc-session.mjs';
import {siloJson} from '../bounded-json.mjs';
import {siloSyncAllVerifiers, xmrArrivalVerifier} from './readers-variants.mjs';
import {createCrosschainCoordinator} from '../crosschain-order.mjs';
import {verifyCrosschainSolanaArrival} from '../crosschain-deposit.mjs';
import {BUILD_COMMIT} from '../../build-commit.ts';

const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

/** The receipt and outcome routes the Jupiter verifiers read. @param {{origin?: string, fetcher?: any}} [options] */
export function siloReceiptRoutes({origin = globalThis.location?.origin, fetcher = sessionRpcFetch} = {}) {
  const post = async (action, body) => {
    const response = await fetcher(new URL('/api/silo/swap/' + action, origin).href, {method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(15000)});
    const result = await siloJson(response, 131072);
    if (!response.ok) throw Error('Outcome route unavailable or held.');
    return result;
  };
  // Same acceptance as the shared/direct flows' verifyFinalizedOutcome; anything else is not a receipt for this record.
  const rawReceipt = async (row) => {
    const proof = await post('shared-receipt', row);
    if (proof?.runtimeFingerprint !== row.runtimeFingerprint || proof.genesisHash !== GENESIS || proof.reviewSeal !== row.reviewSeal || proof.sourceFingerprint !== String(row.reviewSeal ?? '').split('.')[1] || proof.reviewAuthenticated !== true) return null;
    return proof;
  };
  return {sharedRawReceipt: rawReceipt, directRawReceipt: rawReceipt, managedOutcome: (row) => post('outcome', row)};
}

/** The device's read transport for the complete Solana history reader: one JSON-RPC read per call through the read-only
 * history route. The reader itself checks genesis, the finalized anchor, page order and completeness proofs.
 * @param {{origin?: string, fetcher?: any}} [options] */
export function siloHistoryRead({origin = globalThis.location?.origin, fetcher = sessionRpcFetch} = {}) {
  let id = 0;
  return async (method, params) => {
    const response = await fetcher(new URL('/api/silo/solana/history?network=mainnet-beta', origin).href, {method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: ++id, method, params}), signal: AbortSignal.timeout(20000)});
    const body = await siloJson(response, 2 * 1024 * 1024);
    if (!response.ok || body?.error || !Object.hasOwn(body ?? {}, 'result')) throw Error('Solana history read unavailable.');
    return body.result;
  };
}

/** SOL→XMR order outcomes through this device's order store and the order status route: XMR arrival from the open wallet
 * (10 deep, exact address, at least the minimum), SOL refund from the Solana read route. Unknown, refund-reported without
 * proof, provider claims and unavailable routes stay held (crosschain-order.mjs, readers-variants.mjs). */
export function siloOrderReconciler({store, status, xmrSession = null, connection}) {
  if (!store || typeof status !== 'function') return null;
  const adapter = {
    status,
    verifyArrival: xmrSession ? xmrArrivalVerifier({session: xmrSession}) : async () => false,
    verifyRefund: (asset, address, txid) => verifyCrosschainSolanaArrival(asset, address, '1', txid, connection).catch(() => false),
  };
  const coordinator = createCrosschainCoordinator({store, adapter, config: {}, validateAddress: async () => false, verifyDeposit: async () => { throw Error('Orders are not created from the outcome reader.'); }});
  return (id) => coordinator.reconcile(id);
}

const heldOrders = {async checkOutcome(request) { return {status: 'unknown', network: request.network, signature: request.signature, messageHash: request.messageHash, reason: 'order-route-unavailable'}; }};

/** @param {{origin?: string, fetcher?: any, xmrSession?: any, solanaCheckpoints?: any, orders?: {store: any, status: (intent: any, order: any) => Promise<any>}|null}} [options] */
export function siloBrowserVerifiers({origin = globalThis.location?.origin, fetcher = sessionRpcFetch, xmrSession = null, solanaCheckpoints, orders = null} = {}) {
  const solanaConnection = new Connection(new URL('/api/silo/solana/transfer?network=mainnet-beta', origin).href, {commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: fetcher});
  const reconcileOrder = orders ? siloOrderReconciler({...orders, xmrSession, connection: solanaConnection}) : null;
  const verifiers = siloSyncAllVerifiers({solanaConnection, solanaRead: siloHistoryRead({origin, fetcher}), ...(solanaCheckpoints ? {solanaCheckpoints} : {}), ...siloReceiptRoutes({origin, fetcher}), ...(xmrSession ? {xmrSession} : {}), ...(reconcileOrder ? {reconcileOrder} : {})});
  if (!reconcileOrder) verifiers['crosschain-order'] = heldOrders;
  // Build identity is a compiler-defined local constant, never a server field.
  // Each constructed reader also gets an opaque process/runtime incarnation in
  // outcome.mjs, invalidating durable cache entries after reader replacement.
  return Object.fromEntries(Object.entries(verifiers).map(([kind, reader]) => [kind, Object.freeze({...reader,
    cachePolicyVersion: 'silo-browser-outcomes-v2', cacheSource: BUILD_COMMIT})]));
}
