import test from 'node:test'; import assert from 'node:assert/strict';
import { makerReverseStep, freeInventory, sweepDestination, reverseAdmission, createSerial, canSendNow, classifyJointBalance, RESEND_PAUSE_MS } from './maker-reverse.mjs';
import { reverseTimelocks } from '../client/reverse-core.mjs';
import { CONFIRMATIONS, LOCK_WAIT } from '../client/swap-core.mjs';
const CUT = 300; // v2: the secret-free commit must land before t1 - MARGIN; the secret itself is bounded by the on-chain commit time (see the v2 tests below)

const LOCKED = 1_800_000_000, { t0, t1 } = reverseTimelocks(LOCKED), AMT = '50000000000';
const rec = (over = {}) => ({ swapId: 'ab', A: 'aa', B: 'bb', claimer: 'maker', refunder: 'user', lamports: 7, t0, t1, xmrAtomic: AMT, userProofOk: true, quoteExpiresAt: LOCKED + 120, ...over });
const W = 3600;
const pda = (ready = false, claimCommittedAt = 0) => ({ ready, claimCommittedAt, t0, t1, lamports: 7, claimPoint: 'aa', refundPoint: 'bb', claimer: 'maker', refunder: 'user' });
function deps({ now = LOCKED + 60, swap = pda(), xmr = null, revealed = {}, failRelay = false } = {}) {
  const calls = [], stored = [];
  return { calls, stored, d: {
    readSwapFinalized: async () => swap, chainNow: async () => now, scanXmr: async () => xmr,
    readRevealed: async (which) => revealed[which] ?? null,
    buildXmrTransfer: async () => { calls.push('build'); return { txid: 'xt', hex: '00' }; },
    relayXmr: async (_hex, hooks) => { if (hooks && !(await hooks.authorize())) return { sent: false }; hooks?.mark(); calls.push('relay'); if (failRelay) throw new Error('relay down'); return { sent: true }; },
    sendCommit: async () => { calls.push('commit'); return { sig: 'cm' }; },
    sendClaim: async () => { calls.push('claim'); return { sig: 'cs' }; },
    proveFinal: async (_s, o) => ({ final: true, evidence: { finalizedSlot: 1, outcomeSig: o?.sig ?? null } }),   // finality proven (701-H1); the not-proven paths are in reverse-unified-gate.test.mjs
    recoverXmr: async (_s, sec) => { calls.push(`recover:${sec}`); return { status: 'recovered', txids: ['rt'] }; },
    store: (s) => stored.push(JSON.parse(JSON.stringify(s))), log: () => {}, sendAllowed: () => true } };
}

test('M2: the transfer is recorded before it is relayed, and a crash after recording re-relays the same tx', async () => {
  const s = rec(), x = deps({ failRelay: true });
  await assert.rejects(makerReverseStep(s, x.d));
  assert.deepEqual(x.calls, ['build', 'relay']);
  assert.equal(x.stored.at(-1).xmrSendTxid, 'xt', 'txid durable before relay'); assert.equal(x.stored.at(-1).xmrRelayed, false);
  const y = deps({ xmr: { atomic: AMT, confirmations: 1 } });
  await makerReverseStep(x.stored.at(-1), y.d);
  assert.deepEqual(y.calls, ['relay'], 'the same signed tx is relayed again; nothing new is built');
});
test('M3 (v2): commits at ready only with its own XMR confirmed, never before; the secret is not sent with the commit', async () => {
  const s = rec({ xmrSendTxid: 'xt', xmrRelayed: true });
  const early = deps({ swap: pda(true), xmr: { atomic: AMT, confirmations: CONFIRMATIONS - 1 } });
  assert.equal((await makerReverseStep({ ...s }, early.d)).action, 'wait');
  const ok = deps({ swap: pda(true), xmr: { atomic: AMT, confirmations: CONFIRMATIONS } });
  assert.equal((await makerReverseStep({ ...s }, ok.d)).action, 'commit-claim'); assert.deepEqual(ok.calls, ['commit'], 'step one carries no secret; the claim is not sent in the same pass');
});
test('a closed gate holds the XMR send; nothing is built', async () => {
  const x = deps(); x.d.sendAllowed = () => false;
  assert.equal((await makerReverseStep(rec(), x.d)).reason, 'send-held'); assert.deepEqual(x.calls, []);
});
test('M4: a user refund hands the maker b and it recovers its XMR into inventory', async () => {
  const s = rec({ xmrSendTxid: 'xt', xmrRelayed: true, seenPda: true });
  const x = deps({ swap: null, revealed: { refund: { secretHex: 'bsecret', sig: 'rs' } } });
  assert.equal((await makerReverseStep(s, x.d)).action, 'recover-xmr'); assert.deepEqual(x.calls, ['recover:bsecret']);
});
test('a quote the user never locked is closed after its expiry plus LOCK_WAIT; a fresh one waits', async () => {
  assert.equal((await makerReverseStep(rec(), deps({ swap: null, now: LOCKED + 60 }).d)).action, 'wait');
  assert.equal((await makerReverseStep(rec(), deps({ swap: null, now: LOCKED + 121 + LOCK_WAIT }).d)).result, 'not-locked');
});
test('free inventory subtracts unsent open swaps and the fee reserve', () => {
  const open = [{ xmrAtomic: '10', xmrSendTxid: null }, { xmrAtomic: '20', xmrSendTxid: 'x' }, { xmrAtomic: '5', done: 'not-locked' }];
  assert.equal(freeInventory('100', open, '3'), 87n);
  assert.equal(freeInventory('5', open, '3'), 0n);
});

test('owner decision 5 Nov: XMR -> SOL sweeps refill inventory up to the ceiling, the rest goes to the owner', () => {
  const base = { recycle: true, ceilingAtomic: '150000000000', ownerAddress: 'OWNER', treasuryAddress: 'TREASURY' };
  assert.deepEqual(sweepDestination({ ...base, treasuryAtomic: '100000000000', incomingAtomic: '50000000000' }), { kind: 'treasury', address: 'TREASURY' }, 'exactly at the ceiling stays');
  assert.deepEqual(sweepDestination({ ...base, treasuryAtomic: '100000000001', incomingAtomic: '50000000000' }), { kind: 'owner', address: 'OWNER' }, 'above the ceiling goes to the owner');
  assert.deepEqual(sweepDestination({ ...base, recycle: false, treasuryAtomic: '0', incomingAtomic: '1' }), { kind: 'owner', address: 'OWNER' }, 'recycling off: the old rule');
  assert.deepEqual(sweepDestination({ ...base, ownerAddress: null, treasuryAtomic: '0', incomingAtomic: '1' }), { kind: 'treasury', address: 'TREASURY' });
});

import { xmrTransferRequest, xmrTransferResult } from './maker-reverse.mjs';
test('the XMR send asks wallet-rpc for relay_tx metadata, not the raw blob', () => {
  assert.deepEqual(xmrTransferRequest('addr', '2000000000'), { destinations: [{ amount: 2000000000, address: 'addr' }], priority: 0, do_not_relay: true, get_tx_metadata: true });
  assert.deepEqual(xmrTransferResult({ tx_hash: 'h', tx_metadata: 'meta', tx_blob: 'blob' }), { txid: 'h', hex: 'meta' });
  assert.throws(() => xmrTransferResult({ tx_hash: 'h', tx_blob: 'blob' }), /no relayable metadata/);
});

// ---- Astra r4 N1: capacity is enforced at registration, serialized, against durable records ----
const CAPS = { minAtomic: '1000000000', maxPerSwapAtomic: '50000000000', maxPerDayAtomic: '300000000000', maxOpen: 3, reserveAtomic: '1000000000' };
const adm = (over = {}) => reverseAdmission({ xmrAtomic: '1000000000', openCount: 0, lockedTodayAtomic: '0', unlockedAtomic: '150000000000', openReverse: [], caps: CAPS, ...over });
test('N1: admission refuses at the open-swap limit, the daily quota, the per-swap limits and low inventory', () => {
  assert.equal(adm(), true);
  assert.throws(() => adm({ openCount: 3 }), /busy-try-later/);
  assert.throws(() => adm({ lockedTodayAtomic: '299500000000' }), /daily-limit-reached/);
  assert.throws(() => adm({ xmrAtomic: '50000000001' }), /amount-outside-limits/);
  assert.throws(() => adm({ xmrAtomic: '999999999' }), /amount-outside-limits/);
  assert.throws(() => adm({ unlockedAtomic: '1500000000' }), /inventory-low/);
  // three unsent open swaps already hold 3 x 0.05 XMR of a 0.15 balance: a fourth 0.05 does not fit with the fee reserve
  const open = [1, 2, 3].map((n) => ({ swapId: `s${n}`, xmrAtomic: '50000000000' }));
  assert.throws(() => adm({ xmrAtomic: '50000000000', openCount: 2, unlockedAtomic: '150000000000', openReverse: open }), /inventory-low/);
});
test('N1: four concurrent registrations against a limit of three admit exactly three, and the stored records are the reservation', async () => {
  const serial = createSerial(), stored = [], wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const register = (id) => serial(async () => {
    await wait(5); // the awaits a real registration has (chain time, daemon height, treasury balance)
    reverseAdmission({ xmrAtomic: '1000000000', openCount: stored.filter((s) => !s.done).length, lockedTodayAtomic: stored.reduce((t, s) => t + BigInt(s.xmrAtomic), 0n).toString(), unlockedAtomic: '150000000000', openReverse: stored.filter((s) => s.direction === 'sol-xmr'), caps: CAPS });
    await wait(5);
    stored.push({ swapId: id, direction: 'sol-xmr', xmrAtomic: '1000000000' });
    return id;
  });
  const results = await Promise.allSettled(['a', 'b', 'c', 'd'].map(register));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  assert.match(String(results[3].reason), /busy-try-later/);
  assert.equal(stored.length, 3);
});
test('N1: the daily quota and inventory also hold under concurrency; one failed registration does not block the next', async () => {
  const serial = createSerial(), stored = [];
  const register = (id, amount) => serial(async () => {
    await new Promise((r) => setTimeout(r, 3));
    reverseAdmission({ xmrAtomic: amount, openCount: stored.length, lockedTodayAtomic: stored.reduce((t, s) => t + BigInt(s.xmrAtomic), 0n).toString(), unlockedAtomic: '120000000000', openReverse: stored, caps: { ...CAPS, maxOpen: 10 } });
    stored.push({ swapId: id, xmrAtomic: amount }); return id;
  });
  // 0.05 + 0.05 fit a 0.12 treasury (0.001 reserve); the third 0.05 does not; a later 0.01 still does
  const r = await Promise.allSettled([register('a', '50000000000'), register('b', '50000000000'), register('c', '50000000000'), register('d', '10000000000')]);
  assert.deepEqual(r.map((x) => x.status), ['fulfilled', 'fulfilled', 'rejected', 'fulfilled']);
  assert.match(String(r[2].reason), /inventory-low/);
});
test('N1: before a NEW transfer is built the unlocked balance is re-checked; a short balance holds the send and builds nothing', async () => {
  assert.equal(canSendNow({ unlockedAtomic: '51000000000', xmrAtomic: AMT, reserveAtomic: '1000000000' }), true);
  assert.equal(canSendNow({ unlockedAtomic: '50999999999', xmrAtomic: AMT, reserveAtomic: '1000000000' }), false);
  const { d, calls } = deps({ swap: pda(false) });
  const r = await makerReverseStep(rec(), { ...d, canSend: async () => false });
  assert.equal(r.reason, 'inventory-low'); assert.deepEqual(calls, []);
  const ok = await makerReverseStep(rec(), { ...d, canSend: async () => true });
  assert.equal(ok.action, 'send-xmr'); assert.deepEqual(calls, ['build', 'relay']);
});
test('N1/N2 wiring: registration is serialized and admitted before the swap file is stored; the reverse step scans only its own txid and re-checks inventory', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./maker.mjs', import.meta.url), 'utf8');
  // One gate (9 Nov 2026): the registration is an admission like the XMR -> SOL start: the same queue, the same admitSwap (whose order,
  // last check right before store, is tested in admission-gate.test.mjs); the inventory check runs inside prepare, before admitSwap stores.
  assert.match(src, /const reverseRegister = \(input\) => admissions\.run\(\(\) => admitSwap\(input, \{/);
  const reg = src.slice(src.indexOf('const reverseRegister = '), src.indexOf('async function sweepJoint'));
  assert.match(reg, /prepare: prepareReverse,/); assert.match(reg, /isOpen: \(\) => accepting\(\) && CFG\.solXmr,/);
  const prep = reg.slice(reg.indexOf('async function prepareReverse'));
  assert.ok(prep.indexOf('reverseAdmission(') > 0 && !/\bstore\(/.test(prep), 'prepare checks inventory and never stores; admitSwap stores after the last gate check');
  assert.match(src, /scanXmr: scanXmrOwn,/); assert.match(src, /canSend: async \(rs\) => canSendNow\(/);
  assert.match(src, /usableFromTransfersOf\(await W\('get_transfers'/);
});

// ---- Astra r5 High: the time used to authorize a claim or a send is read again right before the side effect ----
test('r5: a claim authorized before a slow scan is NOT sent when the clock has passed t1 - CUTOFF by the time the send would run', async () => {
  const times = [t1 - CUT - 400, t1 - CUT + 10]; // first read: inside the window; read after the (slow) scan: past the claim cutoff
  const { d, calls } = deps({ swap: pda(true), xmr: { atomic: AMT, confirmations: CONFIRMATIONS } });
  const r = await makerReverseStep(rec({ xmrSendTxid: 'xt', xmrRelayed: true }), { ...d, chainNow: async () => times.shift() ?? t1 });
  assert.equal(r.reason, 'stale-authorization'); assert.deepEqual(calls, [], 'no claim, so the secret a is not revealed');
});
test('r5: the same claim goes out when the fresh time is still inside the window; a failing or non-numeric clock fails closed', async () => {
  const ok = deps({ swap: pda(true), xmr: { atomic: AMT, confirmations: CONFIRMATIONS } });
  assert.equal((await makerReverseStep(rec({ xmrSendTxid: 'xt', xmrRelayed: true }), { ...ok.d, chainNow: async () => t1 - 1000 })).action, 'commit-claim');
  assert.deepEqual(ok.calls, ['commit']);
  for (const bad of [async () => { throw new Error('rpc down'); }, async () => NaN]) {
    let n = 0; const w = deps({ swap: pda(true), xmr: { atomic: AMT, confirmations: CONFIRMATIONS } });
    const r = await makerReverseStep(rec({ xmrSendTxid: 'xt', xmrRelayed: true }), { ...w.d, chainNow: async () => (n++ === 0 ? t1 - CUT - 1000 : bad()) });
    assert.equal(r.reason, 'stale-authorization'); assert.deepEqual(w.calls, []);
  }
});
test('r5: an XMR send authorized early is not built when the fresh time is too late to send', async () => {
  const times = [t0 - 9000, t0 - 7000]; // REV_SEND_MIN_LEAD is 7200 s
  const { d, calls } = deps({ swap: pda(false) });
  const r = await makerReverseStep(rec(), { ...d, chainNow: async () => times.shift() ?? t0 });
  assert.equal(r.reason, 'stale-authorization'); assert.deepEqual(calls, []);
});

// ---- Astra r5: one shared serialized admission path for normal and reverse swaps ----
import { capsAdmission } from './maker-reverse.mjs';
test('r5: mixed concurrent normal and reverse admissions share one open limit, one daily quota and are counted together', async () => {
  const serial = createSerial(), stored = [], wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const lockedToday = () => stored.reduce((t, s) => t + BigInt(s.xmrAtomic), 0n).toString();
  const normal = (id) => serial(async () => { capsAdmission({ xmrAtomic: '1000000000', openCount: stored.length, lockedTodayAtomic: lockedToday(), caps: CAPS }); await wait(8); stored.push({ swapId: id, direction: 'xmr-sol', xmrAtomic: '1000000000' }); return id; });
  const reverse = (id) => serial(async () => { await wait(2); reverseAdmission({ xmrAtomic: '1000000000', openCount: stored.length, lockedTodayAtomic: lockedToday(), unlockedAtomic: '150000000000', openReverse: stored.filter((s) => s.direction === 'sol-xmr'), caps: CAPS }); await wait(2); stored.push({ swapId: id, direction: 'sol-xmr', xmrAtomic: '1000000000' }); return id; });
  const r = await Promise.allSettled([normal('n1'), reverse('r1'), normal('n2'), reverse('r2'), normal('n3'), reverse('r3')]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 3, 'three open in total, whatever the direction');
  assert.ok(r.filter((x) => x.status === 'rejected').every((x) => /busy-try-later/.test(String(x.reason))));
  // the daily quota is shared too: 0.3 XMR a day across both directions
  const day = []; const t = (id, dir) => serial(async () => { capsAdmission({ xmrAtomic: '50000000000', openCount: 0, lockedTodayAtomic: day.reduce((a, s) => a + BigInt(s.x), 0n).toString(), caps: CAPS }); await wait(2); day.push({ id, dir, x: '50000000000' }); });
  const d = await Promise.allSettled(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) => t(id, i % 2 ? 'sol-xmr' : 'xmr-sol')));
  assert.equal(d.filter((x) => x.status === 'fulfilled').length, 6); assert.match(String(d[6].reason), /daily-limit-reached/);
});
test('r5 wiring: the normal start and the reverse registration use the SAME serialized section and the same caps check', async () => {
  const { readFileSync } = await import('node:fs'); const src = readFileSync(new URL('./maker.mjs', import.meta.url), 'utf8');
  assert.match(src, /const startSwap = \(input\) => admissions\.run\(\(\) => admitSwap\(input, \{/);
  assert.match(src, /const reverseRegister = \(input\) => admissions\.run\(\(\) => admitSwap\(input, \{/);
  assert.equal((src.match(/createAdmissionSerial\(/g) ?? []).length, 1, 'exactly one admission serial');
  assert.equal((src.match(/createSerial\(\)/g) ?? []).length, 0, 'no second serial');
  assert.equal((src.match(/admitSwap\(input, \{/g) ?? []).length, 2, 'both directions through the one admitSwap');
  assert.equal((src.match(/checkLimits: sharedLimits,/g) ?? []).length, 2, 'the same caps check for both directions');
  assert.match(src, /const sharedLimits = \(q, input\) => \{[^\n]*laneAdmission\(/);   // F-12: the requester address is passed for the per-address unpaid limit; laneAdmission (maker-lanes.mjs) calls capsAdmission
});

// ---- Astra r5 N4: recovery-only. Flag-off, a closed gate or the drain file never stops the runner from finishing swaps already started ----
test('r5 N4: with new sends held (flag off or closed gate) the maker still claims at ready and still recovers its XMR after a user refund', async () => {
  const held = { sendAllowed: () => false };
  const c = deps({ swap: pda(true), xmr: { atomic: AMT, confirmations: CONFIRMATIONS } });
  assert.equal((await makerReverseStep(rec({ xmrSendTxid: 'xt', xmrRelayed: true }), { ...c.d, ...held, chainNow: async () => t1 - 1000 })).action, 'commit-claim');
  assert.deepEqual(c.calls, ['commit']);
  const c2 = deps({ swap: pda(true, t1 - 2000) });
  assert.equal((await makerReverseStep(rec({ xmrSendTxid: 'xt', xmrRelayed: true }), { ...c2.d, ...held, chainNow: async () => t1 - 1000 })).action, 'claim');
  assert.deepEqual(c2.calls, ['claim']);
  const r = deps({ swap: null, revealed: { refund: { secretHex: 'cc'.repeat(32), sig: 's' } } });
  const out = await makerReverseStep(rec({ xmrSendTxid: 'xt', xmrRelayed: true, seenPda: true }), { ...r.d, ...held });
  assert.equal(out.action, 'recover-xmr');
  const n = deps({ swap: pda(false) });
  assert.equal((await makerReverseStep(rec(), { ...n.d, ...held })).reason, 'send-held'); assert.deepEqual(n.calls, []);
});
test('r5 N4 wiring: the drain file blocks every admission and quote of both directions, never the step loop; /v1/status is token-protected and shows in-flight admissions', async () => {
  const { readFileSync } = await import('node:fs'); const src = readFileSync(new URL('./maker.mjs', import.meta.url), 'utf8');
  // ONE drain file (697's gate: live, fail closed, unwritable directory on mainnet), for both directions.
  assert.match(src, /file: E\.MAKER_ADMISSION_FILE \?\? `\$\{STATE\}\/ADMISSION_CLOSED`/);
  assert.equal((src.match(/createAdmission\(\{/g) ?? []).length, 1, 'one admission gate'); assert.ok(!/existsSync|admissionOpen/.test(src), 'no second drain-file reader');
  for (const fn of ['async function quote(', 'async function reverseQuote(']) {
    const body = src.slice(src.indexOf(fn), src.indexOf(fn) + 2200); assert.ok((body.match(/accepting\(\)/g) ?? []).length >= 2, `${fn} reads the gate before and after its awaits`);
  }
  assert.match(src, /onClosed: \(\) => \{ quotes\.clear\(\); reverseQuotes\.clear\(\); \}/, 'a closed read drops the quotes of both directions');
  const loop = src.slice(src.indexOf('async function loop()')); assert.ok(!/accepting\(|admission\.isOpen/.test(loop.slice(0, loop.indexOf('http.createServer'))), 'the runner loop ignores the drain file');
  assert.match(src, /req\.url === '\/v1\/status'[\s\S]{0,400}unauthorized/); assert.match(src, /\.\.\.admissions\.counts\(\)/);
});

// ---- Astra r6: the claim goes out with the deadline t1 - MARGIN; an XMR transfer is relayed only inside its window, also on the retry path ----
import { MARGIN as SWAP_MARGIN } from '../client/swap-core.mjs';
import { REV_SEND_MIN_LEAD } from '../client/reverse-core.mjs';
import { CLOCK_LAG_S } from '../client/secret-send.mjs';
test('r6 (v2, unified): sendClaim is handed the record only, never an estimated deadline; the sender reads c + W itself at finalized on every endpoint (reverse-unified-gate.test.mjs)', async () => {
  const c0 = t1 - 1000;
  let args; const c = deps({ swap: pda(true, c0) });
  await makerReverseStep(rec({ xmrSendTxid: 'xt', xmrRelayed: true }), { ...c.d, chainNow: async () => c0 + 10, sendClaim: async (...a) => { args = a; return { sig: 'cs' }; } });
  assert.equal(args.length, 1); assert.equal(args[0].swapId, 'ab');
});
const closingAt = t0 - REV_SEND_MIN_LEAD - CLOCK_LAG_S;
test('r7: relay reply lost AFTER the bytes left (attempt marked, then the wallet call throws): identity kept; later expiry and clock failure change nothing; the scan resolves it; no second build', async () => {
  const s = rec(); const c = deps({ swap: pda(false) });
  const lost = { ...c.d, chainNow: async () => closingAt - 1000, relayXmr: async (_h, hooks) => { assert.equal(await hooks.authorize(), true); hooks.mark(); c.calls.push('relay-sent'); throw new Error('reply lost'); } };
  await assert.rejects(makerReverseStep(s, lost), /reply lost/);
  assert.equal(s.xmrSendTxid, 'xt'); assert.ok(s.xmrRelayAttemptAt); assert.equal(s.xmrRelayed, false);
  const r = await makerReverseStep(s, { ...c.d, chainNow: async () => closingAt + 500 });
  assert.equal(s.xmrSendTxid, 'xt', 'identity is never deleted while the relay is ambiguous'); assert.equal(r.action, 'wait');
  await assert.rejects(makerReverseStep(s, { ...c.d, chainNow: async () => { throw new Error('rpc down'); } }), /rpc down/); // the pass stops; nothing is touched
  assert.equal(s.xmrSendTxid, 'xt');
  assert.equal(c.calls.filter((x) => x === 'build').length, 1, 'exactly the ONE original transfer was built; no second one, whatever the clock did');
  await makerReverseStep(s, { ...c.d, chainNow: async () => closingAt - 1000, scanXmr: async () => ({ atomic: AMT, confirmations: 1 }) });
  assert.equal(s.xmrRelayed, true, 'the scan saw the recorded transaction: the relay is resolved');
});
test('r7: the user refunds while the relay is still ambiguous: the maker RECOVERS (the payment may be at the joint address), it never classifies the swap as "not sent"', async () => {
  const s = rec({ xmrSendTxid: 'xt', xmrSendHex: '00', xmrRelayed: false, xmrRelayAttemptAt: 1, seenPda: true });
  const r = deps({ swap: null, revealed: { refund: { secretHex: 'cc'.repeat(32), sig: 's' } } });
  const out = await makerReverseStep(s, { ...r.d, chainNow: async () => closingAt + 5000 });
  assert.equal(out.action, 'recover-xmr'); assert.deepEqual(r.calls, ['recover:' + 'cc'.repeat(32)]); assert.equal(s.xmrSendTxid, 'xt');
});
test('r7 wiring: the XMR relay window is judged inside the wallet queue call; /v1/status reports the maker key, program and network the quiesce check binds to', async () => {
  const { readFileSync } = await import('node:fs'); const src = readFileSync(new URL('./maker.mjs', import.meta.url), 'utf8');
  const relay = src.slice(src.indexOf('relayXmr: (txHex, hooks)'), src.indexOf('relayXmr: (txHex, hooks)') + 400);
  assert.match(relay, /withWallet\(TREASURY[\s\S]*await hooks\.authorize\(\)[\s\S]*hooks\.mark\(\)[\s\S]*W\('relay_tx'/);
  assert.match(src, /maker: maker\.publicKey\.toBase58\(\), programId: sol\.PROGRAM_ID\.toBase58\(\), network: CFG\.network/);
});

// ---- design note (built means sent) and the no-program-change claim closure ----
test('built means sent (a): the relay reply was stored late (crash), the window is closed, the user refunds: recovery runs and the identity was never deleted', async () => {
  const s = rec({ xmrSendTxid: 'xt', xmrSendHex: '00', xmrRelayed: false, xmrRelayAttemptAt: 1, seenPda: true });
  const win = deps({ swap: pda(false) });
  const held = await makerReverseStep(s, { ...win.d, chainNow: async () => closingAt + 100 });
  assert.equal(held.reason, 'relay-abandoned'); assert.equal(s.xmrSendTxid, 'xt'); assert.equal(s.xmrSendHex, '00'); assert.equal(s.xmrRelayAbandoned, 'window-closed-after-attempt'); assert.deepEqual(win.calls, []);
  const r = deps({ swap: null, revealed: { refund: { secretHex: 'cc'.repeat(32), sig: 's' } } });
  assert.equal((await makerReverseStep(s, { ...r.d, chainNow: async () => closingAt + 5000 })).action, 'recover-xmr'); assert.deepEqual(r.calls, ['recover:' + 'cc'.repeat(32)]);
});
test('built means sent (b): built, never relayed, window closed, refund: nothing is ever relayed by us; three empty recovery scans end it as xmr-never-relayed and the txid and hex are kept', async () => {
  const s = rec({ xmrSendTxid: 'xt', xmrSendHex: '00', xmrRelayed: false });
  const w = deps({ swap: pda(false) });
  assert.equal((await makerReverseStep(s, { ...w.d, chainNow: async () => closingAt + 100 })).reason, 'relay-abandoned');
  assert.equal(s.xmrRelayAbandoned, 'window-closed-never-attempted'); assert.equal(s.xmrSendTxid, 'xt'); assert.deepEqual(w.calls, [], 'relayXmr was never called');
  const r = deps({ swap: null, revealed: { refund: { secretHex: 'ee'.repeat(32), sig: 's' } } }); r.d.recoverXmr = async () => ({ status: 'absent' });   // nothing at the joint address
  const realNow = Date.now; let clock = realNow(); Date.now = () => clock;
  try {
    for (let i = 1; i <= 3; i++) { await makerReverseStep(s, { ...r.d, chainNow: async () => closingAt + 5000 }); assert.equal(s.recoverEmptyScans, i); assert.equal(s.done, i === 3 ? 'xmr-never-relayed' : undefined); clock += 120_000; }
  } finally { Date.now = realNow; }
  assert.equal(s.xmrSendTxid, 'xt'); assert.equal(s.xmrSendHex, '00');
  // 701-H1: the same end is terminal only on finalized proof; without it the record stays open, a and v kept
  const u = rec({ xmrSendTxid: 'xt', xmrSendHex: '00', xmrRelayed: false, xmrRelayAbandoned: 'window-closed-never-attempted', seenPda: true, a: 'aa'.repeat(32), v: 'vv' });
  const q = deps({ swap: null, revealed: { refund: { secretHex: 'ee'.repeat(32), sig: 's' } } }); q.d.recoverXmr = async () => ({ status: 'absent' }); q.d.proveFinal = async () => ({ final: false, why: 'outcome-not-finalized' });
  const realNow2 = Date.now; let clock2 = realNow2(); Date.now = () => clock2;
  try {
    for (let i = 1; i <= 4; i++) { const out = await makerReverseStep(u, { ...q.d, chainNow: async () => closingAt + 5000 }); clock2 += 120_000; if (i >= 3) assert.equal(out.reason, 'terminal-not-proven'); }
  } finally { Date.now = realNow2; }
  assert.equal(u.done, undefined); assert.equal(u.a, 'aa'.repeat(32)); assert.equal(u.v, 'vv'); assert.equal(u.provisionalResult.result, 'xmr-never-relayed');
});
test('built means sent (b2): two scans less than 100 s apart count once', async () => {
  const s = rec({ xmrSendTxid: 'xt', xmrSendHex: '00', xmrRelayed: false, xmrRelayAbandoned: 'x', seenPda: true });
  const r = deps({ swap: null, revealed: { refund: { secretHex: 'ee'.repeat(32), sig: 's' } } }); r.d.recoverXmr = async () => ({ status: 'absent' });
  const realNow = Date.now; let clock = realNow(); Date.now = () => clock;
  try { await makerReverseStep(s, r.d); clock += 5000; await makerReverseStep(s, r.d); } finally { Date.now = realNow; }
  assert.equal(s.recoverEmptyScans, 1); assert.equal(s.done, undefined);
});
test('built means sent (c): an abandoned transfer that nevertheless appears on chain (someone relayed the hex) continues normally and no second transfer is ever built', async () => {
  const s = rec({ xmrSendTxid: 'xt', xmrSendHex: '00', xmrRelayed: false, xmrRelayAbandoned: 'window-closed-never-attempted' });
  const c = deps({ swap: pda(false), xmr: { atomic: AMT, confirmations: 3 } });
  await makerReverseStep(s, { ...c.d, chainNow: async () => closingAt + 100 });
  assert.equal(s.xmrRelayed, true, 'the scan saw it: resolved'); assert.ok(!c.calls.includes('build') && !c.calls.includes('relay'));
  const ready = deps({ swap: pda(true), xmr: { atomic: AMT, confirmations: CONFIRMATIONS } });
  assert.equal((await makerReverseStep(s, { ...ready.d, chainNow: async () => t1 - CUT - 1000 })).action, 'commit-claim'); assert.ok(!ready.calls.includes('build'));
});
test('static (v2): the transfer identity is never deleted; the secret goes only through the guarded transport, never simulated; the deadline of the claim is the on-chain commit time plus W', async () => {
  const { readFileSync } = await import('node:fs'); const rev = readFileSync(new URL('./maker-reverse.mjs', import.meta.url), 'utf8'), mk = readFileSync(new URL('./maker.mjs', import.meta.url), 'utf8');
  const core = readFileSync(new URL('../client/reverse-core.mjs', import.meta.url), 'utf8'), send = readFileSync(new URL('../client/secret-send.mjs', import.meta.url), 'utf8');
  assert.ok(!/delete s\.xmrSendTxid/.test(rev) && !/delete s\.xmrSendHex/.test(rev));
  assert.match(core, /o\.now < c \+ REV_COMMIT_WINDOW - MARGIN/);
  // The claim (a) goes only through the ONE send discipline: maker-send.mjs sendClaim (never simulated, recorded before broadcast).
  assert.match(mk, /sendClaim: \(x\) => sender\.sendClaim\(x\),/); assert.ok(!/claimStrictIx|sol\.send\(|sol\.sendSecret\(/.test(mk), 'maker.mjs builds no Solana transaction itself');
  const ms = readFileSync(new URL('./maker-send.mjs', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.equal((ms.match(/claimStrictIx\(\{/g) ?? []).length, 1, 'one place builds the claim'); assert.ok(ms.indexOf('claimStrictIx({') > ms.indexOf('async sendClaim('));
  assert.ok(!/conn\.simulateTransaction\(/.test(send), 'a secret-carrying transaction is never simulated');
});

// ---- Astra r8: recovery states (unknown / pending / absent / recovered) and elapsed-time authorization of the XMR relay ----
const refundedRec = (over = {}) => rec({ xmrSendTxid: 'xt', xmrSendHex: '00', seenPda: true, ...over });
const refundDeps = (recover) => { const r = deps({ swap: null, revealed: { refund: { secretHex: 'ab'.repeat(32), sig: 's' } } }); r.d.recoverXmr = recover; return r; };
const withClock = async (fn) => { const real = Date.now; let clock = real(); Date.now = () => clock; try { await fn((ms) => { clock += ms; }); } finally { Date.now = real; } };
test('r8 classify: sweepable, pending (locked or listed), absent; a throwing scan is unknown (an exception), never a count', () => {
  assert.equal(classifyJointBalance({ balance: '5', unlocked_balance: '5' }, null).status, 'sweepable');
  assert.equal(classifyJointBalance({ balance: '5', unlocked_balance: '0' }, { in: [], pool: [] }).status, 'pending');
  assert.equal(classifyJointBalance({ balance: '0', unlocked_balance: '0' }, { in: [], pool: [{ txid: 'x' }] }).status, 'pending');
  assert.equal(classifyJointBalance({ balance: '0', unlocked_balance: '0' }, { in: [{ txid: 'x' }] }).status, 'pending');
  assert.equal(classifyJointBalance({ balance: '0', unlocked_balance: '0' }, { in: [], pool: [] }).status, 'absent');
});
test('r8: locked or pending funds at the joint address are never counted as empty and never end the swap, however many scans', async () => {
  const s = refundedRec({ xmrRelayAbandoned: 'window-closed-never-attempted' }); const r = refundDeps(async () => ({ status: 'pending' }));
  await withClock(async (adv) => { for (let i = 0; i < 6; i++) { await makerReverseStep(s, r.d); adv(200_000); } });
  assert.equal(s.recoverEmptyScans ?? 0, 0); assert.equal(s.done, undefined); assert.equal(s.recoverState, 'pending');
});
test('r8: scan or RPC failures and timeouts increment nothing and end nothing', async () => {
  const s = refundedRec({ xmrRelayAbandoned: 'window-closed-never-attempted' }); const r = refundDeps(async () => { throw new Error('wallet rpc down'); });
  await withClock(async (adv) => { for (let i = 0; i < 5; i++) { await assert.rejects(makerReverseStep(s, r.d), /wallet rpc down/); adv(200_000); } });
  assert.equal(s.recoverEmptyScans ?? 0, 0); assert.equal(s.done, undefined);
  const bad = refundDeps(async () => null); await assert.rejects(makerReverseStep(s, bad.d), /unrecognized result/); // an unknown shape is never read as empty
});
test('r8: a late appearance: two absent scans, then the funds show up pending and later unlock: recovered, never closed early', async () => {
  const s = refundedRec({ xmrRelayAbandoned: 'window-closed-never-attempted' }); const answers = [{ status: 'absent' }, { status: 'absent' }, { status: 'pending' }, { status: 'recovered', txids: ['sw'] }]; const r = refundDeps(async () => answers.shift());
  await withClock(async (adv) => { for (let i = 0; i < 4; i++) { await makerReverseStep(s, r.d); adv(200_000); } });
  assert.deepEqual(s.recoverTxids, ['sw']); assert.equal(s.recoverState, 'recovered'); assert.equal(s.done, undefined, 'recovered ends through the normal done path next pass, not through the empty terminal');
});
test('r8: a transfer that was ATTEMPTED (lost relay reply) or observed is never ended by empty scans: state absent-after-attempt, the record stays open', async () => {
  for (const extra of [{ xmrRelayAttemptAt: 1, xmrRelayAbandoned: 'window-closed-after-attempt' }, { xmrRelayed: true }]) {
    const s = refundedRec(extra); const r = refundDeps(async () => ({ status: 'absent' }));
    await withClock(async (adv) => { for (let i = 0; i < 6; i++) { await makerReverseStep(s, r.d); adv(200_000); } });
    assert.equal(s.done, undefined, JSON.stringify(extra)); assert.equal(s.recoverState, 'absent-after-attempt'); assert.equal(s.xmrSendTxid, 'xt'); assert.equal(s.xmrSendHex, '00');
  }
});
test('r8 wiring: the real wallet adapter answers with the four states and throws on errors', async () => {
  const { readFileSync } = await import('node:fs'); const src = readFileSync(new URL('./maker.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function sweepJoint'), src.indexOf('async function reverseStep'));
  assert.match(fn, /classifyJointBalance\(bal/); assert.match(fn, /status: 'recovered', txids/); assert.ok(!/return null/.test(fn), 'no null (unknown or empty) is returned any more');
});
test('r8: the XMR relay is authorized by ELAPSED time: a delayed FIRST clock reply (it carries an old time) refuses the relay; a retry is judged afresh', async () => {
  const delayedReplyNow = (st, value) => async () => { st.mono += 400_000; return value; };   // the node answers with a safe-looking time, but 400 s after the request
  const st = { mono: 0 }; const safeTime = closingAt - 100;                                   // looks safe if the delay is ignored
  const s = rec(); const c = deps({ swap: pda(false) });
  let n = 0; const chainNow = async () => { n += 1; return n <= 2 ? closingAt - 2000 : delayedReplyNow(st, safeTime)(); };   // decision, fresh check, then the delayed one inside the relay
  const out = await makerReverseStep(s, { ...c.d, chainNow, mono: () => st.mono });
  assert.equal(out.reason, 'relay-abandoned'); assert.ok(!c.calls.includes('relay')); assert.equal(s.xmrSendTxid, 'xt', 'identity kept');
  // retry on a later pass: fresh authorizer, a prompt reply inside the window relays the SAME transfer; an expired window does not
  const again = { ...s }; delete again.xmrRelayAbandoned; const c2 = deps({ swap: pda(false) });
  await makerReverseStep(again, { ...c2.d, chainNow: async () => closingAt - 3000, mono: () => 0 }); assert.ok(c2.calls.includes('relay')); assert.equal(again.xmrRelayed, true);
});
// ---- Protocol v2: two-step claim (commit without a secret, then the secret inside W), resend, and the closed window ----
const ready = (c = 0, over = {}) => ({ swap: pda(true, c), ...over });
const owned = () => rec({ xmrSendTxid: 'xt', xmrRelayed: true });
test('v2: with no commit on the finalized account the secret is never sent, at any time (before or after t1)', async () => {
  for (const now of [t0 + 10, t1 - 2000, t1 - 301, t1 - 299, t1, t1 + 5000]) {
    const x = deps({ ...ready(0), now, xmr: { atomic: AMT, confirmations: CONFIRMATIONS } });
    await makerReverseStep(owned(), x.d);
    assert.ok(!x.calls.includes('claim'), `no secret without a commit at ${now}`);
    if (now >= t1 - SWAP_MARGIN) assert.deepEqual(x.calls, [], `no commit either this close to t1 (${now})`);
  }
});
test('v2: after the commit is on the finalized account the maker claims, past t1 too, without needing the XMR scan, with the deadline c + W - MARGIN', async () => {
  const c0 = t1 - 100;
  for (const now of [c0 + 1, t1 + 10, c0 + W - SWAP_MARGIN - 1]) {
    let args; const x = deps({ ...ready(c0), now, xmr: null });
    const r = await makerReverseStep(owned(), { ...x.d, sendClaim: async (...a) => { args = a; x.calls.push('claim'); return { sig: 'cs' }; } });
    assert.equal(r.action, 'claim', `claim at ${now}`); assert.deepEqual(x.calls, ['claim']); assert.equal(args.length, 1, 'the deadline c + W is the sender\'s own finalized read');
  }
});
test('v2: the claim is never sent from c + W - MARGIN on; the maker waits for the user refund and then recovers its XMR', async () => {
  const c0 = t1 - 100;
  for (const now of [c0 + W - SWAP_MARGIN, c0 + W, c0 + W + 7200]) {
    const x = deps({ ...ready(c0), now });
    const r = await makerReverseStep(owned(), x.d);
    assert.equal(r.reason, 'claim-window-closed-await-refund'); assert.deepEqual(x.calls, []);
  }
  const y = deps({ swap: null, revealed: { refund: { secretHex: 'bb'.repeat(32), sig: 'r' } } });
  assert.equal((await makerReverseStep({ ...owned(), seenPda: true }, y.d)).action, 'recover-xmr');
});
test('v2: a claim stale by the time of the send (clock past c + W - MARGIN) is not sent; a failing clock fails closed', async () => {
  const c0 = t1 - 100, times = [c0 + 100, c0 + W - SWAP_MARGIN + 5];
  const x = deps({ ...ready(c0) });
  assert.equal((await makerReverseStep(owned(), { ...x.d, chainNow: async () => times.shift() ?? c0 + W })).reason, 'stale-authorization'); assert.deepEqual(x.calls, []);
  let n = 0; const y = deps({ ...ready(c0) });
  assert.equal((await makerReverseStep(owned(), { ...y.d, chainNow: async () => { if (n++ === 0) return c0 + 100; throw new Error('down'); } })).reason, 'stale-authorization'); assert.deepEqual(y.calls, []);
});
test('v2: resend: a claim that did not land is sent again after a short pause, as often as needed inside the window, never faster than the pause', async () => {
  const c0 = t1 - 100; let wall = 1_000_000;
  const x = deps({ ...ready(c0), now: c0 + 50 }); x.d.wallNow = () => wall;
  const s = owned();
  assert.equal((await makerReverseStep(s, x.d)).action, 'claim');
  assert.equal((await makerReverseStep(s, x.d)).reason, 'claim-pending-finality', 'not again within the pause');
  wall += RESEND_PAUSE_MS + 1;
  assert.equal((await makerReverseStep(s, x.d)).action, 'claim');
  wall += RESEND_PAUSE_MS + 1;
  assert.equal((await makerReverseStep(s, x.d)).action, 'claim');
  assert.deepEqual(x.calls, ['claim', 'claim', 'claim']);
});
test('v2: the commit is sent once per pause and survives a restart (durable marker), and only before t1 - MARGIN', async () => {
  let wall = 5_000_000;
  const x = deps({ ...ready(0), now: t0 + 100, xmr: { atomic: AMT, confirmations: CONFIRMATIONS } }); x.d.wallNow = () => wall;
  const s = owned();
  assert.equal((await makerReverseStep(s, x.d)).action, 'commit-claim');
  assert.ok(x.stored.at(-1).commitSentAt, 'marker stored before the send returns');
  assert.equal((await makerReverseStep(x.stored.at(-1), x.d)).reason, 'commit-pending-finality');
  wall += RESEND_PAUSE_MS + 1;
  assert.equal((await makerReverseStep(x.stored.at(-1), x.d)).action, 'commit-claim');
  assert.deepEqual(x.calls, ['commit', 'commit']);
  const late = deps({ ...ready(0), now: t1 - SWAP_MARGIN, xmr: { atomic: AMT, confirmations: CONFIRMATIONS } });
  assert.deepEqual([(await makerReverseStep(owned(), late.d)).action, late.calls], ['wait', []]);
});
test('v2 wiring: maker.mjs passes sendCommit and the strict decoder reads claim_committed_at; the secret path is only the guarded sendSecret', async () => {
  const { readFile } = await import('node:fs/promises');
  const m = await readFile(new URL('./maker.mjs', import.meta.url), 'utf8'), sol = await readFile(new URL('./strict-sol.mjs', import.meta.url), 'utf8');
  assert.match(m, /sendCommit: \(x\) => sender\.sendCommit\(x\),/); assert.match(m, /sendClaim: \(x\) => sender\.sendClaim\(x\),/); assert.match(m, /resolve: \(x\) => sender\.resolve\(x\),\n    proveFinal: \(x, o\) => sender\.proveFinal\(x, o\),[^\n]*\n    sendCommit/);
  assert.doesNotMatch(m, /claimStrictIx\(|commitClaimStrictIx\(/, 'maker.mjs builds neither; the one sender does');
  assert.match(sol, /8 \+ 194/); assert.match(sol, /claimCommittedAt: Number\(d\.readBigInt64LE\(186\)\)/);
});

// ---- Hygiene (8 Nov 2026): the single-use view key and the maker's spend share are wiped from the record when the swap is final, never before ----
import { scrubSecrets } from './maker-core.mjs';
const secretful = (over = {}) => rec({ a: 'aa'.repeat(32), v: 'vv'.repeat(16), xmrSendTxid: 'xt', xmrRelayed: true, seenPda: true, ...over });
test('hygiene: a final state wipes a and v (and keeps public keys, txids and signatures); an open or recovering swap keeps them', async () => {
  // recovering after a refund still needs a: not wiped
  const rec1 = secretful();
  const r1 = deps({ swap: null, revealed: { refund: { secretHex: 'bb'.repeat(32), sig: 'rs' } } });
  assert.equal((await makerReverseStep(rec1, r1.d)).action, 'recover-xmr'); assert.ok(rec1.a && rec1.v, 'recovery needs the spend share and the view key');
  // after the recovery, the next pass ends the swap and wipes
  const r2 = deps({ swap: null, revealed: { refund: { secretHex: 'bb'.repeat(32), sig: 'rs' } } });
  const rec2 = { ...rec1, recoverTxids: ['rt'] };
  assert.equal((await makerReverseStep(rec2, r2.d)).result, 'xmr-recovered');
  assert.equal(rec2.a, undefined); assert.equal(rec2.v, undefined); assert.ok(rec2.secretWipedAt === undefined && rec2.secretsWipedAt > 0);
  assert.equal(rec2.A, 'aa'); assert.equal(rec2.xmrSendTxid, 'xt'); assert.equal(r2.stored.at(-1).a, undefined, 'the stored copy is the wiped one');
  // a completed swap (the user's claim seen) wipes too
  const rec3 = secretful(); const r3 = deps({ swap: null, revealed: { claim: { secretHex: 'cc'.repeat(32), sig: 'cs' } } });
  assert.equal((await makerReverseStep(rec3, r3.d)).result, 'completed'); assert.equal(rec3.a, undefined); assert.equal(rec3.v, undefined);
  // a quote nobody locked
  const rec4 = secretful({ seenPda: false, xmrSendTxid: undefined }); const r4 = deps({ swap: null, now: LOCKED + 121 + LOCK_WAIT });
  assert.equal((await makerReverseStep(rec4, r4.d)).result, 'not-locked'); assert.equal(rec4.a, undefined);
  // open swaps keep everything
  const rec5 = secretful(); await makerReverseStep(rec5, deps({ swap: pda(false) }).d); assert.ok(rec5.a && rec5.v);
  assert.equal(scrubSecrets({ x: 1 }), 0, 'nothing to wipe, nothing stamped');
});

// ---- Astra F5-M1: a refusal that signed and broadcast nothing does not start the 60 s pause ----
const claimWorld = () => { const c0 = t1 - 100; const owned = () => rec({ xmrSendTxid: 'xt', xmrRelayed: true, seenPda: true, commitSig: 'cm' }); return { c0, owned }; };
test('F5-M1: an unsent claim refusal is retried on the very next pass (well inside 60 s); the pause only starts once something may have gone out', async () => {
  const { c0, owned } = claimWorld(); const s = owned(); let n = 0, wall = 1_000_000;
  const x = deps({ swap: pda(true, c0), now: c0 + 10 });
  const d = { ...x.d, wallNow: () => wall, sendClaim: async () => { n++; return n === 1 ? { refused: 'endpoint-heights-disagree', unsent: true } : { sig: 'cs' }; } };
  let r = await makerReverseStep(s, d); assert.equal(r.reason, 'claim-refused: endpoint-heights-disagree'); assert.equal(s.claimSentAt, undefined, 'no stamp after an unsent refusal');
  wall += 1500; r = await makerReverseStep(s, d); assert.equal(n, 2, 'the sender was called again 1.5 s later'); assert.equal(r.action, 'claim');
  assert.equal(s.claimSentAt, wall, 'now the stamp is set (a send happened)');
  wall += 1500; r = await makerReverseStep(s, d); assert.equal(n, 2); assert.equal(r.reason, 'claim-pending-finality', 'a real attempt still blocks a replacement inside the pause');
});
test('F5-M1: a refusal that is NOT marked unsent (pending attempt, ambiguity) keeps the stamp and the pause; a previous stamp is restored, not erased', async () => {
  const { c0, owned } = claimWorld(); let wall = 1_000_000;
  for (const refused of ['attempt-open', 'claim-ambiguous']) {
    const s = owned(), x = deps({ swap: pda(true, c0), now: c0 + 10 }); let n = 0;
    const d = { ...x.d, wallNow: () => wall, sendClaim: async () => { n++; return { refused }; } };
    await makerReverseStep(s, d); assert.equal(s.claimSentAt, wall, `${refused} keeps the stamp`);
    wall += 1500; const r = await makerReverseStep(s, d); assert.equal(n, 1); assert.equal(r.reason, 'claim-pending-finality');
    wall += 100_000;
  }
  const s = owned({}); s.claimSentAt = 900_000; const x = deps({ swap: pda(true, c0), now: c0 + 10 });
  await makerReverseStep(s, { ...x.d, wallNow: () => 900_000 + RESEND_PAUSE_MS + 5, sendClaim: async () => ({ refused: 'blockhash-may-outlive-claim-window', unsent: true }) });
  assert.equal(s.claimSentAt, 900_000, 'the earlier stamp is put back');
  const t2 = owned(); const y = deps({ swap: pda(true, c0), now: c0 + 10 });
  await assert.rejects(makerReverseStep(t2, { ...y.d, wallNow: () => 5, sendClaim: async () => { throw new Error('connection lost mid-send'); } }));
  assert.equal(t2.claimSentAt, 5, 'a thrown (ambiguous) send keeps the stamp');
});

// ---- Sol M3 residual: identical Solana history, Monero recovery done vs pending vs failed vs absent: same public response, pass by pass ----
import { publicSwapView } from './maker-lanes.mjs';
test('Sol M3 residual (reverse): a user refund; recovery recovered, pending, failing or absent gives the same public response at every pass', async () => {
  const run = async (kind) => {
    const s = rec({ direction: 'sol-xmr', lockSig: 'LK', xmrSendTxid: 'xt', xmrRelayed: true, seenPda: true }); const views = [];
    const x = deps({ swap: null, revealed: { refund: { secretHex: 'bsecret', sig: 'REFUNDSIG' } } });
    x.d.recoverXmr = async () => { if (kind === 'fail') throw new Error('wallet rpc down'); return kind === 'ok' ? { status: 'recovered', txids: ['rt'] } : { status: kind }; };
    for (let i = 0; i < 4; i++) { try { await makerReverseStep(s, x.d); } catch {} views.push(JSON.stringify(publicSwapView(s))); }
    return { views, s };
  };
  const ok = await run('ok'), pending = await run('pending'), fail = await run('fail'), absent = await run('absent');
  for (let i = 0; i < 4; i++) for (const o of [pending, fail, absent]) assert.equal(o.views[i], ok.views[i], `pass ${i}`);
  assert.deepEqual(JSON.parse(ok.views[0]), { swapId: 'ab', direction: 'sol-xmr', lockSig: 'LK', readySig: null, refundSig: 'REFUNDSIG', claimSig: null, state: 'refunded' });
  assert.ok(ok.s.recoverTxids && ok.s.done, 'recovery did complete in one variant'); assert.equal(pending.s.done, undefined, 'and did not in the other');
});
