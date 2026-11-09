// Direct unit test of lib/silo/conversion-deposit-meta.mjs -- the persisted {orderId, expiresAt, address,
// amountAtomic} round-trip components/silo-native-zone.tsx relies on so the order's own deadline survives a
// reload, lock/unlock or another tab taking over. Sol/Opus review, 29 Oct 2026: the prior in-memory-only WeakMap
// was unreachable after any of those (opened.pending() returns a new JS object each time); a follow-up round
// found the first persisted version's own "fails closed" claim was wrong, since the caller's check only ran when
// a value was present, so a MISSING or CORRUPT value silently skipped it instead of refusing. The three-way
// return here (undefined = nothing ever staged; null = something is stored but unreadable; an object = a real,
// well-formed record) is what lets a caller tell those two very different situations apart.
//
// Round-5 review (Opus): the first scoped version still used ONE global key regardless of which zone/network the
// component was rendering for, so opening, confirming or cancelling a payment in a DIFFERENT zone/network render
// (ZEC, or XMR stagenet) cleared the XMR mainnet deposit's own record -- the exact fail-open this whole mechanism
// exists to prevent, reached a different way. Every persisted read/write now takes a required `scope`
// (zone+network, e.g. 'xmr:mainnet') and each scope's storage is fully independent of every other.
import test from 'node:test';
import assert from 'node:assert/strict';
import {persistDepositMeta, readPersistedDepositMeta, SILO_DEPOSIT_META_KEY_PREFIX} from '../lib/silo/conversion-deposit-meta.mjs';

function freshStorage() {
  const storage = new Map();
  globalThis.localStorage = {getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k)};
  return storage;
}
const sample = {orderId: 'order-123', expiresAt: 999999, address: 'deposit-address', amountAtomic: '1000000'};
const scope = 'xmr:mainnet';

test('nothing stored reads back as undefined (an ordinary, non-deposit payment)', () => {
  freshStorage();
  assert.equal(readPersistedDepositMeta(scope), undefined);
});

test('persists and reads back the exact record, including address and amountAtomic', () => {
  freshStorage();
  assert.equal(persistDepositMeta(sample, scope), true, 'the write must verify as successful');
  assert.deepEqual(readPersistedDepositMeta(scope), sample);
});

test('clearing with null removes the persisted entry, back to undefined (not null)', () => {
  freshStorage();
  persistDepositMeta(sample, scope);
  assert.equal(persistDepositMeta(null, scope), true);
  assert.equal(readPersistedDepositMeta(scope), undefined);
});

test('a second deposit overwrites the first in the same scope (only one can ever be staged at a time)', () => {
  freshStorage();
  const first = {...sample, orderId: 'first'}, second = {...sample, orderId: 'second'};
  persistDepositMeta(first, scope);
  persistDepositMeta(second, scope);
  assert.deepEqual(readPersistedDepositMeta(scope), second);
});

// This is the real-world scenario Opus's round-5 review found broken: the owner opens or cancels a review in a
// DIFFERENT zone/network render (XMR stagenet, or ZEC) while an XMR mainnet deposit is staged. The mainnet
// record must be completely untouched by anything that happens under a different scope.
test('a deposit staged under one scope is untouched by writes (including clears) under a different scope', () => {
  freshStorage();
  assert.equal(persistDepositMeta(sample, 'xmr:mainnet'), true);
  // Simulates opening/closing a ZEC wallet, or an XMR stagenet wallet, while the mainnet deposit is staged.
  assert.equal(persistDepositMeta(null, 'zec:mainnet'), true);
  assert.equal(persistDepositMeta(null, 'xmr:stagenet'), true);
  assert.deepEqual(readPersistedDepositMeta('xmr:mainnet'), sample, 'the mainnet deposit must survive clears issued under any other scope');
  assert.equal(readPersistedDepositMeta('zec:mainnet'), undefined);
  assert.equal(readPersistedDepositMeta('xmr:stagenet'), undefined);
});

// Opus's round-7 review (N-3): localStorage is shared across tabs (and across retries in the same tab), so a
// prepare() that's still in flight when a SECOND, newer deposit is staged in the same scope must not blindly
// clear whatever is currently persisted on its own failure cleanup -- that would wipe the second, now-valid
// record. components/silo-native-zone.tsx's own clearOwnDepositMeta() implements exactly this guard (read back,
// clear only if it still deep-equals what this operation itself wrote); this test proves the same pattern using
// only this module's exported primitives, since that helper itself is component-internal.
test('a stale operation\'s cleanup must not clear a newer record written under the same scope in the meantime', () => {
  freshStorage();
  const first = {...sample, orderId: 'first'}, second = {...sample, orderId: 'second'};
  persistDepositMeta(first, scope); // operation A stages its record
  persistDepositMeta(second, scope); // operation B (a retry, or another tab) overwrites it with a newer one
  // Operation A's own failure cleanup: read back, clear only if it still deep-equals what A itself wrote.
  const current = readPersistedDepositMeta(scope);
  const stillA = current && typeof current === 'object' && JSON.stringify(current) === JSON.stringify(first);
  assert.equal(stillA, false, 'sanity: B\'s record should not equal A\'s');
  if (stillA) persistDepositMeta(null, scope);
  assert.deepEqual(readPersistedDepositMeta(scope), second, 'B\'s record must survive A\'s stale cleanup');
});

test('each scope has its own independent record; writing one scope never overwrites another', () => {
  freshStorage();
  const mainnetMeta = {...sample, orderId: 'mainnet-order'};
  const stagenetMeta = {...sample, orderId: 'stagenet-order'};
  persistDepositMeta(mainnetMeta, 'xmr:mainnet');
  persistDepositMeta(stagenetMeta, 'xmr:stagenet');
  assert.deepEqual(readPersistedDepositMeta('xmr:mainnet'), mainnetMeta);
  assert.deepEqual(readPersistedDepositMeta('xmr:stagenet'), stagenetMeta);
});

test('a missing or malformed scope throws rather than silently falling back to a shared key', () => {
  freshStorage();
  for (const bad of [undefined, null, '', 'xmr', 'XMR:MAINNET', 'xmr:', ':mainnet', 'xmr mainnet']) {
    assert.throws(() => readPersistedDepositMeta(bad));
    assert.throws(() => persistDepositMeta(sample, bad));
  }
});

// This is the exact distinction the fail-closed fix depends on: a stored-but-broken value must read back as
// null (an unverifiable obligation a caller must refuse on), never the same undefined "nothing was ever staged"
// an ordinary send would correctly see.
test('malformed, partial, or wrong-shaped stored data reads back as null (unverifiable), never undefined or a half-valid object', () => {
  const storage = freshStorage();
  for (const bad of [
    'not json', '{}', 'null', '42', '"a string"',
    JSON.stringify({orderId: 'x', expiresAt: 1}), // missing address/amountAtomic
    JSON.stringify({...sample, orderId: 123}), // wrong type
    JSON.stringify({...sample, expiresAt: 'soon'}),
    JSON.stringify({...sample, expiresAt: 1.5}),
    JSON.stringify({...sample, address: ''}),
    JSON.stringify({...sample, amountAtomic: '0'}),
    JSON.stringify({...sample, amountAtomic: '01'}),
    JSON.stringify({...sample, amountAtomic: 'abc'}),
    JSON.stringify({...sample, amountAtomic: 1000000}), // number, not string
  ]) {
    storage.set(SILO_DEPOSIT_META_KEY_PREFIX + scope, bad);
    assert.equal(readPersistedDepositMeta(scope), null, `expected null (unverifiable) for stored value: ${bad}`);
  }
});

test('a localStorage that throws on every call never crashes either function, and reads back as unverifiable (null), not as nothing-staged', () => {
  globalThis.localStorage = {getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); }, removeItem: () => { throw Error('blocked'); }};
  assert.doesNotThrow(() => persistDepositMeta(sample, scope));
  assert.equal(persistDepositMeta(sample, scope), false, 'a write that cannot be verified must report failure, not silent success');
  assert.doesNotThrow(() => persistDepositMeta(null, scope));
  assert.equal(persistDepositMeta(null, scope), false);
  assert.equal(readPersistedDepositMeta(scope), null, 'blocked storage means an obligation cannot be ruled out -- never treated as "nothing staged"');
});

test('persistDepositMeta reports failure if the write cannot be read back, even if setItem itself did not throw', () => {
  const storage = new Map();
  globalThis.localStorage = {getItem: () => null, setItem: () => { /* silently drops the write */ }, removeItem: (k) => storage.delete(k)};
  assert.equal(persistDepositMeta(sample, scope), false);
});
