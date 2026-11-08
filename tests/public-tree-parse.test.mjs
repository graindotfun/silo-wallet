// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {SILO_DISCLOSURES, siloDisclosure} from '../lib/silo/disclosures.mjs';

const root = new URL('..', import.meta.url).pathname;
function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', 'target'].includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files(full, out); else out.push(full);
  }
  return out;
}

test('every .mjs file in the tree parses', () => {
  const bad = [];
  for (const file of files(root).filter((f) => f.endsWith('.mjs'))) {
    const result = spawnSync(process.execPath, ['--check', file], {encoding: 'utf8'});
    if (result.status !== 0) bad.push(`${file}: ${result.stderr.split('\n').slice(0, 4).join(' ')}`);
  }
  assert.deepEqual(bad, []);
});

test('disclosures load and the Monero zone text states the swap view-key exception', () => {
  assert.ok(Object.keys(SILO_DISCLOSURES).length >= 4);
  const xmr = siloDisclosure('xmr');
  assert.match(xmr.hidden, /wallet's view key is never uploaded/);
  assert.match(xmr.hidden, /one-time view key for that swap's address only/);
  assert.throws(() => siloDisclosure('nope'));
});
