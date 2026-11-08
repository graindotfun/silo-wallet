# Maker admission gate: specification (proposal, not deployed)

internal procedure, published for transparency. tracker is our release operator role. astra is an internal model review lane, not an audit.

**Status: design, revision 2 (after Astra round 2 of the upgrade review). Nothing here is deployed.** It is
the prerequisite of step 0.7 in `docs/UPGRADE_TO_VERIFIED_BUILD.md`. Revision 2 adds R9 to R11 (write-ahead lock record,
blockhash rule, record preservation), replaces the "never locked" rule of the quiesce check (section 4) and adds tests T11 to
T15. An implementation started from revision 1 must take these in before review. Implementing it is a separate change to the
maker, whose source is private: internal review by Astra, then deploy by the tracker after approval. An implementation has
been written; it failed its internal review once (2 high, 1 medium findings) and was fixed; its refund path fix is still under
review (see `docs/REVIEW_HISTORY.md`). It was not used for the upgrade of 2026-11-08, which was executed with the maker stopped
(`docs/UPGRADE_TO_VERIFIED_BUILD.md`, section 13).

Target code: the maker's `maker.mjs` and `maker-core.mjs` (private source), read on 8 Nov 2026. Before implementing, the tracker
confirms which maker release is running and that it differs from the source read here only by the per-swap `confirmations`
field.

## 1. What the maker does today

| Mechanism | Exact behaviour |
|---|---|
| Start gate (`createStartGate`) | On mainnet, fixed checks at start: sweep address present and well formed, caps not above 0.05 / 0.3 / 3, API token of 32+ characters. A failure keeps the gate closed until a restart with fixed configuration. Otherwise the sweep address is validated by monero-wallet-rpc on the loop's `gate.check()`; the earliest definitive answer is cached for the life of the process; while wallet-rpc is unreachable before that answer the gate is closed and retried. `isOpen()` returns the cached value, refreshed only by the loop (every 30 s). |
| Effect of a closed start gate | `quote()` and `startSwap()` throw `maker-paused`; XMR sweeps are held (`sweepAllowed`); set-ready and refund keep running (`makerStep`). |
| Operator pause | None. Once the address has validated, nothing at run time closes the gate. |
| Admission race | `startSwap()` checks the gate at entry only, then awaits balance, chain time, daemon height, stores the swap file and sends the lock. A change during those awaits is not seen. Admissions are not serialized. |
| Swap file before lock | The file (with the secret) is stored before the lock is sent. If the lock never lands, the file stays open forever (`makerNext` returns `wait`, `pda-missing`). Counting open files alone therefore never reaches zero after such a case. |
| Lock signature | `lockSig` is written only after `sol.send` returns (`s.lockSig = r.sig; store(s)`). If the RPC accepts the lock and the answer is lost (timeout, crash, network), the file has no `lockSig` while the lock can still land until its blockhash expires, or may already have landed. An empty `lockSig` is therefore **not** evidence that nothing was sent. Whether `sol.send` uses a recent blockhash (expires) or a durable nonce (does not) must be read in the code (R10). |
| API | POST `/v1/quote` and `/v1/swap` need the bearer token. GET `/v1/health` (reachable through the reverse proxy) shows `accepting` = start gate only. No status endpoint. |
| Hosted service | Quote and swap go through the maker, so Silo's hosted service cannot open a swap without it. Its claim relay ignores the beta pause but requires the swap feature flag, so turning that flag off also holds users' claims. `maker-paused` maps to the generic "unavailable" message. |

Existing no-code options and why they are not enough:

- `MAX_OPEN_SWAPS=0` and a restart refuses new quotes and swaps while refunds, ready and sweeps continue, but it needs a
  restart (which can cut an admission between storing the file and sending the lock), gives no in-flight count and no proof of
  quiescence.
- Turning off the hosted service's swap flag holds claims (above). Stopping the maker stops refunds and ready.

## 2. Requirements

| Id | Requirement |
|---|---|
| R1 | An operator closes admission without a restart. The state survives restarts. Neither the maker process nor any HTTP request can reopen it. |
| R2 | Closed admission refuses new quotes and new swaps, refuses any admission queued behind a running one, and drops quotes already issued. |
| R3 | Closed admission does not touch set-ready, refund, XMR sweep or the hosted service's claim relay. It is separate from the start gate: `sweepAllowed` stays tied to the start gate only. |
| R4 | In-flight barrier: admissions run one at a time; an in-flight counter covers queued and running admissions; the admission state is checked again after the last await and immediately before the swap file is stored (the earliest persistent commitment). Once closed and the counter is zero, the maker cannot send another lock. |
| R5 | Fail closed: any error reading the drain file other than "does not exist" means closed. |
| R6 | Token-protected `GET /v1/status`: admission, in-flight count, open swap count and short list (short id, locked on chain, ready), maker key, program id, network. Public `/v1/health` shows `accepting` = start gate and admission, and no swap details. |
| R7 | Journal events: `admission-closed` and `admission-opened` on each change seen by the loop; refusals keep the `maker-paused` error. |
| R8 | A read-only quiesce check (section 4). It never claims that the program is frozen. |
| R9 | Write-ahead lock record: the lock transaction is signed, then its signature, blockhash and `lastValidBlockHeight` are stored in the swap file (fsync) **before** it is sent; `lockSig` is never cleared afterwards. An admission that fails before signing stores `abortedBeforeSign` with the reason before it returns. The maker journals `maker-started` with the time at each process start. |
| R10 | Locks (and ready and refund transactions) use a recent blockhash, never a durable nonce, so an unsent or unlanded transaction stops being landable after `lastValidBlockHeight`. The implementation states this and a test checks it; if a nonce is ever used, the expiry rules K2 and K4 below do not apply and such files stay NOT OK. |
| R11 | Recovery records are preserved: neither the check nor the procedure deletes, moves or edits a swap file, a journal or a secret. Classification is written to a separate quiesce report. The state directory is backed up before the window. A file that cannot be classified is kept and stays NOT OK. |

## 3. Proposed change

Same design as the drain file already written for the protocol v2 maker (in development, not in this repository:
`STATE/ADMISSION_CLOSED`, serialized admission, `/v1/status`, a quiesce check script), back-ported to the current XMR to SOL maker only, with four tightenings that v2
should also take: re-check before storing (R4), fail-closed read (R5), `accepting` includes admission (R6), configurable path.

```js
// maker.mjs (sketch)
const ADMISSION_FILE = E.MAKER_ADMISSION_FILE ?? `${STATE}/ADMISSION_CLOSED`;
// R5: only "does not exist" means open.
function admissionOpen() {
  try { statSync(ADMISSION_FILE); return false; } catch (e) { return e?.code === 'ENOENT'; }
}
const serial = createSerial();              // same helper as the protocol v2 maker: one admission at a time
let inflight = 0;
const admit = (fn) => { inflight += 1; return serial(fn).finally(() => { inflight -= 1; }); };

async function quote(input) {
  if (!gate.isOpen() || !admissionOpen()) throw new Error('maker-paused');
  /* unchanged */
}
const startSwap = (input) => admit(() => startSwapLocked(input));
async function startSwapLocked(input) {
  /* quote lookup, gate and admission check, caps, proofs, balance, keys, chain time, daemon height: unchanged */
  if (!gate.isOpen() || !admissionOpen()) throw new Error('maker-paused');   // R4: last check before any commitment
  store(s);
  // R9: sign, record, then send. Any failure before signing is recorded positively.
  let tx;
  try { tx = await sol.signLock(ixs, maker); }               // recent blockhash only (R10)
  catch (e) { s.abortedBeforeSign = { at: new Date().toISOString(), reason: String(e?.message ?? e) }; store(s); throw e; }
  s.lockSig = tx.sig; s.lockBlockhash = tx.blockhash; s.lockLastValidBlockHeight = tx.lastValidBlockHeight; store(s);
  await sol.sendSigned(tx);                                  // may throw after the RPC accepted it: lockSig is already on disk
  s.solLocked = true; store(s);
}

// loop(): detect changes, drop issued quotes when closed (R2, R7)
let lastAdmission = admissionOpen();
function admissionTick() {
  const open = admissionOpen();
  if (!open) quotes.clear();
  if (open !== lastAdmission) { log({ event: open ? 'admission-opened' : 'admission-closed', inflight }); lastAdmission = open; }
}
// health: accepting: gate.isOpen() && admissionOpen()
// status (bearer token, same check as POST): { admission, inflight, openCount, open: [{ id, lockedOnChain, ready }], maker, programId, network }
```

On mainnet set `MAKER_ADMISSION_FILE` to a file in a directory owned by root and readable (with search permission) by the
maker's group, so the maker can see the file but cannot create or delete it (R1). The default path keeps compatibility with
the protocol v2 maker on test networks.

Operation, on the maker's server: close by creating that file as root; reopen by removing it as root, only after step 4 of
the upgrade procedure has passed.

## 4. Quiesce check (read-only script)

Reuse the quiesce check script of the protocol v2 maker, restricted to the normal swap account, with this contract. It prints OK only if
all of these hold, otherwise NOT OK with the reason; anything it cannot classify counts as NOT OK:

1. `getGenesisHash` of the RPC equals the mainnet genesis hash `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`; the program id
   is `7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS`; `/v1/status` reports the same program id, network `mainnet` and the
   maker key the script expects.
2. `/v1/status`: admission `closed`, in-flight 0.
3. Every swap file is classified by **positive evidence**, all reads at finalized commitment. A file is accepted only as one of:
   - **K0 final:** `done` set by the maker, and no account at its PDA.
   - **K1 outcome proven:** the PDA's signature history (`getSignaturesForAddress`) contains the lock and a successful claim or
     refund, and no account at the PDA. The transaction ids are printed.
   - **K2 expired (write-ahead record, R9):** `lockSig` and `lockLastValidBlockHeight` are on file; `getSignatureStatuses` with
     history finds no such signature; the finalized block height is above `lockLastValidBlockHeight`; the PDA has no signature
     history and no account. The lock can never land.
   - **K3 never signed (R9):** `abortedBeforeSign` is on file, `lockSig` is absent, and the PDA has no signature history and no
     account.
   - **K4 expired by process boundary (files without the R9 fields, for example from before this change, or a crash between
     storing the file and signing):** the file was written by a process that has ended (its `createdAt` is before the current
     process's `maker-started`), every blockhash that process could have used is from a block at or before the earliest finalized
     block whose `blockTime` is at least 120 seconds after that start time (height H), the finalized block height is above
     H + 300, and the PDA has no signature history and no account. This needs R10.
   Anything else is **NOT OK (ambiguous)**, in particular an empty `lockSig` with no account and no K1 to K4 evidence: the lock
   may have been accepted with the answer lost, may have landed and been settled, or may still land. The file is kept (R11).
4. `getProgramAccounts` on the program at finalized commitment, data size 194: zero accounts with refunder (offset 8) equal to
   the maker key, and zero with claimer (offset 40) equal to the maker key. This also catches a lock the maker has not recorded
   and a late landing after an earlier run.
5. Every other escrow of the program (strangers, data size 194) is listed with refunder, t0, t1 and ready, and is not blocking.
6. It prints the finalized slot range it read. It is a snapshot, not a freeze: strangers can still lock directly on chain.

## 5. Acceptance tests (before deploy)

| Id | Test |
|---|---|
| T1 | Drain file present: quote and swap refuse with `maker-paused`. |
| T2 | File created between quote and swap: the swap is refused; the issued quote is dropped at the next tick. |
| T3 | File created while an admission waits before storing (injected delay): refused at the R4 re-check, no swap file, no lock. |
| T4 | Two concurrent swaps run one after the other; the in-flight count is visible in `/v1/status` and returns to 0. |
| T5 | With the file present, set-ready, refund and sweep still run (`makerStep` unchanged). |
| T6 | Restart with the file present: still closed. |
| T7 | A read error other than "does not exist" (for example no permission): closed. |
| T8 | `/v1/status` refuses a missing or wrong token; `/v1/health` shows `accepting: false` when closed and no swap details. |
| T9 | Quiesce check: NOT OK for in-flight above 0, an open swap file, a maker escrow on chain, an unclassified file, a wrong genesis hash or program id; OK otherwise; strangers listed, not blocking. |
| T10 | Stagenet and devnet end to end: close admission during a running swap; it completes (or refunds); new quotes are refused; reopening works. |
| T11 | Lock accepted, answer lost: the RPC accepts the lock and the maker's send throws (injected). `lockSig` is on file. (a) The lock lands: NOT OK (maker escrow on chain) until it is settled, then K1. (b) It never lands: NOT OK until the finalized block height passes `lockLastValidBlockHeight`, then K2. |
| T12 | Late landing: a signed lock is held back and submitted after an earlier check run, before its expiry. That earlier run is NOT OK (expiry not yet proven), the run after landing is NOT OK (account on chain). No run in between prints OK. |
| T13 | Crash between storing the file and signing, and between signing and sending (process killed): after restart NOT OK until K4 (or K2 where the record exists) holds; the file is kept. |
| T14 | Regression of the revision 1 rule: a file with an empty `lockSig`, no account at its PDA and none of the K1 to K4 evidence prints NOT OK (ambiguous). |
| T15 | The check is read-only: the state directory's file list and hashes are equal before and after a run (OK and NOT OK runs). A durable-nonce lock (if any code path could make one) makes K2 and K4 unavailable (R10). |

## 6. Not in this change

No change to pricing, caps, timelocks, the program, the start gate's checks or the hosted service. Optional and non-blocking: a hosted service
message for `maker-paused` ("Swaps are paused for maintenance. Swaps already started continue.").
