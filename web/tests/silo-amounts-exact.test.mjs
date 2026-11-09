// Sol's review, 29 Oct 2026 (sendFlowReview on the Silo private acceptance package): conversion-service.mjs used
// to convert decimal amounts to atomic units via Math.round(Number(value) * 10 ** decimals) -- floating-point
// multiplication, not exact for every decimals count. siloExactAtomic (lib/silo/amounts.mjs) replaces it with
// string-based BigInt arithmetic. These tests prove exactness directly, independent of conversion-service.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {siloExactAtomic} from '../lib/silo/amounts.mjs';

test('parses a plain decimal string into exact atomic units, no floating point involved', () => {
 assert.equal(siloExactAtomic('0.1', 9).toString(), '100000000');
 assert.equal(siloExactAtomic('0.2', 9).toString(), '200000000');
 assert.equal(siloExactAtomic('0.000000001', 9).toString(), '1');
 assert.equal(siloExactAtomic('1', 6).toString(), '1000000');
 assert.equal(siloExactAtomic('20', 6).toString(), '20000000');
 assert.equal(siloExactAtomic('0', 12).toString(), '0');
});

test('matches the old Math.round(Number(x) * 10**decimals) path on ordinary inputs, but is exact where that path is not', () => {
 // 0.1 * 1e9 in IEEE-754 is 99999999.99999999, which Math.round happens to recover correctly here -- but the
 // point of this function is to never depend on that recovery. Confirm the exact value directly instead.
 assert.equal(siloExactAtomic('0.1', 9).toString(), '100000000');
 // A value whose fractional part has more digits than the asset supports is truncated (never rounded up, so this
 // never atomic-overstates a user-entered amount).
 assert.equal(siloExactAtomic('0.1234567', 6).toString(), '123456');
});

test('accepts a provider-returned number, including one that prints in exponential notation', () => {
 // 0.000000000050 as a JS number literal stringifies as "5e-11" -- a naive String(value) would make this (or
 // the old floating-point path) misbehave. toFixed(decimals) must be used instead; confirm the exact result.
 assert.equal(siloExactAtomic(0.000000000050, 12).toString(), '50');
 assert.equal(siloExactAtomic(1.5, 9).toString(), '1500000000');
 assert.equal(siloExactAtomic(0, 6).toString(), '0');
});

// Sol's review, 29 Oct 2026: toFixed(decimals) alone ROUNDS (e.g. .5 at the final digit rounds up), which
// contradicts "truncated, never rounded up" for a numeric input -- 0.0000000005 at 9 decimals used to become
// atomic unit 1 (rounded up) instead of 0 (the true value truncated). Confirm the fix directly.
test('a numeric input is truncated at the exact double value, never rounded up, even at a would-round-up boundary', () => {
 assert.equal(siloExactAtomic(0.0000000005, 9).toString(), '0', 'the true value truncated at 9 decimals is 0, not rounded up to 1');
 assert.equal(siloExactAtomic(0.0000000015, 9).toString(), '1', 'truncating, not rounding, at a value whose true double expansion keeps it just under 2');
});

test('refuses exponential notation, negative, non-finite, or otherwise malformed input', () => {
 for (const bad of ['5e-11', '-1', '1.2.3', 'abc', '', '.5', '1.', NaN, Infinity, -Infinity, -0.5, null, undefined, {}]) {
  assert.throws(() => siloExactAtomic(bad, 9), /Invalid amount/, `expected ${String(bad)} to be refused`);
 }
});

test('refuses invalid decimals rather than silently clamping', () => {
 for (const bad of [-1, 1.5, 19, NaN, Infinity]) assert.throws(() => siloExactAtomic('1', bad), /Invalid asset decimals/);
});

test('refuses an amount outside the uint64 wallet range', () => {
 assert.throws(() => siloExactAtomic('18446744073.709551616', 9), /outside the wallet range/);
 assert.doesNotThrow(() => siloExactAtomic('18446744073.709551615', 9));
});
