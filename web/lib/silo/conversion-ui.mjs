// Pure logic behind the one-screen conversion UI (components/silo-conversion-panel.tsx). No network, no wallet, no
// React: route derivation, the flip / coin-picker rules, the Max-with-fee-reserve calculation, quote choice, the
// pending-state progress mapping and the re-entry guard. Everything here is display or input-shaping logic; the
// safety controls (quote seal, persist-before-order, identity binding, memo refusal) stay in the panel and the
// server and are not weakened by anything in this file.
export const CONVERSION_ASSETS = Object.freeze(['sol', 'usdc', 'xmr']);
export const CONVERSION_DECIMALS = Object.freeze({ sol: 9, usdc: 6, xmr: 12 });
export const CONVERSION_LABEL = Object.freeze({ sol: 'SOL', usdc: 'USDC', xmr: 'XMR' });
export const CONVERSION_ROUTES = Object.freeze(['sol-to-xmr', 'xmr-to-sol', 'usdc-to-xmr', 'xmr-to-usdc', 'sol-to-usdc', 'usdc-to-sol']);
// Conservative fee reserves (atomic units) kept back by Max. They are estimates only: the wallet's own deposit
// review shows the exact fee and remains the second human check. SOL: base fee plus rent-exempt minimum plus a
// possible token-account creation, rounded up. USDC pays its network fee in SOL, so no USDC reserve. XMR: a
// generous ceiling for one ordinary transaction.
export const CONVERSION_FEE_RESERVE = Object.freeze({ sol: 5_000_000n, usdc: 0n, xmr: 1_000_000_000n });

export function conversionRouteId(from, to) {
  if (!CONVERSION_ASSETS.includes(from) || !CONVERSION_ASSETS.includes(to)) throw Error('Unsupported conversion coin.');
  if (from === to) throw Error('Both sides cannot be the same coin.');
  return `${from}-to-${to}`;
}
export function conversionLegs(route) {
  if (!CONVERSION_ROUTES.includes(route)) throw Error('Unsupported conversion route.');
  const [from, to] = route.split('-to-');
  return { from, to };
}
export function flipConversion(state) {
  conversionRouteId(state.from, state.to);
  return { from: state.to, to: state.from };
}
/** Coins offered by a picker: every coin except the one on the other side. */
export function pickerOptions(otherSide) {
  return CONVERSION_ASSETS.filter(coin => coin !== otherSide);
}
/** Choose a coin for one side. Choosing the coin already on the other side swaps the sides, so equal sides are impossible. */
export function pickConversionCoin(state, side, coin) {
  if (!CONVERSION_ASSETS.includes(coin)) throw Error('Unsupported conversion coin.');
  const other = side === 'from' ? 'to' : 'from';
  if (coin === state[other]) return { ...state, [other]: state[side], [side]: coin };
  return { ...state, [side]: coin };
}

export function atomicToDecimal(atomic, decimals) {
  if (typeof atomic !== 'string' || !/^\d+$/.test(atomic)) throw Error('Invalid atomic amount.');
  const digits = atomic.padStart(decimals + 1, '0');
  const whole = digits.slice(0, -decimals) || '0', fraction = digits.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole.replace(/^0+(?=\d)/, '')}.${fraction}` : whole.replace(/^0+(?=\d)/, '');
}
export function decimalToAtomic(text, decimals) {
  if (typeof text !== 'string' || !new RegExp(`^(0|[1-9]\\d{0,18})(\\.\\d{1,${decimals}})?$`).test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}
export function validConversionAmount(text, asset) {
  const atomic = decimalToAtomic(text, CONVERSION_DECIMALS[asset]);
  return atomic !== null && atomic > 0n;
}
/** Max = balance minus the fee reserve, as a decimal string; null when the balance is unknown or does not cover the reserve. */
export function conversionMax(asset, balanceAtomic) {
  if (!CONVERSION_ASSETS.includes(asset) || typeof balanceAtomic !== 'string' || !/^\d+$/.test(balanceAtomic)) return null;
  const left = BigInt(balanceAtomic) - CONVERSION_FEE_RESERVE[asset];
  return left > 0n ? atomicToDecimal(left.toString(), CONVERSION_DECIMALS[asset]) : null;
}

/** Best quote = highest indicative receive amount; ties keep the provider's own order. Never mutates the input. */
export function bestQuote(quotes, decimals) {
  let best = null, bestAtomic = -1n;
  for (const quote of quotes) {
    const atomic = decimalToAtomic(quote.amountTo, decimals);
    if (atomic === null) continue;
    if (atomic > bestAtomic) { best = quote; bestAtomic = atomic; }
  }
  return best ?? quotes[0] ?? null;
}

const TERMINAL = new Set(['settled', 'refund-confirmed', 'refund-reported', 'provider-failed', 'wallet-retired']);
export function conversionStateIsTerminal(state) { return TERMINAL.has(state); }
export const CONVERSION_STEPS = Object.freeze(['Waiting for deposit', 'Exchanging', 'Sending', 'Done']);
/** Map the saved record state to a 4-step progress. `receiptConfirmed` is this wallet's own verification for an XMR
 * payout: a provider's completion claim alone never reaches "Done" for XMR (provider claim is not wallet receipt). */
export function conversionProgress(state, { receiptConfirmed = false, destinationIsXmr = false } = {}) {
  const problem = state === 'provider-failed' || state === 'refund-reported' || state === 'refund-confirmed' || state === 'wallet-retired';
  let index = 0;
  if (state === 'provider-confirming' || state === 'provider-exchanging' || state === 'provider-verifying') index = 1;
  else if (state === 'provider-sending') index = 2;
  // 'payout-reported' is only the provider's claim on every route. XMR: wallet receipt check; Solana: the server's own
  // arrival verification, which turns it into 'settled'. Until then it is still 'Sending'.
  else if (state === 'payout-reported') index = 2;
  else if (state === 'settled') index = 3;
  if (destinationIsXmr && receiptConfirmed && !problem) index = 3;
  return { steps: CONVERSION_STEPS, index, problem, done: index === 3 && !problem };
}

const FUNDS_SAFE_TERMINAL = new Set(['expired', 'provider-failed']);
/** True only for a TERMINAL state whose outcome has been independently verified, so a new conversion may start and the saved
 * handle may leave the active list. Never true for creation-uncertain, deposit-*, provider claims (payout-reported on a
 * Solana route, refund-reported), provider-failed/expired with a deposit possibly sent, or wallet-retired.
 * `noFundsAtRisk` must be true only when this session created the order and never saw a deposit stage. */
export function conversionAttemptResolved(state, { receiptConfirmed = false, destinationIsXmr = false, noFundsAtRisk = false, windowClosed = false, providerVerifiedClosed = false } = {}) {
  if (state === 'refund-confirmed') return true;
  if (state === 'settled') return !destinationIsXmr || receiptConfirmed;
  if (state === 'payout-reported') return destinationIsXmr && receiptConfirmed;
  // The provider is the authority for "nothing arrived": a fresh provider answer in THIS page session (never storage) saying expired /
  // provider-failed, with the deposit window closed, resolves the attempt even if the deposit review was opened. Only these two states.
  if (FUNDS_SAFE_TERMINAL.has(state)) return noFundsAtRisk === true || (providerVerifiedClosed === true && windowClosed === true);
  // An order still 'waiting' after its own deposit deadline, with no deposit step ever opened, can never be funded.
  if (state === 'waiting') return noFundsAtRisk === true && windowClosed === true;
  return false;
}
/** Plain-language outcome for an attempt that was never funded, or null. Used for the one "Start a new conversion" action. */
export function conversionNothingSentMessage(state, { windowClosed = false } = {}) {
  return state === 'expired' || state === 'provider-failed' || (state === 'waiting' && windowClosed) ? 'This order expired. Nothing was sent. Your funds are still in your wallet.' : null;
}
/** Local-only fallback when the saved order cannot be loaded (for example after a reload): the attempt may be discarded only if this
 * browser knows its deposit deadline has passed AND the deposit review was never opened for it. Unreadable meta never qualifies. */
export function conversionStaleWithoutRecord(meta, now = Date.now()) {
  return Boolean(meta) && meta.readable === true && meta.depositOpened === false && Number.isSafeInteger(meta.windowEndsAt) && now >= meta.windowEndsAt;
}
/** States in which a deposit has not (or cannot yet have) left the wallet; anything else means funds may be at risk. */
export function conversionStateMayHoldFunds(state) { return !['waiting', 'expired', 'provider-failed', 'creation-uncertain'].includes(state); }

/** Re-entry guard for the Convert/Confirm taps. Returns true exactly once until release(): the caller must hold the
 * token for the whole create+deposit sequence and never start a second one while it is held or while unresolved. */
export function createReentryGuard() {
  let held = false;
  return {
    enter() { if (held) return false; held = true; return true; },
    release() { held = false; },
    get held() { return held; },
  };
}

/** The only handle "Start a new conversion" may retire: the one bound to the displayed, verified-resolved record, and only while the
 * editable recovery field still holds that same handle. Anything else (unresolved, unbound or edited to a different attempt) returns null. */
export function conversionRetireTarget({resolved,recordHandle,editedHandle}){return resolved===true&&typeof recordHandle==='string'&&recordHandle.length>0&&editedHandle===recordHandle?recordHandle:null;}

/** The provider's limits for the chosen pair, set against what the person typed and what they hold. `range` is the
 * server's {min,max} in plain decimals of the SOURCE asset (max may be null). Nothing here is a fixed number: the
 * minimum moves with the provider, so every sentence says "about" and the range is refreshed with the quote.
 * kind: 'unknown' (no range read), 'ok', 'below-min', 'above-max', 'balance-below-min'. */
/** @param {{source:'sol'|'usdc'|'xmr',dest:'sol'|'usdc'|'xmr',range:{min:string,max:string|null}|null,amountText?:string,balanceAtomic?:string|null}} input */
export function conversionLimitState({ source, dest, range, amountText = '', balanceAtomic = null }) {
  const decimals = CONVERSION_DECIMALS[source];
  const min = range && typeof range.min === 'string' ? decimalToAtomic(range.min, decimals) : null;
  if (min === null || decimals === undefined) return { kind: 'unknown', hint: null, message: null, maxAmount: conversionMax(source, balanceAtomic) };
  const max = range && typeof range.max === 'string' ? decimalToAtomic(range.max, decimals) : null;
  const unit = String(source).toUpperCase(), pair = `${unit} to ${String(dest).toUpperCase()}`;
  const hint = `Minimum for ${pair} is about ${range.min} ${unit}`;
  const spendable = decimalToAtomic(conversionMax(source, balanceAtomic) ?? '', decimals);
  // Max = the balance less the fee reserve, and never above the provider's maximum.
  const capped = spendable !== null && max !== null && spendable > max ? max : spendable;
  const maxAmount = capped !== null && capped >= min ? atomicToDecimal(capped.toString(), decimals) : null;
  if (typeof balanceAtomic === 'string' && /^\d+$/.test(balanceAtomic) && (spendable === null || spendable < min)) {
    return { kind: 'balance-below-min', hint, message: `Your balance is below the minimum for this pair (about ${range.min} ${unit}).`, maxAmount: null };
  }
  const amount = amountText ? decimalToAtomic(amountText, decimals) : null;
  if (amount !== null && amount > 0n && amount < min) return { kind: 'below-min', hint, message: `Minimum for ${pair} is about ${range.min} ${unit}.`, maxAmount };
  if (amount !== null && max !== null && amount > max) return { kind: 'above-max', hint, message: `Maximum for ${pair} is about ${range.max} ${unit}.`, maxAmount };
  return { kind: 'ok', hint, message: null, maxAmount };
}
