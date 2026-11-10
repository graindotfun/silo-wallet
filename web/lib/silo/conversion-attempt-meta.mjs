// Small per-browser facts about a saved conversion attempt, kept so a page reload cannot turn "never reached a deposit
// step" back into "unknown". Keyed by a SHA-256 of the recovery handle (the handle itself is an access secret and is
// never written here). Holds only: the order's own deposit deadline, and whether the deposit review was ever opened.
// Fail-closed: anything unreadable counts as "deposit review may have been opened".
const KEY = 'grain-silo-conversion-attempt-meta-v1';
const MAX_ENTRIES = 64;
async function handleKey(handle) {
  if (typeof handle !== 'string' || handle.length < 1 || handle.length > 2048) throw Error('conversion-attempt-meta-handle');
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(handle))), b => b.toString(16).padStart(2, '0')).join('');
}
function load(storage) {
  const text = storage.getItem(KEY);
  if (text === null) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('conversion-attempt-meta-format');
  return parsed;
}
function defaultStorage() { return typeof localStorage === 'undefined' ? null : localStorage; }
async function update(handle, patch, storage) {
  try {
    if (!storage) return false;
    const key = await handleKey(handle), all = load(storage);
    all[key] = { ...(all[key] ?? {}), ...patch };
    const keys = Object.keys(all);
    // Eviction is fail-closed: a row that says "deposit review was opened" or "hidden from the screen" is never the first to go,
    // because a missing row reads as "never opened" (see readConversionAttemptMeta). Only plain window-only rows are evicted first;
    // protected rows go only past a hard ceiling of 4x the normal limit, oldest first.
    if (keys.length > MAX_ENTRIES) {
      const plain = keys.filter(k => all[k]?.depositOpened !== true && all[k]?.hidden !== true);
      for (const old of plain.slice(0, keys.length - MAX_ENTRIES)) delete all[old];
      const left = Object.keys(all);
      if (left.length > MAX_ENTRIES * 4) for (const old of left.slice(0, left.length - MAX_ENTRIES * 4)) delete all[old];
    }
    storage.setItem(KEY, JSON.stringify(all));
    return true;
  } catch { return false; }
}
/** Remember the order's own deposit deadline (ms). Best effort. */
export function recordConversionWindow(handle, windowEndsAt, storage = defaultStorage()) {
  if (!Number.isSafeInteger(windowEndsAt) || windowEndsAt <= 0) return Promise.resolve(false);
  return update(handle, { windowEndsAt }, storage);
}
/** Must succeed BEFORE the wallet deposit review is opened. Resolves false when it could not be saved. */
export function markConversionDepositOpened(handle, storage = defaultStorage()) { return update(handle, { depositOpened: true }, storage); }
/** Move an expired, still-waiting order off the main screen. Display only: it never retires the recovery handle. Resolves false when not saved. */
export function setConversionAttemptHidden(handle, hidden, storage = defaultStorage()) { return update(handle, { hidden: hidden === true }, storage); }
/** Which of these handles were hidden from the main screen. Unreadable storage hides nothing (fail-closed: everything stays on screen). */
export async function readHiddenConversionAttempts(handles, storage = defaultStorage()) {
  try {
    if (!storage) return [];
    const all = load(storage), out = [];
    for (const handle of handles) if (all[await handleKey(handle)]?.hidden === true) out.push(handle);
    return out;
  } catch { return []; }
}
/** @returns {Promise<{readable:boolean,depositOpened:boolean,windowEndsAt:number|null}>} unreadable => depositOpened true. */
export async function readConversionAttemptMeta(handle, storage = defaultStorage()) {
  try {
    if (!storage) throw Error('no-storage');
    const row = load(storage)[await handleKey(handle)];
    if (row === undefined) return { readable: true, depositOpened: false, windowEndsAt: null };
    return { readable: true, depositOpened: row.depositOpened === true, windowEndsAt: Number.isSafeInteger(row.windowEndsAt) ? row.windowEndsAt : null };
  } catch { return { readable: false, depositOpened: true, windowEndsAt: null }; }
}
