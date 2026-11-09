// SPDX-License-Identifier: AGPL-3.0-only
// Fetches the client files a Silo origin serves for its wallet pages, hashes them, and compares them with a local build
// (dist/client) and/or with a recorded list of expected hashes. Node 22 or later, no dependencies.
//
//   node scripts/verify-app.mjs [--origin https://silo.trading] [--page /app ...] [--dist path/to/dist/client]
//                               [--expected docs/verify-app/<commit>.json] [--write out.json] [--json]
//
// Exit code 0: every served file matched every reference given. 1: at least one mismatch or missing file. 2: usage error.
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';

const args = process.argv.slice(2);
const opt = {origin: 'https://silo.trading', pages: [], dist: null, expected: null, write: null, json: false};
for (let i = 0; i < args.length; i++) {
  const a = args[i], next = () => { const v = args[++i]; if (v === undefined) usage(`missing value for ${a}`); return v; };
  if (a === '--origin') opt.origin = next().replace(/\/+$/, '');
  else if (a === '--page') opt.pages.push(next());
  else if (a === '--dist') opt.dist = next();
  else if (a === '--expected') opt.expected = next();
  else if (a === '--write') opt.write = next();
  else if (a === '--json') opt.json = true;
  else usage(`unknown argument ${a}`);
}
if (!opt.pages.length) opt.pages = ['/app'];
function usage(msg) { console.error(msg); console.error('see the comment at the top of scripts/verify-app.mjs'); process.exit(2); }

const origin = new URL(opt.origin);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
// Client files are the build's static output. Documents (HTML) are rendered per request and carry a fresh CSP nonce,
// so they are never compared byte for byte; only the files they reference are.
const STATIC = /^\/(?:_next\/static\/|fonts\/|brand\/|silo-icons\/|silo-sdk\/|assets\/)/;

async function get(path) {
  const url = new URL(path, origin);
  const res = await fetch(url, {redirect: 'manual', headers: {'accept-encoding': 'gzip, br'}});
  const body = Buffer.from(await res.arrayBuffer());
  return {status: res.status, type: res.headers.get('content-type') || '', body};
}

function refsFromText(text, basePath) {
  const out = new Set();
  const add = (raw) => {
    if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return;
    let u;
    try { u = new URL(raw, new URL(basePath, origin)); } catch { return; }
    if (u.origin !== origin.origin) return;
    if (STATIC.test(u.pathname)) out.add(u.pathname);
  };
  // absolute or root-relative static paths anywhere in the text (attributes, inline flight data, import maps)
  for (const m of text.matchAll(/["'`(\s,](\/(?:_next\/static|fonts|brand|silo-icons|silo-sdk|assets)\/[A-Za-z0-9_.\/-]+)/g)) add(m[1]);
  // bundler deps written relative to the base, for example "_next/static/chunks/x-abc.js"
  for (const m of text.matchAll(/["'`](_next\/static\/[A-Za-z0-9_.\/-]+)["'`]/g)) add('/' + m[1]);
  // ES module specifiers relative to the current chunk
  for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'`](\.{1,2}\/[^"'`\s]+)["'`]/g)) add(m[1]);
  // new URL("x.wasm", import.meta.url)
  for (const m of text.matchAll(/new URL\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url\s*\)/g)) add(m[1]);
  // css url(...)
  for (const m of text.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/g)) add(m[1]);
  return out;
}

const served = new Map(); // path -> {status, sha256, bytes}
const queue = [];
const documents = [];
for (const page of opt.pages) {
  const doc = await get(page);
  documents.push({page, status: doc.status});
  if (doc.status !== 200) continue;
  for (const p of refsFromText(doc.body.toString('utf8'), page)) queue.push(p);
}
while (queue.length) {
  const path = queue.shift();
  if (served.has(path)) continue;
  const r = await get(path);
  served.set(path, {status: r.status, sha256: r.status === 200 ? sha256(r.body) : null, bytes: r.body.length});
  if (r.status === 200 && /\.(m?js|css)$/.test(path)) for (const p of refsFromText(r.body.toString('utf8'), path)) if (!served.has(p)) queue.push(p);
}

const expected = opt.expected ? JSON.parse(readFileSync(opt.expected, 'utf8')) : null;
const rows = [];
for (const [path, s] of [...served].sort(([a], [b]) => a.localeCompare(b))) {
  const row = {path, served: s.sha256, status: s.status};
  if (opt.dist) {
    const f = join(opt.dist, decodeURIComponent(path));
    row.dist = existsSync(f) ? sha256(readFileSync(f)) : null;
  }
  if (expected) row.expected = expected.files?.[path] ?? null;
  rows.push(row);
}
const verdict = (r) => {
  // The wallet Worker serves only an allowlist of static files. The shared router data inside the chunks also names files of
  // other pages that this origin refuses (404). They are listed for information and are not a failure.
  if (r.status !== 200) return 'referenced-not-served';
  const refs = [];
  if ('dist' in r) refs.push(r.dist);
  if ('expected' in r) refs.push(r.expected);
  if (!refs.length) return 'served';
  if (refs.some((x) => x === null)) return 'missing-in-reference';
  return refs.every((x) => x === r.served) ? 'match' : 'mismatch';
};
const counts = {};
for (const r of rows) { r.result = verdict(r); counts[r.result] = (counts[r.result] || 0) + 1; }

if (opt.write) {
  const files = Object.fromEntries(rows.filter((r) => r.served).map((r) => [r.path, r.served]));
  writeFileSync(opt.write, JSON.stringify({schema: 'silo-served-files-v1', origin: origin.origin, pages: opt.pages, files}, null, 1) + '\n');
}
const summary = {origin: origin.origin, documents, files: rows.length, counts};
if (opt.json) console.log(JSON.stringify({...summary, rows}, null, 1));
else {
  for (const r of rows) if (!['match', 'served', 'referenced-not-served'].includes(r.result)) console.log(r.result.padEnd(22), r.path);
  console.log(JSON.stringify(summary));
}
const bad = rows.some((r) => ['mismatch', 'missing-in-reference'].includes(r.result)) || documents.some((d) => d.status !== 200);
process.exit(bad ? 1 : 0);
