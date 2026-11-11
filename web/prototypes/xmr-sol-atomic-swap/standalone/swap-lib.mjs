// Standalone SOL -> XMR swap driver (reference client). The user brings a maker URL, a Solana RPC URL and a Monero wallet RPC;
// nothing else is contacted. The swap decisions (what is safe to send, and when) come from the same modules Silo's wallet runs
// (lib/silo/atomic-swap/bob-flow.mjs and client/reverse-core.mjs, rules U1-U5), and the step order comes from the same driver
// (lib/silo/atomic-reverse-driver.mjs). This file is NOT free of logic of its own. It adds what a program without a wallet UI needs, and that includes
// recovery and reconciliation code (the encrypted recovery file and its locking, funding reconciliation in the XMR to SOL file, the wallet RPC sweep):
//   - client-side checks of the maker's quote before anything is stored or locked,
//   - a durable, encrypted local swap file (written before the maker is contacted with the registration),
//   - the Solana signer (a key file the user names) that signs only the three reviewed layouts,
//   - the user's own Monero view of the joint address and the sweep, through the user's own wallet RPC.
// Secrets (key file contents, tokens, RPC URLs, swap secrets) are never logged and never put in an error message.
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants as fsc, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createEnvelopeCodec, EnvelopeError, PASSPHRASE_MIN_CHARS, peekHeader } from './swap-envelope.mjs';
import { scrub, describeError, createLogger } from './swap-log.mjs';
import * as flow from '../../../lib/silo/atomic-swap/bob-flow.mjs';
import { SILO_ATOMIC_PROGRAM_ID, SILO_ATOMIC_MAX_LOCK_LAMPORTS, verifySiloAtomicRefunderTx } from '../../../lib/silo/atomic-swap/refunder-tx.mjs';
import { createReverseDriver, REFUND_AFTER_T1_S } from '../../../lib/silo/atomic-reverse-driver.mjs';
import { verifyShare, unhex } from '../client/keys.mjs';
import { REV_T0_LEAD, REV_CLAIM_WINDOW, REV_COMMIT_WINDOW } from '../client/reverse-core.mjs';
import { MARGIN, LOCK_WAIT, ABORT_LEAD } from '../client/swap-core.mjs';
import { rpcClient } from '../client/monero-rpc.mjs';
import { usableFromTransfers } from '../maker/maker-core.mjs';
import { classifyJointBalance } from '../maker/maker-reverse.mjs';

export const PROGRAM_ID = SILO_ATOMIC_PROGRAM_ID;           // pinned by the reviewed transaction builder; never read from configuration
export const RECORD_FORMAT = 'silo-standalone-swap/1';
export const GENESIS = { mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' };
export const LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
export const DEFAULT_MAX_SPREAD_BPS = 500;                   // client policy, not a protocol rule: a quote above this is refused unless the user raises it
export const QUOTE_MAX_TTL_S = 900;                          // client policy: a quote that stays open longer than this is refused
export const POLL_MS = 20_000;
export const SCAN_TIMEOUT_MS = 600_000;                      // wallet RPC syncs natively; the wallet's 120 s bound was sized for a browser

export class SwapRefusal extends Error {
  constructor(code, message) { super(message); this.name = 'SwapRefusal'; this.code = code; }
}
export const refuse = (code, message) => { throw new SwapRefusal(code, message); };

// ---- URLs and redaction -------------------------------------------------------------------------------------------------------------
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** A user-supplied http(s) URL: no embedded credentials, https unless the host is loopback. Returns the URL without a trailing slash. */
export function parseUserUrl(value, what) {
  let u;
  try { u = new URL(String(value)); } catch { return refuse('bad-url', `The ${what} URL is not a valid URL.`); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) refuse('bad-url', `The ${what} URL must use https (plain http is accepted only for localhost).`);
  if (u.username || u.password) refuse('bad-url', `The ${what} URL must not contain a user name or password.`);
  return u.toString().replace(/\/+$/, '');
}
/** Kept for callers: the strict scrub of swap-log.mjs (known secrets, credential URLs, long hex and base58 strings). */
export function redact(message, secrets = []) { return scrub(message, secrets, { strict: true }); }
export { describeError };

/** Wraps a fetch so a redirect is never followed and is refused by name (an endpoint that redirects is not the endpoint the user chose). */
export function noRedirect(fetcher) {
  return async (url, init = {}) => {
    const res = await fetcher(url, { ...init, redirect: 'manual' });
    if (res?.type === 'opaqueredirect' || (res?.status >= 300 && res?.status < 400)) throw new SwapRefusal('redirect-refused', 'An endpoint answered with a redirect, which is refused.');
    return res;
  };
}

// ---- number helpers -----------------------------------------------------------------------------------------------------------------
export function parseXmrAmount(text) {
  if (typeof text !== 'string' || !/^\d{1,4}(\.\d{1,12})?$/.test(text)) refuse('bad-amount', 'Enter the XMR amount as a decimal number such as 0.01 (up to 12 decimals).');
  const [i, f = ''] = text.split('.');
  const atomic = BigInt(i) * 10n ** 12n + BigInt(f.padEnd(12, '0'));
  if (atomic <= 0n) refuse('bad-amount', 'The XMR amount must be above zero.');
  return atomic;
}
export const formatAtomic = (n, decimals) => { const s = BigInt(n).toString().padStart(decimals + 1, '0'); return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/0+$/, '').replace(/\.$/, '.0'); };
export const formatXmr = (atomic) => formatAtomic(atomic, 12);
export const formatSol = (lamports) => formatAtomic(lamports, 9);
export const utc = (s) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');

// ---- the maker client ---------------------------------------------------------------------------------------------------------------
/** Two POST calls, nothing else. A maker that needs a bearer token gets it from the caller (an environment variable in the CLI); it is never stored. */
export function createMakerClient({ url, token = null, fetcher = fetch, timeoutMs = 15_000, maxBytes = 16_384 }) {
  const base = parseUserUrl(url, 'maker');
  async function call(path, body) {
    const res = await fetcher(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body), cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) throw new SwapRefusal('maker-redirect', 'The maker answered with a redirect, which is refused.');
    const text = await res.text();
    if (text.length > maxBytes) throw new SwapRefusal('maker-answer-too-large', 'The maker answer is too large.');
    let json; try { json = JSON.parse(text); } catch { throw new SwapRefusal('maker-answer-invalid', 'The maker answer is not JSON.'); }
    if (!res.ok || json?.error) throw new SwapRefusal('maker-refused', `The maker refused: ${typeof json?.error === 'string' ? json.error.replace(/[^\w .:-]/g, '').slice(0, 64) : `HTTP ${res.status}`}`);
    return json;
  }
  return { url: base, secrets: [url, token].filter(Boolean), quote: (xmrText) => call('/v1/rev/quote', { xmr: xmrText }), register: (body) => call('/v1/rev/swap', body),
    // XMR to SOL (the other direction): same client, same limits
    quoteForward: (xmrText) => call('/v1/quote', { xmr: xmrText }), registerForward: (body) => call('/v1/swap', body) };
}

// ---- client-side quote checks (before anything is stored or locked) -----------------------------------------------------------------
const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
const isPubkey = (s) => { try { return typeof s === 'string' && bs58.decode(s).length === 32; } catch { return false; } };
/**
 * Everything that can be checked about a quote from the quote alone. The checks the wallet core makes on the registration answer
 * (acceptMakerRegistration: proof of the maker's share, terms equal to the quote, timelock shape, joint address, escrow address) run later,
 * still before any SOL is locked. Unknown fields are ignored on purpose: a maker may add optional ones (for example `tiers`).
 * Returns the terms to show. Throws SwapRefusal.
 */
export function checkQuote(q, { xmrAtomic, now, owner = null, maxLamports = null, maxSolPerXmr = null, expectedMaker = null, maxSpreadBps = DEFAULT_MAX_SPREAD_BPS, maxTtlS = QUOTE_MAX_TTL_S }) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) refuse('quote-malformed', 'The quote is not an object.');
  if (q.direction !== 'sol-xmr') refuse('quote-wrong-direction', 'The maker answered with a quote for another direction.');
  if (typeof q.quoteId !== 'string' || !HEX(32).test(q.quoteId) || typeof q.swapId !== 'string' || !HEX(64).test(q.swapId)) refuse('quote-malformed', 'The quote ids are malformed.');
  if (typeof q.A !== 'string' || !HEX(64).test(q.A) || !q.proofA || !HEX(64).test(q.proofA.R ?? '') || !HEX(64).test(q.proofA.s ?? '')) refuse('quote-malformed', 'The maker key share or its proof is malformed.');
  if (typeof q.xmrAtomic !== 'string' || !/^\d{1,18}$/.test(q.xmrAtomic) || BigInt(q.xmrAtomic) !== BigInt(xmrAtomic)) refuse('quote-amount-mismatch', 'The quote is for a different XMR amount than you asked for.');
  if (!(Number.isSafeInteger(q.lamports) && q.lamports > 0 && q.lamports <= SILO_ATOMIC_MAX_LOCK_LAMPORTS)) refuse('quote-lamports-out-of-range', 'The SOL amount in the quote is outside what this client will lock.');
  if (maxLamports !== null && q.lamports > maxLamports) refuse('quote-over-limit', `The quote asks for more SOL than your limit (${formatSol(q.lamports)} SOL against ${formatSol(maxLamports)} SOL).`);
  if (!Number.isSafeInteger(q.expiresAt)) refuse('quote-malformed', 'The quote has no valid expiry.');
  if (q.expiresAt <= now) refuse('quote-expired', 'The quote has already expired.');
  if (q.expiresAt > now + maxTtlS) refuse('quote-ttl-too-long', 'The quote stays open longer than this client accepts.');
  if (!isPubkey(q.claimer)) refuse('quote-claimer-invalid', 'The maker Solana address is not valid.');
  if (owner && q.claimer === owner) refuse('quote-claimer-is-user', 'The maker address is your own wallet.');
  // The escrow counterparty is this key: it is the only key that can ever take the SOL. It must be the one you expect (from the maker list entry or your own note).
  if (expectedMaker && q.claimer !== expectedMaker) refuse('quote-maker-address-mismatch', 'The maker Solana address in the quote is not the address you expected for this maker.');
  // The price you actually pay, whatever the maker says about its own price fields. No client can know the market price offline, so the limit is yours.
  const paidPerXmr = q.lamports / 1e9 / (Number(xmrAtomic) / 1e12);
  if (maxSolPerXmr !== null && paidPerXmr > maxSolPerXmr) refuse('quote-price-over-limit', `The quote costs ${paidPerXmr.toFixed(6)} SOL per XMR, above your limit of ${maxSolPerXmr} SOL per XMR.`);
  if (!verifyShare(unhex(q.A), q.proofA, unhex(q.swapId), 0)) refuse('quote-bad-proof', 'The proof for the maker key share does not verify.');
  // Price fields are optional (the protocol does not need them) but when they are stated they must add up to the amount charged.
  let solPerXmr = null, spreadBps = null;
  if (q.solPerXmr !== undefined || q.spreadBps !== undefined) {
    solPerXmr = q.solPerXmr; spreadBps = q.spreadBps;
    if (!(typeof solPerXmr === 'number' && Number.isFinite(solPerXmr) && solPerXmr > 0)) refuse('quote-price-inconsistent', 'The price in the quote is not a positive number.');
    if (!(Number.isSafeInteger(spreadBps) && spreadBps >= 0)) refuse('quote-price-inconsistent', 'The spread in the quote is not a whole number of basis points.');
    if (spreadBps > maxSpreadBps) refuse('quote-spread-too-high', `The maker spread (${spreadBps} basis points) is above your limit (${maxSpreadBps}).`);
    const implied = Number(xmrAtomic) / 1e12 * solPerXmr * (1 + spreadBps / 10_000) * 1e9;
    if (Math.abs(implied - q.lamports) > Math.max(2, implied * 0.001)) refuse('quote-price-inconsistent', 'The SOL amount does not match the stated price and spread.');
  }
  return { swapId: q.swapId, xmr: formatXmr(xmrAtomic), lamports: q.lamports, sol: formatSol(q.lamports), paidPerXmr, solPerXmr, spreadBps, claimer: q.claimer, expiresAt: q.expiresAt,
    tiers: Array.isArray(q.tiers) ? q.tiers.length : null };
}

// ---- what the user can count on, in clock time ---------------------------------------------------------------------------------------
/**
 * The windows of the swap program for this swap, from the numbers the client enforces (reverse-core.mjs, swap-core.mjs, the driver).
 * `approximate` is true before the maker has registered: t0 is then expected near lock time + 3 h (the registration check allows 10 minutes of slack).
 */
export function refundSchedule({ t0, t1, lockedAt = null }) {
  return {
    t0, t1,
    confirmBy: t0 - MARGIN,                                   // the user's confirmation (ready) is sent only before this
    // Eligibility, never settlement: the rules ALLOW a refund from these times, and the refund is then a transaction this tool sends and Solana must confirm.
    refundIfNoXmr: lockedAt === null ? null : lockedAt + LOCK_WAIT,   // before any confirmation: only when a COMPLETED Monero check found no XMR this long after the lock (a failed check does not count)
    refundAttemptFrom: t0 - ABORT_LEAD,                       // before any confirmation: from here a refund may be tried when the payment does not allow confirming (ten minutes before confirmBy)
    refundAfterConfirmEarliest: t1 + REFUND_AFTER_T1_S,       // after a confirmation: never before this (the maker's claim window must be closed)
    refundAfterConfirmLatest: t1 + REV_COMMIT_WINDOW + REFUND_AFTER_T1_S,   // when the maker committed late
  };
}
export function describeTerms(t, { network, now }) {
  const t0 = now + REV_T0_LEAD, t1 = t0 + REV_CLAIM_WINDOW;
  const s = refundSchedule({ t0, t1 });
  const lines = [
    `You pay ${t.sol} SOL and receive ${t.xmr} XMR (${network === 'mainnet' ? 'Monero mainnet' : 'Monero stagenet'}).`,
    t.solPerXmr !== null ? `Stated price ${t.solPerXmr} SOL per XMR, maker spread ${t.spreadBps} basis points.` : 'The maker states no price or spread.',
    `Maker Solana address: ${t.claimer}`,
    `Quote valid until ${utc(t.expiresAt)}.`,
    'Your SOL goes into the swap program, not to the maker. The maker can take it only after you have seen its XMR arrive and sent your confirmation.',
    `Refund times (about, from now; exact times are printed once the maker registers):`,
    `  before you confirm: a refund becomes ALLOWED about ${LOCK_WAIT / 60} minutes after the lock when a completed check of the shared address finds no XMR (a failed check does not count);`,
    `  from ${utc(s.refundAttemptFrom)} (${ABORT_LEAD / 60} minutes before t0, ${(ABORT_LEAD - MARGIN) / 60} minutes before the confirm-by time ${utc(s.confirmBy)}) this tool may try a refund when the payment does not allow confirming;`,
    `  a payment of the full amount with 10 confirmations still gets your confirmation until ${utc(s.confirmBy)}, and is not refunded before that;`,
    `  after you confirm: no refund before ${utc(s.refundAfterConfirmEarliest)}, and if the maker stalls late, not after about ${utc(s.refundAfterConfirmLatest)}.`,
    '"Allowed" is not "done": a refund is a transaction this tool sends and Solana confirms, and it happens only while this tool runs (resume or refund) with your swap file, passphrase and key file. Keep them until the swap is finished.',
  ];
  return lines;
}

// ---- the swap file ------------------------------------------------------------------------------------------------------------------
const fsyncDir = (d) => { const fd = openSync(d, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
const uid = typeof process.getuid === 'function' ? process.getuid() : null;
const unsafe = (what) => refuse('record-file-unsafe', `The swap file location is not safe (${what}). Nothing was read or written.`);
/** A file we may trust as ours: a regular file (never a symlink), owned by this user, no group or other permission bits, a single link. */
function checkOwnFile(st, what) {
  if (!st.isFile()) unsafe(`${what} is not a regular file`);
  if (uid !== null && st.uid !== uid) unsafe(`${what} belongs to another user`);
  if ((st.mode & 0o077) !== 0) unsafe(`${what} can be read by other users`);
  if (st.nlink !== 1) unsafe(`${what} has more than one name`);
}
/** Reads a file without following a symlink and after checking it is ours. */
export function readOwnFile(path) {
  let fd;
  try { fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW); } catch (e) { if (e.code === 'ELOOP') return unsafe('it is a symbolic link'); throw e; }
  try { checkOwnFile(fstatSync(fd), 'the swap file'); return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
}
/**
 * Writes the whole file atomically: temp file next to it (created exclusively, never through a symlink, mode 0600), fsync, rename, directory fsync.
 * A temp file left by a crash is removed only when it is a plain file of ours; anything else (a symlink, another user's file, a loose mode) is refused.
 */
export function writeDurable(path, text) {
  const tmp = `${path}.tmp`;
  let st = null; try { st = lstatSync(tmp); } catch { /* none */ }
  if (st) {
    if (st.isSymbolicLink()) unsafe('the temporary file is a symbolic link');
    checkOwnFile(st, 'the temporary file');
    unlinkSync(tmp);                                               // a stale temp file of ours
  }
  let fd;
  try { fd = openSync(tmp, fsc.O_CREAT | fsc.O_EXCL | fsc.O_WRONLY | fsc.O_NOFOLLOW, 0o600); } catch (e) { if (e.code === 'EEXIST' || e.code === 'ELOOP') return unsafe('the temporary file appeared while writing'); throw e; }
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  fsyncDir(dirname(path));
}

// -- locking: one in-process registry plus an owned lock file (pid and process start time) ----------------------------------------------
const LOCK_ATTEMPTS = 8, LOCK_CONTENTION_MS = 1500;               // a lock entry younger than this may belong to a contender that is backing off
const HELD = new Set();                                            // swap files this process holds right now; a second acquire in the same process fails closed
/** An identity of a running process that survives a reused pid: its start time. null when it cannot be read. */
export function processStartId(pid) {
  try {
    if (process.platform === 'linux') { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); return `linux:${s.slice(s.lastIndexOf(')') + 2).split(' ')[19]}`; }
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out ? `ps:${out}` : null;
  } catch { return null; }
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
/** A lock owner that is certainly gone: the pid does not exist, or it exists with a different start time (the pid was reused). Anything unclear counts as alive. */
function ownerGone(owner) {
  if (!(Number.isSafeInteger(owner.pid) && owner.pid > 0)) return false;
  if (!pidAlive(owner.pid)) return true;
  if (owner.start) { const now = processStartId(owner.pid); if (now && now !== owner.start) return true; }
  return false;
}
const parseLock = (text) => {
  if (/^\d+$/.test(text.trim())) return { pid: Number(text.trim()), start: null, token: null };   // the format of earlier versions
  try { const o = JSON.parse(text); return o && typeof o === 'object' ? o : null; } catch { return null; }
};

/**
 * The one local file that holds the swap. Its content is an encrypted envelope (swap-envelope.mjs): `create` and every save need the passphrase, and a file that is
 * not an envelope is refused, never read as plain text. `create` refuses to overwrite an existing file.
 * `lock` fails closed when this process already holds the swap (two sessions in one program), and otherwise takes an owned lock file next to the record.
 * It never takes over a lock whose owner is alive.
 */
export function createSwapFile(path, { passphrase = null, kdf, minKdfN } = {}) {
  const abs = resolve(path);
  let codec = null;
  const codecOrRefuse = () => {
    if (codec) return codec;
    if (typeof passphrase !== 'string' || passphrase.length === 0) refuse('passphrase-missing', 'The swap file is encrypted: give its passphrase (SWAP_RECORD_PASSPHRASE, --record-passphrase-file, or type it when asked).');
    codec = createEnvelopeCodec({ passphrase, ...(kdf ? { kdf } : {}), ...(minKdfN ? { minN: minKdfN } : {}) });
    return codec;
  };
  const open = () => {
    const text = readOwnFile(abs);
    try { return codecOrRefuse().open(text); }
    catch (e) { if (e instanceof EnvelopeError) refuse(e.code === 'envelope-decrypt-failed' ? 'record-decrypt-failed' : e.code, e.message); throw e; }
  };
  const write = (payload) => {
    const pub = { direction: payload.direction ?? 'sol-xmr', network: payload.network };
    writeDurable(abs, codecOrRefuse().seal({ ...payload, rev: (Number(payload.rev) || 0) + 1 }, pub));      // rev: a counter that grows with every write
  };
  let lockKey = null, lockPath = null, lockToken = null, lockEntry = null;
  const realKey = () => { try { return join(realpathSync(dirname(abs)), basename(abs)); } catch { return abs; } };
  // The lock protocol (no file is ever removed by path after judging it stale, so a lock created after that judgment can never be removed by mistake):
  //   1. every contender writes its OWN entry with a unique name (`<file>.lock.h.<token>`), complete or not at all (temp file, then link);
  //   2. it then lists every entry. Any other entry whose owner is alive, or that cannot be read, means this contender backs off and removes only its own entry;
  //   3. only when every other entry belongs to an owner that is certainly gone does it proceed, and it removes those dead entries (unique names, never rewritten).
  // Two contenders cannot both pass step 2: each created its entry before it listed, so at least one sees the other. Entry names are never reused,
  // so a slow process holding an old judgment cannot touch a newer entry.
  const entryPrefix = () => `${basename(lockPath)}.h.`;
  const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
  /**
   * Reads a sidecar entry (lock entry, funding intent) without following a symlink. { gone: true } ONLY for a confirmed ENOENT. A symlink, a non-regular file, a file of
   * another user, or any other read or stat error (EIO, EACCES, ...) is { uncertain }: the caller must treat it as "somebody may be there" and fail closed.
   */
  const readEntry = (p) => {
    let st;
    try { st = lstatSync(p); } catch (e) { return e.code === 'ENOENT' ? { gone: true } : { uncertain: `stat-${e.code ?? 'error'}` }; }
    if (st.isSymbolicLink() || !st.isFile()) return { uncertain: 'unsafe-type' };
    if (uid !== null && st.uid !== uid) return { uncertain: 'other-user' };
    let fd;
    try { fd = openSync(p, fsc.O_RDONLY | fsc.O_NOFOLLOW); } catch (e) { return e.code === 'ENOENT' ? { gone: true } : { uncertain: `open-${e.code ?? 'error'}` }; }
    try { if (!fstatSync(fd).isFile()) return { uncertain: 'unsafe-type' }; return { text: readFileSync(fd, 'utf8') }; }
    catch (e) { return { uncertain: `read-${e.code ?? 'error'}` }; }
    finally { try { closeSync(fd); } catch { /* closed */ } }
  };
  const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait available */ } };
  function acquireFileLock() {
    lockPath = `${realKey()}.lock`;
    const dir = dirname(lockPath), prefix = entryPrefix();
    const mine = JSON.stringify({ v: 3, pid: process.pid, start: processStartId(process.pid), token: lockToken, at: Date.now() });
    lockEntry = `${lockPath}.h.${lockToken}`;
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      const tmp = `${lockPath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
      try {
        const fd = openSync(tmp, fsc.O_CREAT | fsc.O_EXCL | fsc.O_WRONLY | fsc.O_NOFOLLOW, 0o600); try { writeSync(fd, mine); fsyncSync(fd); } finally { closeSync(fd); }
        linkSync(tmp, lockEntry);                                          // all or nothing: an entry never exists half written
      } finally { try { unlinkSync(tmp); } catch { /* gone */ } }
      fsyncDir(dir);
      // Step 2: look at everybody else.
      const others = [];
      for (const name of readdirSync(dir)) if (name.startsWith(prefix) && `${dir}/${name}` !== lockEntry) others.push(join(dir, name));
      if (existsEntry(lockPath)) others.push(lockPath);                    // the single-file lock of earlier versions
      let live = null, unknown = null, dead = [];
      for (const p of others) {
        const e = readEntry(p);
        if (e.gone) continue;                                              // a confirmed ENOENT only: the entry's owner finished
        if (e.uncertain) { unknown ??= e.uncertain; continue; }            // could not tell (EIO, EACCES, a symlink, a foreign file): somebody may hold the swap, so this contender does not
        const text = e.text, owner = parseLock(text);
        if (!owner) { removeOwn(); refuse('swap-file-busy', 'A swap file lock is unreadable. If no other tool is running this swap, remove the lock files next to the swap file (names start with the swap file name and end in .lock or contain .lock.) and try again.'); }
        if (ownerGone(owner)) dead.push({ p, text }); else if (!live) live = owner;
      }
      if (!live && !unknown) {
        for (const d of dead) { const again = readEntry(d.p); if (again.text === d.text) { try { unlinkSync(d.p); } catch { /* gone */ } } }   // unique, immutable names: this removes exactly the dead entry judged
        return;
      }
      removeOwn();
      if (!live) {                                                         // only unreadable entries: never acquire; try again a few times (a transient error), then report busy
        if (attempt === LOCK_ATTEMPTS - 1) refuse('swap-file-busy', 'A swap file lock entry could not be read safely, so this process did not take the swap. Check the files next to the swap file (names contain .lock.) and try again.');
        sleepSync(10 + Math.floor(Math.random() * 40)); continue;
      }
      // A holder that has been there for a while is final. A very young entry may be a contender that is backing off too: wait a little and try again.
      if (Date.now() - (Number(live.at) || 0) > LOCK_CONTENTION_MS || attempt === LOCK_ATTEMPTS - 1) refuse('swap-file-busy', live.pid === process.pid ? 'This program already runs this swap in another session.' : 'Another process is already running this swap.');
      sleepSync(10 + Math.floor(Math.random() * 40));
    }
    refuse('swap-file-busy', 'Could not take the swap file lock.');
  }
  const existsEntry = (p) => { try { lstatSync(p); return true; } catch (e) { return e.code !== 'ENOENT'; } };   // anything but a confirmed ENOENT counts as "there"
  /** Removes this session's own entry (its name holds a token only this session knows and is never reused). An entry that now holds another token is left alone; one that cannot be read is still ours by name. */
  function removeOwn() { if (!lockEntry) return; const e = readEntry(lockEntry); if (e.gone) return; if (e.text && parseLock(e.text)?.token !== lockToken) return; try { unlinkSync(lockEntry); } catch { /* gone */ } }
  /** True while this session's own lock entry is still on disk with its token. A read that fails for any reason other than a missing file also counts as "not held". */
  const holdsLock = () => { if (!lockToken || !lockEntry) return false; const e = readEntry(lockEntry); return !!e.text && parseLock(e.text)?.token === lockToken; };
  const intentPath = () => `${realKey()}.intent`;
  const headerOf = () => { try { return peekHeader(readOwnFile(abs)); } catch { return { direction: 'xmr-sol', network: '' }; } };
  const intentSeal = (obj) => codecOrRefuse().seal(obj, headerOf());
  const intentOpen = (text) => {
    try { const o = codecOrRefuse().open(text).payload; if (o && typeof o === 'object' && o.v === 2) return o; } catch (e) { if (e instanceof SwapRefusal) throw e; }
    return refuse('funding-conflict', 'The payment reservation file for this swap is unreadable or was changed. Nothing was paid. Resume with the original funding wallet, or check the file next to the swap file.');
  };
  /** The run that made a reservation is certainly gone: its lock entry is gone (we hold the swap, so no live holder can exist), or its process is gone. Unclear counts as alive. */
  const creatorGone = (c) => {
    if (!c || typeof c !== 'object') return false;
    if (c.lockToken && !existsEntry(`${lockPath}.h.${c.lockToken}`)) return true;
    return ownerGone(c);
  };
  return {
    path,
    exists: () => { try { statSync(abs); return true; } catch { return false; } },
    create(meta) {
      let fd;
      try { fd = openSync(abs, fsc.O_CREAT | fsc.O_EXCL | fsc.O_WRONLY | fsc.O_NOFOLLOW, 0o600); } catch (e) { if (e.code === 'EEXIST' || e.code === 'ELOOP') refuse('swap-file-exists', 'That swap file already exists. Use resume, or choose a new file name.'); throw e; }
      closeSync(fd);
      try { unlinkSync(intentPath()); } catch { /* none */ }                // a leftover reservation of an earlier file with this name must not bind a new swap
      if (typeof passphrase !== 'string' || passphrase.length < PASSPHRASE_MIN_CHARS) { try { unlinkSync(abs); } catch { /* gone */ } refuse('passphrase-weak', `The swap file passphrase must have at least ${PASSPHRASE_MIN_CHARS} characters.`); }
      write({ format: RECORD_FORMAT, ...meta, record: null });
    },
    load() {
      const f = open().payload;
      if (f?.format !== RECORD_FORMAT) refuse('record-format', 'This is not a swap file written by this tool.');
      return f;
    },
    /** `ifRev`: write only when the file is still at that revision (checked under the lock, immediately before the write); otherwise refuse and change nothing. */
    saveRecord(record, { ifRev = null } = {}) {
      if (lockToken && !holdsLock()) refuse('swap-file-busy', 'This process no longer holds the swap file lock, so the swap file was not changed. Run resume again.');
      const f = this.load();
      if (ifRev !== null && (f.rev ?? 0) !== ifRev) refuse('record-changed', 'The swap file was changed by another run while this one was working. Nothing further was written. Run resume again.');
      write({ ...f, record });
    },
    /**
     * The funding reservation, claimed atomically BEFORE the wallet builds anything: the intent file is created with O_EXCL (all or nothing, through a temp file and a link),
     * so two processes can never both create it. The intent is ENCRYPTED with the same envelope as the swap file (it names the wallet, the amount and the joint address) and
     * carries a unique claim token and the identity of its creator.
     * Returns { status: 'created', token } (this process made the reservation and is the only one that may build and transfer), or { status: 'same' } (the same wallet and
     * payment is reserved by ANOTHER execution: do not build). A different wallet, amount or address fails closed and tells the user to resume with the original.
     * A reservation whose creator is certainly gone is taken over only by a process that holds the swap lock (the old creator can no longer build), by moving the old intent
     * aside and creating a new one; otherwise it stays 'same'.
     */
    claimIntent(intent) {
      const p = intentPath();
      const token = randomBytes(12).toString('hex');
      const creator = { pid: process.pid, start: processStartId(process.pid), lockToken: lockToken ?? null };
      const body = intentSeal({ v: 2, walletId: intent.walletId, amountAtomic: String(intent.amountAtomic), address: intent.address, at: Date.now(), token, creator });
      for (let i = 0; i < 4; i++) {
        const tmp = `${p}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
        try {
          const fd = openSync(tmp, fsc.O_CREAT | fsc.O_EXCL | fsc.O_WRONLY | fsc.O_NOFOLLOW, 0o600); try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
          try { linkSync(tmp, p); fsyncDir(dirname(p)); return { status: 'created', token }; } catch (e) { if (e.code !== 'EEXIST') throw e; }
        } finally { try { unlinkSync(tmp); } catch { /* gone */ } }
        const e = readEntry(p);
        if (e.gone) continue;                                              // released meanwhile: claim again
        if (e.uncertain) refuse('funding-conflict', 'The payment reservation file for this swap could not be read safely. Nothing was paid. Check the file next to the swap file (name ends in .intent).');
        const cur = intentOpen(e.text);
        if (cur.walletId !== intent.walletId) refuse('funding-wallet-mismatch', 'This swap\'s payment was reserved from a different wallet. Resume with the original funding wallet.');
        if (String(cur.amountAtomic) !== String(intent.amountAtomic) || cur.address !== intent.address) refuse('funding-conflict', 'A different payment is already reserved for this swap. Nothing was paid.');
        if (lockToken && holdsLock() && creatorGone(cur.creator)) {         // the reservation of a run that is gone: this process holds the swap, so it may take the step over
          const again = readEntry(p);
          if (again.text === e.text) { try { renameSync(p, `${p}.old.${token}`); unlinkSync(`${p}.old.${token}`); fsyncDir(dirname(p)); } catch { /* another process moved it */ } }
          continue;
        }
        return { status: 'same' };
      }
      return refuse('funding-conflict', 'Could not claim the payment reservation for this swap. Nothing was paid.');
    },
    /** True while the intent on disk is the one this process created (it still holds this process's claim token). Any read problem counts as "not mine". */
    ownsIntent(token) {
      if (!token) return false;
      const e = readEntry(intentPath()); if (!e.text) return false;
      try { return intentOpen(e.text).token === token; } catch { return false; }
    },
    /** Gives the reservation back, only when it is the one this process made (the wallet built nothing). */
    releaseIntent(intent, token) {
      const p = intentPath(); const e = readEntry(p); if (!e.text) return;
      let cur; try { cur = intentOpen(e.text); } catch { return; }
      if (cur.token === token && cur.walletId === intent.walletId && String(cur.amountAtomic) === String(intent.amountAtomic) && cur.address === intent.address) { try { unlinkSync(p); } catch { /* gone */ } }
    },
    /** True while this session holds the swap lock (or no lock was asked for). */
    lockStillHeld: () => (lockToken ? holdsLock() : true),
    /** The revision counter of the swap file on disk (it grows with every write). */
    revision() { return this.load().rev ?? 0; },
    /** Takes the lock, or throws swap-file-busy. Read the record only AFTER this returns. */
    lock() {
      const key = realKey();
      if (lockToken || HELD.has(key)) refuse('swap-file-busy', 'This program already runs this swap in another session.');
      HELD.add(key); lockKey = key; lockToken = randomBytes(12).toString('hex');
      try { acquireFileLock(); } catch (e) { HELD.delete(key); lockKey = null; lockToken = null; lockEntry = null; throw e; }
    },
    unlock() {
      if (!lockToken) return;
      removeOwn();
      HELD.delete(lockKey); lockKey = null; lockToken = null; lockEntry = null;
    },
  };
}
/** The clear header of a swap file (direction and network). Unauthenticated until the file is opened with its passphrase. */
export function peekSwapFile(path) { try { return peekHeader(readOwnFile(resolve(path))); } catch { return null; } }

// ---- the Solana side ----------------------------------------------------------------------------------------------------------------
/** Reads a Solana CLI style key file (a JSON array of 64 numbers). The content is never printed; a loose file mode is reported by the caller. */
export function loadKeypair(path) {
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return refuse('keypair-unreadable', 'The key file could not be read as a Solana key file (a JSON array of 64 numbers).'); }
  if (!Array.isArray(raw) || raw.length !== 64) refuse('keypair-unreadable', 'The key file could not be read as a Solana key file (a JSON array of 64 numbers).');
  let kp; try { kp = Keypair.fromSecretKey(Uint8Array.from(raw)); } catch { return refuse('keypair-unreadable', 'The key file does not hold a valid Solana key.'); }
  return { keypair: kp, address: kp.publicKey.toBase58(), looseMode: (statSync(path).mode & 0o077) !== 0 };
}

/** A JSON-RPC caller on the user's Solana RPC. Used by the driver for every chain read and for broadcasting. */
export function createSolanaRpc({ url, fetcher = fetch, timeoutMs = 15_000 }) {
  const base = parseUserUrl(url, 'Solana RPC');
  const f = noRedirect(fetcher);
  return async (method, params = []) => {
    const res = await f(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    const json = await res.json();
    if (json.error) throw new Error(String(json.error.message ?? 'rpc-error'));
    return json.result;
  };
}

/**
 * Before the user is asked anything: the RPC is on the cluster the user named, and the pinned program is there. For `devnet` any non-mainnet
 * cluster is accepted when the RPC is on this machine (a local validator); mainnet requires mainnet's genesis hash.
 * Returns what the chain says about the program (read from the chain, never assumed): whether it is upgradeable and by whom.
 */
export async function preflightSolana(rpcCall, { network, rpcIsLocal = false }) {
  const genesis = await rpcCall('getGenesisHash');
  if (network === 'mainnet' && genesis !== GENESIS.mainnet) refuse('wrong-cluster', 'Your Solana RPC is not on Solana mainnet, but you asked for mainnet.');
  if (network !== 'mainnet' && genesis === GENESIS.mainnet) refuse('wrong-cluster', 'Your Solana RPC is on Solana mainnet, but you asked for a test network.');
  if (network !== 'mainnet' && genesis !== GENESIS.devnet && !rpcIsLocal) refuse('wrong-cluster', 'Your Solana RPC is not on devnet or on a local validator.');
  const prog = (await rpcCall('getAccountInfo', [PROGRAM_ID, { encoding: 'base64', commitment: 'confirmed' }]))?.value;
  if (!prog || !prog.executable) refuse('program-missing', 'The swap program is not deployed at the pinned address on this cluster.');
  let upgradeAuthority = null, upgradeable = false;
  if (prog.owner === LOADER_UPGRADEABLE) {
    upgradeable = true;
    const d = Buffer.from(prog.data[0], 'base64');
    if (d.length === 36 && d.readUInt32LE(0) === 2) {
      const pd = (await rpcCall('getAccountInfo', [bs58.encode(d.subarray(4, 36)), { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 45 } }]))?.value;
      if (pd) { const b = Buffer.from(pd.data[0], 'base64'); if (b.length >= 45 && b.readUInt32LE(0) === 3) upgradeAuthority = b[12] === 1 ? bs58.encode(b.subarray(13, 45)) : null; if (b[12] === 0) upgradeable = false; }
    }
  }
  return { genesis, programId: PROGRAM_ID, upgradeable, upgradeAuthority };
}

/** The signer: only the three reviewed layouts (lock, ready, refund) for this swap and this key, checked again here exactly as Silo's keyring does. */
export function createSigner({ keypair, now }) {
  const address = keypair.publicKey.toBase58();
  return (encoded, expected) => {
    let tx;
    try { tx = verifySiloAtomicRefunderTx(encoded, expected, { address, now: Math.floor(now() / 1000) }); }
    catch (e) { throw Object.assign(new Error(`signing refused: ${e.message}`), { fatal: true }); }
    tx.sign([keypair]);
    return Buffer.from(tx.serialize()).toString('base64');
  };
}

// ---- the Monero side (the user's own wallet RPC) ------------------------------------------------------------------------------------
export function createWalletRpc({ url, login = null, fetchImpl = fetch, timeoutMs = SCAN_TIMEOUT_MS }) {
  const base = parseUserUrl(url, 'Monero wallet RPC');
  const opts = { timeoutMs, fetchImpl: noRedirect(fetchImpl), ...(login ? { username: login.slice(0, login.indexOf(':')), password: login.slice(login.indexOf(':') + 1) } : {}) };
  return rpcClient(base.replace(/\/json_rpc$/, ''), opts);
}
/** The user's view of the chain height, only to choose a restore height for the view wallet. A node (monerod) URL. */
export function createDaemonHeight({ url, fetchImpl = fetch }) {
  const base = parseUserUrl(url, 'Monero node');
  const call = rpcClient(base.replace(/\/json_rpc$/, ''), { timeoutMs: 30_000, fetchImpl: noRedirect(fetchImpl) });
  return async () => { const h = (await call('get_info')).height; if (!Number.isSafeInteger(h) || h <= 0) throw new Error('bad node height'); return h; };
}
export const sha = (s) => createHash('sha256').update(s).digest('hex');
/**
 * What the driver calls "the bridge": the user's own view-only scan of the joint address, and the sweep once the maker's claim reveals `a`.
 * Wallet files are created in the wallet RPC's own folder. Their password is derived from the swap's view key, so the files are not readable without the swap file.
 * The wallet RPC holds one open wallet at a time, so every job runs after the previous one (a failed job never blocks the next).
 */
export function createMoneroBridge({ wallet, daemonHeight, destination, saveRecord, records }) {
  let tail = Promise.resolve();
  const job = (filename, password, create, fn) => {
    const run = tail.then(async () => {
      try { await wallet('close_wallet'); } catch { /* none open */ }
      try { await wallet('open_wallet', { filename, password }); } catch { await create(); }
      await wallet('refresh');
      try { return await fn(); } finally { await wallet('close_wallet').catch(() => {}); }
    });
    tail = run.catch(() => {});
    return run;
  };
  const pw = (viewKey) => sha(`silo-standalone-swap/wallet/v1/${viewKey}`);
  const name = (kind, address) => `silo-swap-${kind}-${sha(address).slice(0, 16)}`;
  return {
    saveRecord, records, daemonHeight, job, wallet,
    /** View-only scan: { atomic, confirmations } of spendable outputs at the joint address (pool included), or null when nothing is seen. */
    watchJoint: (k) => job(name('watch', k.primaryAddress), pw(k.privateViewKey),
      () => wallet('generate_from_keys', { filename: name('watch', k.primaryAddress), address: k.primaryAddress, viewkey: k.privateViewKey, password: pw(k.privateViewKey), restore_height: k.restoreHeight, autosave_current: true }),
      async () => usableFromTransfers(await wallet('get_transfers', { in: true, pool: true }))),
    /** Full key of the joint address (after the claim): sweep everything spendable to the user's own address. Returns the tx hashes, or [] while the funds are not spendable yet. */
    sweepRecovery: (k) => job(name('spend', k.primaryAddress), pw(k.privateViewKey),
      () => wallet('generate_from_keys', { filename: name('spend', k.primaryAddress), address: k.primaryAddress, spendkey: k.privateSpendKey, viewkey: k.privateViewKey, password: pw(k.privateViewKey), restore_height: k.restoreHeight, autosave_current: true }),
      async () => {
        const bal = await wallet('get_balance');
        const verdict = classifyJointBalance(bal, BigInt(bal?.unlocked_balance ?? 0) > 0n ? null : await wallet('get_transfers', { in: true, pool: true }));
        if (verdict.status !== 'sweepable') return [];
        return (await wallet('sweep_all', { address: destination, priority: 0 })).tx_hash_list ?? [];
      }),
  };
}
/** A new swap file needs a passphrase of a minimum length (checked before anything else happens, so a weak one never costs a quote). */
export function checkNewPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) refuse('passphrase-missing', 'The swap file is encrypted: give a passphrase (SWAP_RECORD_PASSPHRASE, --record-passphrase-file, or type it when asked).');
  if (passphrase.length < PASSPHRASE_MIN_CHARS) refuse('passphrase-weak', `The swap file passphrase must have at least ${PASSPHRASE_MIN_CHARS} characters.`);
}
/** The destination must be a valid, non-integrated address of the network the swap runs on (wallet RPC does the parsing). */
export async function checkDestination(wallet, address, network) {
  const v = await wallet('validate_address', { address, any_net_type: true });
  const want = network === 'mainnet' ? 'mainnet' : 'stagenet';
  if (!v?.valid) refuse('bad-destination', 'Your Monero address is not valid.');
  if (v.nettype !== want) refuse('bad-destination', `Your Monero address is a ${v.nettype} address, but this swap runs on Monero ${want}.`);
  if (v.integrated) refuse('bad-destination', 'An integrated address cannot be used as the destination.');
  return true;
}

// ---- chain time (A4) ------------------------------------------------------------------------------------------------------------------
/**
 * Every deadline this client judges (quote expiry, the maker's timelocks, the signer's lock-shape check, the driver's retry and refund logic) uses chain time
 * read from the user's own Solana RPC, never the local clock alone. The local clock only carries the time between two reads. A large difference is reported.
 */
export const CLOCK_MAX_AGE_MS = 120_000;      // chain time is trusted for this long after the last good read; after that it must be read again
export function createChainClock({ rpc, localNow = () => Date.now(), onSkew = () => {}, maxAgeMs = CLOCK_MAX_AGE_MS }) {
  let offset = 0, syncedAt = null;
  const fresh = () => syncedAt !== null && localNow() - syncedAt <= maxAgeMs;
  return {
    /** True only while the last good read is recent. A failed read does not extend it, and an old offset is never used past its age. */
    get synced() { return fresh(); },
    async sync() {
      try {
        const slot = await rpc('getSlot', [{ commitment: 'confirmed' }]);
        const t = await rpc('getBlockTime', [slot]);
        if (!Number.isSafeInteger(t)) throw new Error('chain-time-unavailable');
        offset = t * 1000 - localNow(); syncedAt = localNow();
      } catch (e) { if (!fresh()) { syncedAt = null; offset = 0; } throw e; }
      if (Math.abs(offset) > 60_000) onSkew(Math.round(offset / 1000));
      return offset;
    },
    /** Milliseconds, chain time. Refuses before a successful read and once the last good read is older than maxAgeMs. */
    now() { if (!fresh()) throw new SwapRefusal('clock-unsynced', 'Chain time has not been read recently enough.'); return localNow() + offset; },
  };
}

// ---- the session: quote, start, resume, status, refund ---------------------------------------------------------------------------------
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(['final', 'received', 'refunded', 'stopped']);
/** Maps the driver's phase and the record to one plain line. */
export function phaseLine(v) {
  const r = v.record ?? {};
  switch (v.phase) {
    case 'waiting-maker': return 'Registered with the maker; the SOL is not locked yet.';
    case 'locking': return 'Locking your SOL in the swap program.';
    case 'awaiting-maker-xmr': return 'SOL is locked. Waiting for the maker to send the XMR to the shared address.';
    case 'xmr-confirming': return v.scanFailed ? 'Your Monero wallet RPC could not complete the check of the shared address. Retrying. A failed check never counts as "nothing arrived".' : `XMR is on its way: ${v.confirmations ?? 0} of 10 confirmations.`;
    case 'confirming': return 'XMR confirmed. Sending your confirmation to the swap program.';
    case 'await-claim': return 'Confirmation sent. Waiting for the maker to claim the SOL, which gives you the key to the XMR.';
    case 'sweeping': return v.notice ?? 'Moving the XMR to your address.';
    case 'received': return `Done. The XMR was moved to your address (${(r.xmrSweptTxids ?? []).length} transaction).`;
    case 'refunding': return 'The swap rules allow a refund. Sending the refund of your SOL.';
    case 'refunded': return 'Done. Your SOL was refunded.';
    case 'stopped': return `Stopped: ${r.result ?? 'no result'}. Nothing was lost.`;
    case 'final': return `Finished: ${r.result ?? r.status}.`;
    case 'would-lock': case 'would-ready': case 'would-refund': return `Next step when run: ${v.phase.slice(6)}.`;
    default: return v.phase;
  }
}

/**
 * Builds a session from the three user-supplied endpoints and the user's key. `fetcher` serves the maker and the Solana RPC; `walletFetcher` and `nodeFetcher`
 * (default: the same `fetcher`) serve the Monero side. Nothing else in this module opens a connection.
 */
export function createSession(o) {
  const { network, sleep = sleepReal, fetcher = fetch } = o;
  // ONE logging boundary (swap-log.mjs): every line below goes through it, and a retry prints a fixed code, never a raw error message.
  const logger = createLogger({ sink: o.log ?? (() => {}), secrets: () => [o.solanaRpcUrl, o.moneroWalletRpcUrl, o.moneroLogin, o.recordPassphrase, ...(o.maker?.secrets ?? []), ...(o.secrets ?? [])] });
  const log = logger.show;
  const localNow = o.now ?? (() => Date.now());
  if (network !== 'mainnet' && network !== 'devnet') refuse('bad-network', 'The network must be named explicitly: mainnet or devnet (devnet means Solana devnet or a local validator with Monero stagenet).');
  const solana = createSolanaRpc({ url: o.solanaRpcUrl, fetcher });
  const clock = createChainClock({ rpc: solana, localNow, onSkew: (s) => log(`Warning: your computer clock differs from Solana chain time by ${s} seconds. Chain time is used for every deadline.`) });
  const now = () => clock.now();                       // ms, chain time (A4)
  const syncClock = async () => { try { await clock.sync(); } catch { if (!clock.synced) throw new SwapRefusal('clock-unsynced', 'Could not read chain time from your Solana RPC.'); } };
  const rpcIsLocal = LOOPBACK.has(new URL(o.solanaRpcUrl).hostname);
  const file = createSwapFile(o.recordPath, { passphrase: o.recordPassphrase ?? null, kdf: o.recordKdf, minKdfN: o.recordMinKdfN });
  const fetcherFor = (x) => x ?? fetcher;

  /** C3: a remote Monero node can show a view-only wallet a payment that does not exist. The confirmation (ready) is sent on what the wallet shows, so the node must be yours. */
  const requireNodeOwnership = () => {
    // 'own' is the user's STATEMENT (--own-node). This tool cannot check that the node behind the wallet RPC is independent of the maker, of Grain or of anyone else.
    if (o.nodeOwnership === 'own') return;
    if (o.nodeOwnership === 'remote-accepted') { log('WARNING: you chose to proceed with a Monero node that is not yours. A remote node can report an XMR payment that does not exist. This tool sends your confirmation to the swap program when your wallet shows the payment, and after that the maker can take your SOL. You can lose the SOL.'); return; }
    refuse('node-not-confirmed', 'Your Monero wallet RPC must use a Monero node that you run yourself (a remote node can report a payment that does not exist, and your confirmation lets the maker take the SOL). Pass --own-node to state that it is yours (this tool cannot check that), or --remote-node-ok to proceed at your own risk.');
  };
  const walletRpc = () => createWalletRpc({ url: o.moneroWalletRpcUrl, login: o.moneroLogin ?? null, fetchImpl: fetcherFor(o.walletFetcher) });
  /** What start checks, checked again before a resume or a refund signs anything: the file is for this network, the cluster and the pinned program are right, the destination is valid. */
  async function preflightResume(meta, { destination }) {
    if (meta.network !== network) refuse('network-mismatch', `This swap file is for ${meta.network}, but you named ${network}.`);
    if (o.xmrAddress && meta.xmrAddress && o.xmrAddress !== meta.xmrAddress) refuse('destination-mismatch', 'The Monero address you gave is not the one in the swap file.');
    if (o.maker?.url && meta.makerUrl && o.maker.url !== meta.makerUrl) log('Note: the maker URL differs from the one recorded when the swap started. Nothing needs the maker after registration, so this is only a note.');
    await preflightSolana(solana, { network, rpcIsLocal });
    if (destination && meta.xmrAddress) await checkDestination(walletRpc(), meta.xmrAddress, network);
  }
  const driverFor = ({ mode, meta, wallet }) => {
    const dry = mode === 'dry';
    let current = null;
    const signer = o.keypair ? createSigner({ keypair: o.keypair, now }) : null;
    const sign = async (encoded, expected) => {
      if (dry) throw Object.assign(new Error('dry run'), { dryRun: true, kind: expected.kind });
      if (mode === 'refund' && expected.kind !== 'refund') throw Object.assign(new Error(`not a refund step (${expected.kind})`), { notRefund: true });
      if (!signer) throw Object.assign(new Error('a key file is needed'), { fatal: true });
      return signer(encoded, expected);
    };
    const saveRecord = async (record) => { current = record; if (!dry) file.saveRecord(record); };
    const bridge = createMoneroBridge({ wallet, daemonHeight: o.daemonHeight ?? (async () => { throw new Error('no Monero node URL'); }), destination: meta?.xmrAddress,
      saveRecord, records: () => (current ? [current] : []) });
    if (dry) bridge.sweepRecovery = async () => { throw Object.assign(new Error('dry run'), { dryRun: true }); };
    const driver = createReverseDriver({ flow, post: async (action, body) => { if (action !== 'rev-swap') throw new Error('unexpected action'); return o.maker.register(body); },
      bridge, sign, network, now, fetcher: noRedirect(fetcher), publicRpc: parseUserUrl(o.solanaRpcUrl, 'Solana RPC'), scanTimeoutMs: SCAN_TIMEOUT_MS });
    return { driver, bridge, seed: (r) => { current = r; } };
  };

  /** Runs ticks until the swap settles (or `until: 'locked'` is met). Transient read failures are retried; a signing refusal is final. */
  async function run(record, { mode = 'normal', meta, wallet, until = 'done', pollMs = POLL_MS, maxTicks = Infinity, onPhase = () => {} } = {}) {
    const { driver, seed } = driverFor({ mode, meta, wallet });
    seed(record);
    let failures = 0, last = null;
    for (let i = 0; i < maxTicks; i++) {
      let v;
      try { await syncClock(); v = await driver.tick(record); failures = 0; }
      catch (e) {
        if (e.dryRun) return { ...last, phase: e.kind ? `would-${e.kind}` : (last?.phase ?? 'dry'), record };
        if (e.notRefund) return { record, phase: 'not-refundable', reason: e.message };
        if (e.fatal) throw e;
        if (e instanceof SwapRefusal && e.code !== 'clock-unsynced') throw e;
        if (++failures >= 5) throw new SwapRefusal('stopped-after-errors', `Stopped after repeated errors (${describeError(e)}). Run resume to continue.`);
        logger.line(`temporary error (${describeError(e, [])}); retrying`); await sleep(pollMs); continue;
      }
      v = logger.view(v); record = v.record; last = v; onPhase(v);
      if (TERMINAL.has(v.phase)) return v;
      if (mode !== 'normal') return v;                       // refund / status: one pass
      if (until === 'locked' && record.lockSeen) return v;
      await sleep(pollMs);
    }
    return last;
  }

  return {
    file,
    /** Preflight: cluster, program, destination. Returns what the chain says about the program. */
    async preflight() {
      const program = await preflightSolana(solana, { network, rpcIsLocal });
      if (o.xmrAddress) await checkDestination(walletRpc(), o.xmrAddress, network);
      return program;
    },
    /** Asks the maker for a quote and checks it. Touches no state. */
    async quote(xmrText) {
      const xmrAtomic = parseXmrAmount(xmrText);
      await syncClock();
      const q = await o.maker.quote(xmrText);
      const terms = checkQuote(q, { xmrAtomic, now: Math.floor(now() / 1000), owner: o.owner ?? null, maxLamports: o.maxLamports ?? null, maxSolPerXmr: o.maxSolPerXmr ?? null, expectedMaker: o.expectedMaker ?? null, maxSpreadBps: o.maxSpreadBps ?? DEFAULT_MAX_SPREAD_BPS });
      return { quote: q, terms, xmrAtomic };
    },
    /**
     * Full start. Order: preflight, quote, quote checks, show terms and the refund times, ask `confirm`, read the Monero height,
     * write the swap file, only then register with the maker, check its answer, and let the driver lock.
     */
    async start({ xmr, confirm, until = 'done', pollMs, maxTicks, onPhase }) {
      if (!o.keypair) refuse('keypair-missing', 'A key file is needed to start a swap.');
      if (!o.xmrAddress) refuse('destination-missing', 'A Monero destination address is needed to start a swap.');
      if (!o.daemonHeight) refuse('node-missing', 'A Monero node URL is needed to start a swap (it chooses where the view wallet starts scanning).');
      if (!o.expectedMaker && !o.allowUnverifiedMaker) refuse('maker-address-missing', 'Name the Solana address you expect for this maker (--maker-address). Without it nothing proves whose escrow you are paying into. Pass --allow-unverified-maker to proceed anyway.');
      if (o.maxSolPerXmr == null && o.maxLamports == null) refuse('price-limit-missing', 'Set a price limit: --max-sol-per-xmr or --max-sol. No client can know the market price, so the limit has to come from you.');
      requireNodeOwnership();
      checkNewPassphrase(o.recordPassphrase);
      log('Connections: this tool talks directly to the endpoints you gave it. It does not use Tor and does not check that you do; your endpoints see your network address.');
      log('Your wallet RPC receives the swap private keys it needs to watch and sweep the shared address (the view key, and the spend key after the maker claims), and it keeps wallet files in its folder.');
      if (file.exists()) refuse('swap-file-exists', 'That swap file already exists. Use resume, or choose a new file name.');
      const program = await this.preflight();
      await syncClock();
      log(`Swap program ${program.programId}: ${program.upgradeable ? `upgradeable, upgrade authority ${program.upgradeAuthority ?? 'unknown'}` : 'not upgradeable'} (read from the chain).`);
      const { quote, terms } = await this.quote(xmr);
      for (const l of describeTerms(terms, { network, now: Math.floor(now() / 1000) })) log(l);
      if (!(await confirm(terms))) refuse('declined', 'You declined. Nothing was stored and nothing was locked.');
      if (Math.floor(now() / 1000) >= quote.expiresAt - 5) refuse('quote-expired', 'The quote expired while you were deciding. Nothing was stored and nothing was locked. Run start again.');
      const height = await o.daemonHeight();
      if (!Number.isSafeInteger(height) || height <= 0) refuse('node-unreadable', 'Could not read the Monero network height from your node.');
      file.lock();
      try {
        file.create({ network, makerUrl: o.maker.url, xmrAddress: o.xmrAddress, owner: o.owner, createdAt: Math.floor(now() / 1000), nodeOwnership: o.nodeOwnership ?? null });
        const wallet = walletRpc();
        const meta = file.load();
        const { driver, seed } = driverFor({ mode: 'normal', meta, wallet });
        // The driver stores the record (secrets included) BEFORE it contacts the maker, then checks the registration answer (core rules) before anything is locked.
        let record;
        try { record = await driver.start({ quote, owner: o.owner }); }
        catch (e) { throw new SwapRefusal('registration-refused', e?.userFacing ? scrub(e.message, [], { strict: true }) : `The maker registration was refused (${describeError(e)}).`); }
        seed(record);
        const s = refundSchedule({ t0: record.t0, t1: record.t1 });
        log(`Registered. Exact times: confirm by ${utc(s.confirmBy)}; deadline t0 ${utc(s.t0)}; maker claim window ends t1 ${utc(s.t1)}.`);
        log(`Refund rules (allowed, not done): before you confirm, a refund is allowed about ${LOCK_WAIT / 60} minutes after the lock when a completed check finds no XMR, and may be tried from ${utc(s.refundAttemptFrom)} when the payment does not allow confirming; a full payment still gets your confirmation until ${utc(s.confirmBy)}. After you confirm, a refund is allowed between ${utc(s.refundAfterConfirmEarliest)} and ${utc(s.refundAfterConfirmLatest)}.`);
        return await run(record, { mode: 'normal', meta, wallet, until, pollMs, maxTicks, onPhase });
      } finally { file.unlock(); }
    },
    /** Continues a swap from its file. Safe to run again at any point: a lock is never repeated, and a refund waits for its time. */
    async resume({ until = 'done', pollMs, maxTicks, onPhase } = {}) {
      requireNodeOwnership();
      file.lock();                                        // take the lock, then read: the record is the one on disk now, not an earlier copy
      try {
        const meta = file.load();
        if (!meta.record) refuse('no-record', 'The swap file has no swap in it yet.');
        await preflightResume(meta, { destination: true });
        return await run(meta.record, { mode: 'normal', meta, wallet: walletRpc(), until, pollMs, maxTicks, onPhase });
      } finally { file.unlock(); }
    },
    /** Reads the chain and decides, but signs, sends and writes nothing. */
    async status() {
      const meta = file.load();
      if (!meta.record) return { meta, record: null, phase: 'no-record' };
      const v = await run(meta.record, { mode: 'dry', meta, wallet: walletRpc(), maxTicks: 1 });
      return { meta, record: meta.record, phase: v?.phase ?? 'unknown', view: v, schedule: refundSchedule({ t0: meta.record.t0 ?? 0, t1: meta.record.t1 ?? 0, lockedAt: meta.record.lockedAt ?? null }) };
    },
    /** One pass that sends only a refund, and only when the swap rules allow it right now. Never sends a lock or a confirmation. */
    async refund() {
      file.lock();
      try {
        const meta = file.load();
        if (!meta.record) refuse('no-record', 'The swap file has no swap in it yet.');
        await preflightResume(meta, { destination: false });
        // Honest scope: this pass sends only a refund, but the shared driver also sweeps the XMR if the maker has already claimed (that is the recovery path).
        return await run(meta.record, { mode: 'refund', meta, wallet: walletRpc(), maxTicks: 1 });
      } finally { file.unlock(); }
    },
  };
}

/** The final outcome of a settled run as an exit code for scripts: 0 XMR received, 3 SOL refunded or stopped without a loss, 4 still in progress. */
export function outcomeOf(v) {
  const result = v?.record?.result;
  if (result === 'xmr-received') return { code: 0, text: 'xmr-received' };
  if (result === 'sol-refunded') return { code: 3, text: 'sol-refunded' };
  if (v?.record?.status === 'done' || v?.record?.status === 'rejected') return { code: 3, text: result ?? 'stopped' };
  return { code: 4, text: 'in-progress' };
}
