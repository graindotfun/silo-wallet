// Bounded priority fee for the maker's own secret-bearing or deadline-racing Solana transactions (review 10 Nov 2026, SEC-P-09).
// The escrow program does not inspect other instructions in the transaction, so a ComputeBudget instruction is accepted (the maker already
// sends setComputeUnitLimit). The price (micro-lamports per compute unit) is read from getRecentPrioritizationFees for the ESCROW ACCOUNT ONLY:
// that request carries an address, never the message, so the secret in the instruction data is never shown to an RPC before sending.
// Bounds: a floor used when the RPC cannot answer, a ceiling a fee spike can never exceed, and an absolute hard cap in code that
// configuration cannot raise. Worst case at the hard cap: 60,000 CU x 1,000,000 micro-lamports = 60,000 lamports (0.00006 SOL) per attempt.
import { ComputeBudgetProgram } from '@solana/web3.js';

export const HARD_CAP_MICROLAMPORTS = 1_000_000;
export const DEFAULTS = { floor: 5_000, ceiling: 200_000, percentile: 75 };   // default worst case 60,000 x 200,000 / 1e6 = 12,000 lamports

export function priorityFeeConfig(env = {}) {
  const n = (v, d) => { const x = Number(v ?? d); return Number.isFinite(x) && x >= 0 ? Math.floor(x) : d; };
  const ceiling = Math.min(n(env.PRIORITY_FEE_CEILING_MICROLAMPORTS, DEFAULTS.ceiling), HARD_CAP_MICROLAMPORTS);
  const floor = Math.min(n(env.PRIORITY_FEE_FLOOR_MICROLAMPORTS, DEFAULTS.floor), ceiling);
  const percentile = Math.min(100, Math.max(1, n(env.PRIORITY_FEE_PERCENTILE, DEFAULTS.percentile)));
  return { floor, ceiling, percentile, enabled: env.PRIORITY_FEE !== 'off' };
}

/** Pure: samples = [{ slot, prioritizationFee }] (or plain numbers). Returns the clamped price; empty or garbage input gives the floor. */
export function pickPriorityFee(samples, { floor, ceiling, percentile }) {
  const v = (Array.isArray(samples) ? samples : []).map((x) => Number(typeof x === 'number' ? x : x?.prioritizationFee)).filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  const raw = v.length ? v[Math.min(v.length - 1, Math.ceil(v.length * percentile / 100) - 1)] : 0;
  return Math.min(ceiling, Math.max(floor, Math.floor(raw)));
}

/** One price per attempt, read BEFORE the blockhash so the safety checks that follow it stay synchronous. Never throws: any RPC failure gives the floor. */
export function createFeeSource(cfg, conn) {
  return async function microLamportsFor(escrowPda) {
    if (!cfg || cfg.enabled === false) return 0;
    try {
      const rows = await Promise.race([conn.getRecentPrioritizationFees({ lockedWritableAccounts: [escrowPda] }), new Promise((_, rej) => setTimeout(() => rej(new Error('fee-timeout')), 3000).unref?.())]);
      return pickPriorityFee(rows, cfg);
    } catch { return pickPriorityFee([], cfg); }
  };
}

/** The ComputeBudget instructions: limit, then (when the price is above zero) the price. */
export function computeBudgetIxs(units, microLamports = 0) {
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units })];
  const price = Math.min(HARD_CAP_MICROLAMPORTS, Math.max(0, Math.floor(microLamports)));
  if (price > 0) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }));
  return ixs;
}
