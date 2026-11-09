// Pure helpers for the full-screen money animation (components/silo-money-animation.tsx). Cosmetic only: these map an
// ALREADY KNOWN real state to a display phase. Nothing here decides, delays or changes any money step.
import { conversionProgress } from './conversion-ui.mjs';

export const MONEY_PHASES = Object.freeze(['pending', 'done', 'error']);
export const MONEY_KINDS = Object.freeze(['send', 'conversion', 'entry']);

// Packaged, unrecoloured full-colour logos. An asset without a logo here simply shows no coin (never a ticker).
const COIN_SRC = Object.freeze({
  sol: '/silo-icons/sol-color.svg',
  xmr: '/silo-icons/xmr-color.svg',
  usdc: '/silo-icons/usdc-color.svg',
  zec: '/silo-icons/zec.svg',
  grain: '/silo-icons/grain.svg',
  eth: '/silo-icons/eth.svg',
  base: '/silo-icons/base.svg',
  bnb: '/silo-icons/bnb.svg',
});

/** Distinct involved assets with a packaged logo, in the given order. Never adds an asset that was not named. */
export function moneyCoinAssets(assets) {
  const out = [];
  for (const raw of Array.isArray(assets) ? assets : []) {
    const id = String(raw ?? '').toLowerCase();
    if (Object.hasOwn(COIN_SRC, id) && !out.includes(id)) out.push(id);
  }
  return out;
}
export function moneyCoinSrc(asset) { return Object.hasOwn(COIN_SRC, asset) ? COIN_SRC[asset] : null; }

/** `count` coin descriptors cycling through the involved assets only. Deterministic, so the picture is stable. */
export function moneyCoins(assets, count = 6) {
  const ids = moneyCoinAssets(assets);
  if (!ids.length) return [];
  return Array.from({ length: count }, (_, i) => ({ asset: ids[i % ids.length], src: COIN_SRC[ids[i % ids.length]], index: i }));
}

/** Short lowercase caption (the dot is added by the component) and a one-line hint. "done" only for phase 'done'. */
export function moneyCaption(kind, phase) {
  // The first-entry welcome is not a payment: it never says done, sending or exchanging.
  if (kind === 'entry') return { text: 'you\u2019re in', hint: 'one wallet for monero and solana' };
  if (phase === 'done') return { text: 'done', hint: 'tap to close' };
  if (phase === 'error') return { text: 'not completed', hint: 'tap to see what happened' };
  return { text: kind === 'conversion' ? 'exchanging' : 'sending', hint: 'tap to see the status' };
}

/** Conversion record state -> display phase. 'done' only when the existing progress view says Done (conversionProgress,
 * which already needs the wallet's own receipt for an XMR payout). Unknown or in-flight states stay 'pending'. */
const CONVERSION_ERROR = new Set(['expired', 'provider-failed', 'refund-reported', 'refund-confirmed', 'wallet-retired']);
export function conversionMoneyPhase(state, { receiptConfirmed = false, destinationIsXmr = false } = {}) {
  if (typeof state !== 'string' || !state) return null;
  if (CONVERSION_ERROR.has(state)) return 'error';
  if (conversionProgress(state, { receiptConfirmed, destinationIsXmr }).done) return 'done';
  return 'pending';
}

/** Solana send (components/silo-solana-transfer.tsx): 'done' only for the finalized, saved-free `sent` result. */
export function solanaSendMoneyPhase({ sent = null, pending = null, outcome = null, status = '' } = {}) {
  if (sent && !pending) return 'done';
  if (!pending) return null;
  if (outcome === 'expired' || /^The network rejected this transfer/.test(String(status))) return 'error';
  return 'pending';
}

/** Monero send (components/silo-native-zone.tsx): `submission.checkedInclusion` is the only 'done'. */
export function xmrSendMoneyPhase({ attempted = false, failed = false, checkedInclusion = false, error = false } = {}) {
  if (failed || error) return 'error';
  if (!attempted) return null;
  return checkedInclusion ? 'done' : 'pending';
}
