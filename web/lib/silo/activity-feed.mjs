/** One Activity list for the sources the wallet can show. Pure functions only: no network, no storage writes except the
 * harmless filter preference. Inputs are rows the wallet already holds (the bounded Solana page it already reads, the
 * Monero history it already reads, and saved Silo swap receipts kept in this browser). */
import {siloUnits} from './amounts.mjs';
import {reverseReturnCopy} from './atomic-reverse-return.mjs';

export const ACTIVITY_FILTER_KEY = 'silo-activity-filter-v1';
export const ACTIVITY_CHAINS = ['all', 'sol', 'xmr'];
export const ACTIVITY_TYPES = ['all', 'sent', 'received', 'swap'];
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const short = (mint) => `${mint.slice(0, 4)}…${mint.slice(-4)}`;
const symbol = (mint) => (mint === SOL_MINT ? 'SOL' : mint === USDC_MINT ? 'USDC' : short(mint));
const signed = (value, places) => `${value.startsWith('-') ? '−' : '+'}${siloUnits(value.replace(/^-/, ''), places)}`;

/** @returns {{chain:string,type:string}} defaults to All / All on any unreadable value. */
export function readActivityFilter(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(ACTIVITY_FILTER_KEY) ?? 'null');
    if (parsed && ACTIVITY_CHAINS.includes(parsed.chain) && ACTIVITY_TYPES.includes(parsed.type)) return {chain: parsed.chain, type: parsed.type};
  } catch { /* fall through to the default */ }
  return {chain: 'all', type: 'all'};
}
export function writeActivityFilter(storage, filter) {
  try { storage.setItem(ACTIVITY_FILTER_KEY, JSON.stringify({chain: filter.chain, type: filter.type})); } catch { /* a preference only */ }
}

/** Solana rows from the bounded finalized page. Asset, direction and amount come from ONE observation: a single decoded SOL transfer whose
 * instruction amount is used (never the fee-inclusive balance change). Anything mixed, multi-transfer, self, token, unresolved or only a
 * fee gets neutral words and no amount. A fee is called paid by this wallet only when the receipt verified that (ownerPaidFee === true). */
export function solanaItems(page) {
  if (!page) return [];
  const cluster = page.network === 'devnet' ? '?cluster=devnet' : '';
  return page.rows.map((row) => {
    const transfers = Array.isArray(row.transfers) ? row.transfers : [];
    const net = row.nativeNetRaw;
    const tokenActivity = transfers.some((entry) => entry.asset === 'token') || (Array.isArray(row.tokenDeltas) && row.tokenDeltas.length > 0);
    const only = transfers.length === 1 && !tokenActivity ? transfers[0] : null;
    const single = row.status === 'finalized' && row.classification === 'transfer' && only && only.asset === 'SOL' && (only.direction === 'sent' || only.direction === 'received')
      && typeof only.amountRaw === 'string' && /^[0-9]+$/.test(only.amountRaw) && only.amountRaw !== '0' ? only : null;
    const feeOnly = row.status === 'finalized' && transfers.length === 0 && !tokenActivity && row.ownerPaidFee === true && typeof net === 'string' && /^-[0-9]+$/.test(net)
      && typeof row.networkFeeRaw === 'string' && /^[0-9]+$/.test(row.networkFeeRaw) && BigInt(net.slice(1)) === BigInt(row.networkFeeRaw) && BigInt(row.networkFeeRaw) > 0n;
    let type = 'other', neutral = null;
    if (row.classification === 'jupiter-unverified') type = 'swap';
    else if (row.status !== 'finalized') type = 'other';
    else if (single) type = single.direction;
    else if (feeOnly) neutral = 'fee';
    else if (tokenActivity && !transfers.some((entry) => entry.asset === 'SOL') && transfers.filter((entry) => entry.asset === 'token').length <= 1 && transfers.length <= 1) neutral = 'token';
    else neutral = 'mixed';
    const title = row.status === 'failed' ? 'Failed transaction'
      : row.status === 'receipt-unavailable' ? 'Receipt unavailable'
      : row.status === 'unknown' ? 'Unknown transaction details'
      : type === 'swap' ? 'Swap · details unverified'
      : neutral === 'token' ? 'Token activity' : neutral === 'fee' ? 'Fee' : neutral === 'mixed' ? 'Wallet activity'
      : type === 'sent' ? 'Sent' : type === 'received' ? 'Received' : 'Other on-chain activity';
    if (row.status !== 'finalized' || type === 'swap') neutral = null;
    const amount = single ? `${siloUnits(single.amountRaw, 9)} SOL` : null;
    return {
      id: row.signature, chain: 'sol', type, when: row.blockTime === null ? null : row.blockTime * 1000, title,
      href: `https://explorer.solana.com/tx/${row.signature}${cluster}`,
      neutral, amount, problem: row.status === 'failed' ? 'failed' : row.status === 'finalized' ? null : 'details',
      detail: neutral === 'token' ? 'Solana · public · token activity' : single ? 'Solana · public · decoded SOL transfer' : 'Solana · public · details not fully resolved',
      value: single ? `${single.direction === 'sent' ? '−' : '+'}${amount}` : null,
      state: row.status === 'finalized' ? 'ok' : row.status === 'failed' ? 'danger' : 'held',
      // Receipt availability is separate from confirmation: the signature came from a finalized page even when its details did not load.
      word: row.status === 'finalized' ? 'Confirmed' : row.status === 'failed' ? 'Failed' : 'Details unavailable',
    };
  });
}

/** Saved Silo swap receipts kept in this browser (readSiloManagedHistory rows). */
export function swapItems(receipts, owner) {
  return receipts.filter((receipt) => receipt?.journal?.review?.contract?.owner === owner).map((receipt) => {
    const journal = receipt.journal, contract = journal.review.contract, status = receipt.outcome?.status;
    const failed = status === 'failed';
    const swapState = failed ? 'failed' : status === 'finalized' ? 'finalized' : status ? 'in-progress' : 'started';
    return {
      id: journal.signature, chain: 'sol', type: 'swap', pair: `${symbol(contract.inputMint)} to ${symbol(contract.outputMint)}`, href: `https://explorer.solana.com/tx/${journal.signature}`, problem: failed ? 'failed' : null, when: Number.isSafeInteger(journal.createdAt) ? journal.createdAt : null,
      swapState, title: failed ? 'Swap failed' : 'Swap', detail: `Solana · ${symbol(contract.inputMint)} to ${symbol(contract.outputMint)} · saved on this device`,
      value: null, state: failed ? 'danger' : status === 'finalized' ? 'ok' : 'held', word: failed ? 'Failed' : status === 'finalized' ? 'Confirmed' : 'Saved on this device',
    };
  });
}

/** Monero history rows (SiloXmrHistoryRow). The time comes from `row.timestamp` (seconds, the mined block's time) when the history carries it.
 * Until it does, a mined row's time is estimated from its confirmations (about 120 seconds a block) counted back from `readAt`, the moment the
 * history was read, and an unmined pending row is placed at `readAt`. A row with neither stays undated and sorts last. */
export const XMR_BLOCK_SECONDS = 120;
function moneroTime(row, readAt) {
  if (Number.isSafeInteger(row.timestamp) && row.timestamp > 0) return row.timestamp * 1000;
  if (row.height !== null && row.height !== undefined && Number.isSafeInteger(row.confirmations) && row.confirmations >= 1) return readAt - (row.confirmations - 1) * XMR_BLOCK_SECONDS * 1000;
  if ((row.height === null || row.height === undefined) && row.status === 'pending') return readAt;
  return null;
}
export function moneroItems(rows, decimals = 12, readAt = Date.now()) {
  if (!rows) return [];
  return rows.map((row) => {
    const kind = row.selfTransfer ? 'self' : row.balanceDelta !== null ? 'delta' : row.outgoing !== null && row.outgoing !== '0' ? 'out' : 'in';
    const value = row.selfTransfer ? `−${siloUnits(row.fee, decimals)}`
      : row.balanceDelta !== null ? signed(row.balanceDelta, decimals)
      : kind === 'out' ? `−${siloUnits(row.outgoing, decimals)}` : `+${siloUnits(row.incoming, decimals)}`;
    const failed = row.status === 'reported-failed' || row.status === 'expired';
    const type = kind === 'out' ? 'sent' : kind === 'in' ? 'received' : kind === 'delta' ? (row.balanceDelta.startsWith('-') ? 'sent' : 'received') : 'other';
    const title = row.status === 'reported-failed' ? 'Reported failed by the node · check again'
      : row.status === 'expired' ? 'Reported expired · recovery may still be held'
      : kind === 'delta' ? 'Account balance change' : kind === 'self' ? 'Moved within this wallet' : kind === 'in' ? 'Received' : 'Sent';
    const confirmed = row.confirmations !== null && row.confirmations >= 10;
    return {
      id: row.id, chain: 'xmr', type, when: moneroTime(row, readAt), title, kind,
      amount: kind === 'self' ? (row.fee ? `${siloUnits(row.fee, decimals)} XMR` : null) : kind === 'delta' ? `${siloUnits(row.balanceDelta.replace(/^-/, ''), decimals)} XMR` : `${siloUnits(kind === 'out' ? row.outgoing : row.incoming, decimals)} XMR`,
      problem: row.status === 'reported-failed' ? 'failed' : row.status === 'expired' ? 'expired' : null, detail: `Monero · ${row.confirmations ?? 'not checked'} confirmations`,
      value: `${value} XMR`, state: failed ? 'held' : confirmed ? 'ok' : 'held', word: failed ? 'Not confirmed yet' : confirmed ? 'Confirmed' : 'Not confirmed yet',
    };
  });
}

/** Merge, drop duplicates (a saved swap replaces the same chain row by signature), newest first. Undated rows go last, in input order. */
export function mergeActivity(...lists) {
  const byKey = new Map();
  for (const list of lists) for (const item of list) {
    const key = `${item.chain}:${item.id}`, existing = byKey.get(key);
    if (!existing) byKey.set(key, item);
    else if (item.type === 'swap') byKey.set(key, {...item, when: existing.when ?? item.when}); // the saved receipt names the swap; the chain time wins
  }
  return [...byKey.values()].map((item, index) => ({item, index}))
    .sort((a, b) => (b.item.when ?? -1) - (a.item.when ?? -1) || a.index - b.index).map(({item}) => item);
}

export function filterActivity(items, {chain = 'all', type = 'all'} = {}) {
  return items.filter((item) => (chain === 'all' || item.chain === 'both' || item.chain === chain) && (type === 'all' || item.type === type));
}

/** Coverage after loading an older page: counts add up, reasons stay (no repeats), and the paging flags describe the newest page. */
export function combineCoverage(previous, next) {
  const sum = (key) => (previous[key] ?? 0) + (next[key] ?? 0);
  return {
    ...next, scanned: sum('scanned'), parsed: sum('parsed'), unavailable: sum('unavailable'), malformed: sum('malformed'), skippedNewer: sum('skippedNewer'),
    partialReasons: [...new Set([...previous.partialReasons, ...next.partialReasons])],
  };
}

/** Plain-words coverage lines shown beside the merged list. A missing row never proves that a payment did not happen. */
export function coverageNotes(page) {
  if (!page) return [];
  const {coverage} = page, notes = [];
  notes.push('Transactions from about the last 25 seconds may not be listed yet. A row that is missing here does not prove that a payment was not made.');
  if (coverage.skippedNewer > 0) notes.push(`${coverage.skippedNewer} newer ${coverage.skippedNewer === 1 ? 'transaction was' : 'transactions were'} left out on purpose so this page stays consistent. Refresh to include ${coverage.skippedNewer === 1 ? 'it' : 'them'}.`);
  if (coverage.unavailable > 0 || coverage.malformed > 0) notes.push(`${coverage.unavailable + coverage.malformed} listed ${coverage.unavailable + coverage.malformed === 1 ? 'transaction has' : 'transactions have'} details that are unavailable or could not be read.`);
  notes.push('Showing your latest Solana activity. This is not complete history.');
  for (const reason of coverage.partialReasons) if (!notes.includes(reason) && !/bounded provider view/.test(reason)) notes.push(reason);
  return notes;
}

// ---- Timeline (cream Activity): one plain sentence and one status line per row, grouped by the user's own day. Display only. ----

/** Whole days since 1970 for an instant, as the calendar reads in `timeZone` (default: the browser's own zone). */
function localDay(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {timeZone, year: 'numeric', month: 'numeric', day: 'numeric'}).formatToParts(ms);
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  return Date.UTC(get('year'), get('month') - 1, get('day')) / 86400000;
}
/** Left-column label: TODAY, then the weekday for the last six days, then the date, EARLIER when the source gives no time.
 * A time in the future (a clock that runs ahead) reads as TODAY. */
export function timelineLabel(when, now = Date.now(), timeZone) {
  if (!Number.isFinite(when)) return 'EARLIER';
  const diff = localDay(now, timeZone) - localDay(when, timeZone);
  if (diff <= 0) return 'TODAY';
  if (diff < 7) return new Intl.DateTimeFormat('en-US', {timeZone, weekday: 'short'}).format(when).toUpperCase();
  const sameYear = new Intl.DateTimeFormat('en-US', {timeZone, year: 'numeric'}).format(when) === new Intl.DateTimeFormat('en-US', {timeZone, year: 'numeric'}).format(now);
  return new Intl.DateTimeFormat('en-GB', {timeZone, day: 'numeric', month: 'short', ...(sameYear ? {} : {year: 'numeric'})}).format(when).toUpperCase();
}
/** "Updated 14:05" in the user's zone. */
export function updatedLine(at, timeZone) {
  return `Updated ${new Intl.DateTimeFormat('en-GB', {timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(at)}`;
}
const hide = (amount, concealed) => (concealed ? amount.replace(/^\S+/, '••••') : amount);
/** @returns {{sentence:string,status:string}} built only from fields the row already holds. */
export function plainRow(item, {concealed = false} = {}) {
  const amount = item.amount ? hide(item.amount, concealed) : null;
  const privacy = item.chain === 'xmr' ? 'Private.' : 'Public.';
  const network = item.chain === 'xmr' ? 'Monero' : 'Solana';
  let sentence;
  if (item.problem === 'failed' && item.chain === 'xmr') sentence = 'A Monero transaction was reported failed by the node. Check again.';
  else if (item.problem === 'failed') sentence = item.type === 'swap' ? 'A swap failed.' : `A ${network} transaction failed.`;
  else if (item.problem === 'expired') sentence = `A ${network} payment was reported expired.`;
  else if (item.type === 'swap') sentence = item.pair ? (item.swapState === 'finalized' ? `You swapped ${item.pair}.` : item.swapState === 'in-progress' ? `Swap in progress: ${item.pair}.` : `Swap started: ${item.pair}.`) : 'A swap used this wallet.';
  else if (item.neutral === 'token') sentence = 'Token activity on this Solana wallet.';
  else if (item.neutral === 'fee') sentence = 'A network fee was paid by this wallet.';
  else if (item.neutral === 'mixed') sentence = 'Activity on this Solana wallet.';
  else if (item.type === 'sent') sentence = amount ? `You sent ${amount}.` : 'You sent a payment.';
  else if (item.type === 'received') sentence = amount ? `You received ${amount}.` : 'You received a payment.';
  else if (item.kind === 'self') sentence = 'You moved funds within this wallet.';
  else sentence = `Something happened on this ${network} wallet.`;
  let status;
  if (item.type === 'swap' && !item.pair && !item.problem) status = item.href ? `${privacy} Open in a Solana explorer to see details.` : privacy;
  else if (item.problem === 'expired') status = `Expired. Recovery may still be held. ${privacy}`;
  else if (item.problem === 'failed' && item.chain === 'xmr') status = `Reported failed by the node, check again. ${privacy}`;
  else if (item.state === 'ok') status = `Done. ${privacy}`;
  else if (item.state === 'danger') status = `Failed. ${privacy}`;
  else if (item.chain === 'xmr') status = `Waiting for confirmations. ${privacy}`;
  else status = `${item.word === 'Saved on this device' ? 'Saved on this device' : 'Details unavailable'}. ${privacy}`;
  const linked = item.type === 'swap' && !item.pair && !item.problem && item.href ? {href: item.href, text: 'Open in a Solana explorer to see details.'} : null;
  return {sentence, status, link: linked};
}

/** "14:05" in the user's zone for a protocol deadline given in seconds, or null. */
function deadline(seconds, timeZone) {
  if (!Number.isFinite(seconds)) return null;
  return new Intl.DateTimeFormat('en-GB', {timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(seconds * 1000);
}
/** Open swaps from the pending store (PR 704) as NOW rows. The words reuse the swap card's own wording and always keep the dependency on the
 * maker and the deadlines the person must act before. The detailed swap card stays visible under these rows. */
export function pendingItems(list, now = Date.now(), timeZone) {
  return (list ?? []).map((item, index) => {
    if (item.dir === 'sol-xmr') {
      const stage = ['start', 'confirm', 'pending', 'collect', 'refund'].includes(item.stage ?? '') ? item.stage : 'confirm';
      const words = reverseReturnCopy({stage, canLeave: stage !== 'start', confirmBy: item.confirmBy ?? null, returnBy: item.returnBy ?? null,
        late: Number.isFinite(item.confirmBy) && now / 1000 >= item.confirmBy, claimed: item.claimed === true}, {now: new Date(now)});
      const facts = (words.facts ?? []).filter(([, value]) => value && value !== '-').map(([label, value]) => ` ${label}: ${value}.`).join('');
      // Qualified by stage: only a refund that is not yet eligible waits on the maker. An eligible refund needs no maker cooperation, and after the
      // maker claims, collecting the XMR depends on this swap's recovery record, not on the maker.
      const depends = stage === 'collect' ? ' Collecting your XMR uses this swap\'s recovery record on this device or backup.'
        : stage === 'refund' ? (item.refundEligible === false ? ' The refund opens when the maker\'s claim window closes; if the maker claims first, Silo collects your XMR instead.' : ' You can refund when eligible.') : '';
      return {id: `swap:${item.swapId}`, chain: 'both', type: 'swap', now: true, when: null, index, dir: 'sol-xmr', state: 'held',
        sentence: `Moving ${item.sol} SOL to private.`, status: `${words.title}.${facts}${depends}`};
    }
    const refund = item.phase === 'awaiting-refund' || item.phase === 'recovering';
    const sendBy = deadline(item.sendBy, timeZone), claimBy = deadline(item.claimBy, timeZone);
    let status;
    if (item.phase === 'awaiting-xmr') status = `Your step: send the XMR${sendBy ? ` by ${sendBy}` : ''}.`;
    else if (refund) status = 'Your XMR comes back only if the maker returns the SOL lock. This depends on the maker. Open and unlock Silo to continue.';
    else if (item.phase === 'stopped') status = 'Stopped: the maker cancelled this offer. Do not send more XMR. If you did send, it comes back only if the maker returns the SOL lock.';
    else if (item.phase === 'waiting-maker' || item.phase === 'checking-lock') status = 'Starting your swap. This depends on the maker locking the SOL.';
    else status = `Your SOL is on its way.${claimBy ? ` Open and unlock Silo before ${claimBy} so it can claim.` : ''}`;
    return {id: `swap:${item.swapId}`, chain: 'both', type: 'swap', now: true, when: null, index, dir: 'xmr-sol', state: 'held',
      sentence: `Moving ${item.xmr} XMR to SOL.`, status};
  });
}

/** NOW first, then one group per day label in the order the rows come (newest first; undated rows are last under EARLIER). */
export function groupTimeline(pending, items, {now = Date.now(), timeZone, concealed = false} = {}) {
  const groups = [];
  const add = (label, item, text) => {
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push({item, ...text});
    else groups.push({label, rows: [{item, ...text}]});
  };
  for (const item of pending) add('NOW', item, {sentence: item.sentence, status: item.status, link: null});
  for (const item of items) add(timelineLabel(item.when, now, timeZone), item, plainRow(item, {concealed}));
  return groups;
}

/** Refresh re-reads every source and reports which ones failed or did not run, so one failure never hides the others. `read` may throw, reject or
 * return. `updated` is true only when every source answered 'updated'. */
export const REFRESH_TIMEOUT_MS = 120_000;
/** One outcome per source: only 'updated' counts as updated. false or 'failed' (or a throw) is failed; anything else (undefined, 'skipped',
 * or no answer within the timeout, e.g. a long Monero sync that keeps running) is reported as not refreshed this time. */
export async function refreshSources(sources, clock = Date.now, timeoutMs = REFRESH_TIMEOUT_MS) {
  const results = await Promise.all(sources.map(async (source) => {
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
    try {
      const outcome = await Promise.race([Promise.resolve().then(() => source.read()), late]);
      if (outcome === 'updated') return null;
      return outcome === 'failed' || outcome === false ? {label: source.label, outcome: 'failed'} : {label: source.label, outcome: 'skipped'};
    } catch { return {label: source.label, outcome: 'failed'}; } finally { clearTimeout(timer); }
  }));
  const failed = results.filter((entry) => entry?.outcome === 'failed').map((entry) => entry.label);
  const skipped = results.filter((entry) => entry?.outcome === 'skipped').map((entry) => entry.label);
  return {at: clock(), failed, skipped, updated: failed.length === 0 && skipped.length === 0};
}
