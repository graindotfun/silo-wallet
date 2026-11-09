import { siloNewReceiveAddress } from './new-receive.mjs';
import { siloProviderSwapFeeBps, siloApprovedSwapFeeBps } from './revenue-policy.mjs';

/** This is the local execution/recovery contract, not proof of live provider support. */
export const SILO_CROSSCHAIN_ROUTES = Object.freeze([
  'sol-to-xmr', 'usdc-to-xmr', 'xmr-to-sol', 'xmr-to-usdc',
  // Both legs on Solana (owner decision, 2 Nov 2026): the deposit and the arrival are both server-verifiable,
  // so these two can reach 'settled' (and the refund path can be verified) without a Monero wallet.
  'sol-to-usdc', 'usdc-to-sol',
  // EVM destinations (owner decision, 4 Nov 2026): the user pastes an Ethereum-compatible address of their own choosing.
  // Silo holds no EVM key yet, so these are destination-only: there is no EVM source and nothing here signs on an EVM chain.
  'sol-to-eth', 'usdc-to-eth', 'xmr-to-eth', 'sol-to-ethbase', 'usdc-to-ethbase', 'xmr-to-ethbase',
]);
const ASSETS = Object.freeze({
  sol: { chain: 'solana', network: 'mainnet', decimals: 9, mint: null },
  usdc: { chain: 'solana', network: 'mainnet', decimals: 6, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  xmr: { chain: 'monero', network: 'mainnet', decimals: 12, mint: null },
  // Native ETH only (no token): chainId is part of the asset identity so an order for one EVM chain can never be read as another.
  eth: { chain: 'evm', network: 'mainnet', chainId: 1, decimals: 18, mint: null },
  ethbase: { chain: 'evm', network: 'mainnet', chainId: 8453, decimals: 18, mint: null },
});
export function crosschainAsset(name) {
  if (!Object.hasOwn(ASSETS, name)) throw Error('crosschain-asset');
  return { asset: name, ...ASSETS[name] };
}
function text(value) { return typeof value === 'string' && value.length > 0 && value.length <= 512; }
function positive(value) { return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value); }
export function validateCrosschainIntent(intent) {
  if (!intent || !SILO_CROSSCHAIN_ROUTES.includes(intent.route)) throw Error('crosschain-route');
  const [from, to] = intent.route.split('-to-');
  for (const [key, asset] of [['source', from], ['destination', to]]) {
    const expected = crosschainAsset(asset), actual = intent[key];
    if (!actual || Object.keys(expected).some((field) => actual[field] !== expected[field])) throw Error('crosschain-network-or-mint');
  }
  if (!positive(intent.amountAtomic) || !positive(intent.minimumReceiveAtomic)) throw Error('crosschain-amount');
  for (const field of ['id', 'quoteId', 'provider', 'sourceAddress', 'destinationAddress', 'refundAddress']) {
    if (!text(intent[field])) throw Error('crosschain-identity');
  }
  // Across chains the destination and refund addresses are different wallets and must differ. On a same-chain
  // route (SOL<->USDC) both are the user's own Solana address, so equality is expected and allowed.
  const sameChain = crosschainAsset(from).chain === crosschainAsset(to).chain;
  if (intent.id !== intent.quoteId || (!sameChain && intent.destinationAddress === intent.refundAddress) || typeof intent.fixed !== 'boolean') throw Error('crosschain-binding');
  if (!Number.isSafeInteger(intent.expiresAt)) throw Error('crosschain-expiry');
  // Structural check only: some owner-approved adapter's fee. intent.provider identifies the underlying
  // exchange a cross-chain platform routed through, not the Silo adapter processing this intent, so it is
  // not the fee-policy key here -- assertCrosschainAvailable(config), keyed by config.provider, is what
  // actually gates "the fee configured for the adapter in use."
  if (!siloApprovedSwapFeeBps(intent.siloFeeBps) || intent.collectionActive !== false || intent.buybacksActive !== false) throw Error('crosschain-fee-policy');
  return structuredClone(intent);
}

/** Address allocation is completed and encrypted-save awaited before a provider can see it. */
export async function prepareCrosschainXmrAddress({ wallet, save, network, validateAddress }) {
  if (network !== 'mainnet' || typeof validateAddress !== 'function') throw Error('crosschain-mainnet-required');
  const address = await siloNewReceiveAddress(wallet, save);
  if (!validateAddress(address, crosschainAsset('xmr'))) throw Error('crosschain-xmr-address');
  return address;
}

export function assertCrosschainAvailable(config = {}) {
  // An unapproved config.provider must fail closed as 'not-configured', not surface
  // siloProviderSwapFeeBps's own error -- a caller should only ever see one refusal shape here.
  let approvedFee; try { approvedFee = siloProviderSwapFeeBps(config.provider); } catch { approvedFee = null; }
  if (config.enabled !== true || config.apiAccessVerified !== true || config.routesVerified !== true
    || config.feeContractVerified !== true || config.feeBps !== approvedFee || config.walletExecutionVerified !== true || config.commissionAccrualAuthorized !== true) {
    throw Error('crosschain-not-configured');
  }
}

/** Store must encrypt every record and perform durable, atomic CAS (also across tabs).
 * Adapter callbacks are trusted chain/provider verifiers, never raw UI results.
 * No private wallet material belongs in a server-side order store. */
export function createCrosschainCoordinator({ store, adapter, config, validateAddress, verifyDeposit, now = Date.now }) {
  async function update(record, patch) {
    const next = { ...record, ...patch, revision: record.revision + 1 };
    if (!await store.compareAndSwap(record.id, record.revision, next)) throw Error('crosschain-concurrent-change');
    return next;
  }
  async function read(id) { const record = await store.read(id); if (!record) throw Error('crosschain-order-missing'); return record; }
  return {
    async create(intent) {
      assertCrosschainAvailable(config);
      const bound = validateCrosschainIntent(intent);
      if (bound.expiresAt <= now()) throw Error('crosschain-expired');
      for (const [address, asset] of [[bound.sourceAddress, bound.source], [bound.refundAddress, bound.source], [bound.destinationAddress, bound.destination]]) {
        if (typeof validateAddress !== 'function' || !validateAddress(address, asset)) throw Error('crosschain-address');
      }
      // Persist the intent BEFORE the create request. Response loss is never a second order.
      const record = { id: bound.id, revision: 0, intent: bound, state: 'creation-uncertain', order: null, deposit: null };
      if (!await store.compareAndSwap(bound.id, null, record)) throw Error('crosschain-order-already-exists');
      const order = await adapter.create(bound); // Failure deliberately leaves creation-uncertain.
      return update(record, { order, state: 'waiting', depositState: 'not-started' });
    },
    async reconcileCreation(id) {
      const record = await read(id);
      if (record.state !== 'creation-uncertain') throw Error('crosschain-not-creation-uncertain');
      // Provider lookup by original quote ID must be verified in the commercial contract.
      // Null/unknown NEVER means it is safe to retry creation.
      const order = await adapter.recoverCreation(record.intent);
      if (!order) return record;
      return update(record, { order, state: 'waiting', depositState: 'not-started' });
    },
    async recordSignedDeposit(id, signed) {
      assertCrosschainAvailable(config);
      const record = await read(id);
      if (record.depositState !== 'not-started' || record.state !== 'waiting' || record.deposit) throw Error('crosschain-deposit-already-started');
      if (record.intent.expiresAt <= now() || record.order.expiresAt <= now()) throw Error('crosschain-expired');
      const binding = {
        asset: record.intent.source, amountAtomic: record.intent.amountAtomic,
        sourceAddress: record.intent.sourceAddress, depositAddress: record.order.depositAddress,
        depositMemo: record.order.depositMemo, orderId: record.order.orderId,
      };
      // Verify actual decoded signed transaction against exact source, asset, amount,
      // deposit address/memo, and immutable order BEFORE persisting or broadcasting.
      const verified = await verifyDeposit(signed, binding);
      if (record.intent.expiresAt <= now() || record.order.expiresAt <= now()) throw Error('crosschain-expired');
      if (!verified || !text(verified.txid) || typeof verified.bytes !== 'string'
        || verified.bytes.length < 1 || verified.bytes.length > 128 * 1024) throw Error('crosschain-deposit-unverified');
      return update(record, { state: 'deposit-signed', depositState: 'signed', deposit: structuredClone(verified) });
    },
    async broadcast(id, sendExactSignedBytes) {
      assertCrosschainAvailable(config);
      let record = await read(id);
      if (record.depositState !== 'signed' || record.state !== 'deposit-signed') throw Error('crosschain-do-not-repeat-deposit');
      if (record.providerObservation && record.providerObservation.state !== 'waiting') throw Error('crosschain-provider-not-awaiting-deposit');
      if (record.intent.expiresAt <= now() || record.order.expiresAt <= now()) throw Error('crosschain-expired');
      record = await update(record, { state: 'deposit-uncertain', depositState: 'uncertain' }); // BEFORE network I/O.
      await sendExactSignedBytes(record.deposit.bytes, record.deposit.txid);
      return update(record, { state: 'deposit-submitted', depositState: 'submitted' });
    },
    async reconcile(id) {
      const record = await read(id);
      if (!record.order) throw Error('crosschain-creation-unresolved');
      if (['settled', 'refund-confirmed'].includes(record.state)) return record;
      const status = await adapter.status(record.intent, record.order);
      let state = status.state;
      // Provider 'finished'/'refunded' are claims, not recipient-chain settlement.
      if (state === 'payout-reported') {
        const arrival = await adapter.verifyArrival(record.intent.destination, record.intent.destinationAddress, record.intent.minimumReceiveAtomic, status.payoutTxid);
        if (arrival === true) state = 'settled';
      } else if (state === 'refund-reported') {
        const arrival = await adapter.verifyRefund(record.intent.source, record.intent.refundAddress, status.refundTxid);
        if (arrival === true) state = 'refund-confirmed';
      }
      // Polling waiting/expired cannot erase signed/broadcast uncertainty or authorize retry.
      if (record.depositState === 'signed') state = 'deposit-signed';
      else if (record.deposit && ['waiting', 'expired'].includes(state)) state = 'deposit-uncertain';
      return update(record, { state, providerObservation: status });
    },
  };
}
