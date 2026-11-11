// Reproducible hash of a swap maker release. Read only. Prints file names and sha256 values of the files
// it selected, never file contents. It does not run, import or install anything.
//
// Usage:
//   node release-hash.mjs <root>                      manifest lines, then the hash line
//   node release-hash.mjs <root> --hash-only          only sha256:<hex>
//   node release-hash.mjs <root> --list               only the sorted file names of the manifest
//   node release-hash.mjs <root> --json               the same as JSON
//   node release-hash.mjs <root> --from-git <rev>     read the files of one commit instead of the working tree
//   node release-hash.mjs <root> --fail-on-extra      exit 2 when unreached entries are present
//
// <root> is a directory that holds maker/ and client/ side by side: prototypes/xmr-sol-atomic-swap in a
// repository checkout, or the release directory on the maker host (the layout the runbook uses:
// the maker is started and checked as `node maker/...` from the release directory).
//
// What is hashed (the "release set"), recomputing a selected-source manifest and nothing more:
//   - the entry points maker/maker.mjs and maker/quiesce-check.mjs,
//   - the files discovered from them by the supported import syntax (see below), not from a fixed list, so a
//     new module is picked up and a missing one is an error. Completeness is not established: a file that
//     is loaded by any other route is not discovered,
//   - maker/package.deploy.json and maker/package-lock.deploy.json (the only data files allowed).
// Manifest text: one line per file, sorted by JavaScript string (UTF-16 code unit) order, which equals byte
// order only for ASCII names (names are limited to [A-Za-z0-9._-] per component, so it does here), then
// `<sha256 hex>  <path>\n` (digest, two spaces, path, line feed; no sha256sum filename escaping), the path
// relative to <root> with forward slashes. The release hash is `sha256:` plus the sha256 of that text. File
// bytes are hashed as they are: LF and CRLF give different digests. Permissions and timestamps are not part of it.
//
// Import reader (M1). The source is split into tokens by a small tokenizer that skips comments, strings,
// template literals (including nested ${ } code) and regular expression literals. Followed: static
// `import ... from 'x'`, `import 'x'`, `export ... from 'x'`, and `import('x')` with a plain string literal,
// each also with import attributes (`with { ... }`). Mentions inside comments, strings, templates and regular
// expressions are ignored, consistently. The reader FAILS CLOSED (stops with an error) on: `require`,
// `createRequire`, `eval`, `new Function`/`Function(`, `.constructor(`, a dynamic import whose argument is not
// a plain string literal (a template literal counts as computed), `import.meta` other than a comparison with
// `import.meta.url`, a specifier containing a backslash escape, the node modules vm, module and worker_threads,
// a backslash identifier escape outside strings, anything the tokenizer cannot finish (unterminated comment,
// string, template or regular expression), and a line that starts with import or export without the reader
// having seen it as code. A "/" that the reader cannot classify with certainty also stops it,
// naming the line: after `}` (block end or object/function expression end), after postfix or prefix `++`/`--`, after
// `of`, `yield` or `await`. Decided without guessing: regular expression after an operator or opening punctuation,
// `return`/`typeof`/`in`/`case`/... and the head of if/while/for/with; division after a number, string, template
// end, regular expression, `]`, a plain `)`, a private name (#word, read as one token) and a normal identifier (also a
// keyword-like property after `.`). A private name spelled like a keyword, a contextual keyword or a watched name
// (#return, #if, #of, #eval, #require ...) stops the tool. Scope of the assurance: the scanner fails closed on the
// forms listed here and on nothing else. It is a token rule, not a full ECMAScript parser; any ECMAScript form not
// listed is not certified. The test file compares it with a real parser (test oracle only, not a dependency of the
// tool) over generated valid modules: it must match or stop. That is evidence for the generated cases, not a proof for
// all programs. Files loaded by reading them (fs, child processes, workers, other routes) are not discovered.
//
// File system (M2). Below <root>, every path component must be a real directory or file: a symbolic link in
// any component, a resolved path outside <root>, a name outside [A-Za-z0-9._-], an extension other than .mjs
// or .js (the two package files are the only data files), and content that looks like a secret (private key
// block, byte-array key, ENV style secret assignment, a file that is one long token) are refused. These checks
// are heuristics, not proof that a file holds no secret. The manifest prints sha256 of every included file:
// the digest of a file with a low-entropy secret in it can be guessed offline, so nothing secret may be in
// the release set. Reads are sequential and not atomic: files can change between two reads. In git mode the
// revision is resolved once to a commit id and every read uses that id.
//
// What this does NOT cover: independent reproduction of a complete release artifact, a binding to the running
// service, node_modules (the lockfile pins versions and integrity values, the installed files are not hashed
// here), the Node.js binary and version, monero-wallet-rpc, runtime configuration, the environment file, the
// state directory, logs, keys, the host and operating system, the launch identity, the on-chain program.
// Unreached immediate entries of maker/ and client/ (except tooling files and node_modules) are listed as
// "extra" by name only, without a recursive inventory and without reading them.

import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, posix, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FORMAT = 'silo-maker-release-manifest/1';
export const ENTRY_POINTS = ['maker/maker.mjs', 'maker/quiesce-check.mjs'];
export const PACKAGE_FILES = ['maker/package.deploy.json', 'maker/package-lock.deploy.json'];
// The only non-code files that may be part of the set. Explicitly non-secret data; any other data file is refused.
export const DATA_FILES = PACKAGE_FILES;
const CODE_DIRS = ['maker', 'client'];
// Present in a checkout or a release made from one. Excluded from extra-file reporting only: a file the
// entry points reach is still included and hashed even if its name matches. Never read when unreached.
const TOOLING = [/\.test\.mjs$/, /\.selftest\.mjs$/, /^release-hash\.mjs$/, /^README\.md$/];
const FOLLOWED = /\.(?:mjs|js)$/;
const CODE_FILE = /\.(?:mjs|js)$/;
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const BLOCKED_NODE = new Set(['vm', 'module', 'worker_threads', 'node:vm', 'node:module', 'node:worker_threads']);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export class ReleaseHashError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ---- sources: the only two ways bytes enter this script ----------------------------------------------

// Every component below the root is checked with lstat: a symbolic link anywhere is refused, then the real
// path must still lie inside the root. The root argument itself is resolved with realpath (it is the
// operator's choice); only what is below it is held to the rule.
export function fsSource(root) {
  const base = realpathSync(resolve(root));
  const walk = (rel) => {
    let cur = base;
    for (const part of rel.split('/')) {
      if (!part || part === '.' || part === '..') throw new ReleaseHashError('outside', `path leaves the release root: ${rel}`);
      cur = join(cur, part);
      let st; try { st = lstatSync(cur); } catch { throw new ReleaseHashError('missing', `missing: ${rel}`); }
      if (st.isSymbolicLink()) throw new ReleaseHashError('symlink', `refusing a symbolic link in the path: ${rel}`);
    }
    let real; try { real = realpathSync(cur); } catch { throw new ReleaseHashError('missing', `missing: ${rel}`); }
    if (real !== base && !real.startsWith(base + sep)) throw new ReleaseHashError('outside', `resolved path is outside the release root: ${rel}`);
    return cur;
  };
  return {
    describe: base,
    read(rel) {
      const p = walk(rel);
      let fd;
      try { fd = openSync(p, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)); } catch (e) { throw new ReleaseHashError(e.code === 'ELOOP' ? 'symlink' : 'missing', `cannot open: ${rel}`); }
      try {
        if (!fstatSync(fd).isFile()) throw new ReleaseHashError('not-file', `not a regular file: ${rel}`);
        return readFileSync(fd);
      } finally { closeSync(fd); }
    },
    list(dir) {
      const p = walk(dir);
      let ents; try { ents = readdirSync(p, { withFileTypes: true }); } catch { throw new ReleaseHashError('missing', `missing directory: ${dir}`); }
      return ents.map((e) => ({ name: e.name, dir: e.isDirectory() }));
    },
  };
}

// The revision is resolved once to a commit id; every later read uses that id, so a moving branch or tag
// cannot give two different commits within one run.
export function gitSource(root, rev) {
  const cwd = realpathSync(resolve(root));
  const git = (args, opts = {}) => execFileSync('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  let prefix, commit;
  try { prefix = git(['rev-parse', '--show-prefix']).toString().trim(); commit = git(['rev-parse', '--verify', `${rev}^{commit}`]).toString().trim(); } catch { throw new ReleaseHashError('git', `not a git checkout or unknown revision: ${rev}`); }
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) throw new ReleaseHashError('git', `revision did not resolve to a commit id: ${rev}`);
  const tree = (rel) => `${commit}:${prefix}${rel}`;
  const entry = (rel) => { let o; try { o = git(['ls-tree', commit, '--', rel]).toString(); } catch { o = ''; } return o ? o.split(' ')[0] : null; };
  const ancestors = (rel) => {
    const parts = rel.split('/'); let cur = '';
    for (const part of parts.slice(0, -1)) {
      cur = cur ? `${cur}/${part}` : part;
      const mode = entry(cur);
      if (mode === '120000') throw new ReleaseHashError('symlink', `refusing a symbolic link in the path: ${rel}`);
      if (mode !== '040000') throw new ReleaseHashError('missing', `missing directory: ${cur}`);
    }
  };
  return {
    describe: `${cwd} @ ${commit}`,
    commit,
    read(rel) {
      ancestors(rel);
      const mode = entry(rel);
      if (!mode) throw new ReleaseHashError('missing', `missing file: ${rel}`);
      if (mode === '120000') throw new ReleaseHashError('symlink', `refusing a symbolic link: ${rel}`);
      if (mode !== '100644' && mode !== '100755') throw new ReleaseHashError('not-file', `not a regular file: ${rel}`);
      return git(['show', tree(rel)]);
    },
    list(dir) {
      ancestors(`${dir}/x`);
      let out; try { out = git(['ls-tree', '-z', commit, '--', `${dir}/`]).toString(); } catch { throw new ReleaseHashError('missing', `missing directory: ${dir}`); }
      const names = out.split('\0').filter(Boolean).map((l) => { const [info, name] = l.split('\t'); return { name: posix.basename(name), dir: info.split(' ')[1] === 'tree' }; });
      if (!names.length) throw new ReleaseHashError('missing', `missing directory: ${dir}`);
      return names;
    },
  };
}

// ---- import reader ----------------------------------------------------------------------------------------

// Reserved words after which a slash always starts a regular expression. Words that are only sometimes
// keywords (of, yield, await, let, static, async, get, set) are not here: a slash after `of`, `yield` or
// `await` is refused as ambiguous, after the others it is division.
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'extends', 'default']);
// A private name (#word) is ONE identifier-like token. If its word is a keyword, a contextual keyword or a name
// this tool watches for, the tool stops: it does not try to reason about such a name.
const RESERVED_PRIVATE = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'await', 'async', 'of', 'get', 'set', 'as', 'from', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'arguments', 'eval', 'undefined', 'require', 'createRequire', 'Function', 'constructor', 'meta', 'target', 'accessor']);
const SOMETIMES_KEYWORD = new Set(['of', 'yield', 'await']);
const CONTROL_WORD = new Set(['if', 'while', 'for', 'with']);
const unparseable = (m) => new ReleaseHashError('unparseable', m);
const opaque = (m) => new ReleaseHashError('opaque-import', m);

// Splits source text into tokens. Comments, strings, templates and regular expressions never produce code
// tokens. Throws on anything it cannot finish.
export function tokenize(src) {
  const toks = [], comments = [];
  const n = src.length;
  const braces = []; // 'b' normal brace, 't' template substitution
  const parens = []; // true when the parenthesis follows if, while, for or with
  let controlParen = false; // the parenthesis closed last was such a control head
  let i = 0;
  const isIdStart = (c) => /[A-Za-z_$\u0080-￿]/.test(c);
  const isIdPart = (c) => /[A-Za-z0-9_$\u0080-￿]/.test(c);
  const isNl = (c) => c === '\n' || c === '\r' || c === ' ' || c === ' ';
  const push = (t, v, at, extra = {}) => toks.push({ t, v, i: at, ...extra });
  const lineAt = (at) => { let l = 1; for (let k = 0; k < at && k < n; k++) if (src[k] === '\n') l++; return l; };
  // true: a slash here starts a regular expression. false: it is division. 'ambiguous': cannot be decided
  // with certainty; the caller stops with an error instead of guessing.
  const slashKind = () => {
    const p = toks[toks.length - 1];
    if (!p) return true;
    if (p.t === 'num' || p.t === 'str' || p.t === 're' || p.t === 'priv') return false; // a private name is an operand
    if (p.t === 'tpl') return p.end ? false : true; // after the closing backtick: division; after `${`: code starts
    if (p.t === 'id') {
      const before = toks[toks.length - 2];
      if (before && before.t === 'p' && before.v === '.') return false; // a property name, even one spelled like a keyword
      if (SOMETIMES_KEYWORD.has(p.v)) return 'ambiguous';
      return REGEX_AFTER_WORD.has(p.v);
    }
    if (p.v === ')') return controlParen; // a plain parenthesis is division, the head of if/while/for/with is not
    if (p.v === ']') return false;
    if (p.v === '++' || p.v === '--') return 'ambiguous'; // postfix means division, prefix means regular expression
    if (p.v === '}') return 'ambiguous'; // block end or object/function expression end
    return true;
  };
  // Reads template text from index j (just after the backtick or the closing brace of a substitution).
  const template = (j) => {
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') { push('tpl', '`', j, { end: true }); return j + 1; }
      if (c === '$' && src[j + 1] === '{') { braces.push('t'); return j + 2; }
      j++;
    }
    throw unparseable('unterminated template literal');
  };
  const regex = (j) => {
    let k = j + 1, inClass = false;
    while (k < n) {
      const c = src[k];
      if (isNl(c)) break;
      if (c === '\\') { k += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        let e = k + 1;
        while (e < n && isIdPart(src[e])) e++;
        return e;
      }
      k++;
    }
    throw unparseable(`line ${lineAt(j)}: unterminated regular expression`);
  };
  if (src.startsWith('#!')) { while (i < n && !isNl(src[i])) i++; }
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === ' ' || c === '\t' || c === '\v' || c === '\f' || c === '﻿' || c === ' ' || isNl(c)) { i++; continue; }
    if (c === '/' && d === '/') { const s = i; while (i < n && !isNl(src[i])) i++; comments.push([s, i]); continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) throw unparseable('unterminated block comment'); comments.push([i, e + 2]); i = e + 2; continue; }
    if (c === '"' || c === "'") {
      let k = i + 1, esc = false;
      for (;;) {
        if (k >= n || isNl(src[k])) throw unparseable('unterminated string literal');
        if (src[k] === '\\') { esc = true; k += src[k + 1] === '\r' && src[k + 2] === '\n' ? 3 : 2; continue; }
        if (src[k] === c) break;
        k++;
      }
      push('str', src.slice(i + 1, k), i, { esc }); i = k + 1; continue;
    }
    if (c === '`') { push('tpl', '`', i, { end: false }); i = template(i + 1); continue; }
    if (c === '/') {
      const kind = slashKind();
      if (kind === 'ambiguous') throw unparseable(`line ${lineAt(i)}: a "/" where a regular expression and a division cannot be told apart (after ${toks[toks.length - 1].v}); the reader refuses to guess. Rewrite that expression (add a semicolon or parentheses)`);
      if (kind) { push('re', '/', i); i = regex(i); continue; }
      push('p', '/', i); i++; continue;
    }
    if (isIdStart(c)) {
      let k = i + 1; while (k < n && isIdPart(src[k])) k++;
      push('id', src.slice(i, k), i); i = k; continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(d || ''))) {
      let k = i + 1; while (k < n && /[0-9A-Za-z_.]/.test(src[k])) k++;
      push('num', src.slice(i, k), i); i = k; continue;
    }
    if (c === '\\') throw unparseable('backslash identifier escape outside a string');
    if (c === '#') {
      // private name: '#' immediately followed by an identifier is one token, never '#' plus a word
      if (!d || !isIdStart(d)) throw unparseable(`line ${lineAt(i)}: a "#" that does not start a private name`);
      let k = i + 2; while (k < n && isIdPart(src[k])) k++;
      const name = src.slice(i + 1, k);
      if (RESERVED_PRIVATE.has(name)) throw unparseable(`line ${lineAt(i)}: the private name #${name} is spelled like a keyword or a watched name; the reader refuses to reason about it`);
      push('priv', `#${name}`, i); i = k; continue;
    }
    if (c === '(') { const p = toks[toks.length - 1]; const dot = toks[toks.length - 2]; const dotted = !!dot && dot.v === '.'; parens.push(!!p && p.t === 'id' && !dotted && (CONTROL_WORD.has(p.v) || (p.v === 'await' && !!dot && dot.t === 'id' && dot.v === 'for'))); push('p', '(', i); i++; continue; }
    if (c === ')') { controlParen = parens.pop() || false; push('p', ')', i); i++; continue; }
    if (c === '{') { braces.push('b'); push('p', '{', i); i++; continue; }
    if (c === '}') {
      const top = braces.pop();
      if (top === 't') { i = template(i + 1); continue; }
      push('p', '}', i); i++; continue;
    }
    if ((c === '+' || c === '-') && d === c) { push('p', c + c, i); i += 2; continue; }
    push('p', c, i); i++;
  }
  if (braces.includes('t')) throw unparseable('unterminated template substitution');
  return { toks, comments };
}

// Returns the module specifiers a source text loads. Throws ReleaseHashError (code opaque-import or
// unparseable) for any loading form this reader does not support. Fail closed.
export function specifiers(text) {
  const { toks, comments } = tokenize(text);
  const found = new Set();
  const spec = (t, what) => {
    if (t.esc) throw opaque(`a module specifier with an escape sequence (${what})`);
    if (BLOCKED_NODE.has(t.v)) throw opaque(`imports ${t.v}, which can load code this tool cannot follow`);
    found.add(t.v);
  };
  const is = (t, v) => !!t && t.t === 'p' && t.v === v;
  const word = (t, v) => !!t && t.t === 'id' && t.v === v;
  const seen = new Set();
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t !== 'id') continue;
    const p = toks[k - 1], nx = toks[k + 1];
    const member = is(p, '.') || is(p, '#');
    if (t.v === 'require' || t.v === 'createRequire' || t.v === 'eval') throw opaque(`uses ${t.v}`);
    if (t.v === 'Function' && !member && (word(p, 'new') || is(nx, '('))) throw opaque('uses the Function constructor');
    if (t.v === 'constructor' && is(p, '.') && is(nx, '(')) throw opaque('calls .constructor(...)');
    if (member) continue;
    if (t.v === 'import') {
      seen.add(t.i);
      if (is(nx, ':')) continue; // a property key named import
      if (is(nx, '(')) {
        const a = toks[k + 2], b = toks[k + 3];
        if (a && a.t === 'str' && (is(b, ')') || is(b, ','))) { spec(a, 'import()'); continue; }
        throw opaque('a dynamic import whose argument is not a plain string literal');
      }
      if (is(nx, '.')) {
        const cmpAfter = (is(toks[k + 5], '=') || is(toks[k + 5], '!')) && is(toks[k + 6], '=');
        const cmpBefore = is(p, '=') && is(toks[k - 2], '=');
        if (!(word(toks[k + 2], 'meta') && is(toks[k + 3], '.') && word(toks[k + 4], 'url') && (cmpAfter || cmpBefore))) throw opaque('import.meta other than a comparison with import.meta.url');
        continue;
      }
      if (nx && nx.t === 'str') { spec(nx, 'import'); continue; }
      let depth = 0, done = false;
      for (let j = k + 1; j < toks.length; j++) {
        const u = toks[j];
        if (is(u, '{')) depth++;
        else if (is(u, '}')) depth--;
        else if (depth === 0 && is(u, ';')) break;
        else if (depth === 0 && word(u, 'from') && toks[j + 1] && toks[j + 1].t === 'str') { spec(toks[j + 1], 'import'); done = true; break; }
        else if (depth === 0 && (word(u, 'import') || word(u, 'export'))) break;
      }
      if (!done) throw unparseable('an import statement the reader could not complete');
      continue;
    }
    if (t.v === 'export') {
      seen.add(t.i);
      if (is(nx, '*')) {
        let done = false;
        for (let j = k + 2; j < toks.length; j++) {
          const u = toks[j];
          if (is(u, ';') || word(u, 'import') || word(u, 'export')) break;
          if (word(u, 'from') && toks[j + 1] && toks[j + 1].t === 'str') { spec(toks[j + 1], 'export'); done = true; break; }
        }
        if (!done) throw unparseable('an export * statement the reader could not complete');
      } else if (is(nx, '{')) {
        let depth = 0, j = k + 1;
        for (; j < toks.length; j++) { if (is(toks[j], '{')) depth++; else if (is(toks[j], '}') && --depth === 0) break; }
        if (j >= toks.length) throw unparseable('an export list the reader could not complete');
        if (word(toks[j + 1], 'from')) {
          if (toks[j + 2] && toks[j + 2].t === 'str') spec(toks[j + 2], 'export'); else throw unparseable('an export-from statement the reader could not complete');
        }
      }
    }
  }
  // Belt: a line that starts with import or export must have been seen as code, or sit inside a comment.
  for (const m of text.matchAll(/^[ \t]*(import|export)\b/gm)) {
    const at = m.index + m[0].length - m[1].length;
    if (seen.has(at)) continue;
    if (comments.some(([s, e]) => at >= s && at < e)) continue;
    throw unparseable('a line starts with import or export but was not read as code (string, template or expression context)');
  }
  return { specs: [...found], opaque: false };
}

const packageName = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

// Heuristic only: refuses content that looks like a secret. Never prints content.
export function looksSecret(text) {
  const t = text.trim();
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(t)) return 'private key block';
  if (/\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]/.test(t) && !/^\s*(?:import|export|const|let|var|function)\b/m.test(t)) return 'byte-array key';
  if (/^[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*(?:SECRET|PRIVATE_KEY|PASSWORD|PASSWD|TOKEN|API_KEY|SEED|MNEMONIC)[A-Z0-9_]*[ \t]*=[ \t]*[^\s=]/m.test(t)) return 'environment style secret assignment';
  if (/^[A-Za-z0-9+/=_-]{40,}$/.test(t)) return 'a file that is one long token';
  return null;
}

export function buildManifest(source) {
  const files = new Map(); // path -> sha256
  const bare = new Set();
  const queue = [...ENTRY_POINTS];
  const take = (rel) => {
    if (!rel.split('/').every((part) => SAFE_NAME.test(part) && part !== '.' && part !== '..')) throw new ReleaseHashError('bad-filename', `file name outside [A-Za-z0-9._-]: ${JSON.stringify(rel)}`);
    if (!files.has(rel)) files.set(rel, null);
  };
  const admit = (rel, bytes) => {
    if (!CODE_FILE.test(rel) && !DATA_FILES.includes(rel)) throw new ReleaseHashError('disallowed-file', `not an allowed release file type (only .mjs, .js and the two package files): ${rel}`);
    const why = looksSecret(bytes.toString('utf8'));
    if (why) throw new ReleaseHashError('secret-like', `${rel} looks like a secret (${why}); refusing to hash it`);
  };
  for (const rel of [...ENTRY_POINTS, ...PACKAGE_FILES]) take(rel);
  const seen = new Set();
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const bytes = source.read(rel);
    admit(rel, bytes);
    files.set(rel, sha256(bytes));
    if (!FOLLOWED.test(rel)) continue;
    let specs;
    try { ({ specs } = specifiers(bytes.toString('utf8'))); } catch (e) { if (e instanceof ReleaseHashError) throw new ReleaseHashError(e.code, `${rel}: ${e.message}`); throw e; }
    for (const spec of specs) {
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('.')) { bare.add(packageName(spec)); continue; }
      const target = posix.normalize(posix.join(posix.dirname(rel), spec));
      if (!CODE_DIRS.some((d) => target.startsWith(`${d}/`)) || target.split('/').includes('..')) throw new ReleaseHashError('outside', `${rel} imports a file outside maker/ and client/: ${spec}`);
      if (!/\.(?:mjs|js|json)$/.test(target)) throw new ReleaseHashError('no-extension', `${rel} imports without a file extension: ${spec}`);
      take(target);
      queue.push(target);
    }
  }
  for (const rel of PACKAGE_FILES) if (!seen.has(rel)) { const b = source.read(rel); admit(rel, b); files.set(rel, sha256(b)); }

  let deps;
  try { deps = JSON.parse(source.read('maker/package.deploy.json').toString('utf8')).dependencies || {}; } catch (e) { throw e instanceof ReleaseHashError ? e : new ReleaseHashError('package', 'maker/package.deploy.json is not valid JSON'); }
  const undeclared = [...bare].filter((n) => !(n in deps)).sort();
  if (undeclared.length) throw new ReleaseHashError('undeclared-dependency', `imported packages missing from maker/package.deploy.json: ${undeclared.join(', ')}`);

  const sorted = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, hash]) => ({ path, sha256: hash }));
  const text = sorted.map((f) => `${f.sha256}  ${f.path}\n`).join('');
  const extras = [];
  for (const dir of CODE_DIRS) {
    for (const e of source.list(dir)) {
      const rel = `${dir}/${e.name}`;
      if (files.has(rel)) continue;
      const shown = SAFE_NAME.test(e.name) ? rel : `${dir}/${JSON.stringify(e.name)}`;
      if (e.dir) { if (e.name !== 'node_modules') extras.push(`${shown}/`); continue; }
      if (TOOLING.some((re) => re.test(e.name))) continue;
      extras.push(shown);
    }
  }
  return { format: FORMAT, files: sorted, manifest: text, hash: `sha256:${sha256(Buffer.from(text, 'utf8'))}`, packages: [...bare].sort(), extras: extras.sort(), commit: source.commit || null };
}

// ---- command line -------------------------------------------------------------------------------------------

function main(argv) {
  const args = argv.slice(2);
  const flag = (n) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };
  const value = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v ?? null; };
  const hashOnly = flag('--hash-only'), list = flag('--list'), json = flag('--json'), failOnExtra = flag('--fail-on-extra');
  const rev = value('--from-git');
  if (args.length !== 1 || args[0].startsWith('--')) { process.stderr.write('usage: release-hash.mjs <root> [--hash-only|--list|--json] [--from-git <rev>] [--fail-on-extra]\n'); return 1; }
  try {
    const src = rev ? gitSource(args[0], rev) : fsSource(args[0]);
    if (src.commit) process.stderr.write(`revision ${rev} resolved once to commit ${src.commit}\n`);
    const r = buildManifest(src);
    if (hashOnly) process.stdout.write(`${r.hash}\n`);
    else if (list) process.stdout.write(r.files.map((f) => `${f.path}\n`).join(''));
    else if (json) process.stdout.write(`${JSON.stringify({ format: r.format, hash: r.hash, commit: r.commit, files: r.files, packages: r.packages, extras: r.extras }, null, 2)}\n`);
    else {
      process.stdout.write(`${r.format}\n${r.manifest}${r.hash}\n`);
      for (const x of r.extras) process.stdout.write(`extra (not hashed): ${x}\n`);
    }
    if (r.extras.length) process.stderr.write(`${r.extras.length} unreached entr(ies) in maker/ and client/ are outside the hashed set (names only, not read, no recursive inventory)\n`);
    return failOnExtra && r.extras.length ? 2 : 0;
  } catch (e) {
    if (!(e instanceof ReleaseHashError)) throw e;
    process.stderr.write(`release-hash: ${e.code}: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv);
