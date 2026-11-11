import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519';
import { loadPinnedKeys, verifyMakerList, classifyMaker, makerMatchesEscrow, normalizeMakerUrl } from '../lib/silo/maker-list/index.mjs';

// Test keys exist only inside this file. No real signing key is created or used.
const b64 = (u8) => Buffer.from(u8).toString('base64');
const hex = (u8) => Buffer.from(u8).toString('hex');
const mkKey = (id) => { const sk = ed25519.utils.randomPrivateKey(); return { id, sk, pub: hex(ed25519.getPublicKey(sk)) }; };
const A = mkKey('test-a'), B = mkKey('test-b'), C = mkKey('test-c'), STRANGER = mkKey('test-x');
const PIN = [A, B, C].map((k) => ({ keyId: k.id, publicKey: k.pub }));
const PROGRAM = '7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS';
const ADDR = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'; // any valid 32-byte base58 shape
const NOW = Date.parse('2026-11-12T12:00:00Z');
const maker = (over = {}) => ({ id: 'maker-one', url: 'https://maker-one.example', solanaAddress: ADDR, caps: { minXmr: '0.001', maxXmrPerSwap: '0.05', maxXmrPerDay: '0.3', maxOpenSwaps: 3 }, spreadBps: 200, buildHash: null, buildHashStatus: 'not proven', contact: 'ops@maker-one.example', ...over });
const payload = (over = {}) => ({ format: 'silo-maker-list/1', version: 5, issuedAt: '2026-11-11T00:00:00Z', expiresAt: '2026-12-11T00:00:00Z', network: 'mainnet-beta', programId: PROGRAM, makers: [maker()], ...over });
const sign = (bytes, keys) => keys.map((k) => ({ keyId: k.id, alg: 'ed25519', sig: b64(ed25519.sign(bytes, k.sk)) }));
const envelope = (p = payload(), keys = [A, B]) => { const bytes = Buffer.from(JSON.stringify(p)); return { payload: b64(bytes), signatures: sign(bytes, keys) }; };
const opts = (over = {}) => ({ pinnedKeys: PIN, threshold: 2, now: NOW, lastSeenVersion: null, network: 'mainnet-beta', programId: PROGRAM, ...over });
const reason = (env, o) => { const r = verifyMakerList(env, opts(o)); assert.equal(r.ok, false); return r.reason; };

test('a valid list with two of three pinned signatures passes and returns the parsed list', () => {
  const r = verifyMakerList(envelope(), opts());
  assert.equal(r.ok, true);
  assert.equal(r.list.version, 5);
  assert.equal(r.list.makers[0].url, 'https://maker-one.example');
  assert.deepEqual(r.signedBy, ['test-a', 'test-b']);
});

test('a changed payload byte is refused', () => {
  const env = envelope();
  const bytes = Buffer.from(env.payload, 'base64'); bytes[bytes.length - 3] ^= 1;
  assert.equal(reason({ ...env, payload: b64(bytes) }), 'below-threshold');
});

test('re-serialised JSON with different spacing fails: the signature covers exact bytes', () => {
  const env = envelope();
  const spaced = Buffer.from(JSON.stringify(payload(), null, 2));
  assert.equal(reason({ payload: b64(spaced), signatures: env.signatures }), 'below-threshold');
});

test('an unpinned key does not count, and one key signing twice counts once', () => {
  assert.equal(reason(envelope(payload(), [A, STRANGER])), 'below-threshold');
  const e = envelope(payload(), [A]);
  e.signatures.push(e.signatures[0]);
  assert.equal(reason(e), 'below-threshold');
});

test('a pinned keyId carrying another key signature is refused', () => {
  const bytes = Buffer.from(JSON.stringify(payload()));
  const sigs = [{ keyId: 'test-a', alg: 'ed25519', sig: b64(ed25519.sign(bytes, STRANGER.sk)) }, { keyId: 'test-b', alg: 'ed25519', sig: b64(ed25519.sign(bytes, B.sk)) }];
  assert.equal(reason({ payload: b64(bytes), signatures: sigs }), 'below-threshold');
});

test('below threshold: one signature when two are required', () => {
  assert.equal(reason(envelope(payload(), [A])), 'below-threshold');
  assert.equal(verifyMakerList(envelope(payload(), [A]), opts({ threshold: 1 })).ok, true);
});

test('expired list is refused but handed back as a verified stale list', () => {
  const r = verifyMakerList(envelope(), opts({ now: Date.parse('2026-12-11T00:00:00Z') }));
  assert.equal(r.ok, false); assert.equal(r.reason, 'expired');
  assert.equal(r.staleList.makers.length, 1);
});

test('a list dated in the future is refused', () => {
  assert.equal(reason(envelope(), { now: Date.parse('2026-11-10T00:00:00Z') }), 'not-yet-valid');
});

test('rollback: an older version than the one already seen is refused; the same version is fine', () => {
  assert.equal(reason(envelope(), { lastSeenVersion: 6 }), 'rollback');
  assert.equal(verifyMakerList(envelope(), opts({ lastSeenVersion: 5 })).ok, true);
});

test('wrong network and wrong program id are refused', () => {
  assert.equal(reason(envelope(), { network: 'devnet' }), 'wrong-network');
  assert.equal(reason(envelope(), { programId: ADDR }), 'wrong-program');
});

test('duplicate maker id or URL is refused (URL compared after normalisation)', () => {
  assert.equal(reason(envelope(payload({ makers: [maker(), maker({ url: 'https://other.example' })] }))), 'duplicate-maker');
  assert.equal(reason(envelope(payload({ makers: [maker(), maker({ id: 'maker-two', url: 'https://MAKER-ONE.example/' })] }))), 'duplicate-maker');
});

test('oversize payload is refused', () => {
  const big = Buffer.alloc(70000, 32);
  assert.equal(reason({ payload: b64(big), signatures: sign(big, [A, B]) }), 'payload-too-large');
});

test('malformed base64 is refused', () => {
  for (const bad of ['not base64!', 'abc', 'YWJj\nZA==', '', 42]) assert.equal(reason({ payload: bad, signatures: envelope().signatures }), 'bad-base64');
});

test('unknown format, unknown fields and bad envelope shapes are refused', () => {
  assert.equal(reason(envelope(payload({ format: 'silo-maker-list/2' }))), 'unknown-format');
  assert.equal(reason(envelope({ ...payload(), extra: 1 })), 'bad-fields');
  assert.equal(reason(envelope(payload({ version: 1.5 }))), 'bad-fields');
  assert.equal(reason(envelope(payload({ expiresAt: '2027-12-11T00:00:00Z' }))), 'bad-fields');
  assert.equal(reason({ payload: envelope().payload }), 'bad-envelope');
  assert.equal(reason({ ...envelope(), signatures: [{ keyId: 'test-a', alg: 'rsa', sig: 'AA==' }] }), 'bad-signature-field');
});

test('maker field limits: http, credentials, bad address, spread, caps, build hash claims', () => {
  const bad = (over) => reason(envelope(payload({ makers: [maker(over)] })));
  assert.equal(bad({ url: 'http://maker-one.example' }), 'bad-maker');
  assert.equal(bad({ url: 'https://user:pw@maker-one.example' }), 'bad-maker');
  assert.equal(bad({ url: 'https://maker-one.example/?x=1' }), 'bad-maker');
  assert.equal(bad({ url: 'https://127.0.0.1' }), 'bad-maker');
  assert.equal(bad({ solanaAddress: 'abc' }), 'bad-maker');
  assert.equal(bad({ spreadBps: 2001 }), 'bad-maker');
  assert.equal(bad({ spreadBps: 1.5 }), 'bad-maker');
  assert.equal(bad({ spreadBps: -1 }), 'bad-maker');
  assert.equal(bad({ caps: { minXmr: '0.1', maxXmrPerSwap: '0.05', maxXmrPerDay: '0.3', maxOpenSwaps: 3 } }), 'bad-maker');
  assert.equal(bad({ caps: { minXmr: '0.001', maxXmrPerSwap: '0.05', maxXmrPerDay: '0.3', maxOpenSwaps: 0 } }), 'bad-maker');
  assert.equal(bad({ buildHash: null, buildHashStatus: 'proven' }), 'bad-maker');
  assert.equal(bad({ buildHash: 'sha256:abc', buildHashStatus: 'not proven' }), 'bad-maker');
  assert.equal(bad({ extra: true }), 'bad-maker');
});

test('http on localhost is accepted only in test mode', () => {
  const env = envelope(payload({ makers: [maker({ url: 'http://localhost:8787' })] }));
  assert.equal(reason(env), 'bad-maker');
  assert.equal(verifyMakerList(env, opts({ testMode: true })).ok, true);
});

test('bad verifier options are refused, not guessed', () => {
  assert.equal(reason(envelope(), { threshold: 4 }), 'bad-options');
  assert.equal(reason(envelope(), { now: undefined }), 'bad-options');
  assert.equal(reason(envelope(), { network: 'mainnet' }), 'bad-options');
});

test('classifyMaker labels listed and unlisted and never blocks a typed URL', () => {
  const { list } = verifyMakerList(envelope(), opts());
  const hit = classifyMaker('https://Maker-One.example/', list);
  assert.equal(hit.classification, 'listed'); assert.equal(hit.maker.id, 'maker-one');
  assert.deepEqual(classifyMaker('https://somebody-else.example', list), { classification: 'unlisted' });
  assert.deepEqual(classifyMaker('https://203.0.113.9:8443', list), { classification: 'unlisted' });
  assert.deepEqual(classifyMaker('https://maker-one.example', null), { classification: 'unlisted' });
  assert.deepEqual(classifyMaker('ftp://x', list), { classification: 'invalid-url' });
  assert.equal(normalizeMakerUrl('https://a.example/v1/'), 'https://a.example/v1');
});

// ---- A5 hardening: byte rules, canonical form, version bounds ----
const signedRaw = (text) => { const bytes = Buffer.from(text, 'latin1'); return { payload: b64(bytes), signatures: sign(bytes, [A, B]) }; };
const compact = () => JSON.stringify(payload());

test('canonical form: spacing, number spelling, redundant escapes and duplicate keys are refused even when correctly signed', () => {
  assert.equal(reason(signedRaw(JSON.stringify(payload(), null, 1))), 'non-ascii'); // newlines are control bytes
  assert.equal(reason(signedRaw(compact().replace(/,/g, ', '))), 'non-canonical');
  assert.equal(reason(signedRaw(compact().replace('"version":5', '"version":5.0'))), 'non-canonical');
  assert.equal(reason(signedRaw(compact().replace('"version":5', '"version":5e0'))), 'non-canonical');
  assert.equal(reason(signedRaw(compact().replace('"network":"mainnet-beta"', '"network":"mainnet\\u002dbeta"'))), 'non-canonical');
  assert.equal(reason(signedRaw(compact().replace('"version":5', '"version":4,"version":5'))), 'non-canonical');
  assert.equal(verifyMakerList(signedRaw(compact()), opts()).ok, true);
});

test('non-ASCII bytes are refused: raw direction override, raw look-alike letters, control bytes', () => {
  for (const ch of ['‮', 'а', '​', '\u0007']) {
    const bytes = Buffer.from(compact().replace('ops@maker-one.example', `ops${ch}@maker-one.example`), 'utf8');
    assert.equal(reason({ payload: b64(bytes), signatures: sign(bytes, [A, B]) }), 'non-ascii');
  }
});

test('escaped control and direction-override characters are refused after parsing', () => {
  for (const esc of ['\\u202e', '\\u200b', '\\u0001', '\\u007f', '\\u0085']) {
    assert.equal(reason(signedRaw(compact().replace('ops@maker-one.example', `ops${esc}@maker-one.example`))), 'bad-characters', esc);
  }
  assert.equal(reason(signedRaw(compact().replace('"format"', '"for\\u202emat"'))), 'bad-characters');
});

test('minVersion: a release refuses lists older than the version compiled into it, even on a fresh install', () => {
  assert.equal(reason(envelope(), { minVersion: 6 }), 'below-minimum');
  assert.equal(verifyMakerList(envelope(), opts({ minVersion: 5 })).ok, true);
});

test('version jump is bounded relative to lastSeenVersion, or to minVersion on a fresh install', () => {
  assert.equal(reason(envelope(payload({ version: 100 })), { lastSeenVersion: 5 }), 'version-jump');
  assert.equal(verifyMakerList(envelope(payload({ version: 55 })), opts({ lastSeenVersion: 5 })).ok, true);
  assert.equal(reason(envelope(payload({ version: 100 })), { minVersion: 5 }), 'version-jump');
  assert.equal(verifyMakerList(envelope(payload({ version: 100 })), opts({ lastSeenVersion: 5, maxVersionJump: 100 })).ok, true);
  assert.equal(reason(envelope(), { minVersion: -1 }), 'bad-options');
});

test('A2: makerMatchesEscrow accepts only the listed Solana address as counterparty', () => {
  const entry = maker();
  assert.equal(makerMatchesEscrow(entry, ADDR), true);
  assert.equal(makerMatchesEscrow(entry, { toBase58: () => ADDR }), true);
  assert.equal(makerMatchesEscrow(entry, PROGRAM), false);
  assert.equal(makerMatchesEscrow(entry, ''), false);
  assert.equal(makerMatchesEscrow(entry, null), false);
  assert.equal(makerMatchesEscrow(entry, ADDR + '1'), false);
  assert.equal(makerMatchesEscrow({ ...entry, solanaAddress: 'abc' }, 'abc'), false);
  assert.equal(makerMatchesEscrow(null, ADDR), false);
});

test('M1: two key ids holding the same public key are refused, at load and at verify, so one signer cannot count twice', () => {
  const dup = [{ keyId: 'test-a', publicKey: A.pub }, { keyId: 'test-a2', publicKey: A.pub }, { keyId: 'test-b', publicKey: B.pub }];
  assert.equal(loadPinnedKeys(dup), null);
  assert.ok(loadPinnedKeys(PIN) instanceof Map);
  const env = envelope(payload(), [A]);
  env.signatures.push({ ...env.signatures[0], keyId: 'test-a2' });
  assert.equal(reason(env, { pinnedKeys: dup }), 'bad-options');
});

test('first list is bounded without a remembered version or minVersion; null or odd options are refused cleanly', () => {
  assert.equal(reason(envelope(payload({ version: 100 })), {}), 'version-jump');
  assert.equal(verifyMakerList(envelope(), null).reason, 'bad-options');
  assert.equal(verifyMakerList(envelope(), 'x').reason, 'bad-options');
  assert.equal(reason(envelope(), { minVersion: null }), 'bad-options');
  assert.equal(reason(envelope(), { lastSeenVersion: undefined, maxVersionJump: null }), 'bad-options');
  assert.equal(verifyMakerList(envelope(), opts({ lastSeenVersion: undefined })).ok, true);
});
