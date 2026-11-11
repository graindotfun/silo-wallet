#!/usr/bin/env node
// THE read-only quiesce check of the maker, both directions, before a program upgrade (MAKER_ADMISSION_GATE_SPEC.md revision 2, section 4).
// It replaces PR 675's program/upgrade-quiesce-check.mjs (retired; its rules are kept here: StrictSwap accounts of ANYONE always block, the
// maker as refunder OR claimer in either escrow layout blocks, strangers are listed). It sends nothing, signs nothing and
// never writes, moves or deletes anything under the state directory (R11): its only output besides stdout is the report file, which must
// lie outside the state directory. OK only if ALL of these hold; anything it cannot read or classify is NOT OK:
//   1. the RPC's genesis hash is mainnet, the program is the swap program, and /v1/status reports the same program, network mainnet, the
//      maker key given with --maker-key and the state directory given with --state; it reports the generation and start time of the
//      journal's last maker-started, and a second status read at the end reports the same generation (the same process served the run);
//   2. /v1/status: admission closed, in flight 0 (at the start and at the end);
//   3. every swap file is valid JSON matching the record schema; every send attempt it holds as open (set-ready, refund, commit, strict
//      claim) is settled from this script's own reads (finalized status, or unknown and expired); an open record with an ambiguity mark
//      blocks; a SOL -> XMR record passes only as K0 (final, no escrow at its strict PDA); an XMR -> SOL record is one of K0 final, K1 outcome proven from the PDA history, K2
//      write-ahead lock expired, K3 aborted before signing, K4 expired by process boundary (classifyRecord in maker-core.mjs), all from
//      this script's OWN finalized reads: an expiry observation first, then absence reads from contexts at least as new (AG-H2). Anything
//      else is NOT OK (ambiguous), in particular an empty lockSig with no account and no K1 to K4 evidence. Every swap the journal names
//      (swap-recorded, sol-locked) must have its file;
//   4. getProgramAccounts (finalized, data sizes 194 and 202, contexts at or after the expiry observation): no escrow with the maker as refunder
//      (offset 8) or as claimer (offset 40) in either layout, and NO StrictSwap account of anyone (the v2 binary cannot read a pre-v2
//      186-byte strict account, and a downgrade would strand a v2 one; 691, always on, no flag);
//   5. every other escrow is listed with refunder, t0, t1 and ready, not blocking;
//   6. it prints the finalized slot range it read. A snapshot, not a freeze: strangers can still lock directly on chain.
// Residual assumption: an honest RPC. Context checks reject stale answers; they cannot beat a lying RPC (MAINNET_RUNBOOK.md 3b).
// Usage, on the maker host as the maker user:
//   ALLOW_MAINNET_READS=1 node quiesce-check.mjs --state /var/lib/swapmaker/state --maker http://127.0.0.1:<port> \
//        --env-file /etc/swapmaker/maker.env --maker-key <maker public key> --rpc <mainnet rpc url> --report <file outside the state dir>
//   (--token-file <file> instead of --env-file also works; the token is never printed or written.)
import { readdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import * as sol from '../client/sol.mjs';
import { classifyRecord, K4_TIME_MARGIN_S, REVERSE_FINAL, ATTEMPT_LISTS } from './maker-core.mjs';
import { createHash } from 'node:crypto';
import { rpcClient, chainSnapshot, collectEvidence, txKind } from './maker-chain.mjs';
export { rpcClient, txKind };

export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const SWAP_PROGRAM = '7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS';

const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const isB58 = (x, min, max) => typeof x === 'string' && x.length >= min && x.length <= max && B58.test(x);
const optional = (v, ok) => v === undefined || ok(v);
/** Schema of a swap file as this maker writes it. Anything else is kept and blocks (R11): it is never guessed at. */
export function recordProblem(s, fileId) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'not an object';
  if (typeof s.swapId !== 'string' || !/^[0-9a-f]{64}$/.test(s.swapId)) return 'swapId missing or malformed';
  if (fileId !== undefined && fileId !== s.swapId) return 'file name does not match swapId';
  if (typeof s.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(s.createdAt) || !Number.isFinite(Date.parse(s.createdAt))) return 'createdAt missing or malformed';
  if (!optional(s.lockSig, (v) => isB58(v, 32, 88))) return 'lockSig malformed';
  if (!optional(s.lockBlockhash, (v) => isB58(v, 32, 44))) return 'lockBlockhash malformed';
  if (!optional(s.lockLastValidBlockHeight, (v) => Number.isSafeInteger(v) && v >= 0)) return 'lockLastValidBlockHeight malformed';
  if (!optional(s.lockFormat, Number.isInteger)) return 'lockFormat malformed';
  if (!optional(s.solLocked, (v) => typeof v === 'boolean')) return 'solLocked malformed';
  if (!optional(s.direction, (v) => v === 'xmr-sol' || v === 'sol-xmr')) return 'direction has an unknown value';
  if (s.direction === 'sol-xmr') {
    if (!isB58(s.refunder, 32, 44)) return 'refunder missing or malformed';   // also kept by retention: the collector derives the strict PDA from it (709-M2)
    if (!optional(s.pda, (v) => isB58(v, 32, 44))) return 'pda malformed';
    if (!optional(s.done, (v) => REVERSE_FINAL.has(v))) return 'done has an unknown value';
  } else if (!optional(s.done, (v) => v === 'completed' || v === 'refunded')) return 'done has an unknown value';
  for (const list of ATTEMPT_LISTS) {
    if (!optional(s[list], Array.isArray)) return `${list} malformed`;
    for (const a of s[list] ?? []) if (!a || typeof a !== 'object' || !isB58(a.sig, 32, 88) || !Number.isSafeInteger(a.lastValidBlockHeight) || typeof a.state !== 'string') return `${list} entry malformed`;
  }
  for (const k of ['earlyAbort', 'claimAbort']) if (!optional(s[k], (v) => typeof v === 'string')) return `${k} malformed`;
  if (!optional(s.abortedBeforeSign, (v) => v && typeof v === 'object')) return 'abortedBeforeSign malformed';
  if (!optional(s.lockNeverLanded, (v) => v && typeof v === 'object')) return 'lockNeverLanded malformed';
  if (!optional(s.xmrAtomic, (v) => typeof v === 'string' && /^\d+$/.test(v))) return 'xmrAtomic malformed';
  return null;
}

/** Reads every swap file. An unreadable or invalid one is kept as { blocked: name, why } (it blocks). Read-only. */
export function readRecords(stateDir) {
  const dir = join(stateDir, 'swaps');
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    const id = f.slice(0, -5);
    let s; try { s = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return { blocked: id.slice(0, 8), why: 'unreadable file' }; }
    const p = recordProblem(s, id);
    return p ? { blocked: id.slice(0, 8), why: `invalid record: ${p}` } : s;
  });
}
/**
 * One pass over the journal: the last maker-started event { at, generation } (or null) and every swap id the journal names as recorded or
 * locked (so a swap file missing from the directory is seen). A torn line is skipped. Read-only.
 */
export function journalFacts(stateDir) {
  let started = null; const named = new Set();
  for (const line of readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').split('\n')) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.event === 'maker-started' && typeof e.at === 'string') started = { at: e.at, generation: typeof e.generation === 'string' ? e.generation : null };
    if ((e.event === 'swap-recorded' || e.event === 'sol-locked') && typeof e.swapId === 'string') named.add(e.swapId);
  }
  return { started, named };
}
/** Time of the most recent maker-started event in the journal (R9), or null. Read-only. */
export const lastMakerStarted = (stateDir) => journalFacts(stateDir).started?.at ?? null;

const STRICT_DISC = createHash('sha256').update('account:StrictSwap').digest().subarray(0, 8);
/**
 * Program accounts (base64) -> ours (maker is refunder at offset 8 OR claimer at offset 40; both layouts put them there), strangers decoded,
 * strictAll (EVERY StrictSwap account of anyone, any size: the pre-v2 186-byte layout too), undecodable (neither layout).
 */
export function classifyEscrows(accounts, makerKey) {
  const ours = [], foreign = [], undecodable = [], strictAll = [];
  for (const a of accounts) {
    const data = Buffer.from(a.data, 'base64');
    if (data.length >= 72 && data.subarray(0, 8).equals(STRICT_DISC)) {
      strictAll.push(a.pubkey);
      const refunder = new PublicKey(data.subarray(8, 40)).toBase58(), claimer = new PublicKey(data.subarray(40, 72)).toBase58();
      if (refunder === makerKey || claimer === makerKey) ours.push(a.pubkey); else foreign.push({ pubkey: a.pubkey, refunder, strict: true });
      continue;
    }
    let d; try { d = sol.decodeSwap(data); } catch { undecodable.push(a.pubkey); continue; }
    if (d.refunder === makerKey || d.claimer === makerKey) ours.push(a.pubkey); else foreign.push({ pubkey: a.pubkey, refunder: d.refunder, t0: d.t0, t1: d.t1, ready: d.ready });
  }
  return { ours, foreign, undecodable, strictAll };
}
/** Data sizes of the two escrow layouts: Swap and the pre-v2 StrictSwap (8 + 186), the v2 StrictSwap (8 + 194). */
export const ESCROW_SIZES = [sol.SWAP_ACCOUNT_LEN, 8 + 194];

/** Pure verdict. classes: [{ id, k, why, txids? }] for every swap file; any null input is a failure. */
export function quiesceVerdict({ status, classes, chain, binding, generation, missing = [] }) {
  const problems = [];
  if (!binding?.ok) problems.push(`binding failed: ${binding?.why ?? 'not checked'}`);
  if (!generation?.ok) problems.push(`maker process check failed: ${generation?.why ?? 'not checked'}`);
  if (!status || typeof status !== 'object') problems.push('maker status unreachable or unreadable');
  else {
    if (status.admission !== 'closed') problems.push('admission is not closed (create the drain file first)');
    if (!(Number.isInteger(status.inflight) && status.inflight === 0)) problems.push(`admissions in flight: ${status.inflight}`);
  }
  if (!Array.isArray(classes)) problems.push('swap files unreadable');
  else for (const c of classes) if (!c.k) problems.push(`swap ${c.id}: NOT OK (ambiguous: ${c.why})`);
  for (const id of missing) problems.push(`swap ${id.slice(0, 8)}: named in the journal but its swap file is missing`);
  if (!chain || !Array.isArray(chain.ours) || !Array.isArray(chain.undecodable)) problems.push('chain check not run or failed (set ALLOW_MAINNET_READS=1 and --rpc)');
  else {
    if (chain.ours.length) problems.push(`${chain.ours.length} escrow account(s) with this maker as refunder or claimer exist on chain: ${chain.ours.slice(0, 5).map((k) => k.slice(0, 8)).join(', ')}`);
    if (chain.undecodable.length) problems.push(`${chain.undecodable.length} program account(s) of escrow size could not be classified`);
    // 691 (Astra), always on: no StrictSwap account of anyone, strangers included. No proof means no.
    if (!Array.isArray(chain.strictAll)) problems.push('strict-account proof not available (chain check failed)');
    else if (chain.strictAll.length) problems.push(`${chain.strictAll.length} StrictSwap account(s) exist on chain (any owner, strangers included): the v2 binary cannot read a pre-v2 one and a downgrade would strand a v2 one`);
  }
  return { ok: problems.length === 0, problems };
}

/** Binding of RPC, program, maker status and state directory (contract item 1). stateDir is the realpath of --state. */
export function bindingCheck({ genesis, program, status, makerKey, stateDir }) {
  if (program !== SWAP_PROGRAM) return { ok: false, why: `program ${program} is not the swap program ${SWAP_PROGRAM}` };
  if (genesis !== MAINNET_GENESIS) return { ok: false, why: `the RPC is not mainnet-beta (genesis ${genesis ?? 'unreadable'})` };
  if (!status) return { ok: false, why: 'maker status unavailable' };
  if (status.programId !== program || status.network !== 'mainnet' || status.maker !== makerKey) return { ok: false, why: 'the maker reports a different program id, a non-mainnet network or a different maker key' };
  if (typeof stateDir !== 'string' || status.stateDir !== stateDir) return { ok: false, why: 'the maker serves a different state directory than --state' };
  return { ok: true, why: '' };
}

/**
 * Process generation (K4 boundary bound to the serving process): the journal's last maker-started names the generation and start time that
 * /v1/status reports, and a second status read at the END of the run reports the same generation, admission closed and nothing in flight.
 */
export function generationCheck({ started, first, last }) {
  if (!started?.generation) return { ok: false, why: 'the journal has no maker-started with a generation' };
  if (!first || first.generation !== started.generation || first.startedAt !== started.at) return { ok: false, why: 'the serving maker is not the process of the journal\'s last maker-started' };
  if (!last || last.generation !== first.generation) return { ok: false, why: 'the maker process changed during the check' };
  if (last.admission !== 'closed' || last.inflight !== 0) return { ok: false, why: 'admission reopened or an admission started during the check' };
  return { ok: true, why: '' };
}

/** Only these getBlock errors mean "no block in this slot"; any other error means the boundary cannot be established. */
export const SKIPPED_SLOT_CODES = new Set([-32007]);
/**
 * K4 height H: the first finalized block whose blockTime is at least startedAt + 120 s. Searches back from the finalized tip by doubling,
 * then bisects. Skipped slots (SKIPPED_SLOT_CODES only) are stepped over; any other error or an answer without height and time returns null.
 */
export async function boundaryHeight(rpc, startedAt, tipSlot) {
  const target = Math.floor(Date.parse(startedAt) / 1000) + K4_TIME_MARGIN_S;
  if (!Number.isFinite(target) || !Number.isInteger(tipSlot)) return null;
  // First block in [from, limit): the block, 'none' when every slot there is skipped, or null when that cannot be established.
  const first = async (from, limit) => {
    for (let s = from, n = 0; s < limit; s++, n++) {
      if (n >= 256) return null;
      let b; try { b = await rpc('getBlock', [s, { commitment: 'finalized', transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 }]); } catch (e) { if (SKIPPED_SLOT_CODES.has(e?.code)) continue; return null; }
      if (b && Number.isInteger(b.blockHeight) && Number.isInteger(b.blockTime)) return { slot: s, blockHeight: b.blockHeight, blockTime: b.blockTime };
      return null;
    }
    return 'none';
  };
  let best = null;
  for (let back = 0; back <= 256 && !best; back += 32) { const b = await first(Math.max(0, tipSlot - back - 32), tipSlot - back + 1); if (b === null) return null; if (b !== 'none') best = b; }
  if (!best || best.blockTime < target) return null;   // the boundary is not finalized yet
  let hi = best.slot, lo = null;
  for (let step = 1; lo === null; step *= 2) {
    if (hi - step < 0) return null;
    const b = await first(hi - step, hi); if (b === null) return null;
    if (b === 'none') continue;
    if (b.blockTime >= target) { best = b; hi = b.slot; } else lo = b.slot;
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2); const b = await first(mid, hi); if (b === null) return null;
    if (b === 'none') { hi = mid; continue; }
    if (b.blockTime >= target) { best = b; hi = b.slot; } else lo = b.slot;
  }
  return { H: best.blockHeight, slot: best.slot };
}

/** Evidence for one record (maker-chain collectEvidence): the run's expiry snapshot plus the record's own absence reads, all fresh. */
export async function recordEvidence(rpc, { record, makerKey, program, snapshot, boundary }) {
  sol.setProgramId(program);
  return collectEvidence(rpc, { snapshot, record, makerKey: new PublicKey(makerKey), program, boundary });
}

function readToken({ tokenFile, envFile }) {
  if (tokenFile) return readFileSync(tokenFile, 'utf8').trim();
  const line = readFileSync(envFile, 'utf8').split('\n').find((l) => /^\s*MAKER_API_TOKEN\s*=/.test(l));
  return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') : '';
}
/** The report must not be written inside the state directory (R11). */
export function reportPathAllowed(reportPath, stateDir) {
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const st = real(stateDir) + sep, rp = real(dirname(resolve(reportPath))) + sep;
  return !rp.startsWith(st);
}

/** Runs the whole check. Returns { ok, problems, report }. Writes nothing itself. */
export async function runCheck({ state, makerUrl, token, rpcUrl, makerKey, program = SWAP_PROGRAM, allowMainnetReads }) {
  let status = null, statusEnd = null, records = null, chain = null, genesis = null, slotBefore = null, slotAfter = null, journal = null, boundary = null, classes = null, snapshot = null, stateDir = null;
  const readStatus = async () => { try { const r = await fetch(`${makerUrl}/v1/status`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }); if (r.ok) return await r.json(); } catch { /* stays null */ } return null; };
  status = await readStatus();
  try { stateDir = realpathSync(state); } catch { /* stays null */ }
  try { records = readRecords(state); } catch { /* stays null */ }
  try { journal = journalFacts(state); } catch { /* stays null */ }
  const startedAt = journal?.started?.at ?? null;
  if (allowMainnetReads && rpcUrl) {
    const rpc = rpcClient(rpcUrl);
    try {
      genesis = await rpc('getGenesisHash', []);
      if (genesis === MAINNET_GENESIS && program === SWAP_PROGRAM) {
        // The expiry observation comes FIRST; every absence read below must answer from a context at or after its slot (AG-H2).
        snapshot = await chainSnapshot(rpc);
        slotBefore = snapshot?.expiry?.slot ?? null;
        if (startedAt && Number.isInteger(slotBefore)) { const b = await boundaryHeight(rpc, startedAt, slotBefore).catch(() => null); boundary = { started: startedAt, H: b?.H ?? null }; } else boundary = { started: startedAt, H: null };
        if (Array.isArray(records)) {
          classes = [];
          for (const s of records) {
            if (s.blocked) { classes.push({ id: s.blocked, k: null, why: s.why }); continue; }
            const ev = await recordEvidence(rpc, { record: s, makerKey, program, snapshot, boundary }).catch(() => null);
            const c = classifyRecord(s, ev);
            classes.push({ id: String(s.swapId).slice(0, 8), ...c, ...(c.k && ev?.history?.some((h) => h.kind === 'unrelated' || h.err) ? { unrelatedHistory: ev.history.filter((h) => h.kind === 'unrelated' || h.err).length } : {}) });
          }
        }
        if (Number.isInteger(slotBefore)) {
          // Both escrow layouts, each answer from a context at or after the expiry observation; any stale or unreadable answer leaves chain null.
          const all = [];
          let fresh = true;
          for (const dataSize of ESCROW_SIZES) {
            const pa = await rpc('getProgramAccounts', [program, { commitment: 'finalized', encoding: 'base64', withContext: true, minContextSlot: slotBefore, filters: [{ dataSize }] }]);
            if (!(Number.isInteger(pa?.context?.slot) && pa.context.slot >= slotBefore && Array.isArray(pa.value))) { fresh = false; break; }
            all.push(...pa.value.map((a) => ({ pubkey: a.pubkey, data: a.account.data[0] })));
          }
          if (fresh) chain = classifyEscrows(all, makerKey);
        }
        slotAfter = await rpc('getSlot', [{ commitment: 'finalized' }]);
      }
    } catch { chain = null; }
  }
  statusEnd = await readStatus();
  const binding = bindingCheck({ genesis, program, status, makerKey, stateDir });
  const generation = generationCheck({ started: journal?.started ?? null, first: status, last: statusEnd });
  const present = new Set((records ?? []).filter((r) => !r.blocked).map((r) => r.swapId));
  const blockedIds = (records ?? []).filter((r) => r.blocked).map((r) => r.blocked);
  const missing = journal ? [...journal.named].filter((id) => !present.has(id) && !blockedIds.includes(id.slice(0, 8))) : [];
  const v = quiesceVerdict({ status, classes, chain, binding, generation, missing: journal ? missing : ['journal-unreadable'] });
  const report = { at: new Date().toISOString(), ok: v.ok, problems: v.problems, finalizedSlots: [slotBefore, slotAfter], expiry: snapshot?.expiry ?? null, historyIndex: snapshot?.historyIndex ?? null, makerStarted: startedAt, generation: journal?.started?.generation ?? null, boundary, classes, strangers: chain?.foreign ?? null, admission: status?.admission ?? null, inflight: status?.inflight ?? null };
  return { ...v, report };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const state = arg('state'), makerUrl = arg('maker'), tokenFile = arg('token-file'), envFile = arg('env-file'), rpcUrl = arg('rpc'), makerKey = arg('maker-key'), reportPath = arg('report');
  if (!state || !makerUrl || !(tokenFile || envFile) || !makerKey || !reportPath) { console.error('Usage: ... --state <dir> --maker <url> --env-file <file>|--token-file <file> --maker-key <key> --rpc <url> --report <file> [--program <id>]'); process.exit(2); }
  if (!reportPathAllowed(reportPath, state)) { console.error('The report must be written outside the state directory.'); process.exit(2); }
  const r = await runCheck({ state, makerUrl, token: readToken({ tokenFile, envFile }), rpcUrl, makerKey, program: arg('program') ?? SWAP_PROGRAM, allowMainnetReads: process.env.ALLOW_MAINNET_READS === '1' });
  writeFileSync(reportPath, JSON.stringify(r.report, null, 2) + '\n', { flag: 'wx' });   // never overwrites an earlier report
  console.log(`Read at finalized slots ${r.report.finalizedSlots[0]}..${r.report.finalizedSlots[1]}. Report: ${reportPath}`);
  for (const c of r.report.classes ?? []) console.log(`  swap ${c.id}: ${c.k ?? 'NOT OK'} (${c.why})${c.txids ? ' tx ' + c.txids.join(', ') : ''}`);
  if (r.report.strangers?.length) { console.log(`${r.report.strangers.length} escrow(s) of other parties (direct on-chain locks), not blocking:`); for (const f of r.report.strangers) console.log(`  ${f.pubkey} refunder ${f.refunder} t0 ${f.t0} t1 ${f.t1} ready ${f.ready}`); }
  if (r.ok) {
    console.log('OK: admission closed, nothing in flight, every swap file (both directions) classified K0 to K4 with every send attempt settled, no escrow with this maker as refunder or claimer on chain, no StrictSwap account of anyone.');
    console.log('This is a snapshot, not a freeze: the program is permissionless and has no pause. Keep the drain file in place and run this again right before signing.');
    process.exit(0);
  }
  console.log('NOT OK: do not upgrade the program.'); for (const p of r.problems) console.log(`  - ${p}`); process.exit(1);
}
