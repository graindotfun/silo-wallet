// Reading the swap directory without letting one bad file stop the maker (Astra 709-H1).
// Before: openSwaps() parsed EVERY file before filtering out finished ones, outside the loop's per-record try, so one unreadable file meant no
// refund, claim or sweep for any other swap and no next timer. Now every file is read on its own; a file that cannot be read or parsed is
// reported (id and a short reason class only, never content) and kept untouched; the readable records are recovered as always; and while any
// record is unreadable (or the directory itself cannot be listed) accounting is INCOMPLETE and new admissions are refused.
// Records whose own storage is unsafe are never stepped: nothing here lets a send skip the durable write before broadcast.

/** A short, secret-free reason class. JSON.parse messages can quote file content, so they are never passed on. */
export const reasonOf = (e) => (e instanceof SyntaxError ? 'unparseable' : typeof e?.code === 'string' && /^[A-Z0-9_]{2,20}$/.test(e.code) ? e.code : 'unreadable');

/** deps = { list(): string[] file names, load(id): record }. Never throws. */
export function scanSwaps({ list, load }) {
  let names;
  try { names = list(); } catch (e) { return { records: [], bad: [], dirError: reasonOf(e), complete: false }; }
  const records = [], bad = [];
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    try {
      const s = load(id);
      if (!s || typeof s !== 'object' || Array.isArray(s) || s.swapId !== id) { bad.push({ id, why: 'malformed' }); continue; }
      records.push(s);
    } catch (e) { bad.push({ id, why: reasonOf(e) }); }
  }
  return { records, bad, dirError: null, complete: bad.length === 0 };
}

/**
 * One recovery pass. deps = { scan(), handle(record) -> any, onScan(result), log(e) }. Every record has its own try; the scan itself cannot throw.
 * Returns the list of handle results (for the caller's quick-retry decision).
 */
export async function recoveryPass({ scan, handle, onScan, log }) {
  const r = scan();
  onScan(r);
  const out = [];
  for (const s of r.records) {
    if (s.done) continue;
    try { out.push(await handle(s)); } catch (e) { log({ event: 'error', swapId: s.swapId, error: String(e?.message ?? e).slice(0, 200) }); }
  }
  return out;
}
