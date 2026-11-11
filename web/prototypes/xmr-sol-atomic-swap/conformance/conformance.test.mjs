// Tests of the conformance suite itself: a conforming fake passes everything, and each fake that breaks one rule fails exactly the matching check.
// The suite has NOT been run against the real maker.mjs process (it needs a Monero wallet RPC and Solana funds); the fake is built from its shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runConformance, formatTable } from './checks.mjs';
import { startFakeMaker, startFakeRpc } from './fake-maker.mjs';
import { GENESIS } from './checks.mjs';

const run = promisify(execFile);
const RUNNER = fileURLToPath(new URL('./run.mjs', import.meta.url));
const TOKEN = 't'.repeat(40);
async function suite(fakeOpts, runOpts = {}, rpcOpts = { genesis: GENESIS.devnet }) {
  const fake = await startFakeMaker({ token: TOKEN, ...fakeOpts });
  // A registration run always names a Solana RPC (the guard refuses without one); rpcOpts null = none named.
  const rpc = runOpts.allowRegistration && rpcOpts ? await startFakeRpc(rpcOpts) : null;
  try { const out = await runConformance({ makerUrl: fake.url, token: TOKEN, ...(rpc ? { solanaRpc: rpc.url } : {}), ...runOpts }); return { ...out, fake, rpc }; } finally { await fake.close(); await rpc?.close(); }
}
const failing = (r, status = 'fail') => r.results.filter((x) => x.status === status).map((x) => x.id).sort();

test('a conforming fake passes every check (registration skipped by default and never reached)', async () => {
  const r = await suite({});
  assert.deepEqual(failing(r), []);
  assert.deepEqual(failing(r, 'warn'), []);
  assert.equal(r.fake.stats.registrations, 0, 'no swap was recorded without the opt-in flag');
  assert.equal(r.fake.stats.swapPosts, 0, 'no request at all reached a registration route without the opt-in flag');
  const skipped = failing(r, 'skip');
  assert.ok(skipped.includes('forward.register.terms') && skipped.includes('reverse.register.terms') && skipped.includes('forward.swap.unknown-quote') && skipped.includes('reverse.swap.unknown-quote'));
  assert.ok(r.results.filter((x) => x.status === 'pass').length >= 30);
});

test('with the opt-in flag, registration is verified with the client core and a reused quote is refused', async () => {
  const r = await suite({}, { allowRegistration: 'stagenet' });
  assert.deepEqual(failing(r), []);
  for (const id of ['forward.register.terms', 'forward.register.reuse', 'reverse.register.terms', 'reverse.register.reuse']) assert.equal(r.results.find((x) => x.id === id)?.status, 'pass', id);
  assert.equal(r.fake.stats.registrations, 3);
});

test('the opt-in flag only takes stagenet or devnet', async () => {
  await assert.rejects(() => runConformance({ makerUrl: 'http://127.0.0.1:9', allowRegistration: 'mainnet' }), /stagenet/);
});

test('a token is sent when given, and a missing token is reported', async () => {
  const ok = await suite({}, {});
  assert.deepEqual(failing(ok), []);
  const none = await suite({}, { token: null });
  assert.deepEqual(failing(none), ['auth.token-accepted']);
  const open = await suite({ token: null }, { token: null });
  assert.deepEqual(failing(open), []);
  assert.deepEqual(failing(open, 'warn'), ['auth.bad-token'], 'a maker that needs no token gets a warning about rate limits');
});

test('forward-only and reverse-disabled makers are handled', async () => {
  const r = await suite({ solXmr: false });
  assert.deepEqual(failing(r), []);
  assert.equal(r.results.find((x) => x.id === 'reverse.disabled')?.status, 'pass');
});

test('the reference price bound fails a maker that quotes far from it', async () => {
  const r = await suite({}, { referencePrice: 4.0, maxDeviationBps: 500 });
  assert.deepEqual(failing(r), ['forward.quote.reference-price', 'reverse.quote.reference-price']);
});

const breaks = [
  ['health-shape', ['health.shape']],
  ['quote-units', ['forward.quote.shape']],
  ['quote-ttl', ['forward.quote.ttl']],
  ['quote-spread', ['forward.quote.consistency']],
  ['over-cap', ['forward.quote.reject-over-cap', 'reverse.quote.reject-over-cap']],
  ['accepts-wrong-types', ['forward.quote.reject-wrong-types']],
  ['no-oversize-limit', ['forward.quote.reject-oversize']],
  ['rev-bad-proof', ['reverse.quote.proof']],
  ['reused-share', ['reverse.quote.fresh-share']],
];
for (const [rule, expected] of breaks) test(`break "${rule}" fails exactly ${expected.join(', ')}`, async () => {
  const r = await suite({ breakRule: rule });
  assert.deepEqual(failing(r).filter((id) => !(rule === 'over-cap' && id === 'forward.quote.caps')), expected.sort());
});

test('break "path-leak" is a warning, not a failure', async () => {
  const r = await suite({ breakRule: 'path-leak' });
  assert.deepEqual(failing(r), []);
  assert.deepEqual(failing(r, 'warn'), ['status.error-has-no-path']);
});

for (const [rule, expected] of [['accepts-unknown-quote', ['forward.register.reuse', 'forward.swap.unknown-quote', 'reverse.register.reuse', 'reverse.swap.unknown-quote']], ['bad-proofB', ['forward.register.terms']], ['bad-timelocks', ['forward.register.terms']], ['wrong-pda', ['forward.register.terms']], ['rev-bad-joint', ['reverse.register.terms']], ['reuse-quote', ['forward.register.reuse', 'reverse.register.reuse']], ['reused-share', ['forward.register.fresh-secrets', 'reverse.quote.fresh-share']], ['ready-and-refund', ['forward.register.one-action', 'reverse.register.one-action']]]) {
  test(`registration break "${rule}" fails ${expected.join(', ')}`, async () => {
    const r = await suite({ breakRule: rule }, { allowRegistration: 'devnet' });
    const f = failing(r).filter((id) => !(rule === 'rev-bad-proof' && id.startsWith('reverse.quote')));
    assert.deepEqual(f, expected.sort());
  });
}

test('the runner exits 0 on a conforming maker, 1 on a broken one, and never prints the token', async () => {
  const token = 'secret-token-value-0123456789abcdef-xyz';
  const good = await startFakeMaker({ token });
  try {
    const out = await run('node', [RUNNER, '--maker-url', good.url, '--token-env', 'CONF_TEST_TOKEN'], { env: { ...process.env, CONF_TEST_TOKEN: token } });
    assert.match(out.stdout, /fail 0/);
    assert.ok(!out.stdout.includes(token) && !out.stderr.includes(token));
  } finally { await good.close(); }
  const bad = await startFakeMaker({ breakRule: 'quote-ttl', token });
  try {
    await assert.rejects(() => run('node', [RUNNER, '--maker-url', bad.url, '--token-env', 'CONF_TEST_TOKEN'], { env: { ...process.env, CONF_TEST_TOKEN: token } }), (e) => e.code === 1 && /forward.quote.ttl/.test(e.stdout) && !e.stdout.includes(token));
  } finally { await bad.close(); }
  await assert.rejects(() => run('node', [RUNNER]), (e) => e.code === 2);
});

test('the table has no secrets shape: ids, levels, short details', async () => {
  const r = await suite({});
  const t = formatTable(r.results);
  assert.match(t, /RESULT\s+LEVEL\s+CHECK\s+DETAIL/);
});

test('tier fields: tolerated when present and never sent by the suite', async () => {
  const r = await suite({ tiers: true }, { allowRegistration: 'stagenet' });
  assert.deepEqual(failing(r), []);
  assert.equal(r.results.find((x) => x.id === 'forward.quote.tiers').detail.includes('holder tier'), true);
  assert.equal(r.fake.stats.tierOkSeen, 0, 'the suite never sends tierOk');
});

test('tier fields: a tier that is not better for the user fails', async () => {
  const r = await suite({ tiers: true, breakRule: 'tiers-worse' });
  assert.deepEqual(failing(r), ['forward.quote.tiers']);
});

// ---- network guard (review M2): registration is refused unless the network is verified, and the refusal happens before any POST that records a swap ----
const guardOf = (r) => r.results.find((x) => x.id === 'network.guard');
const refusesBeforeRegistering = (r, re) => {
  assert.equal(guardOf(r)?.status, 'fail');
  assert.match(guardOf(r).detail, re);
  assert.equal(r.fake.stats.registrations, 0, 'nothing was registered on the maker');
  assert.equal(r.fake.stats.swapPosts, 0, 'no request, not even a malformed probe, reached a registration route');
  assert.ok(failing(r, 'skip').includes('forward.register.terms') && failing(r, 'skip').includes('reverse.register.terms'));
  assert.ok(!r.results.some((x) => x.id === 'forward.register.shape' || x.id === 'reverse.register.shape'));
};

test('guard passes on a test network and registration then runs', async () => {
  const r = await suite({}, { allowRegistration: 'stagenet' });
  assert.equal(guardOf(r)?.status, 'pass');
  assert.equal(r.fake.stats.registrations, 3);
  assert.ok(r.rpc.stats.calls >= 2);
  const firstPost = r.fake.stats.log.findIndex((l) => l === 'POST /v1/swap' || l === 'POST /v1/rev/swap');
  const statusRead = r.fake.stats.log.indexOf('GET /v1/status');
  assert.ok(statusRead >= 0 && firstPost > statusRead, 'the maker network was read before any registration-route request');
});

test('a maker that accepts an unknown quote cannot record anything from the default run (review M2)', async () => {
  const r = await suite({ breakRule: 'accepts-unknown-quote' });
  assert.equal(r.fake.stats.registrations, 0);
  assert.equal(r.fake.stats.swapPosts, 0);
  assert.deepEqual(failing(r), []);
});

test('a maker that accepts an unknown quote is caught only after the guard passed, and the probe fails', async () => {
  const r = await suite({ breakRule: 'accepts-unknown-quote' }, { allowRegistration: 'stagenet' });
  assert.equal(guardOf(r)?.status, 'pass');
  assert.ok(failing(r).includes('forward.swap.unknown-quote') && failing(r).includes('reverse.swap.unknown-quote') && r.fake.stats.registrations > 0);
});

test('guard: a "testnet" maker is refused (no matching Monero network is verified)', async () => {
  refusesBeforeRegistering(await suite({ network: 'testnet' }, { allowRegistration: 'stagenet' }), /testnet/);
});

test('a verified mainnet pair checks joint addresses as Monero mainnet; a maker that serves stagenet addresses there is refused by the client core', async () => {
  const ok = await suite({ network: 'mainnet' }, { allowRegistration: 'stagenet', allowMainnetRegistration: true }, { genesis: GENESIS.mainnet });
  assert.match(guardOf(ok).detail, /Monero mainnet/);
  assert.equal(ok.results.find((x) => x.id === 'forward.register.terms')?.status, 'pass');
  assert.equal(ok.results.find((x) => x.id === 'reverse.register.terms')?.status, 'pass');
  const lie = await suite({ network: 'mainnet', servesMonero: 'stagenet' }, { allowRegistration: 'stagenet', allowMainnetRegistration: true }, { genesis: GENESIS.mainnet });
  assert.equal(lie.results.find((x) => x.id === 'forward.register.terms')?.status, 'fail');
});

test('guard: no Solana RPC named refuses before registering', async () => {
  const r = await suite({}, { allowRegistration: 'stagenet' }, null);
  refusesBeforeRegistering(r, /--solana-rpc is required/);
});

test('guard: a mainnet Solana RPC is refused without the second flag, even against a test-network maker', async () => {
  const r = await suite({}, { allowRegistration: 'stagenet' }, { genesis: GENESIS.mainnet });
  refusesBeforeRegistering(r, /MAINNET.*--allow-mainnet-registration/);
});

test('guard: a maker that reports mainnet is refused without the second flag', async () => {
  const r = await suite({ network: 'mainnet' }, { allowRegistration: 'devnet' });
  refusesBeforeRegistering(r, /MAINNET.*--allow-mainnet-registration/);
});

test('guard: an unknown genesis hash, an unreadable RPC and a garbage RPC answer all refuse', async () => {
  refusesBeforeRegistering(await suite({}, { allowRegistration: 'stagenet' }, { genesis: 'NotARealGenesisHash11111111111111111111111111' }), /unknown genesis/);
  refusesBeforeRegistering(await suite({}, { allowRegistration: 'stagenet' }, { garbage: true }), /could not read the Solana genesis hash/);
  const fake = await startFakeMaker({ token: TOKEN });
  try {
    const r = await runConformance({ makerUrl: fake.url, token: TOKEN, allowRegistration: 'stagenet', solanaRpc: 'http://127.0.0.1:9' });
    assert.equal(guardOf(r)?.status, 'fail'); assert.equal(fake.stats.registrations, 0);
  } finally { await fake.close(); }
});

test('guard: a maker whose network cannot be read (no status field, or no token) refuses', async () => {
  refusesBeforeRegistering(await suite({ statusReadable: false }, { allowRegistration: 'stagenet' }), /could not be read from \/v1\/status/);
  const noToken = await suite({}, { allowRegistration: 'stagenet', token: null });   // the run stops at the token check, before any registration
  assert.equal(noToken.fake.stats.registrations, 0);
  assert.equal(failing(noToken).includes('auth.token-accepted'), true);
});

test('guard: a maker address with no SOL on the named network is not confirmed to run there', async () => {
  const r = await suite({}, { allowRegistration: 'stagenet' }, { genesis: GENESIS.devnet, balance: 0 });
  refusesBeforeRegistering(r, /holds no SOL/);
});

test('guard: a mismatch between the RPC network and the maker network is refused even with the second flag', async () => {
  const r = await suite({ network: 'mainnet' }, { allowRegistration: 'stagenet', allowMainnetRegistration: true }, { genesis: GENESIS.devnet });
  refusesBeforeRegistering(r, /network mismatch/);
});

test('guard: with the second flag, a verified mainnet pair is allowed and says so', async () => {
  const r = await suite({ network: 'mainnet' }, { allowRegistration: 'stagenet', allowMainnetRegistration: true }, { genesis: GENESIS.mainnet });
  assert.equal(guardOf(r)?.status, 'pass');
  assert.match(guardOf(r).detail, /MAINNET allowed by the second flag/);
});

test('the second flag alone never enables registration', async () => {
  const r = await suite({}, { allowMainnetRegistration: true });
  assert.equal(r.fake.stats.registrations, 0);
  assert.equal(guardOf(r), undefined);
});

test('the runner needs --solana-rpc with --allow-registration and refuses a lone second flag, before contacting the maker', async () => {
  await assert.rejects(() => run('node', [RUNNER, '--maker-url', 'http://127.0.0.1:9', '--allow-registration', 'stagenet']), (e) => e.code === 2 && /--solana-rpc/.test(e.stderr));
  await assert.rejects(() => run('node', [RUNNER, '--maker-url', 'http://127.0.0.1:9', '--allow-mainnet-registration']), (e) => e.code === 2 && /only modifies/.test(e.stderr));
  await assert.rejects(() => run('node', [RUNNER, '--maker-url', 'http://127.0.0.1:9', '--allow-registration', 'mainnet', '--solana-rpc', 'http://127.0.0.1:9']), (e) => e.code === 2);
});

test('the runner prints the scope note under the table', async () => {
  const good = await startFakeMaker({ token: TOKEN });
  try {
    const out = await run('node', [RUNNER, '--maker-url', good.url, '--token-env', 'CONF_TEST_TOKEN'], { env: { ...process.env, CONF_TEST_TOKEN: TOKEN } });
    assert.match(out.stdout, /does not show that its escrows, swap lifecycle, refunds or recovery work/);
  } finally { await good.close(); }
});

test('the protocol doc separates refund eligibility from settlement and states no maximum lock duration', async () => {
  const { readFile } = await import('node:fs/promises');
  const doc = await readFile(fileURLToPath(new URL('../../../docs/OPEN_MAKER_PROTOCOL.md', import.meta.url)), 'utf8');
  assert.ok(doc.includes('Refund eligibility opens at `max(t1, commit+3600)`; the client waits an additional 300 seconds. SOL remains locked until a claim or refund executes.'));
  assert.match(doc, /Eligibility is not execution: an offline user, or a refund transaction that is absent or fails/);
  assert.ok(!/at most `t1 \+ 3600 s`/.test(doc), 'no unconditional maximum-lock bound');
  assert.ok(!/up to about 6 hours/.test(doc), 'no promise of a six hour hold');
});
