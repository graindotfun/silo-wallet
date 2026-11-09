// Maker decision plumbing with every side effect injected, so the wallet-response -> scan -> decision path
// and the queue/RPC failure paths are tested deterministically (Astra round 2, H4 and H5).
import { makerNext } from '../client/swap-core.mjs';

const XMR_ADDRESS = /^[48][1-9A-HJ-NP-Za-km-z]{94}$/;
/**
 * Start-up checks that never stop refunds (Astra round 4, N1). A failed check closes the gate: no new quotes or
 * swaps and no XMR sweeps, while the loop keeps refunding expired escrows from Solana alone. Config problems keep
 * it closed until a fixed restart; a wallet-rpc outage is retried on every check. A definitive answer is cached.
 * caps and limits are in atomic units; validate(address) is monero-wallet-rpc validate_address.
 */
export function createStartGate({ network, sweepTo, token, caps, limits, validate }) {
  const fixed = [];
  if (network === 'mainnet') {
    if (!sweepTo || !XMR_ADDRESS.test(sweepTo)) fixed.push('sweep-address-missing-or-malformed');
    if (caps.perSwap > limits.perSwap || caps.perDay > limits.perDay || caps.open > limits.open) fixed.push('caps-above-approved');
    if (!token || token.length < 32) fixed.push('api-token-missing');
  }
  let verdict = fixed.length ? { open: false, reasons: fixed } : sweepTo ? null : { open: true, reasons: [] };
  let last = verdict ?? { open: false, reasons: ['sweep-address-not-yet-validated'] };
  return {
    isOpen: () => last.open,
    async check() {
      if (verdict) return (last = verdict);
      try {
        const v = await validate(sweepTo);
        verdict = v?.valid && v.nettype === network && !v.integrated ? { open: true, reasons: [] } : { open: false, reasons: ['sweep-address-invalid-for-' + network] };
        return (last = verdict);
      } catch { return (last = { open: false, reasons: ['wallet-rpc-unavailable'] }); }
    },
  };
}

/**
 * get_transfers answer -> what the maker may count. Only outputs spendable without an extra lock count
 * toward the amount (H4): a far-future unlock_time would buy liquid SOL with XMR the maker cannot sweep.
 * Confirmations are the minimum over everything seen (pool included), so a pending or locked output can
 * only delay ready, never trigger it.
 */
export function usableFromTransfers(t) {
  const all = [...(t?.in ?? []), ...(t?.pool ?? [])];
  if (!all.length) return null;
  const usable = (t.in ?? []).filter((i) => Number(i.unlock_time ?? 0) === 0);
  return { atomic: usable.reduce((x, i) => x + BigInt(i.amount), 0n).toString(), confirmations: Math.min(...all.map((i) => i.confirmations ?? 0)) };
}

/**
 * wallet-rpc holds one open wallet at a time, so access is serialized. One failure must not poison the
 * queue (H5): each job runs after the previous one settles, whatever its outcome, and its own error goes
 * only to its own caller.
 */
export function createWalletQueue(W, password) {
  let chain = Promise.resolve();
  return (filename, create, fn) => {
    const run = chain.then(async () => {
      try { await W('close_wallet'); } catch {}
      try { await W('open_wallet', { filename, password }); } catch { await create(); }
      await W('refresh');
      try { return await fn(); } finally { await W('close_wallet').catch(() => {}); }
    });
    chain = run.catch(() => {});
    return run;
  };
}

/**
 * One maker pass for one swap. deps = { readSwap(), readRevealed(which, point, cursor, onCursor), chainNow(),
 * scanXmr(s), sendReady(), sendRefund(), sweep(s, secret), store(s), log(e) }.
 * Monero is consulted only for an escrow that is still open and not ready; an expired escrow is refunded
 * without depending on Monero at all (H5).
 */
export async function makerStep(s, deps) {
  const pda = await deps.readSwap();
  let outcome = null, cursorMoved = false;
  if (!pda) {
    s.histCursor ??= {};
    const read = (which, point) => deps.readRevealed(which, point, s.histCursor[which] ?? null, (c) => { if ((s.histCursor[which] ?? null) !== c) { s.histCursor[which] = c; cursorMoved = true; } });
    const c = await read('claim', s.A);
    const r = c ? null : await read('refund', s.B);
    outcome = c ? { kind: 'claimed', secret: c.secretHex, sig: c.sig } : r ? { kind: 'refunded', sig: r.sig } : null;
  }
  const now = await deps.chainNow();
  const xmr = pda && !pda.ready && now < pda.t1 ? await deps.scanXmr(s) : null;
  const a = makerNext({ now, lockedAt: s.lockedAt, pda, outcome, xmr, xmrSwept: !!s.sweepTxids, expectedAtomic: s.xmrAtomic, requiredConfirmations: s.confirmations });
  if (a.action === 'wait') { if (cursorMoved) deps.store(s); return a; }   // the history position survives a restart (H7)
  // A closed start gate holds the sweep (the revealed secret stays on chain); refunds and ready still run (N1).
  if (a.action === 'sweep-xmr' && deps.sweepAllowed && !deps.sweepAllowed()) { if (cursorMoved) deps.store(s); deps.log({ event: 'sweep-held', swapId: s.swapId }); return { action: 'wait', reason: 'sweep-held' }; }
  deps.log({ event: 'action', swapId: s.swapId, action: a.action, xmr, ready: pda?.ready ?? null });
  if (a.action === 'set-ready') s.readySig = (await deps.sendReady()).sig;
  if (a.action === 'refund') s.refundSig = (await deps.sendRefund()).sig;
  if (a.action === 'sweep-xmr') { const t = await deps.sweep(s, a.secret); if (t) { s.sweepTxids = t; s.claimSig = outcome.sig; } }
  if (a.action === 'done') s.done = a.result;
  deps.store(s);
  deps.log({ event: 'state', swapId: s.swapId, readySig: s.readySig, refundSig: s.refundSig, sweepTxids: s.sweepTxids, done: s.done });
  return a;
}
