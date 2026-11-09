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
    if (keys.length > MAX_ENTRIES) for (const old of keys.slice(0, keys.length - MAX_ENTRIES)) delete all[old];
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
/** @returns {Promise<{readable:boolean,depositOpened:boolean,windowEndsAt:number|null}>} unreadable => depositOpened true. */
export async function readConversionAttemptMeta(handle, storage = defaultStorage()) {
  try {
    if (!storage) throw Error('no-storage');
    const row = load(storage)[await handleKey(handle)];
    if (row === undefined) return { readable: true, depositOpened: false, windowEndsAt: null };
    return { readable: true, depositOpened: row.depositOpened === true, windowEndsAt: Number.isSafeInteger(row.windowEndsAt) ? row.windowEndsAt : null };
  } catch { return { readable: false, depositOpened: true, windowEndsAt: null }; }
}
