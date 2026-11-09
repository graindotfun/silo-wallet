// Complete Solana owner history for recovery coverage. A synthetic in-memory ledger stands in for RPC; signatures are
// synthetic base58 strings. No key generation, signing, RPC or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {SILO_SOLANA_GENESIS} from '../lib/silo/solana-transfer.mjs';
import {createSolanaHistoryReader, memoryCheckpoints} from '../lib/silo/sync/solana-history.mjs';
import {readCoverage} from '../lib/silo/sync/coverage.mjs';

const OWNER = 'So1anaSyntheticOwner111111111111111111111111';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sig = (n) => { let s = '', v = n + 1; while (s.length < 88) { s += B58[v % 58]; v = Math.floor(v / 58) + 7 * s.length + 1; } return s; };
const START = 1_800_000_000_000; // vault start, ms

/** Rows newest first. `count` signatures since the start (one per slot), then `before` signatures older than the start. */
function ledger({count, before = 1, firstAvailableTime = null, firstAvailable = 5, mutate = (rows) => rows} = {}) {
  const rows = [];
  for (let i = 0; i < count + before; i++) {
    const slot = 10_000_000 - i, older = i >= count;
    rows.push({signature: sig(i), slot, blockTime: older ? Math.floor(START / 1000) - 10 - i : Math.floor(START / 1000) + (count - i) * 2, confirmationStatus: 'finalized', err: null, memo: null});
  }
  const calls = [];
  const read = async (method, params) => {
    calls.push(method);
    if (method === 'getGenesisHash') return SILO_SOLANA_GENESIS['mainnet-beta'];
    if (method === 'getSlot') return 10_000_100;
    if (method === 'getFirstAvailableBlock') return firstAvailable;
    if (method === 'getBlockTime') return firstAvailableTime;
    if (method === 'getSignaturesForAddress') {
      const [, {limit, before: cursor, minContextSlot}] = params;
      assert.equal(minContextSlot, 10_000_100, 'every page is anchored');
      const start = cursor ? rows.findIndex((row) => row.signature === cursor) + 1 : 0;
      return mutate(rows.slice(start, start + limit).map((row) => ({...row})), {cursor, start});
    }
    throw Error('unexpected ' + method);
  };
  return {rows, read, calls};
}
const key = (extra = {}) => ({network: 'mainnet-beta', protocol: 'solana-transfer', wallet: OWNER, from: START, ...extra});

test('reads far beyond the old 100-signature bound and completes when it passes the vault start', async () => {
  const l = ledger({count: 2500, before: 3});
  const result = await createSolanaHistoryReader({read: l.read, maxCallsPerRun: 100})(key());
  assert.equal(result.complete, true);
  assert.equal(result.proof, 'start-passed');
  assert.equal(result.items.length, 2500);
  assert.ok(result.coveredFrom < START);
  assert.equal(new Set(result.items.map((i) => i.signature)).size, 2500);
  assert.equal(l.calls.filter((m) => m === 'getSignaturesForAddress').length, 3, '1000-row pages');
});

test('a small call budget resumes from its checkpoint across runs without gaps or duplicates', async () => {
  const l = ledger({count: 4200}), checkpoints = memoryCheckpoints();
  const reader = createSolanaHistoryReader({read: l.read, maxCallsPerRun: 3, checkpoints});
  const runs = [];
  for (let i = 0; i < 6; i++) { const r = await reader(key()); runs.push(r); if (r.complete) break; }
  assert.ok(runs.length > 2, 'needed several runs');
  assert.ok(runs.slice(0, -1).every((r) => r.complete === false && r.progress?.resumable === true));
  const last = runs.at(-1);
  assert.equal(last.complete, true);
  assert.deepEqual(last.items.map((i) => i.signature), l.rows.slice(0, 4200).map((row) => row.signature));
});

test('end of rows is complete only with archival proof or the recorded start marker', async () => {
  const noOlder = (firstAvailableTime) => ledger({count: 1500, before: 0, firstAvailableTime});
  assert.equal((await createSolanaHistoryReader({read: noOlder(null).read})(key())).complete, false, 'pruned or unknown ledger');
  const late = await createSolanaHistoryReader({read: noOlder(Math.floor(START / 1000) + 5).read})(key());
  assert.deepEqual([late.complete, late.reason], [false, 'end-unproven'], 'ledger starts after the vault');
  const archive = await createSolanaHistoryReader({read: noOlder(Math.floor(START / 1000) - 5).read})(key());
  assert.deepEqual([archive.complete, archive.proof], [true, 'archive-proven-end']);
  const l = noOlder(null), marker = {owner: OWNER, slot: l.rows[1499].slot, signature: l.rows[1499].signature};
  const withMarker = await createSolanaHistoryReader({read: l.read})(key({marker}));
  assert.deepEqual([withMarker.complete, withMarker.proof, withMarker.items.length], [true, 'marker', 1499]);
});

test('the vault start marker {owner, slot, signature|null} proves the start by slot; a marker for another owner proves nothing', async () => {
  // Owner had no signature when the vault was created: rows in slots before the marker slot predate the vault.
  const l = ledger({count: 1500, before: 2}), slot = l.rows[1499].slot;
  const bySlot = await createSolanaHistoryReader({read: l.read})(key({marker: {owner: OWNER, slot, signature: null}, from: START - 10 ** 9}));
  assert.deepEqual([bySlot.complete, bySlot.proof, bySlot.items.length], [true, 'marker', 1500], 'the slot alone proves the start, even when block times cannot');
  // Ran out of rows: complete only if the provider still holds the marker slot.
  const empty = (firstAvailable) => ledger({count: 0, before: 0, firstAvailable});
  const kept = await createSolanaHistoryReader({read: empty(9_000_000).read})(key({marker: {owner: OWNER, slot: 9_500_000, signature: null}}));
  assert.deepEqual([kept.complete, kept.proof, kept.items.length], [true, 'archive-proven-end', 0]);
  const pruned = await createSolanaHistoryReader({read: empty(9_600_000).read})(key({marker: {owner: OWNER, slot: 9_500_000, signature: null}}));
  assert.deepEqual([pruned.complete, pruned.reason], [false, 'end-unproven']);
  // Wrong owner or malformed markers are ignored, so only the time rule applies.
  for (const marker of [{owner: 'Other', slot, signature: null}, {owner: OWNER, slot: 0, signature: null}, {owner: OWNER, slot, signature: 'bad'}, 'legacy-string']) {
    const r = await createSolanaHistoryReader({read: ledger({count: 1500, before: 0}).read})(key({marker}));
    assert.equal(r.complete, false, JSON.stringify(marker));
  }
});

test('hostile or broken pages are refused, never stitched', async () => {
  const shapes = {
    'repeated-row': (rows, {start}) => start > 0 ? [{...rows[0], signature: sig(start - 1)}, ...rows.slice(1)] : rows,
    'slot-increases': (rows, {start}) => start > 0 ? rows.map((row, i) => i === 0 ? {...row, slot: 99_999_999} : row) : rows,
    'oversized-page': (rows) => [...rows, ...rows.slice(0, 1).map((row) => ({...row, signature: sig(900_000)}))],
    'malformed-signature': (rows) => rows.map((row, i) => i === 5 ? {...row, signature: 'not-base58-0OIl'} : row),
  };
  for (const [name, mutate] of Object.entries(shapes)) {
    const l = ledger({count: 2500, mutate});
    await assert.rejects(createSolanaHistoryReader({read: l.read})(key()), /page|row|order|cursor/i, name);
  }
  const wrongGenesis = async (method) => method === 'getGenesisHash' ? SILO_SOLANA_GENESIS.devnet : null;
  await assert.rejects(createSolanaHistoryReader({read: wrongGenesis})(key()), /genesis/);
  const pending = ledger({count: 50, mutate: (rows) => rows.map((row, i) => i === 3 ? {...row, confirmationStatus: 'confirmed'} : row)});
  const result = await createSolanaHistoryReader({read: pending.read})(key());
  assert.equal(result.items.find((i) => i.signature === sig(3)).final, false);
});

test('through coverage: a large owner history passes, and one non-final or missing piece holds recovery', async () => {
  const state = (extra = {}) => ({profile: {xmrNetwork: 'mainnet', xmrWallet: 'x', solanaNetwork: 'mainnet-beta', expectedSolanaOwner: OWNER, createdAt: START, ...extra}, 'xmr-state': {birthday: 1}, journal: {entries: {}}});
  const xmr = {history: async (k) => ({...k, complete: true, throughTip: true, coveredFrom: 0, items: []})};
  const l = ledger({count: 1800});
  const history = createSolanaHistoryReader({read: l.read});
  const ok = await readCoverage(state(), {'xmr-payment': xmr, 'solana-transfer': {history}, 'jupiter-swap': {history}});
  assert.deepEqual(ok.held, []);
  assert.equal(ok.items.length, 3600, 'both protocols report the shared owner history');
  assert.equal(l.calls.filter((m) => m === 'getSignaturesForAddress').length, 2, 'scanned once, reused for the second protocol');
  const p = ledger({count: 300, mutate: (rows) => rows.map((row, i) => i === 7 ? {...row, confirmationStatus: 'processed'} : row)});
  const pendingHistory = createSolanaHistoryReader({read: p.read});
  assert.deepEqual((await readCoverage(state(), {'xmr-payment': xmr, 'solana-transfer': {history: pendingHistory}, 'jupiter-swap': {history: pendingHistory}})).held.map((h) => h.reason), ['history-pending', 'history-pending']);
});
