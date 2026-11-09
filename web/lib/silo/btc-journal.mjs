// Silo Bitcoin send journal (H3) and receive-index memory.
// The signed bytes, txid and intent are written to durable storage BEFORE a broadcast is attempted and stay until the provider returns the same txid,
// the network reports the transaction confirmed, a confirmed spend by that same transaction is seen, or the person clears it by hand.
// Refusals, conflicts and negative lookups never release it. While one is unresolved no other send can be prepared or signed, so an ambiguous broadcast
// (a timeout after the provider accepted) can never turn into a second payment from other coins. Only the SAME transaction may be
// rebroadcast. A timeout is never reported as "nothing was sent". Storage is injected (localStorage in the browser). No key or phrase is ever stored here.
import * as btc from '@scure/btc-signer';
import {SILO_BTC_NETWORKS} from './btc.mjs';

const fail = (message, reason) => Object.assign(Error(message), {siloBtcJournal: reason});
const key = network => { if (!SILO_BTC_NETWORKS.includes(network)) throw fail('Unsupported Bitcoin network.', 'network'); return `grain-silo-btc-send-journal-v1:${network}`; };
const receiveKey = network => { key(network); return `grain-silo-btc-receive-index-v1:${network}`; };
const HEX = /^[0-9a-f]+$/;
const idOf = hex => { try { return btc.Transaction.fromRaw(Uint8Array.from(hex.match(/../g), b => parseInt(b, 16)), {allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true}).id; } catch { return null; } };

export const SILO_BTC_UNRESOLVED_NOTE = 'A send to the Bitcoin network is unresolved: Silo could not confirm whether it was received. It may have been sent. Do not send again. Check its status or rebroadcast the same transaction.';

/** The unresolved send for a network: the record, null when none, or {unreadable:true} when storage holds something that cannot be trusted
 * (treated as unresolved, so nothing else is signed until the person deals with it). */
export function siloBtcJournalRead(storage, network) {
  const k = key(network); let text; try { text = storage.getItem(k); } catch { return {unreadable: true}; }
  if (text === null || text === undefined) return null;
  try {
    const row = JSON.parse(text);
    if (!row || row.version !== 1 || row.network !== network || typeof row.txid !== 'string' || !/^[0-9a-f]{64}$/.test(row.txid) || typeof row.hex !== 'string' || row.hex.length > 200_000 || !HEX.test(row.hex) || idOf(row.hex) !== row.txid) return {unreadable: true};
    return row;
  } catch { return {unreadable: true}; }
}
/** The text an error may show. While a send is unresolved (a broadcast that may have reached a provider) every later error, a failed balance read
 * included, says so and never claims that nothing was sent. Otherwise the plain fallback. */
export function siloBtcErrorText(storage, network, fallback) {
  return siloBtcJournalRead(storage, network) === null ? fallback : SILO_BTC_UNRESOLVED_NOTE;
}
export function siloBtcAssertNoUnresolved(storage, network) {
  if (siloBtcJournalRead(storage, network) !== null) throw fail(SILO_BTC_UNRESOLVED_NOTE, 'unresolved');
}
/** Writes the intent BEFORE any broadcast; reads it back; throws (and the caller must not broadcast) if it cannot be made durable. */
export function siloBtcJournalBegin(storage, network, {txid, hex, destination, amountSats, feeSats, createdAt = Date.now()}) {
  siloBtcAssertNoUnresolved(storage, network);
  if (idOf(hex) !== txid) throw fail('The transaction does not match its id.', 'txid');
  const row = {version: 1, network, txid, hex, destination, amountSats, feeSats, createdAt};
  try { storage.setItem(key(network), JSON.stringify(row)); } catch { throw fail('This device could not record the send, so it was not sent.', 'storage'); }
  const back = siloBtcJournalRead(storage, network);
  if (!back || back.unreadable || back.txid !== txid) throw fail('This device could not record the send, so it was not sent.', 'storage');
  return row;
}
export function siloBtcJournalClear(storage, network, txid) {
  const row = siloBtcJournalRead(storage, network);
  if (row && !row.unreadable && row.txid !== txid) return false;
  try { storage.removeItem(key(network)); } catch { /* a failed clear leaves it unresolved, which is the safe side */ }
  return true;
}
const archiveKey = network => { key(network); return `grain-silo-btc-send-archive-v1:${network}`; };
const ARCHIVE_MAX = 20;
/** The list holds this many cleared payments. When it is full a further clear is REFUSED (never dropping an older record). */
export const SILO_BTC_ARCHIVE_MAX = 200;
function archive(storage, network, entry) {
  const k = archiveKey(network); let text;
  // A failed READ is not "no archive": nothing is cleared, so a later successful write can never replace history it could not see.
  try { text = storage.getItem(k); } catch { throw fail('The list of cleared payments could not be read, so nothing was cleared.', 'archive-read'); }
  let list = [];
  if (text !== null && text !== undefined) {
    try { list = JSON.parse(text); if (!Array.isArray(list)) throw Error(); }
    // An unreadable list is moved aside WHOLE (no truncation) before a new one starts; if that write fails, nothing is cleared.
    catch { list = []; try { storage.setItem(`${k}-unreadable-${entry.clearedAt}`, String(text)); } catch { throw fail('The list of cleared payments is damaged and could not be saved aside, so nothing was cleared.', 'archive-write'); } }
  }
  if (list.length >= SILO_BTC_ARCHIVE_MAX) throw fail('The list of cleared payments is full, so nothing was cleared.', 'archive-full');
  list.push(entry);
  try { storage.setItem(k, JSON.stringify(list)); } catch { throw fail('The list of cleared payments could not be saved, so nothing was cleared.', 'archive-write'); }
}
/** Recovery history: payments the person cleared by hand, kept (never lost on clear). */
export function siloBtcArchiveRead(storage, network) {
  try { const list = JSON.parse(storage.getItem(archiveKey(network)) ?? '[]'); return Array.isArray(list) ? list.filter(x => x && /^[0-9a-f]{64}$/.test(x.txid ?? '')) : []; } catch { return []; }
}
/** The ONLY way to remove an unresolved record other than seeing the transaction itself confirmed (or a provider accepting it). It is a
 * deliberate human act: the caller must pass `acknowledge` equal to the first 8 characters of the txid, which the person has to type after
 * reading the warning. The record is ARCHIVED first (bytes, txid, intent); if the archive cannot be written nothing is cleared. The app never
 * says the payment was not made: only the person can know that, from outside. A clear is not permanent proof (a reorg or a late broadcast can
 * revive the payment), so cleared payments stay in the archive and `siloBtcAuditArchive` looks for them again. */
export function siloBtcJournalManualClear(storage, network, {acknowledge, now = Date.now()}) {
  const row = siloBtcJournalRead(storage, network);
  if (row === null) return {cleared: false, reason: 'none'};
  const raw = (() => { try { return storage.getItem(key(network)); } catch { return null; } })();
  if (row.unreadable) {
    if (acknowledge !== 'unreadable') throw fail('Type the word unreadable to clear a record that cannot be read.', 'acknowledge');
    archive(storage, network, {kind: 'unreadable', clearedAt: now, raw: typeof raw === 'string' ? raw : null, txid: '0'.repeat(64)});
  } else {
    if (typeof acknowledge !== 'string' || acknowledge !== row.txid.slice(0, 8)) throw fail('Type the first 8 characters of the transaction id to confirm.', 'acknowledge');
    archive(storage, network, {kind: 'manual', clearedAt: now, txid: row.txid, hex: row.hex, destination: row.destination, amountSats: row.amountSats, feeSats: row.feeSats, createdAt: row.createdAt});
  }
  storage.removeItem(key(network));
  return {cleared: true};
}
/** Looks again for payments that were cleared by hand: any that the network now lists is reported so the person is told, not surprised. */
export async function siloBtcAuditArchive({storage, network, status}) {
  const seen = [];
  for (const entry of siloBtcArchiveRead(storage, network)) {
    if (entry.txid === '0'.repeat(64)) continue;
    try { const known = await status(entry.txid); if (known?.known === true) seen.push({txid: entry.txid, confirmed: known.confirmed === true}); } catch { /* no verdict */ }
  }
  return seen;
}

const inputsOf = hex => {
  const tx = btc.Transaction.fromRaw(Uint8Array.from(hex.match(/../g), b => parseInt(b, 16)), {allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true});
  const out = []; for (let i = 0; i < tx.inputsLength; i++) { const input = tx.getInput(i); out.push({txid: Array.from(input.txid, b => b.toString(16).padStart(2, '0')).join(''), vout: input.index}); }
  return out;
};
export const SILO_BTC_CONFLICT_NOTE = 'Another confirmed transaction spends one of this payment\'s coins. It may have replaced this payment, or this payment may still confirm. Silo cannot tell which, so nothing was cleared. Look at the history of this wallet elsewhere, then decide.';
export const SILO_BTC_OWN_PARTIAL_NOTE = 'A data provider reports that this payment itself is confirmed, but not every provider agrees yet. Wait and check again. Nothing was cleared.';
export const SILO_BTC_MEMPOOL_NOTE = 'The network lists this payment but it is not confirmed yet. Wait for a confirmation.';
/** INFORMATION ONLY. Looks at who spent T's inputs (provider data, unverified). It can tell the person that something else spent a coin, or that
 * T itself is confirmed; it never clears anything on a conflict, because a conflicting spend is not proof that the payment failed (a replacement
 * may pay the same recipient, a provider may be wrong, a reorg may bring T back). Returns 'settled' (a confirmed spend by T itself, seen by every provider), 'conflict-seen', 'own-partial' (T itself, not yet by every provider) or 'none'. */
export async function siloBtcInspectConflict({record, outspends}) {
  const inputs = inputsOf(record.hex); let seen = false, own = false;
  for (let i = 0; i < inputs.length; i += 20) {
    const rows = await outspends(inputs.slice(i, i + 20));
    if (!Array.isArray(rows)) throw fail('The answer was unexpected.', 'proof');
    for (const row of rows) {
      if (!row || row.spent !== true || row.confirmed !== true || typeof row.spenderTxid !== 'string') continue;
      // A mainnet release needs every configured provider to have answered (rows from the relay carry the counts).
      if (row.spenderTxid === record.txid) {
        // Our own transaction, but not yet confirmed by every provider (a missing count counts as not proven): hold, and say it is OUR payment.
        if (!Number.isSafeInteger(row.providersTotal) || row.providersTotal < 1 || row.providersAnswered !== row.providersTotal) { own = true; continue; }
        return 'settled';
      }
      seen = true;
    }
  }
  return seen ? 'conflict-seen' : own ? 'own-partial' : 'none';
}

/** The record is deleted by a broadcast only when the provider returns the txid (accepted), or when the network reports the transaction
 * CONFIRMED. Every error, every 4xx included, every negative lookup and every unconfirmed listing leaves it unresolved: Bitcoin transactions
 * do not expire, a refused rebroadcast does not undo an earlier broadcast, and a conflict is never proof of failure. */
export async function siloBtcBroadcastJournaled({storage, network, record, send, status}) {
  try {
    const answer = await send({hex: record.hex, txid: record.txid});
    if (answer?.txid === record.txid) { siloBtcJournalClear(storage, network, record.txid); return {state: 'accepted'}; }
  } catch { /* inconclusive by definition */ }
  let known = null; try { known = await status(record.txid); } catch { known = null; }
  if (known?.known === true && known.confirmed === true) { siloBtcJournalClear(storage, network, record.txid); return {state: 'already-known'}; }
  if (known?.known === true) return {state: 'unresolved', note: SILO_BTC_MEMPOOL_NOTE};
  return {state: 'unresolved', note: SILO_BTC_UNRESOLVED_NOTE};
}
/** After a reload or for the "Check" button: (1) is T confirmed? then done. (2) is T listed but unconfirmed? wait. (3) otherwise look at
 * conflicts (information only), then rebroadcast the SAME bytes. The only exits are confirmation, provider acceptance, or the person's deliberate manual clear. */
export async function siloBtcResolveUnresolved({storage, network, send, status, outspends}) {
  const record = siloBtcJournalRead(storage, network);
  if (!record) return {state: 'none'};
  if (record.unreadable) return {state: 'unreadable', note: SILO_BTC_UNRESOLVED_NOTE};
  let known = null; try { known = await status(record.txid); } catch { known = null; }
  if (known?.known === true && known.confirmed === true) { siloBtcJournalClear(storage, network, record.txid); return {state: 'already-known'}; }
  if (known?.known === true) return {state: 'unresolved', note: SILO_BTC_MEMPOOL_NOTE};
  let outcome = 'none'; try { outcome = await siloBtcInspectConflict({record, outspends}); } catch { outcome = 'none'; }
  if (outcome === 'settled') { siloBtcJournalClear(storage, network, record.txid); return {state: 'already-known'}; }
  const result = await siloBtcBroadcastJournaled({storage, network, record, send, status});
  if (result.state === 'unresolved' && outcome === 'own-partial') return {state: 'unresolved', note: SILO_BTC_OWN_PARTIAL_NOTE};
  if (result.state === 'unresolved' && outcome === 'conflict-seen') return {state: 'unresolved', note: SILO_BTC_CONFLICT_NOTE, conflict: true};
  return result;
}

/** Highest receive index the wallet has shown; it only moves up, so an address once shown is never offered again after a reload. */
export function siloBtcReceiveIndexRead(storage, network) {
  try { const n = Number(storage.getItem(receiveKey(network))); return Number.isSafeInteger(n) && n >= 0 && n < 100_000 ? n : 0; } catch { return 0; }
}
export function siloBtcReceiveIndexRaise(storage, network, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 100_000) return;
  try { if (index > siloBtcReceiveIndexRead(storage, network)) storage.setItem(receiveKey(network), String(index)); } catch { /* the next scan still finds the first unused address */ }
}
