// A balance from the device's saved state is shown while the automatic sync runs, but only ever as "saved, not final": never as the current
// amount, never as the available amount, and the sync is automatic only for XMR with a bounded cadence and the same adapter path as the button.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const overview=readFileSync(new URL('../components/silo-overview.tsx',import.meta.url),'utf8'),zone=readFileSync(new URL('../components/silo-native-zone.tsx',import.meta.url),'utf8');
test('the saved balance is flagged and never feeds the current or available amounts',()=>{
 assert.match(overview,/const currentXmrAmount=synced\?xmr\.amount:null;/);
 assert.match(overview,/const available=!synced\|\|xmr\.spendable==null\?'not checked'/);
 assert.match(overview,/saved balance from \$\{savedAgo\(xmr\.cachedAt\)\}, not final until synced/);
 assert.match(overview,/aria-label="Saved balance, not final until the sync finishes"/);
 assert.doesNotMatch(overview,/cachedAmount[^;]{0,80}available/);
});
test('the automatic sync is XMR only, once per open, again only after ten minutes visible, and never overlaps another operation',()=>{
 assert.match(zone,/if\(zone!=='xmr'\|\|!receive\|\|recoveryOnly\|\|busy\|\|working\.current\|\|!wallet\.current\|\|!online\|\|autoSyncEpoch\.current===epoch\.current\)return;/);
 assert.match(zone,/Date\.now\(\)-autoSyncAt\.current<600_000/);
 assert.match(zone,/document\.addEventListener\('visibilitychange',visible\)/);
 assert.match(zone,/const secret=|secret=sessionSecret\.current\|\|passphrase/);
 assert.match(zone,/async function lock\(\)\{sessionSecret\.current='';/,'the in-memory passphrase is cleared on lock');
});
