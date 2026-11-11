// Admission limits that tell paid swaps from unpaid requests (review 10 Nov 2026, F-12 / SEC-P-05).
//
// Before: the 0.3 XMR daily limit summed every swap created today, paid or not, so six unpaid requests shut the swap for everyone until
// the next UTC day. Now there are three separate things:
// - the PAID daily volume counts only swaps where the counterparty committed value (see isCommitted);
// - requests that have not committed yet ("unpaid") are bounded by their own small counters: per UTC day, at the same time, and per
//   address, so they can neither use up the paid allowance nor drain gas without limit;
// - the open-swap cap still counts everything that holds maker float, paid or not.
// To keep the daily ceiling literally true, the XMR amounts of the unpaid swaps that are open right now are RESERVED against the paid
// allowance (they may turn paid); a reservation ends when that swap is done, so it never lasts longer than the swap itself.
// Pure: no I/O, no clock except the `now` argument.

/**
 * Value is committed by the counterparty when:
 * - XMR -> SOL: the maker saw the full XMR payment mined (record.committedAt, set by makerStep), or the swap got past that point (ready, claimed, swept);
 * - SOL -> XMR: the user's SOL is locked in the escrow (record.seenPda), or the maker already sent XMR / committed its claim.
 * Older records written before `committedAt` existed are recognised by the later fields, so no migration is needed.
 */
export function isCommitted(s) {
  if (!s) return false;
  if (s.direction === 'sol-xmr') return !!(s.seenPda || s.xmrSendTxid || s.commitSig || (s.commitAttempts?.length ?? 0) > 0 || s.claimSig || (s.claimAttempts?.length ?? 0) > 0);
  return !!(s.committedAt || s.readySig || (s.readyAttempts?.length ?? 0) > 0 || s.sweepTxids || s.claimSig);
}

/** The address the requester controls: the Solana claimer (XMR -> SOL) or refunder (SOL -> XMR). */
export const requesterOf = (s) => (s.direction === 'sol-xmr' ? s.refunder : s.claimer) ?? null;

const dayOf = (iso) => String(iso ?? '').slice(0, 10);

/**
 * @param swaps every swap record on disk
 * @param opts { now: Date, isOpenCounted(s): boolean (the record counts toward the open cap, i.e. not done and not a lock proven never landed) }
 * @returns { paidTodayAtomic, reservedAtomic, unpaidOpen: record[], unpaidToday }
 */
export function tally(swaps, { now = new Date(), isOpenCounted = (s) => !s.done } = {}) {
  const day = now.toISOString().slice(0, 10);
  let paidTodayAtomic = 0n, reservedAtomic = 0n, unpaidToday = 0;
  const unpaidOpen = [];
  for (const s of swaps) {
    if (isCommitted(s)) {
      // 709-M1: booked to the day value was FIRST committed (committedAt, set in both directions), not the day the request was created, so a
      // request made yesterday and funded today counts today. A legacy record that looks committed but has no timestamp is counted
      // conservatively: on its creation day, and also today while it is still open (it may well have been funded today).
      if (s.committedAt) { if (dayOf(s.committedAt) === day) paidTodayAtomic += BigInt(s.xmrAtomic); }
      else if (dayOf(s.createdAt) === day || !s.done) paidTodayAtomic += BigInt(s.xmrAtomic);
      continue;
    }
    if (dayOf(s.createdAt) === day) unpaidToday += 1;
    if (isOpenCounted(s)) { unpaidOpen.push(s); reservedAtomic += BigInt(s.xmrAtomic); }
  }
  return { paidTodayAtomic, reservedAtomic, unpaidOpen, unpaidToday };
}

/** Inputs for capsAdmission (maker-reverse.mjs) for a new request by `requester` (may be null at quote time). */
export function limitInputs(swaps, requester, opts) {
  const t = tally(swaps, opts);
  return {
    lockedTodayAtomic: t.paidTodayAtomic + t.reservedAtomic,
    paidTodayAtomic: t.paidTodayAtomic,
    unpaid: { openCount: t.unpaidOpen.length, todayCount: t.unpaidToday, addressOpenCount: requester ? t.unpaidOpen.filter((s) => requesterOf(s) === requester).length : 0 },
  };
}

/** Limits from the environment, with safe defaults. Tests and operators may override; every value is a plain count. */
export function unpaidCaps(env = {}) {
  const n = (v, d) => { const x = Number(v ?? d); return Number.isInteger(x) && x >= 0 ? x : d; };
  return {
    maxUnpaidOpen: n(env.MAX_UNPAID_OPEN, 2),                // at most this many unpaid requests at once; with the default open cap of 3 one slot is always left for a paying user
    maxUnpaidPerAddress: n(env.MAX_UNPAID_PER_ADDRESS, 1),   // one unpaid request per Solana address at a time
    maxUnpaidPerDay: n(env.MAX_UNPAID_PER_DAY, 48),          // bounds the gas the maker can lose to requests that never pay (about 0.05 SOL at 0.001 SOL each)
  };
}
