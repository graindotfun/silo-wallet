import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, utimesSync, symlinkSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildManifest, fsSource, gitSource, specifiers, tokenize, looksSecret, ReleaseHashError, ENTRY_POINTS, PACKAGE_FILES } from './release-hash.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SCRIPT = join(HERE, 'release-hash.mjs');
const repo = buildManifest(fsSource(ROOT));
const tmp = () => mkdtempSync(join(tmpdir(), 'rel-hash-'));

// Copy the release set into a new directory, in a chosen order, with chosen timestamps.
function copySet(dest, { reverse = false, mtime = 1000 } = {}) {
  const paths = repo.files.map((f) => f.path);
  if (reverse) paths.reverse();
  paths.forEach((p, i) => {
    mkdirSync(join(dest, dirname(p)), { recursive: true });
    copyFileSync(join(ROOT, p), join(dest, p));
    utimesSync(join(dest, p), mtime + i * 7, mtime + i * 13);
  });
  return dest;
}
const cli = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('the repository checkout gives a well formed hash over a closure that contains the real modules', () => {
  assert.match(repo.hash, /^sha256:[0-9a-f]{64}$/);
  const paths = repo.files.map((f) => f.path);
  for (const p of [...ENTRY_POINTS, ...PACKAGE_FILES, 'maker/maker-core.mjs', 'maker/maker-reverse.mjs', 'client/sol.mjs', 'client/swap-core.mjs', 'client/reverse-core.mjs', 'client/keys.mjs']) assert.ok(paths.includes(p), p);
  assert.ok(!paths.some((p) => /\.test\.mjs$/.test(p)), 'no test file in the release set');
  assert.deepEqual(paths, [...paths].sort(), 'sorted by path');
  assert.deepEqual(repo.packages.filter((n) => !['@noble/curves', '@noble/hashes', '@solana/web3.js', 'bs58'].includes(n)), []);
  assert.equal(buildManifest(fsSource(ROOT)).hash, repo.hash, 'deterministic');
});

test('same content in differently ordered and differently timestamped directories gives the same hash', () => {
  const a = copySet(tmp(), { mtime: 1000 }), b = copySet(tmp(), { reverse: true, mtime: 1.7e9 });
  try {
    assert.equal(buildManifest(fsSource(a)).hash, repo.hash);
    assert.equal(buildManifest(fsSource(b)).hash, repo.hash);
    assert.equal(cli([a, '--hash-only']).stdout.trim(), cli([b, '--hash-only']).stdout.trim());
  } finally { rmSync(a, { recursive: true }); rmSync(b, { recursive: true }); }
});

test('one changed byte in any file of the set changes the hash', () => {
  const d = copySet(tmp());
  try {
    for (const p of repo.files.map((f) => f.path)) {
      const bytes = readFileSync(join(d, p));
      const changed = Buffer.from(bytes); changed[changed.length >> 1] ^= 1;
      writeFileSync(join(d, p), changed);
      let h; try { h = buildManifest(fsSource(d)).hash; } catch (e) { h = `error:${e.code}`; }
      assert.notEqual(h, repo.hash, p);
      writeFileSync(join(d, p), bytes);
    }
    assert.equal(buildManifest(fsSource(d)).hash, repo.hash, 'restored');
  } finally { rmSync(d, { recursive: true }); }
});

test('an unexpected file is reported, is not hashed, and --fail-on-extra turns it into exit 2', () => {
  const d = copySet(tmp());
  try {
    writeFileSync(join(d, 'maker/surprise.mjs'), 'process.exit(1)\n');
    mkdirSync(join(d, 'client/state')); mkdirSync(join(d, 'maker/node_modules'));
    writeFileSync(join(d, 'maker/something.test.mjs'), '');
    const r = buildManifest(fsSource(d));
    assert.equal(r.hash, repo.hash);
    assert.deepEqual(r.extras, ['client/state/', 'maker/surprise.mjs']);
    const out = cli([d]);
    assert.equal(out.status, 0);
    assert.match(out.stdout, /extra \(not hashed\): maker\/surprise\.mjs/);
    assert.equal(cli([d, '--fail-on-extra']).status, 2);
    assert.equal(cli([copySet(tmp()), '--fail-on-extra']).status, 0);
  } finally { rmSync(d, { recursive: true }); }
});

test('nothing outside the reachable set is read', { skip: process.getuid?.() === 0 }, () => {
  const d = copySet(tmp());
  try {
    for (const f of ['maker/maker.env', 'maker/wallet-password', 'client/secret-key.json']) { writeFileSync(join(d, f), 'SECRET'); chmodSync(join(d, f), 0o000); }
    mkdirSync(join(d, 'maker/state')); writeFileSync(join(d, 'maker/state/journal.jsonl'), 'x'); chmodSync(join(d, 'maker/state'), 0o000);
    const r = buildManifest(fsSource(d));
    assert.equal(r.hash, repo.hash);
    assert.ok(r.extras.includes('maker/wallet-password') && r.extras.includes('maker/state/'));
    const everything = JSON.stringify(r) + cli([d]).stdout;
    assert.ok(!everything.includes('SECRET'));
    chmodSync(join(d, 'maker/state'), 0o700);
  } finally { rmSync(d, { recursive: true }); }
});

test('imports are followed from the files themselves: a new module is hashed, a missing or escaping one is an error', () => {
  const d = copySet(tmp());
  try {
    const m = join(d, 'maker/maker.mjs'), orig = readFileSync(m, 'utf8');
    writeFileSync(m, `${orig}\nimport './added.mjs';\n`);
    assert.throws(() => buildManifest(fsSource(d)), (e) => e instanceof ReleaseHashError && e.code === 'missing');
    writeFileSync(join(d, 'maker/added.mjs'), 'export const x = 1;\n');
    const r = buildManifest(fsSource(d));
    assert.ok(r.files.some((f) => f.path === 'maker/added.mjs'));
    assert.notEqual(r.hash, repo.hash);
    writeFileSync(m, `${orig}\nimport '../../outside.mjs';\n`);
    assert.throws(() => buildManifest(fsSource(d)), (e) => e.code === 'outside');
    writeFileSync(m, `${orig}\nconst p = './x'; await import(p);\n`);
    assert.throws(() => buildManifest(fsSource(d)), (e) => e.code === 'opaque-import');
    writeFileSync(m, `${orig}\nimport 'left-pad';\n`);
    assert.throws(() => buildManifest(fsSource(d)), (e) => e.code === 'undeclared-dependency');
  } finally { rmSync(d, { recursive: true }); }
});

test('a symbolic link in the set is refused', () => {
  const d = copySet(tmp());
  try {
    rmSync(join(d, 'client/keys.mjs')); symlinkSync(join(ROOT, 'client/keys.mjs'), join(d, 'client/keys.mjs'));
    assert.throws(() => buildManifest(fsSource(d)), (e) => e.code === 'symlink');
  } finally { rmSync(d, { recursive: true }); }
});

test('--from-git hashes the committed files, not the working tree, and matches a plain directory with the same content', () => {
  const d = copySet(tmp());
  try {
    const git = (...a) => execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-C', d, ...a], { stdio: 'pipe' });
    git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'release');
    writeFileSync(join(d, 'maker/maker.mjs'), `${readFileSync(join(d, 'maker/maker.mjs'), 'utf8')}// local edit\n`);
    assert.equal(buildManifest(gitSource(d, 'HEAD')).hash, repo.hash);
    assert.notEqual(buildManifest(fsSource(d)).hash, repo.hash);
    assert.equal(cli([d, '--from-git', 'HEAD', '--hash-only']).stdout.trim(), repo.hash);
    assert.equal(cli([d, '--from-git', 'no-such-rev']).status, 1);
  } finally { rmSync(d, { recursive: true }); }
});

test('output carries only file names and hashes, and the shell recipe gives the same hash', () => {
  const out = cli([ROOT]).stdout.split('\n').filter(Boolean);
  assert.equal(out[0], 'silo-maker-release-manifest/1');
  const body = out.slice(1);
  const lines = body.filter((l) => !l.startsWith('sha256:') && !l.startsWith('extra (not hashed): '));
  for (const l of lines) assert.match(l, /^[0-9a-f]{64}  (?:maker|client)\/[A-Za-z0-9._-]+$/);
  assert.equal(body.filter((l) => l.startsWith('sha256:')).length, 1);
  const list = cli([ROOT, '--list']).stdout.split('\n').filter(Boolean);
  const shell = execFileSync('sh', ['-c', "tr '\\n' '\\0' | xargs -0 shasum -a 256 | shasum -a 256"], { cwd: ROOT, input: list.join('\n'), encoding: 'utf8' }).split(' ')[0];
  assert.equal(`sha256:${shell}`, repo.hash);
  assert.equal(cli([]).status, 1);
  assert.equal(cli(['/no/such/dir']).status, 1);
});

// ---- M1: the import reader ---------------------------------------------------------------------------------

const specs = (t) => specifiers(t).specs.sort();
const refused = (t, code) => assert.throws(() => specifiers(t), (e) => e instanceof ReleaseHashError && e.code === code, t);

test('reader: statements, attributes and literal dynamic imports count; comments, strings, templates and regular expressions do not', () => {
  assert.deepEqual(specs(`import a from './a.mjs';\nimport {\n  b,\n} from "./b.mjs";\nexport * from './c.mjs';\nimport './d.mjs';\nconst k = (await import('./e.mjs')).x;\n// says it comes from 'never-landed' or 'legacy'\n/** moves from 'pending' to 'final' */`), ['./a.mjs', './b.mjs', './c.mjs', './d.mjs', './e.mjs']);
  assert.deepEqual(specs(`export { x, y as z } from './f.mjs'; export * as ns from './g.mjs'; export const q = 1; export { q as r };`), ['./f.mjs', './g.mjs']);
  assert.deepEqual(specs(`import * as ns from './a.mjs'; import d, { e as f, 'str name' as g } from './b.mjs';`), ['./a.mjs', './b.mjs']);
});

test('reader (regression): a valid import after a comment is found, in every spot a comment can sit', () => {
  assert.deepEqual(specs(`/* x */ import './hidden.mjs';`), ['./hidden.mjs']);
  assert.deepEqual(specs(`/* a */ /* b */ import x from './h1.mjs';`), ['./h1.mjs']);
  assert.deepEqual(specs(`const a = 1; /* c */ import './h2.mjs';`), ['./h2.mjs']);
  assert.deepEqual(specs(`import/* c */'./h3.mjs';`), ['./h3.mjs']);
  assert.deepEqual(specs(`import a from /* c */ './h4.mjs'; // import './not-this.mjs'`), ['./h4.mjs']);
  assert.deepEqual(specs(`export /* c */ * /* d */ from './h5.mjs';`), ['./h5.mjs']);
  assert.deepEqual(specs(`1;/*\n*/import('./h6.mjs');`), ['./h6.mjs']);
});

test('reader: an import that only a comment mentions is ignored, consistently', () => {
  assert.deepEqual(specs(`// import './nope1.mjs'\n/* import './nope2.mjs'; */\n/*\nimport './nope3.mjs'\n*/\nexport const x = 1;`), []);
  assert.deepEqual(specs(`// import('./nope4.mjs')\n// require('x')\nexport const y = 2;`), []);
});

test('reader: strings, templates and regular expressions hide nothing and invent nothing', () => {
  assert.deepEqual(specs('const s = "import \'./nope.mjs\'"; const t = `import \'./nope2.mjs\' ${1 + 1} /* import \'./nope3.mjs\' */`;'), []);
  assert.deepEqual(specs('const t = `a ${ `b ${ await import(\'./deep.mjs\') }` } c`; import \'./after.mjs\';'), ['./after.mjs', './deep.mjs']);
  assert.deepEqual(specs('const t = `// not a comment ${x} /* nor this`; import \'./real.mjs\';'), ['./real.mjs']);
  assert.deepEqual(specs(`const r = /import '.\\/x'/; const q = /[/*]/g; const d = a / b / c; import './ok.mjs';`), ['./ok.mjs']);
  assert.deepEqual(specs(`const s = "/* "; import './after-string.mjs'; const e = " */";`), ['./after-string.mjs']);
  assert.deepEqual(specs(`const o = { import: 1 }; o.import; x.require_ok = 1;`), []);
});

const stops = (t) => assert.throws(() => specifiers(t), (e) => e instanceof ReleaseHashError, t);

// Test oracle: a real ECMAScript parser (acorn, found in the checkout's node_modules; the tool itself needs no install).
// For a valid module it yields the literal module specifiers and the number of computed import() calls.
let acorn = null;
try { acorn = await import('acorn'); } catch { /* the oracle tests report a skip with the reason */ }
const oracle = !!acorn;
const NO_ORACLE = oracle ? false : 'the acorn parser is not installed in any node_modules above this file; run the tests in a checkout with its dev dependencies';
function oracleOf(src) {
  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }); } catch { return null; }
  const specs = new Set(); let computed = 0;
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if ((n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration' || n.type === 'ExportNamedDeclaration') && n.source) specs.add(n.source.value);
    if (n.type === 'ImportExpression') { if (n.source.type === 'Literal' && typeof n.source.value === 'string') specs.add(n.source.value); else computed++; }
    for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v); }
  };
  walk(ast);
  return { specs, computed };
}
// Tool versus oracle: the tool must match the parser or stop with a ReleaseHashError. Never miss, never invent.
function compare(src, tally) {
  const o = oracleOf(src);
  if (!o) return;
  tally.valid++;
  let r;
  try { r = specifiers(src); } catch (e) { assert.ok(e instanceof ReleaseHashError, `${e}\n${src}`); tally.stopped++; return; }
  assert.equal(o.computed, 0, `silently skipped a computed import in a valid module:\n${src}`);
  assert.deepEqual([...r.specs].sort(), [...o.specs].sort(), `specifiers differ from the parser:\n${src}`);
  tally.accepted++;
}

test('reader (regression, review M1): a division after a closing brace can no longer hide a computed import', () => {
  // `{} / import(p) / 1` is a division of an object by two imports; the old heuristic read /.../ as a regex and skipped the import.
  stops('{} / import(p) / 1');
  stops('x = {} / import(p) / 1;');
  stops('function f() {}\n/ import(p) / 1');
  stops('x = (a)/import(p)/1');
  stops('x = a[0] / import(p) / 1');
  stops('x = n++ / import(p) / 1');
  stops('x = n-- / import(p) / 1');
  stops('x = of / import(p) / 1');
  stops('x = `t` / import(p) / 1');
  // a literal specifier after a division is found as a real import (never skipped)
  assert.deepEqual(specs(`x = a / b / import('./m.mjs');`), ['./m.mjs']);
  assert.deepEqual(specs(`x = (a)/import('./m.mjs')/1;`), ['./m.mjs']);
  assert.deepEqual(specs(`x = a[0] / import('./m.mjs') / 1;`), ['./m.mjs']);
  assert.deepEqual(specs(`x = 4 / import('./m.mjs');`), ['./m.mjs']);
  assert.deepEqual(specs('x = `t` / import(\'./m.mjs\');'), ['./m.mjs']);
  assert.deepEqual(specs(`x = o.return / import('./m.mjs');`), ['./m.mjs']);
  // the refusal names the line
  assert.throws(() => specifiers('a;\nb;\n{} / c'), (e) => e instanceof ReleaseHashError && e.code === 'unparseable' && /line 3/.test(e.message));
});

test('reader: regular expression literals are recognised where they are certain, division where it is certain', () => {
  const hides = (t) => assert.deepEqual(specs(`${t}\nimport './ok.mjs';`), ['./ok.mjs'], t);
  hides(`x = (/import(p)/);`);
  hides(`f(/import(p)/);`);
  hides(`f(a, /import(p)/);`);
  hides(`x = /import(p)/;`);
  hides(`function g() { return /import(p)/; }`);
  hides(`x = typeof /import(p)/;`);
  hides(`switch (a) { case /import(p)/.test(b): break; }`);
  hides(`if (a) /import(p)/.test(b);`);
  hides(`while (a) /import(p)/.test(b);`);
  hides(`x = a ? /import(p)/ : /require(q)/;`);
  hides(`x = [/import(p)/, /eval(q)/];`);
  hides(`x = !/import(p)/.test(b);`);
  hides(`x = () => /import(p)/;`);
  hides('x = `${/import(p)/.test(b)}`;');
  hides(`x = a / b / c;`);
  hides(`x = (a) / b / c;`);
  hides(`x = a[0] / b / c;`);
  hides(`x = a.in / b / c;`);
  hides(`x = 10 / 2 / 5;`);
  hides(`for await (const a of b) /import(p)/.test(a);`);
  // ambiguous contexts stop the tool instead of guessing
  stops('{}\n/import(p)/.test(b)');
  stops('x = a++ /import(p)/ 2');
  stops('x = ++/import(p)/.lastIndex');
  stops('for (const a of /import(p)/g) {}');
  stops('x = await /import(p)/g');
});

test('reader (fuzz): over many slash contexts a real import is either found or the tool stops, never silently skipped', () => {
  let seed = 20261111;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  // Prefixes after which a slash is division when the whole statement is valid JavaScript, or after which it is ambiguous.
  const divisionOrAmbiguous = ['{}', 'x = {}', 'function f() {}', 'class C {}', '(a)', 'f(b)', 'a[0]', 'a', 'a.b', 'a.return', 'a.in', '1', '0x1f', '1.5e3', '"s"', "'s'", '`t`', '/r/g', 'a++', 'a--', 'of', 'yield', 'await', 'async', 'let', 'static', 'x => {}', 'x = function () {}', 'x = { a: 1 }', 'if (a) {}', 'try {} finally {}', 'this', 'null', 'true', 'undefined', 'a?.b', 'import.meta.url', 'f()()', 'a[b][c]', '((a))', 'new X'];
  const tails = ['/ import(p) / 1', '/import(p)/1', ' / import(p) / 1', '\n/ import(p) / 1', '/* c */ / import(p) / 1', '/ import(p)'];
  let checked = 0, validParsed = 0;
  for (const pre of divisionOrAmbiguous) for (const tail of tails) {
    const src = `${rnd(3) ? 'x;\n' : ''}${pre} ${tail}`;
    let result;
    try { result = specifiers(src); } catch (e) { assert.ok(e instanceof ReleaseHashError, src); checked++; continue; }
    // not stopped: judged by a real parser when the text is a valid module (see the oracle tests below); text that is not valid JavaScript has no meaning to compare
    const o = oracle ? oracleOf(src) : null;
    if (o) { validParsed++; assert.equal(o.computed, 0, `a computed import in an accepted valid module: ${JSON.stringify(src)}`); assert.deepEqual([...result.specs].sort(), [...o.specs].sort(), src); }
    checked++;
  }
  assert.equal(checked, divisionOrAmbiguous.length * tails.length);
  void validParsed;
  // Statements that make the slash certainly division: the computed import must always be refused.
  for (const pre of ['a', 'a.b', '1', '"s"', 'a[0]', '(a)', 'f(b)', '`t`', 'a.return', 'a.in', 'this', 'null', 'x.y.z', '1.5', 'f()()']) {
    for (const tail of ['/ import(p) / 1', '/import(p)/1', ' / import(p)']) stops(`x = ${pre} ${tail};`);
  }
  // Statements where the slash is certainly a regular expression: an import() mention inside it is hidden, and a following literal import is found.
  for (const pre of ['x =', 'f(', 'f(a,', '[', '{ a:', 'return', 'typeof', 'void', 'case', 'throw', 'delete', 'in', 'instanceof', '!', '&&', '||', '?', ':', '+', '-', '*', '%', '<', '>', '=>', ';', '(', ',', '=']) {
    const src = `${pre} /import(p)/.test(z)\nimport './after.mjs';`;
    try { assert.deepEqual(specs(src), ['./after.mjs'], src); } catch (e) { if (!(e instanceof ReleaseHashError)) throw e; /* stopping is also acceptable */ }
  }
});

test('reader (regression, review M1 round 3): private names are one token; keyword-named ones stop the tool, others do not hide imports', () => {
  // the two review examples are valid modules: the tool must stop (or find the import), never skip it
  const a = "const p = './hidden.mjs'; class C { #return = 1; f(){ return this.#return / import(p) / 1; } } new C().f();";
  const b = "const p = './hidden.mjs'; class C { #if(){ return 1; } f(){ return this.#if() / import(p) / 1; } } new C().f();";
  for (const t of [a, b]) { assert.ok(oracle ? oracleOf(t) : true, 'valid module'); stops(t); }
  // a private name that is not a keyword is an operand: the computed import is refused, a literal one is in the closure
  stops("class C { #r = 1; f(){ return this.#r / import(p) / 1; } }");
  assert.deepEqual(specs("class C { #r = 1; f(){ return this.#r / import('./m1.mjs') / 1; } }"), ['./m1.mjs']);
  assert.deepEqual(specs("class C { #r(){ return 2; } f(){ return this.#r() / import('./m2.mjs') / 1; } }"), ['./m2.mjs']);
  assert.deepEqual(specs("class C { static #r = 4; f(){ return C.#r / import('./m3.mjs'); } }"), ['./m3.mjs']);
  assert.deepEqual(specs("class C { #r = 4; f(o){ return #r in o / import('./m4.mjs'); } }"), ['./m4.mjs']);
  assert.deepEqual(specs("class C { #r = 4; f(){ if (1) this.#r / 2 / 3; } } import './m5.mjs';"), ['./m5.mjs']);
  // every keyword or watched word as a private name stops the tool, in every position
  for (const k of ['return', 'if', 'while', 'for', 'with', 'in', 'of', 'yield', 'await', 'typeof', 'new', 'delete', 'else', 'case', 'do', 'throw', 'void', 'instanceof', 'import', 'export', 'default', 'extends', 'eval', 'require', 'createRequire', 'Function', 'get', 'set', 'static', 'async', 'let', 'this', 'super', 'null', 'true']) {
    for (const t of [`class C { #${k} = 1; f(){ return this.#${k} / 2; } }`, `class C { #${k}(){} f(){ this.#${k}() / import('./x.mjs'); } }`, `class C { static #${k} = 1; }`]) refused(t, 'unparseable');
  }
  refused('x = a # b', 'unparseable');
  refused('x = #', 'unparseable');
  // and the plain forms around them keep working
  assert.deepEqual(specs("class C { #a = 1; #b = 2; f(){ return this.#a + this.#b; } } import './m6.mjs';"), ['./m6.mjs']);
  assert.deepEqual(tokenize('this.#abc / 2').toks.map((t) => t.t), ['id', 'p', 'priv', 'p', 'num']);
});

test('reader (oracle): over generated valid modules the tool matches a real parser or stops, and never misses an import', { skip: NO_ORACLE }, () => {
  const tally = { valid: 0, accepted: 0, stopped: 0 };
  const HEAD = "const p = './h.mjs', s = '', a = 1, x = 2, o = { if: 1, return: 2, in: 3, of: 4 }; let y = 1;\n";
  const WORDS = ['return', 'if', 'while', 'for', 'with', 'in', 'of', 'yield', 'await', 'typeof', 'new', 'delete', 'else', 'case', 'do', 'throw', 'void', 'instanceof', 'import', 'export', 'default', 'extends', 'class', 'function', 'this', 'super', 'null', 'true', 'static', 'get', 'set', 'async', 'let', 'var', 'const', 'eval', 'require', 'Function', 'catch', 'finally', 'switch', 'try', 'break', 'continue', 'debugger', 'enum', 'false', 'from', 'as', 'meta', 'url', 'target', 'arguments', 'undefined', 'abc'];
  const TAILS = ['/ import(p) / 1', "/ import('./lit.mjs') / 1", '/import(p)/1', "/ 2 / import('./lit2.mjs')"];
  for (const k of WORDS) for (const tl of TAILS) {
    const progs = [
      `class C { #${k} = 1; f(){ return this.#${k} ${tl}; } }`,
      `class C { #${k}(){ return 1; } f(){ return this.#${k}() ${tl}; } }`,
      `class C { static #${k} = 1; f(){ return C.#${k} ${tl}; } }`,
      `class C { #${k} = 1; f(){ return (this.#${k}) ${tl}; } }`,
      `class C { #${k} = 1; f(){ if (1) this.#${k} ${tl}; } }`,
      `class C { #${k} = 1; f(o){ return #${k} in o ${tl}; } }`,
      `class C { #${k} = 1; f(){ return this?.#${k} ${tl}; } }`,
      `class C { #${k} = 1; f(){ x = [this.#${k}]\n${tl}; } }`,
      `o.${k} ${tl};`, `o.${k}(1) ${tl};`, `o?.${k} ${tl};`, `o?.${k}() ${tl};`, `o.${k}\n${tl};`,
      `x = { ${k}: 1 }.${k} ${tl};`, `x = { ${k}: 1 }\n${tl};`, `x = o['${k}'] ${tl};`,
      `class C { ${k}(){ return 1; } f(){ return this.${k}() ${tl}; } }`,
    ];
    for (const body of progs) compare(HEAD + body, tally);
  }
  // operands and positions
  const OPERANDS = ['a', '1', "'s'", '`t`', '/r/', '/r/g', '(a)', '(a, x)', '[a][0]', '[a]', 'a++', 'a--', 'o.x', 'o.return', 'o.if', 'o.of', 'o.await', 'o.yield', 'f()', 'f(a)(x)', 'this', 'null', 'true', 'undefined', 'new Object', '(function(){})', '(() => 1)', '({})', '({}).x', 'async', 'let', 'of', 'yield', 'await', 'static', 'get', 'x => x', 'function(){ }', '{ a: 1 }', 'class {}', 'import.meta.url'];
  const POSITIONS = [(e) => `x = ${e};`, (e) => `function w(){ return ${e}; }`, (e) => `f(${e});`, (e) => `if (a) ${e};`, (e) => `if (${e}) {}`, (e) => `while (0) ${e};`, (e) => `for (;0;) ${e};`, (e) => `for (const q of [1]) ${e};`, (e) => `async function w(){ for await (const q of []) ${e}; }`, (e) => `{ ${e}; }`, (e) => `{}\n${e};`, (e) => `;${e};`, (e) => `if (a) {} else ${e};`, (e) => `do ${e}; while (0)`, (e) => `x = a ? ${e} : 1;`, (e) => `x = [${e}];`, (e) => `x = \`${'${'}${e}}\`;`, (e) => `x = () => ${e};`, (e) => `export default ${e};`, (e) => `label: ${e};`, (e) => `switch (a) { case 1: ${e}; }`, (e) => `x = typeof ${e};`, (e) => `x = !${e};`, (e) => `throw ${e};`, (e) => `x = new (${e});`];
  const FORMS = [(op) => `${op} / import(p) / 1`, (op) => `${op}\n/ import(p) / 1`, (op) => `${op} /import(p)/ 1`, (op) => `${op} / import('./lit3.mjs') / 1`, (op) => `${op} / 2 / import(p)`, (op) => `/import(p)/.test(${op})`, (op) => `${op}, /import(p)/.test(s)`];
  for (const op of OPERANDS) for (const form of FORMS) for (const pos of POSITIONS) compare(HEAD + pos(form(op)), tally);
  // the regular expression itself, in positions where it is one
  for (const pos of POSITIONS) for (const re of ['/import(p)/', '/import(p)/g', '/[/]import(p)/', '/\\//', "/import('./nope.mjs')/", '/ /', '/=/']) compare(HEAD + pos(re) + "\nimport './after.mjs';", tally);
  // seeded random expressions, kept only when they are valid modules
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >>> 8) % n; };
  const pick = (arr) => arr[rnd(arr.length)];
  const TERMS = ['a', 'x', '1', '2.5', "'s'", '`t`', '/q/', '/import(p)/g', 'import(p)', "import('./lit4.mjs')", 'o.return', 'o.if', 'this.#m', 'this.#n()', '#m in this', 'f()', '[a]', '({})', 'o.in', 'a++', '--x', 'y'];
  const gen = (d) => {
    if (d <= 0 || !rnd(4)) return pick(TERMS);
    switch (rnd(9)) {
      case 0: case 1: case 2: return `${gen(d - 1)}${pick([' / ', '/', ' /\n'])}${gen(d - 1)}`;
      case 3: return `(${gen(d - 1)})`;
      case 4: return `${gen(d - 1)}${pick([' + ', ' && ', ' , ', ' ? 1 : ', ' in ', ' instanceof ', ' * '])}${gen(d - 1)}`;
      case 5: return `${pick(['!', 'typeof ', 'void ', '-', '+', 'await '])}${gen(d - 1)}`;
      case 6: return `${gen(d - 1)}[${gen(d - 1)}]`;
      case 7: return `f(${gen(d - 1)}, ${gen(d - 1)})`;
      default: return `${gen(d - 1)}.${pick(WORDS)}${pick(['', '()', ' '])}`;
    }
  };
  const CLASS = 'class C { #m = 1; #n(){ return 1; } f(o){ ';
  for (let i = 0; i < 6000; i++) {
    const e = gen(4);
    const wrap = pick([(z) => `${z};`, (z) => `if (a) ${z};`, (z) => `x = ${z};`, (z) => `${z}\nyield_;`, (z) => `while (y) ${z};`, (z) => `for (;;) { ${z} }`, (z) => `{} ${z};`]);
    compare(HEAD + CLASS + wrap(e) + ' } }', tally);
    compare(HEAD + 'async function g(o){ ' + wrap(e) + ' }', tally);
    compare(HEAD + wrap(e), tally);
  }
  if (process.env.TALLY) console.error(JSON.stringify(tally));
  assert.ok(tally.valid > 5000, `the corpus produced too few valid modules (${JSON.stringify(tally)})`);
  assert.ok(tally.accepted > 1000, `the tool accepted too few valid modules; it may be stopping on everything (${JSON.stringify(tally)})`);
  assert.ok(tally.stopped > 100, `no stops seen (${JSON.stringify(tally)})`);
});

test('reader: import attributes are followed for the specifier and never produce one', () => {
  assert.deepEqual(specs(`import a from './a.mjs' with { type: 'javascript' };`), ['./a.mjs']);
  assert.deepEqual(specs(`import './b.mjs' with { type: "x" };`), ['./b.mjs']);
  assert.deepEqual(specs(`const m = await import('./c.mjs', { with: { type: 'javascript' } });`), ['./c.mjs']);
  assert.deepEqual(specs(`export * from './d.mjs' with { type: 'javascript' };`), ['./d.mjs']);
});

test('reader: fails closed on every unsupported loading form', () => {
  for (const t of [`const r = require('x');`, `const { createRequire } = await import('node:module');`, `eval('1')`, `const f = new Function('return 1');`, `Function('return 1')()`, `(() => {}).constructor('return 1')()`,
    `await import(p);`, `await import('./a' + b);`, 'await import(`./a.mjs`);', `await import();`, `await import(...a);`,
    `const u = import.meta.resolve('./x.mjs');`, `const u = import.meta;`, `const u = new URL('./x.mjs', import.meta.url);`, `const u = import.meta.url;`,
    `import w from 'node:worker_threads';`, `import vm from 'vm';`, `import './a\\u002emjs';`, `ev\\u0061l('1')`]) {
    assert.throws(() => specifiers(t), (e) => e instanceof ReleaseHashError && (e.code === 'opaque-import' || e.code === 'unparseable'), t);
  }
  for (const t of [`/* never closed`, `const s = 'never closed`, 'const t = `never closed', 'const t = `a ${ b', `const r = /never closed`, `import { a from './x.mjs'`, `import a from`, `export * from`]) refused(t, 'unparseable');
  // a line that starts with import inside a template is ambiguous for the reader, so it stops instead of guessing
  refused('const t = `\nimport \'./x.mjs\'\n`;', 'unparseable');
});

test('reader: the entry point check import.meta.url === ... is accepted, nothing else about import.meta is', () => {
  assert.deepEqual(specs('if (import.meta.url === `file://${process.argv[1]}`) { main(); }'), []);
  assert.deepEqual(specs('if (`file://${process.argv[1]}` === import.meta.url) { main(); }'), []);
  refused('const here = import.meta.url;', 'opaque-import');
});

test('a changed module that only a comment-prefixed import reaches changes the manifest and the hash (regression for the missed import)', () => {
  const d = copySet(tmp());
  try {
    const m = join(d, 'maker/maker.mjs'), orig = readFileSync(m, 'utf8');
    writeFileSync(m, `${orig}\n/* x */ import './hidden.mjs';\n`);
    writeFileSync(join(d, 'maker/hidden.mjs'), 'export const v = 1;\n');
    const a = buildManifest(fsSource(d));
    assert.ok(a.files.some((f) => f.path === 'maker/hidden.mjs'));
    writeFileSync(join(d, 'maker/hidden.mjs'), 'export const v = 2;\n');
    const b = buildManifest(fsSource(d));
    assert.notEqual(a.hash, b.hash);
    assert.notEqual(a.manifest, b.manifest);
  } finally { rmSync(d, { recursive: true }); }
});

test('a module with an unsupported loading form stops the tool and names the file', () => {
  const d = copySet(tmp());
  try {
    const m = join(d, 'maker/maker.mjs'), orig = readFileSync(m, 'utf8');
    for (const line of ["const x = require('fs');", "eval('1');", 'await import(`./${n}.mjs`);', "new Function('a');"]) {
      writeFileSync(m, `${orig}\n${line}\n`);
      assert.throws(() => buildManifest(fsSource(d)), (e) => e.code === 'opaque-import' && e.message.startsWith('maker/maker.mjs:'), line);
    }
  } finally { rmSync(d, { recursive: true }); }
});

test('tokenize: positions and kinds', () => {
  const { toks } = tokenize(`#!/usr/bin/env node\nconst a = 'x'; // c\n`);
  assert.deepEqual(toks.map((t) => t.t), ['id', 'id', 'p', 'str', 'p']);
});

// ---- M2: file system containment and secret avoidance ------------------------------------------------------

test('a symbolic link in any ancestor directory is refused, even when it leads to real files', () => {
  const outside = tmp();
  const d = copySet(tmp());
  try {
    copySet(outside);
    rmSync(join(d, 'client'), { recursive: true }); symlinkSync(join(outside, 'client'), join(d, 'client'));
    assert.throws(() => buildManifest(fsSource(d)), (e) => e.code === 'symlink');
    rmSync(join(d, 'client')); copySet(d);
    rmSync(join(d, 'maker'), { recursive: true }); symlinkSync(join(outside, 'maker'), join(d, 'maker'));
    assert.throws(() => buildManifest(fsSource(d)), (e) => e.code === 'symlink');
  } finally { rmSync(d, { recursive: true }); rmSync(outside, { recursive: true }); }
});

test('a nested directory that is a symbolic link, reached by an import, is refused', () => {
  const outside = tmp();
  const d = copySet(tmp());
  try {
    mkdirSync(join(outside, 'lib')); writeFileSync(join(outside, 'lib/x.mjs'), 'export const x = 1;\n');
    symlinkSync(join(outside, 'lib'), join(d, 'client/lib'));
    const m = join(d, 'maker/maker.mjs');
    writeFileSync(m, `${readFileSync(m, 'utf8')}\nimport '../client/lib/x.mjs';\n`);
    assert.throws(() => buildManifest(fsSource(d)), (e) => e.code === 'symlink');
  } finally { rmSync(d, { recursive: true }); rmSync(outside, { recursive: true }); }
});

test('a referenced json file other than the two package files is refused and its content is never hashed or printed', () => {
  const d = copySet(tmp());
  try {
    writeFileSync(join(d, 'client/config.json'), '{"apiToken":"hunter2-SECRET"}\n');
    const m = join(d, 'maker/maker.mjs');
    writeFileSync(m, `${readFileSync(m, 'utf8')}\nimport cfg from '../client/config.json' with { type: 'json' };\n`);
    assert.throws(() => buildManifest(fsSource(d)), (e) => e.code === 'disallowed-file' && !e.message.includes('hunter2'));
    const out = cli([d]);
    assert.equal(out.status, 1);
    assert.ok(!out.stdout.includes('hunter2') && !out.stderr.includes('hunter2'));
  } finally { rmSync(d, { recursive: true }); }
});

test('a code file whose content looks like a secret is refused without printing it', () => {
  const d = copySet(tmp());
  try {
    const m = join(d, 'maker/maker.mjs'), orig = readFileSync(m, 'utf8');
    writeFileSync(m, `${orig}\nimport './leak.mjs';\n`);
    const bad = {
      pem: '// -----BEGIN PRIVATE KEY-----\n// abcd\nexport const x = 1;\n',
      bytes: `export const k = [${Array.from({ length: 64 }, (_, i) => i * 3 % 256).join(',')}];\n`.replace('export const k = ', ''),
      env: 'MAKER_API_TOKEN=abc123xyz\n',
      token: 'a'.repeat(64),
    };
    for (const [name, content] of Object.entries(bad)) {
      writeFileSync(join(d, 'maker/leak.mjs'), content);
      assert.throws(() => buildManifest(fsSource(d)), (e) => e.code === 'secret-like' && !e.message.includes('abc123xyz'), name);
    }
    writeFileSync(join(d, 'maker/leak.mjs'), 'export const fine = 1;\n');
    assert.doesNotThrow(() => buildManifest(fsSource(d)));
  } finally { rmSync(d, { recursive: true }); }
});

test('secret heuristics: real release files pass, obvious secrets do not', () => {
  for (const f of repo.files) assert.equal(looksSecret(readFileSync(join(ROOT, f.path), 'utf8')), null, f.path);
  assert.ok(looksSecret('-----BEGIN OPENSSH PRIVATE KEY-----\nxx\n-----END OPENSSH PRIVATE KEY-----'));
  assert.ok(looksSecret(`[${Array.from({ length: 64 }, (_, i) => i).join(', ')}]`));
});

test('file names outside the safe set are refused, so the shell recipe cannot be confused by them', () => {
  const d = copySet(tmp());
  try {
    const m = join(d, 'maker/maker.mjs');
    writeFileSync(join(d, 'maker/two words.mjs'), 'export const x = 1;\n');
    writeFileSync(m, `${readFileSync(m, 'utf8')}\nimport './two words.mjs';\n`);
    assert.throws(() => buildManifest(fsSource(d)), (e) => e.code === 'bad-filename');
    writeFileSync(m, readFileSync(join(ROOT, 'maker/maker.mjs')));
    writeFileSync(join(d, 'maker/odd\\name\'.mjs'), 'x');
    const r = buildManifest(fsSource(d));
    assert.equal(r.hash, repo.hash);
    assert.ok(r.extras.every((x) => !x.includes('\n')));
    assert.ok(r.extras.includes('maker/"odd\\\\name\'.mjs"'));
  } finally { rmSync(d, { recursive: true }); }
});

test('line endings are part of the digest: CRLF differs from LF', () => {
  const d = copySet(tmp());
  try {
    const f = join(d, 'client/keys.mjs');
    writeFileSync(f, readFileSync(f, 'utf8').replace(/\n/g, '\r\n'));
    assert.notEqual(buildManifest(fsSource(d)).hash, repo.hash);
  } finally { rmSync(d, { recursive: true }); }
});

// ---- git mode: one pinned commit -----------------------------------------------------------------------------

test('--from-git resolves the revision once to a commit id and reads every blob from it', () => {
  const d = copySet(tmp());
  try {
    const git = (...a) => execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-C', d, ...a], { stdio: 'pipe' }).toString().trim();
    git('init', '-q'); git('checkout', '-q', '-b', 'rel'); git('add', '.'); git('commit', '-q', '-m', 'one');
    const c1 = git('rev-parse', 'HEAD');
    const src = gitSource(d, 'rel');
    assert.equal(src.commit, c1);
    writeFileSync(join(d, 'maker/maker.mjs'), `${readFileSync(join(d, 'maker/maker.mjs'), 'utf8')}// second\n`);
    git('commit', '-q', '-am', 'two');
    assert.notEqual(git('rev-parse', 'rel'), c1);
    assert.equal(buildManifest(src).hash, repo.hash, 'the open source still reads the earlier commit');
    assert.notEqual(buildManifest(gitSource(d, 'rel')).hash, repo.hash);
    assert.equal(JSON.parse(cli([d, '--from-git', c1, '--json']).stdout).commit, c1);
  } finally { rmSync(d, { recursive: true }); }
});

test('--from-git refuses a symbolic link in an ancestor directory of the tree', () => {
  const d = copySet(tmp());
  try {
    const git = (...a) => execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-C', d, ...a], { stdio: 'pipe' });
    const outside = tmp(); copySet(outside);
    rmSync(join(d, 'client'), { recursive: true }); symlinkSync(join(outside, 'client'), join(d, 'client'));
    git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'link');
    assert.throws(() => buildManifest(gitSource(d, 'HEAD')), (e) => e instanceof ReleaseHashError && ['symlink', 'missing'].includes(e.code));
    rmSync(outside, { recursive: true });
  } finally { rmSync(d, { recursive: true }); }
});
