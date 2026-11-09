/** Monero payment intent reserved on the account before the wallet engine runs (signing-gate.mjs, SYNC-GATE-01). */
import {canonical, sha256Hex} from './codec.mjs';
import {siloAmount, siloUnits} from '../amounts.mjs';

export const XMR_RECORD = 'silo-xmr-account-payment-v1';
/** The payment intent reserved before the wallet engine runs: network, recipient, amount (normalised exactly as the
 * wallet's review shows it) and a fresh nonce, so two payments of the same amount are two operations. */
export function xmrIntent({network, address, amount, nonce = randomHex(16)}) {
  if (!['mainnet', 'stagenet'].includes(network) || typeof address !== 'string' || !address || address.length > 128 || !/^[a-f0-9]{32}$/.test(nonce)) throw Object.assign(Error('Payment details are incomplete. Nothing was prepared.'), {gateCode: 'no-reservation'});
  return {schema: 'silo-xmr-payment-intent-v1', network, address, amount: siloUnits(siloAmount(amount, 12), 12), nonce};
}
export const xmrIntentHash = (intent) => sha256Hex(canonical(intent));
export const xmrRecordMatches = (intent, pending) => Boolean(intent && pending?.review && pending.review.network === intent.network && pending.review.address === intent.address && pending.review.amount === intent.amount && pending.review.asset === 'XMR');
const randomHex = (bytes) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
