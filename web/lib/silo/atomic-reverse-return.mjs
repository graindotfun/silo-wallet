// Leave and return for "Swap SOL to XMR, no bridge" (design: prototypes/xmr-sol-atomic-swap/SOL_TO_XMR_PAGE_OPTIONAL.md).
// Pure and display-only: it decides what the screen may truthfully say about closing the page. It never moves money, holds no key and
// changes no rule of the swap (reverse-core.mjs, bob-flow.mjs and the driver are untouched). Silo cannot confirm the XMR for the user
// while it is closed, because only this wallet's own signature (set_ready) releases the SOL to the maker. Every sentence below must hold
// in the worst case of the rules: the refund after a ready opens at max(t1, c + 1 h) + 300 s, i.e. about 5 h 05 after the start with the
// agreed timelocks (t0 = start + 3 h, t1 = t0 + 2 h), and more than 6 h with a late maker commit, plus the time to settle.
import { REVERSE_BACKUP, reverseStageCopy } from './atomic-reverse-terms.mjs';
export const RETURN_MARGIN_S = 300;      // = MARGIN (swap-core): the last second a ready may be sent is t0 - this
export const RETURN_ADVICE_S = 1800;     // come back this long before that: unlocking, one Monero check and the signature take minutes
export const RETURN_STAGES = Object.freeze(['start', 'confirm', 'pending', 'collect', 'refund']);
// Phases in which the driver has OBSERVED the ready on chain (nextReverseAction reads p.ready and answers await-maker-claim) or is past it.
const OBSERVED_PHASES = new Set(['await-claim', 'sweeping', 'received']);
// Phases after the maker's claim: the SOL is the maker's, and only collecting the XMR is left.
const CLAIMED_PHASES = new Set(['sweeping', 'received']);

const readyMayBeOut = (r) => r?.branch === 'ready' || Boolean(r?.readyAttemptAt) || Boolean(r?.readyAttempts?.length);

/**
 * @param {{t0?:number,lockSeen?:boolean,branch?:string,readyAttemptAt?:number,readyAttempts?:unknown[],refundAttemptAt?:number}} record
 * @param {{phase?:string}} view  the driver's phase for this record (may be empty)
 * @param {number} nowSeconds     the user's clock, seconds
 * @returns {{stage:'start'|'confirm'|'pending'|'collect'|'refund',canLeave:boolean,confirmBy:number|null,returnBy:number|null,late:boolean,claimed:boolean}}
 * `collect` (the maker may claim; after its claim only collecting the XMR is left) only once the ready is OBSERVED. A ready attempt is stored before it is broadcast, so an attempt alone
 * is `pending`: if the broadcast failed it never lands, and only a page that is open (or reopened in time) can send it again.
 */
export function reverseReturnPlan(record, view, nowSeconds) {
  const raw = record?.t0, t0 = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : NaN;
  const confirmBy = Number.isSafeInteger(t0) && t0 > RETURN_MARGIN_S ? t0 - RETURN_MARGIN_S : null; // null or 0 is never a time
  const returnBy = confirmBy === null ? null : confirmBy - RETURN_ADVICE_S;
  const phase = view?.phase ?? '';
  const late = confirmBy !== null && Number.isFinite(nowSeconds) && nowSeconds >= confirmBy;
  const claimed = CLAIMED_PHASES.has(phase);
  const out = (stage, canLeave) => ({ stage, canLeave, confirmBy, returnBy, late, claimed });
  // The driver's current on-chain reading wins over an older refund marker: once the maker has claimed (sweeping) or the XMR arrived (received),
  // a refund attempt saved earlier no longer describes the swap (Astra 756 low).
  if (phase === 'refunding') return out('refund', true);
  if (CLAIMED_PHASES.has(phase)) return out('collect', true);
  if (record?.branch === 'refund' || record?.refundAttemptAt) return out('refund', true);
  // The lock is signed by this page, so the page is needed until the escrow is seen on chain.
  if (!record?.lockSeen) return out('start', false);
  if (OBSERVED_PHASES.has(phase)) return out('collect', true);
  if (readyMayBeOut(record)) return out('pending', true);
  if (late) return out('refund', true); // a ready can no longer be sent: only the refund is left
  return out('confirm', true);
}

const validDate = (d) => d instanceof Date && Number.isFinite(d.getTime());
const hm = (seconds, now = new Date()) => {
  if (!Number.isFinite(seconds)) return null;
  const ref = validDate(now) ? now : new Date(), d = new Date(seconds * 1000), t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === ref.toDateString() ? `${t} today` : `${t} ${d.toLocaleDateString([], { weekday: 'short' })}`;
};
export const BACKUP = REVERSE_BACKUP;
// A swap runs for hours: the refund deadline is about 3 h after the start (t0), and the lock comes within minutes of it. A device clock more than this
// far before "Confirm by" (or an invalid one) cannot be inside the swap window, so no relative wording is shown (Astra 759 L1).
const MAX_LEAD_S = 4 * 3600;
/** The one time the confirm stage may show, chosen once for every screen (swap screen, Home and Activity cards, compact and detailed):
 * "Come back by" while that suggested time is still ahead, otherwise "Latest possible" (Confirm by) while that is ahead, otherwise nothing.
 * A time that has passed is never shown as "before"; missing, unsorted (suggested after latest), non-finite inputs, an invalid clock or a clock far outside the swap window give no time.
 * `suggestedPassed` is true only when a valid suggested time exists and has passed.
 * @returns {{kind:'comeBack'|'latest'|null,text:string|null,suggestedPassed:boolean}} */
export function reverseConfirmTime(plan, { now = new Date() } = {}) {
  const none = { kind: null, text: null, suggestedPassed: false };
  if (!plan || !validDate(now)) return none;
  const nowS = now.getTime() / 1000, ok = (s) => typeof s === 'number' && Number.isFinite(s) && s > 0;
  const sug = ok(plan.returnBy) ? plan.returnBy : null, last = ok(plan.confirmBy) ? plan.confirmBy : null;
  if (last === null || (sug !== null && sug > last)) return none;
  if (nowS < last - MAX_LEAD_S) return none;
  if (sug !== null && nowS < sug) return { kind: 'comeBack', text: hm(sug, now), suggestedPassed: false };
  if (nowS < last) return { kind: 'latest', text: hm(last, now), suggestedPassed: sug !== null };
  return none;
}

/** The words for one stage, shared by the swap screen and the Home/Activity card. `line` is the one short visible sentence; `more` holds the
 * rest (late behaviour, the recovery record, the backup), from the shared terms module, for a closed-by-default "What if I am late or lose this record". */
export function reverseReturnCopy(plan, { now = new Date() } = {}) {
  const t = reverseConfirmTime(plan, { now }), last = hm(plan?.confirmBy, now), c = reverseStageCopy(plan, t, last);
  const facts = plan?.stage === 'confirm' ? (t.kind === 'comeBack' ? [['Come back by', t.text], ['Latest possible', last ?? '-']] : t.kind === 'latest' ? [['Latest possible', t.text]] : [])
    : plan?.stage === 'pending' ? [['Latest possible', last ?? '-']] : [];
  return { title: c.title, line: c.line, facts, more: c.more };
}
