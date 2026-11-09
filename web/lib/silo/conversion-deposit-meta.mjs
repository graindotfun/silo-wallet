// Persists the {orderId, expiresAt, address, amountAtomic} of the one XMR deposit that may be staged at a time
// in components/silo-native-zone.tsx, across exactly the boundary that loses a plain in-memory association: a
// reload, lock/unlock, or another tab taking over. opened.pending() (the wallet engine's own restore of a
// signed-but-unconfirmed payment) returns a NEW JS object each time the wallet opens, so a WeakMap keyed by that
// object alone is unreachable after any of those (Sol/Opus review, 29 Oct 2026).
//
// Opus's follow-up round, same date: the first version's own "fails closed" claim was wrong -- the caller's
// deadline check only ran when meta was present, so a MISSING or CORRUPT persisted value skipped the check
// entirely instead of refusing. address and amountAtomic are now part of what's persisted (not just orderId and
// expiresAt), specifically so a caller can verify a restored record actually belongs to the draft it's about to
// be trusted for, rather than assuming any readable value is correct. persistDepositMeta now reads its own write
// back before returning, so a caller can tell a genuine write failure (storage full, blocked, etc.) apart from
// "nothing was ever staged" -- the two cases need different handling (the former should refuse to let the
// deposit be considered successfully staged at all; the latter is just an ordinary, non-deposit payment).
// Opus's round-5 review: a single global key meant opening, confirming or cancelling a payment in a DIFFERENT
// zone/network render of the same component (ZEC, or XMR stagenet) cleared the XMR mainnet deposit's own record
// -- the exact fail-open this module exists to prevent, just reached a different way. The key is now scoped per
// zone+network (e.g. 'xmr:mainnet', 'xmr:stagenet', 'zec:mainnet'); each render only ever touches its own scope.
export const SILO_DEPOSIT_META_KEY_PREFIX = 'grain-silo-conversion-xmr-deposit-v1:';
function depositMetaKey(scope) {
  if (typeof scope !== 'string' || !/^[a-z]+:[a-z-]+$/.test(scope)) throw Error('A deposit-meta scope (zone:network) is required.');
  return SILO_DEPOSIT_META_KEY_PREFIX + scope;
}
function sameShape(value) {
  return typeof value?.orderId === 'string' && value.orderId.length > 0
    && Number.isSafeInteger(value?.expiresAt)
    && typeof value?.address === 'string' && value.address.length > 0
    && typeof value?.amountAtomic === 'string' && /^[1-9]\d{0,19}$/.test(value.amountAtomic);
}
/** Returns true once the write is confirmed by reading it back (or confirmed cleared, for meta=null). False means
 * the caller cannot trust this value to have been durably recorded -- it must not treat staging as successful. */
export function persistDepositMeta(meta, scope) {
  const key = depositMetaKey(scope);
  try {
    if (meta) {
      localStorage.setItem(key, JSON.stringify(meta));
      // Must deep-equal what was just written, not merely "not null" -- a storage implementation that silently
      // drops writes (getItem always returning null, say) would otherwise look like success: readPersistedDepositMeta()
      // would return undefined (its own "nothing stored" value), which is not null either.
      const readBack = readPersistedDepositMeta(scope);
      return typeof readBack === 'object' && readBack !== null && JSON.stringify(readBack) === JSON.stringify(meta);
    }
    localStorage.removeItem(key); return localStorage.getItem(key) === null;
  } catch { return false; }
}
// Three-way return, deliberately NOT collapsed to a boolean/null pair: `undefined` means nothing was ever
// stored here at all (an ordinary, non-deposit payment -- no deadline obligation to enforce); `null` means
// something WAS stored but is unreadable or malformed (storage corruption, a value from an incompatible future
// version, or a key collision) -- the caller must treat this as "an obligation exists but cannot be verified",
// never the same as "no obligation" (Opus's review, 29 Oct 2026: the original version conflated these two,
// so a corrupt value silently behaved like no deposit was ever staged). Only a real, well-formed object means
// "here is the obligation, trusted."
export function readPersistedDepositMeta(scope) {
  const key = depositMetaKey(scope);
  let raw;
  try { raw = localStorage.getItem(key); } catch { return null; }
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return sameShape(parsed) ? parsed : null;
  } catch { return null; }
}
