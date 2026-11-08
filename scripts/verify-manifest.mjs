// SPDX-License-Identifier: AGPL-3.0-only
// Checks every file listed in PUBLIC_MANIFEST.json against its sha256 and reports files that are not listed.
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
const root = new URL('..', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(root, 'PUBLIC_MANIFEST.json'), 'utf8'));
const listed = new Map(manifest.files.map((f) => [f.path, f.sha256]));
let bad = 0;
for (const [path, sha] of listed) {
  const actual = createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
  if (actual !== sha) { console.error('MISMATCH', path); bad++; }
}
const skip = new Set(['node_modules', '.git', 'target']);
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else { const rel = relative(root, full); if (rel !== 'PUBLIC_MANIFEST.json' && rel !== 'package-lock.json' && !listed.has(rel)) { console.error('UNLISTED', rel); bad++; } }
  }
})(root);
console.log(bad ? `${bad} problem(s)` : `manifest ok, ${listed.size} files`);
process.exit(bad ? 1 : 0);
