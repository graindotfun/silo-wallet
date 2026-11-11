# Open maker protocol (draft, written from the code)

Status: draft. Everything here was read from the code at source commit `970207fd8` and cites file and line. Paths in this document are written as in the source tree. In this repository the same files are under `web/` (for example `P/maker/` is `web/prototypes/xmr-sol-atomic-swap/maker/`, `lib/silo/` is `web/lib/silo/`). Line numbers refer to the source commit named in this sentence and may have moved. Nothing here has been independently reviewed. Where the code does not do
something a maker or client spec would want, it is listed in "Gaps" and not papered over.

Paths: `P` = `prototypes/xmr-sol-atomic-swap`. Client core: `P/client/`. Maker: `P/maker/`. Program: `P/program/src/lib.rs`.
Wallet copies of the client core: `lib/silo/atomic-swap/` (six modules kept byte-identical by `tests/silo-atomic-modules-in-sync.test.mjs`;
`bob-flow.mjs` and `refunder-tx.mjs` exist only there, see Gaps). Silo's server proxy: `lib/silo/atomic-server.mjs`, `app/api/silo/atomic/[action]/route.ts`.

Related documents (not restated here): the signed maker list format is in `docs/OPEN_MAKER_LIST.md`; the standalone command line client is described in
`prototypes/xmr-sol-atomic-swap/standalone/README.md`. Both are in this repository.

## 1. What is true today

- There is one maker, run by us. It listens on `127.0.0.1` only (`P/maker/maker.mjs:418`, the `listen` call) and, when `MAKER_API_TOKEN` is set, every POST needs
  that bearer token (`maker.mjs:393-396`). Only the Silo Worker holds the token. A user cannot reach the maker without Silo's server.
- Quotes and registrations go through Silo's servers (`app/api/silo/atomic/[action]/route.ts`). The claim that pays the user is built and signed on the user's
  device and is broadcast by the device itself before any other copy, through an independent public RPC; Silo's server copy of the broadcast is best effort (`lib/silo/atomic-driver.mjs:139-142`).
- The escrow program is upgradeable and the upgrade authority is an owner wallet (section 7).
- A public network of makers is a plan and an experiment with a stop condition, not something that exists. This document describes the interface such a
  maker would have to offer, and what a client must check before it trusts one. It does not claim the current maker code can be exposed as is (section 3).

## 2. Roles and the two directions

| | XMR to SOL (live beta direction) | SOL to XMR |
|---|---|---|
| Maker holds | SOL (locks it in the escrow before the user acts) | XMR (sends it after the user's SOL lock is final) |
| User holds | XMR (locks it after the maker's SOL lock) | SOL (locks it before the maker sends XMR) |
| Maker role in the program | `refunder` (signs the lock) | `claimer` |
| Program instructions | `lock`, `set_ready`, `claim`, `refund` (`lib.rs:69-155`) | strict family: `lock_strict`, `set_ready_strict`, `claim_commit_strict`, `claim_strict`, `refund_strict` (`lib.rs:159-243`) |
| Client logic | `P/client/swap-core.mjs` (`aliceNext`), `alice-flow.mjs` | `P/client/reverse-core.mjs` (`userNext`), `lib/silo/atomic-swap/bob-flow.mjs`, `refunder-tx.mjs` |
| Maker logic | `swap-core.mjs` `makerNext`, `maker/maker.mjs` | `reverse-core.mjs` `makerReverseNext`, `maker/maker-reverse.mjs` |

Both directions use the same key idea: the Monero spend key of the shared address is `a + b`. The XMR side's holder knows one share, the SOL side's holder the other.
Claiming the SOL reveals `a` on chain; refunding reveals `b`. Each share comes with a proof of knowledge bound to the swap id and a role byte
(`P/client/keys.mjs:proveShare` and `verifyShare`), which stops a party choosing a share that cancels the other.

## 3. What an open maker endpoint has to replace

Today (`maker.mjs:418` and `:393-396`): loopback bind, bearer token on every POST, token held only by the Silo Worker. The code comment says why: "this stops anyone tying
up the caps". The start gate also refuses new swaps on mainnet unless a token of at least 32 characters is configured (`maker-core.mjs:createStartGate`, `api-token-missing`).
So `maker.mjs` as written cannot be a public maker: either the bind and the token rule change, or it sits behind a proxy that holds the token, which is the Silo Worker's role today.

What "tying up the caps" means in the code:

- A quote reserves nothing. It is an in-memory entry for 120 s (`maker.mjs:132-151`, `quoteTtl: 120` at `:37`).
- A registration is the commitment: it writes a swap record that counts against `maxOpenSwaps` and against the daily XMR total (`maker.mjs:126-130`
  `cappedSwaps`, `lockedToday`; `maker-reverse.mjs:34-40` `capsAdmission`). In XMR to SOL it also makes the maker lock real SOL and pay gas (`maker.mjs:180-210`).
  In SOL to XMR it reserves inventory with no SOL from the user. With defaults (3 open swaps, 0.3 XMR per day) a handful of free registrations fills every cap.
  How long a registration that never receives the user's lock stays open in the SOL to XMR direction was not measured for this document.

Realistic replacements for the token, design only, with what each costs in privacy and usability:

| Option | What it stops | Privacy cost | Other cost |
|---|---|---|---|
| Reverse proxy per IP rate limit and a cap on open registrations per IP | casual abuse | the maker sees client IPs; Tor and shared networks get blocked or share a bucket | trivial to bypass with many addresses |
| Proof of work attached to each registration request (quotes stay free) | cheap bulk registrations | none, no identity | costs a phone battery; attackers with servers pay little |
| Per-claimer-address limits (one open swap per `claimer` in XMR to SOL, per `refunder` in SOL to XMR) | one address filling the caps | the maker already receives these addresses at registration; no new data | trivial to bypass with fresh addresses |
| Registration deposit: user pays a small non-refundable fee or a refundable lock before the maker commits | any cheap abuse | links a payment to the swap; a refundable deposit is a Solana transaction tied to the user's address | extra step and extra on-chain fee for every swap |
| Unlinkable rate-limit tokens issued by the maker or by the list publisher (blind signed, one per time period) | bulk abuse without identity | issuance needs an identity check or a payment somewhere; implementation and review cost is high | design and code do not exist |
| Shorter hold for a registration that does not progress (expire an XMR to SOL lock sooner when no XMR is seen, close an unlocked SOL to XMR registration after a fixed time) | limits how long a cap stays tied up | none | the user has less time; some of this already exists for XMR to SOL (`LOCK_WAIT` 1800 s, `swap-core.mjs:7`) |
| Keep a front server holding the token (status quo) | everything above | the front server sees every quote and registration and the user's IP | the front server is a single point of failure and of censorship; it is the situation today |

None of these is built. The privacy cost is the point to decide before any of them is built: the maker already learns the user's Solana address and the swap's
private view key at registration (`swapRequest`, `alice-flow.mjs:29`; `reverseRegisterRequest`, `bob-flow.mjs:23`). That is by design, because both sides watch the shared address.

## 4. HTTP interface a maker exposes

There is **no relay endpoint on the maker**. A maker exposes quote, register, status and health. The claim transaction is built by the user's device and is broadcast
by the device itself (section 5.4). Silo's Worker also offers `POST /api/silo/atomic/claim` as a best effort relay; that is a Silo server feature, not part of the maker.

Common rules (`maker.mjs:389-418`):

- JSON over HTTP, `content-type: application/json`. Request body at most **8192 characters**, else HTTP 400 `{"error":"too-large"}`. A body that is not JSON gives 400 with the parser's message.
- Every error is a JSON object `{"error": "<text>"}` with status 400 (bad input or refusal), 401 `unauthorized`, or 404 `not-found`. The error text is a short code in almost all cases (table below).
- When a token is configured, every POST needs `Authorization: Bearer <token>`. GET `/v1/health` and GET `/v1/swap/<id>` need no token in the current code. A public maker has no shared token and needs another answer (section 3).
- The reference maker ignores request fields it does not know.
- Silo's Worker refuses maker answers above **16384 bytes**, redirects, and calls that take longer than **15 s** (`atomic-server.mjs:72-80`). A maker meant to sit behind it has to stay inside those.
- Amounts: XMR is carried as atomic units (1 XMR = 10^12) in decimal strings; SOL as lamports (10^9) in JSON numbers; times as Unix seconds in JSON numbers.
- Optional tier fields (an unreleased draft extension, not part of this repository): either quote **may** carry
  `tiers: [{ rate: 'holder', min, spreadBps, lamports }]` (`min` a whole-token string, `spreadBps` below the standard spread, `lamports` the amount at that rate), and a swap or registration request **may** carry `tierOk: true`.
  A registration answer that applied a holder rate carries `rate: 'holder'` and `spreadBps` and a `lamports` that differs from the quote. Rules:
  - A client that does not know these fields ignores `tiers`, **never sends `tierOk`**, and refuses any registration whose `lamports` differs from the quote (`alice-flow.mjs:41` and `bob-flow.mjs:31` on main throw `terms-mismatch`).
    A maker must price a request without `tierOk` at the standard rate.
  - A client that knows them accepts only an answer that says `rate: 'holder'`, matches one quoted tier exactly (`lamports` and `spreadBps`), and is strictly better for the user (more SOL received, or less SOL paid); anything else is `terms-mismatch`.
    It sends `tierOk: true` whenever the quote has tiers, so the flag says nothing about what the user holds. The maker reads the balance of the swap's own address only at registration.
  - Silo's Worker today refuses any request field it does not list (`atomic-server.mjs:17` `exactKeys`); the draft extension adds `tierOk` to the lists.

### 4.1 `GET /v1/health`

No request. Response 200:

| Field | Type | Meaning |
|---|---|---|
| `ok` | boolean | always `true` when the process answers |
| `accepting` | boolean | the maker takes new quotes and swaps (start gate and drain file both open) |
| `maker` | string | the maker's Solana address (base58, 32 bytes) |
| `limits.maxXmrPerSwap` | string | decimal XMR with 12 decimals, e.g. `0.050000000000` |
| `limits.maxXmrPerDay` | string | same format |
| `limits.maxOpenSwaps` | integer | |
| `solXmr` | boolean | the SOL to XMR direction is enabled |

The minimum amount, the spread and the network are **not** in the health answer. The live caps and spread are inputs the operator supplies; they are not written here.

### 4.2 XMR to SOL: `POST /v1/quote`

Request: `{ "xmr": <decimal XMR> }`. The reference maker converts with `Number()` and rounds to 12 decimals (`xmr.mjs:atomic`), so it also accepts a JSON number;
Silo sends a string matching `^\d{1,4}(\.\d{1,12})?$`. A maker must refuse missing, non-numeric, zero, negative and non-finite amounts.

Response 200 (`maker.mjs:132-151`):

| Field | Type | Meaning |
|---|---|---|
| `quoteId` | 32 hex chars | single use, 16 random bytes |
| `swapId` | 64 hex chars | fixed at quote time so both key share proofs bind to it |
| `xmrAtomic` | string | the amount the user must send to the shared address |
| `lamports` | integer | the SOL the maker will lock for the user, after gas |
| `gasLamports` | integer | SOL the maker pays to the user's fee payer account (default 1,000,000) |
| `solPerXmr` | number | the market price the maker used |
| `spreadBps` | number | basis points taken off the market price (code default 200; the live value is an input) |
| `priceSource` | string | name of the price source (`coingecko` in the reference maker) |
| `confirmations` | integer 1..10 | Monero confirmations the maker waits for before it sends `ready` (10 unless a shallower depth is configured for small swaps) |
| `expiresAt` | integer | Unix seconds; the quote is dead at this time. Reference value: now + 120 s, a constant in `maker.mjs` |
| `tiers` | array, optional | may be present, see above |

`lamports = floor(xmr * solPerXmr * (1 - spreadBps/10000) * 1e9) - gasLamports`. Refusals: `amount-outside-limits` (below the minimum or above the per-swap cap), `daily-limit-reached`, `maker-paused` (start gate or drain file closed),
`busy-try-later` (open swap cap), `amount-too-small`, `price-unavailable` (the price source failed), and arbitrary parser text for malformed input.

### 4.3 XMR to SOL: `POST /v1/swap` (register, the maker locks SOL)

Request (all required): `{ quoteId, claimer, feePayer, A, proofA, v }` where `claimer` is the user's Solana address that receives the SOL, `feePayer` the address of a throwaway key the
user generated to pay the claim fee, `A` the user's 32 byte public key share (64 hex), `proofA` `{ R, s }` (64 hex each, proof of knowledge bound to `swapId` and role 0), `v` the user's private view key (64 hex, shared by design).
The user's wallet key never signs anything in this direction (`alice-flow.mjs:1-4`).

Response 200 (`maker.mjs:172-178`): `{ swapId, B, proofB, jointAddress, pda, refunder, t0, t1, lamports, lockSig, xmrAtomic }`: `B` the maker's public share (64 hex), `proofB` `{R,s}` (role 1),
`jointAddress` the Monero address (spend key `A + B`, view key from `v`), `pda` the escrow account address, `refunder` the maker address, `t0` and `t1` Unix seconds, `lamports` integer, `lockSig` the Solana signature of the lock the maker broadcast, `xmrAtomic` string.

Behaviour that matters:

- The quote is **consumed before anything else is checked**: a request with a bad proof burns its quote (`maker-core.mjs:admitSwap`, `takeQuote` runs as the step before all others). A reused or expired quote gives `quote-expired`.
- Other refusals: `maker-paused`, the cap errors above (checked again at registration), `bad-share-proof`, `bad-view-key`, `inventory-low` (the maker's SOL balance is below lamports + gas + reserve).
- The swap record, holding the maker's secret and the signed lock, is stored **before** the lock is broadcast (`maker.mjs:160-178`).
- Timelocks: `t0 = chain time + T0`, `t1 = chain time + T1`, with `T0` default 7200 s and `T1` default 14400 s, both environment settings (`maker.mjs:37`). A client accepts only the bounds in section 6.
- Gas: if the fee payer holds less than `gasLamports`, the lock transaction also transfers `gasLamports` from the maker to the fee payer (`maker.mjs:200`).

### 4.4 SOL to XMR: `POST /v1/rev/quote`

Same request as 4.2. Disabled unless `SOL_XMR_ENABLED=true`: `direction-disabled`. Extra refusal: `inventory-low` (the maker's XMR treasury cannot cover the amount plus its fee reserve).

Response 200 (`maker.mjs:213-235`): `{ direction: "sol-xmr", quoteId, swapId, xmrAtomic, lamports, solPerXmr, spreadBps, priceSource, A, proofA, claimer, expiresAt }`.
`lamports` is what the user pays: `ceil(xmr * solPerXmr * (1 + spreadBps/10000) * 1e9)`. `A` is the maker's public share and `proofA` its proof (role 0); the maker generates them at quote time and
keeps its secret in memory until registration. `claimer` is the maker's Solana address. There is no `confirmations` and no `gasLamports` in this direction (the user's wallet pays its own fees).

### 4.5 SOL to XMR: `POST /v1/rev/swap` (register, nothing is locked yet)

Request: `{ quoteId, refunder, B, proofB, v }`: the user's wallet address, public share (64 hex), proof (role 1), private view key.
Response 200 (`maker.mjs:248-250`): `{ swapId, jointAddress, t0, t1, lamports, xmrAtomic, claimer, claimPoint, pda }` where `pda` is the strict escrow address (seed `swap-strict`).
The maker broadcasts nothing here; the registration is the reservation of its XMR inventory and caps. The user then locks the SOL with the timelocks in the answer.
Timelocks are fixed in code, not configurable: `t0 = chain time + 3 h`, `t1 = t0 + 2 h` (`reverse-core.mjs:16-29`).

### 4.6 `GET /v1/swap/<id>`

Returns the maker's progress for one swap: `{ swapId, direction ("xmr-sol" or "sol-xmr"), jointAddress, lockSig, readySig, refundSig, xmrSendTxid, claimSig, done }`, each unset field `null`.
It holds no addresses of the user. No token is needed. An unknown id returns 400 with the file system error text, which contains the maker's state directory path (a small information leak, found by reading `maker.mjs:78` and `:412`; the conformance suite reports it as a warning).
`GET /v1/status` is operator only (token always required) and not part of the interface.

## 5. What a client must check

### 5.1 Before it acts on a quote

Where each check lives today, and what is missing.

| Check | Where | Status |
|---|---|---|
| Quote has the fields and types above; `lamports` is a safe integer | `components/silo-atomic-panel.tsx:99`, `silo-atomic-reverse-panel.tsx:93` | partial: only `xmrAtomic` is a string and `lamports` a safe integer; nothing else is read or checked |
| `xmrAtomic` within the beta cap | Worker `checkQuoteWithinCap` (`atomic-server.mjs:35`) | present, in Silo's server, not in the client core |
| `xmrAtomic` equals the amount the user asked for | nowhere | **gap** |
| `lamports` consistent with `solPerXmr`, `spreadBps`, `gasLamports` | nowhere in a client; the conformance suite does it | **gap** |
| Spread and price within bounds of a price the client gets elsewhere | nowhere. The panels only display `solPerXmr`, `spreadBps` and the price source | **gap** |
| `expiresAt` not too far in the future | nowhere | **gap** |
| Optional `tiers` ignored unless the client implements them; if present each must be strictly better for the user | conformance suite only (`forward.quote.tiers`, `reverse.quote.tiers`) | no client code on main reads `tiers` |
| SOL to XMR: `proofA` verifies for this `swapId` (role 0) | `bob-flow.mjs:28`, again in `reverse-core` terms at `bob-flow.mjs:117` | present |
| SOL to XMR: `claimer` is not the user's own wallet | `bob-flow.mjs:30` | present |

A quote that expires is treated as dead (`aliceNext`, `swap-core.mjs:62`; `userNext`, `reverse-core.mjs:54`), but only to retire a swap that never got a registration answer.

### 5.2 Before it locks anything (XMR to SOL: before it sends XMR)

On the registration answer `acceptMakerLock` (`alice-flow.mjs:33-43`) requires, and the loop in `aliceNext` (`swap-core.mjs:60-75`) re-requires on the escrow read from chain:

1. Timelocks inside the bounds of section 6 (`timelocksAcceptable`, `swap-core.mjs:42`).
2. `proofB` verifies for this swap id and role 1 (`verifyShare`); this also rejects small order and identity points.
3. `jointAddress` equals the address the client derives from `A + B` and its own view key.
4. `pda` equals the escrow address the client derives from `refunder`, `swapId` and **the program id it is configured with** (`swapPda`, `sol.mjs:17`).
5. `xmrAtomic` and `lamports` equal the quote.
6. Then, on an escrow read from an independent public RPC, never from Silo's server (`readChainIndependent`, `alice-flow.mjs:103-136`): the account is owned by the program and decodes as a swap, and every field matches what the user agreed
   (`escrowMatches`, `swap-core.mjs:37-40`: `claimPoint`, `refundPoint`, `claimer`, `lamports`, `refunder`, `t0`, `t1`). A mismatch means `bad-terms` and the XMR is never locked.
7. **The escrow counterparty key must be the Solana address in the maker's list entry.** A client that selected the maker from a signed list (`docs/OPEN_MAKER_LIST.md`, field `solanaAddress`) must refuse when the escrow's `refunder` (XMR to SOL) or the quote's `claimer` (SOL to XMR) is any other address. Otherwise a listed maker could rotate keys to hide its refund history, and a hijacked URL could stand in for a listed maker.
   **No code does this today** (Gaps 10): `acceptMakerLock` takes `refunder` from the maker's own answer and only checks that the escrow address derives from it (`alice-flow.mjs:39`), and `acceptMakerRegistration` checks `claimer` only against the quote and against the user's own wallet (`bob-flow.mjs:29-30`).
8. The user's XMR is sent only if now is at least `LOCK_MIN_LEAD` (3600 s) before `t0`, and only after the fee payer holds at least `MIN_GAS` (10,000 lamports) so the claim can be paid (`swap-core.mjs:70-74`).

SOL to XMR: `acceptMakerRegistration` (`bob-flow.mjs:26-41`) requires: `proofA` valid; the answer repeats `swapId`, `claimer` (equal to the quote's maker address), `claimPoint` (equal to the quote's `A`), `lamports`, `xmrAtomic`;
the `lamports` are a positive safe integer at most 2,000,000,000 (`SILO_ATOMIC_MAX_LOCK_LAMPORTS`, `refunder-tx.mjs:13`); `t0` within 600 s of now + 3 h and `t1 - t0` exactly 7200 s; `jointAddress` and `pda` match the client's own derivation.
Then the wallet signs only a lock rebuilt byte for byte from those fields, for the program id pinned in the code (`refunder-tx.mjs:11,62-68`).

### 5.3 Before `ready` (SOL to XMR, the user's confirmation)

`userNext` (`reverse-core.mjs:47-74`): the user sends `set_ready` only when its **own** view-only scan of the shared address shows at least the quoted XMR in outputs with no extra unlock time and at least 10 confirmations, and
now is before `t0 - 300 s`. A scan that fails or times out proves nothing: it never sets `ready`, and it does not on its own start the 30 minute early refund. The driver hands the core a placeholder of zero XMR at zero confirmations instead of "no scan result", so the "nothing arrived after 1800 s" rule (`!o.xmr`, `reverse-core.mjs:71`) does not fire on it (`atomic-reverse-driver.mjs:141-153`). A failed scan can still delay `ready` until it is too late, and the refund that follows at `t0 - 900 s` is then a time rule, not a finding about the XMR. An empty scan that does complete (a node that answers but shows nothing) is a result like any other and can start the early refund, so a node that hides a real payment costs the user time, and costs the maker the XMR it sent. If the maker sends too little, too late or nothing, the user refunds (`reverse-core.mjs:70-72`).
Where the refund is decided on a state that a ready could have changed, it is decided again on a finalized account read and the block time of the same slot (`bob-flow.mjs:112-131`).

The user's own Monero node is a safety requirement here, not an option. A remote node can report a payment that does not exist to a view-only wallet, and `ready` hands the SOL to the maker's claim. So the scan that decides `ready` must run against a node the user runs or otherwise trusts, ideally with a second witness. The code does not enforce this: `userNext` takes `xmr` as an input and has no notion of which node produced it (`reverse-core.mjs:47-69`), and `atomic-reverse-driver.mjs:140-145` uses whatever scan the wallet bridge provides. A standalone client must require it before it sends `ready` (Gaps 11).

### 5.4 Claim and broadcast (XMR to SOL)

There is no relay on the maker, and none is needed. The user's device holds `a` and builds one transaction with the throwaway fee payer as signer: the program's `claim` instruction, plus, when the fee payer
has a balance left, a transfer of the leftover to the user's own address (`alice-flow.mjs:60-70`). The program sends the SOL to the recorded `claimer`, whoever submits the transaction (`lib.rs:127-143`).
The device broadcasts it through its own public RPC on every retry (`directBroadcast`) and only sends Silo's copy as a best effort (`atomic-driver.mjs:139-142`); the landing is judged from the independent chain read only.
A claim reveals `a` on chain; a refund reveals `b`. So a standalone client needs only its own Solana RPC to claim.

The zero-SOL user: the fee payer is a throwaway key made for this swap, funded by the maker's `gasLamports` transfer inside the lock transaction (section 4.3). The client waits (`fee-payer-not-funded`) and does not send XMR until the fee payer holds at
least 10,000 lamports. A maker that sets `gasLamports` to 0 leaves a user without SOL waiting forever, but safe: no XMR has been sent. The client does not read `gasLamports` from the quote, so it only finds out by waiting. The claim fee is 5000 lamports
(`CLAIM_FEE`, `swap-core.mjs:11`) and the rest of the gas goes back to the user in the same transaction.

Silo's relay, for completeness: `POST /api/silo/atomic/claim {tx}` accepts a base64 transaction of 100 to 2200 characters that is one `claim` instruction (and at most one transfer of the leftover to the claimer) for the server's configured program id, signed by one signer
(`atomic-server.mjs:58-65`, `alice-flow.mjs:83-93`), and sends it with the server's RPC.

### 5.5 Program id

SOL to XMR: pinned in the wallet code (`refunder-tx.mjs:11`). XMR to SOL: **not pinned**. `sol.mjs:7` reads the default from `SWAP_PROGRAM_ID` or the constant, and the wallet overwrites it with a value from Silo's server
configuration (`components/silo-atomic-panel.tsx:49-51`, `atomic-swap/sol.mjs:9`). A client that takes the program id from a server or from a maker's answer lets that party point the escrow at a program it controls. A standalone client must pin it (Gaps).

### 5.6 Clock

Some decisions are judged on **chain time** (the block time of a Solana slot read from an independent RPC), and the claim, which reveals a secret, is sent only when the later of the two clocks is still safe. Other decisions use the local clock alone; the list is below. Solana's clock can run behind wall time, and a local clock can be wrong or set by the user.
What the core does today:

- Decision functions take `now` as an input; the wallet passes chain time: `readChainIndependent` and `readReverseChain` build `now` from `getBlockTime(getSlot())` (`alice-flow.mjs:107-109`, `bob-flow.mjs:64-66`). The refund that reveals `b` is decided again on the block time of a finalized slot (`bob-flow.mjs:70-84,112-131`).
- Claim (reveals `a`): `claimStillSafe(r, localNow)` compares against `t1 - 300 s` (`alice-flow.mjs:139`), and the XMR to SOL driver passes the **later** of the local clock and chain time plus the time elapsed since the read (`atomic-driver.mjs:134-137`). That is the "both agree" rule for the claim.
- **Decisions that use chain time:** the decision functions the wallet feeds with the `now` it builds from its independent chain read (the `readChainIndependent` bullet above), and the refund that reveals `b` (finalized slot block time). **Decisions that use the local clock (not chain time):** acceptance of the maker's timelocks, and quote expiry. The claim uses the later of the two. The maker uses chain time for `t0` and `t1`. Detail on the local clock decisions: the acceptance bounds on the maker's timelocks use the local clock by default (`acceptMakerLock(r, m, now = Date.now()/1000)`, `alice-flow.mjs:33`; `acceptMakerRegistration`, `bob-flow.mjs:26`), and both drivers pass `now()` from the local clock (`atomic-driver.mjs:72`, `atomic-reverse-driver.mjs:86`). Quote expiry is also compared against the local clock (`atomic-driver.mjs:92`, `silo-atomic-panel.tsx:95`).
- The maker takes `t0` and `t1` from chain time (`sol.chainNow`, `maker.mjs:196` and `:260`).

A standalone client must use chain time for the timelock bounds as well (Gaps 12). Neither clock is a guarantee. Chain time is the block time of a slot and can lag wall time, so a deadline can look later on chain than on a clock; the local clock can be wrong or changed by the user, which moves the acceptance bounds and the quote expiry. A client that works out an offset between the two has only a snapshot: it goes stale, and the code on main keeps no offset at all. The claim rule limits the harm for the one decision that reveals a secret (the later of the two clocks must still be before `t1 - 300 s`), but it does not remove it: a claim that is late on either clock is not sent, and the program refuses it after `t1` on chain time whatever the device believes. The conformance suite compares a quote's `expiresAt` with the local clock only to catch a wildly wrong value (30 s slack).

## 6. Timing

All times Unix seconds on chain (`Clock::unix_timestamp`), `t0` and `t1` as in the escrow account.

XMR to SOL (maker locks SOL, `T0` and `T1` defaults 7200 s and 14400 s, both set by the maker's operator):

| Moment | Rule | Source |
|---|---|---|
| Quote lifetime | 120 s | `maker.mjs:37`, constant |
| Client accepts `t0` between | acceptance + 3600 s and acceptance + 3 h | `swap-core.mjs:30,43` |
| Client accepts `t1` at most | acceptance + 26 h, and `t1 - t0` at least 3600 s | `swap-core.mjs:33,34,43` |
| User locks XMR only if now is at least | 3600 s before `t0` | `LOCK_MIN_LEAD` |
| Maker sets `ready` | when the maker's scan sees the full amount with the quoted confirmations, before `t0 - 300 s` | `makerNext`, `swap-core.mjs:105` |
| Maker aborts (early refund, reveals `b`) | no XMR 1800 s after its lock; or from `t0 - 900 s` if the payment is not full and deep; or an underpayment at depth | `swap-core.mjs:7,13,117-121` |
| User claims | from `ready`, or from `t0` without `ready`, until `t1 - 300 s` (device rule) / `t1` (program) | `swap-core.mjs:80`, `lib.rs:272-275` |
| Maker refunds late | from `t1`, and sends the bytes only after a finalized block time is at least `t1 + 60 s` | `swap-core.mjs:101`, `LATE_REFUND_MARGIN` |

Worst case for a user in this direction: the maker never sets `ready` and never aborts. The user waits until `t0` (at least 1 h and by default about 2 h after the lock), then claims. If the user is away until `t1` and the maker
stays silent, the claim window is over, the SOL is not the user's any more, and the user's XMR sits at the shared address until the maker refunds and reveals `b`. The user cannot move it alone, and nothing in the program makes the maker refund (section 7.1, case F2).

SOL to XMR (user locks SOL, timelocks fixed in code):

| Moment | Rule | Source |
|---|---|---|
| Registration to `t0` | 3 h (client accepts a 600 s slack) | `reverse-core.mjs:16,18,35` |
| `t1 - t0` | exactly 2 h | `reverse-core.mjs:17` |
| Maker sends XMR only if now is before | `t0 - 2 h`, i.e. within about the opening hour, and only after the user's lock is finalized | `reverse-core.mjs:19,95` |
| User `ready` | after 10 confirmations on its own scan, before `t0 - 300 s` | `reverse-core.mjs:69` |
| Maker commit (no secret) | after `ready`, with its own XMR at 10 confirmations, before `t1 - 300 s` | `reverse-core.mjs:108` |
| Maker claim (reveals `a`) | within 3600 s of the commit, safe resend until `commit + 3600 - 300 s` | `reverse-core.mjs:20,104`, `lib.rs:259` |
| User refund, not ready | any time | `lib.rs:268` |
| User refund, ready | from `max(t1, commit + 3600 s)` | `lib.rs:268-269` |

Worst case: the user sent `ready`, the maker commits just before `t1` and then does nothing. Refund eligibility opens at `max(t1, commit+3600)`; the client waits an additional 300 seconds. SOL remains locked until a claim or refund executes. Eligibility is not execution: an offline user, or a refund transaction that is absent or fails, leaves the SOL locked past that point. If the maker never commits, refund eligibility opens at `t1`.

## 7. What a maker can and cannot do

Each line names the rule that enforces it. "Program" is `lib.rs`; "client" is the cited check.

SOL to XMR (the user locks SOL, the maker is `claimer`):

- **The maker cannot take the SOL before the user has sent `ready`.** `claim_commit_strict` and `claim_strict` both require `ready` (`lib.rs:213`, `strict_claim_open` `:262-264`), and `set_ready_strict` requires the refunder's signature and `now < t0` (`:198-206`,
  `SetReadyStrict` `has_one = refunder`). Tests: `program/tests/strict.rs` `strict_claim_never_works_without_ready_or_without_a_commit_at_any_time`, `strict_rogue_signers_and_rogue_destinations_are_refused`.
- **The "XMR is confirmed" half of that sentence is a client rule, not a program rule.** The program does not see Monero. The user's device sends `ready` only on its own scan (section 5.3). A client that skips the scan would let a maker take SOL for XMR that never arrived.
- The maker cannot claim without a commit, nor commit outside `ready` and `now < t1`, nor claim after `commit + 3600 s` (`lib.rs:213,262-264`; tests `strict_commit_only_by_the_claimer_once_ready_and_before_t1`, `strict_claim_window_is_exactly_c_to_c_plus_w_and_refund_waits_behind_it`).
- The maker cannot claim with a secret that does not open `A`, which the user checked against `proofA` (`lib.rs:225`, `opens`).
- The user can refund at any time while not ready, and from `max(t1, commit + 3600 s)` once ready (`lib.rs:268-269`, test `strict_refund_works_any_time_before_ready_including_after_t0`).
- The maker **can** stall (send no XMR: the user refunds), **refuse** (any error in section 4), **quote badly** (nothing in the client bounds the price, Gaps), and **hold the SOL** by committing late: refund eligibility then opens at `max(t1, commit+3600)`, and the SOL remains locked until a claim or refund executes.
- A maker that sends XMR with an extra unlock time, or less than quoted, gets no `ready` (section 5.3).

XMR to SOL (the maker locks SOL, the user is `claimer`):

- The maker **cannot spend the user's XMR on its own**: the shared address needs `a + b` and `a` is only revealed by the user's claim (`lib.rs:141`).
- The user locks no SOL in this direction, but **the user's XMR principal is at risk** once it is sent. It sits at an address whose spend key is `a + b`; the user holds `a`, the maker holds `b`, and only an on-chain claim (reveals `a`, the maker then takes the XMR) or an on-chain refund (reveals `b`, the user then takes the XMR) lets anyone spend it. **The user has no refund of their own**: `refund` needs the secret `b` that opens the escrow's refund point, and pays only to the escrow's `refunder`, the maker (`lib.rs:147`, `Refund` accounts at `:349-364`: the secret is the authorization, not a signature). Only the maker holds `b`. The maker **can** abort before `t0` while not ready and refund, revealing `b`; the user then recovers the XMR if the client sees the refund and sweeps (`refund_open`, `lib.rs:278-280`, test `refund_before_t0_when_not_ready_reveals_b`). Section 7.1 lists the cases in which that does not happen.
- Once the maker has set `ready` it **cannot** refund before `t1` (`lib.rs:278-280`, test `refund_after_ready_before_t1_is_refused`). The user can claim from `t0` even without `ready` (`lib.rs:273-275`, test `claim_after_t0_without_ready_succeeds`),
  so a maker that never sets `ready` does not stop the claim.
- The user **must** claim before `t1`. After `t1` only the maker's refund can open (`claim_open` is closed, `lib.rs:273`), and the user's XMR then depends on the maker publishing `b`. `refund_open` has no end date (`now >= t1`, `lib.rs:278-280`), so a late refund is still possible, and so is a refund that never comes.
- The maker **cannot** change the terms after the lock: the account is written once at `lock` and every field is compared by the client on an independent read.
- The maker **can** stall, refuse, and quote badly; it **can** refuse a registration after the quote (its own cap, drain file or low balance).

### 7.1 What a user can lose, by direction

This is a list of cases read from the code. It is not a guarantee that no other case exists, and it assumes the program binary on chain is the one in the repository (see the paragraph on the upgrade authority at the end of this section). Fees and time are lost in every case below; the cases that put principal at risk are marked **principal**.

XMR to SOL (the maker locks its SOL, then the user sends XMR):

- **F1, before any XMR is sent: nothing of the user's is at stake.** The client sends XMR only after it has checked the escrow on an independent RPC and the fee payer holds gas (section 5.2). A maker that never publishes the escrow, or a client that stops at `bad-terms`, `too-late-to-lock` or `fee-payer-not-funded`, leaves the user with nothing sent.
- **F2, after XMR is sent: the user cannot get it back alone. principal.** If the maker never sets `ready` and never refunds, the user can still claim the SOL from `t0` to `t1` (device rule `t1 - 300 s`), provided the client is online in that window, the fee payer is funded and an independent Solana RPC works. If the user misses the window, or the claim cannot land, the maker becomes eligible to refund the SOL from `t1` (nothing moves by itself at `t1`: the SOL stays in the escrow until the maker sends a refund; the program no longer accepts the user's claim from `t1`), and the XMR stays at the shared address until the maker refunds and so reveals `b`. A maker that is offline, has lost its swap state, or is malicious can leave it there for as long as it likes. The code gives the maker a reason to refund (it takes its SOL back) but no obligation, and the user has no instruction of their own to call.
- **F3, the maker aborts early (before `t0`, not ready). Time and fees, and principal while the refund is not seen.** The maker refunds and reveals `b`; the user recovers by sweeping with `a + b`. This depends on the client noticing the refund on chain and running the sweep; recovery retries on its own and shows the keys for a manual sweep, but a sweep can fail (for example an output that is not yet spendable) and the user pays two Monero fees (`atomic-driver.mjs:145-157`).
- **F4, the claim window is missed by a client that was offline or could not reach an RPC.** This is F2. The window is at least 1 hour long by the client's bounds and about 2 hours by default after the lock (section 6).
- **F5, the Monero side.** A payment that does not confirm, or that the maker's scan does not see at the quoted depth, can lead to a conditional refund attempt by the maker. Recovery of the XMR happens only after the maker's refund reveals `b` and the client sees it and sweeps, as in F3; a maker that does not refund leaves the XMR where it is (F2). The client counts a payment that may have gone out as sent and keeps recovery running (`alice-flow.mjs:49-50`).

SOL to XMR (the user locks SOL, the maker sends XMR):

- **R1, SOL locked before any XMR is seen, not ready: refundable.** The user's own client can refund at any time while `ready` is not set (`lib.rs:268`, section 7). The loss is Solana fees and time. This depends on the user's client (or key) being available to sign the refund.
- **R2, after `ready` the SOL is locked for a while.** If the maker never commits, the refund opens at `t1` (about 5 hours after registration); if it commits late and does nothing, at `max(t1, commit + 3600 s)`, at most about 6 hours after registration (section 6). No maker action is needed for the user to get the SOL back, but the user must send the refund; before then the SOL is not usable.
- **R3, `ready` sent on a wrong scan: principal.** The program does not see Monero. If the user's scan shows a payment that is not there (a remote node that lies, a bug, a client that skips the scan), `ready` lets the maker commit and claim the SOL and the user receives no XMR (section 7, section 5.3). The code does not require the user's own node (Gaps 11).
- **R4, after the maker's claim the XMR is collected by the user's client, not by the program.** The claim reveals `a`; the user takes the XMR with `a` and their own `b`, which lives in the swap record on the user's device. There is no deadline on that sweep, but a user who has lost the record and the backup that holds it cannot collect.
- **R5, the maker stalls (sends nothing, sends too little, sends late, commits and does not claim).** The user refunds as in R1 and R2. The maker's XMR, if any was sent, comes back to the maker through the revealed `b`.

Both directions depend on one thing outside the swap: **the program's upgrade authority** (end of section 7). A swap is only as safe as the binary that is live when each instruction is called.

Honest summary of the dependence on the maker: in XMR to SOL the user's way back to the XMR after the claim window runs through a refund that only the maker can send and that the maker is not forced to send. In SOL to XMR the user's way back to the SOL runs through a refund that the user sends, after the rules above.

What a user can do to a maker (the free option on price). Both directions let the user wait and look at the price before committing, and the maker bears the move:

- XMR to SOL: after the maker's lock, the user may simply not send XMR. The maker aborts only when no XMR is seen 1800 s after its lock (`LOCK_WAIT`, `swap-core.mjs:7,119`), and the quote itself lives 120 s, so the user's costless window is about 32 minutes. A user who has already sent XMR cannot walk away without the maker's abort.
- SOL to XMR: the wallet signs a lock only while `t0` is within 600 s of now + 3 h (`refunder-tx.mjs:67`), so the lock decision is about 10 minutes after registration (the core helper `reverseTimelocksAcceptable` allows 600 s + 1800 s, `reverse-core.mjs:30-35`, and the maker sends XMR only until `t0 - 2 h`, about an hour after registration, `reverse-core.mjs:95`). After the maker has sent XMR the user can still choose `ready` or a refund until `t0 - 300 s`, about 2 hours 55 minutes after registration (refund is open at any time while not ready, `lib.rs:268`). That later choice costs the user only Solana fees and costs the maker two Monero transactions plus the price move.
- Over those spans the price moves by about as much as the spread, and users commit only when it moved their way. For a small maker this shows up as refunds and aborted swaps. A maker can shorten the window (for XMR to SOL its abort time is code constant `LOCK_WAIT`; a shorter lock wait is a maker setting that does not exist yet).
- Disagreement with the review's numbers: it puts about 32 minutes on SOL to XMR and over an hour on XMR to SOL. In the code the roles are the other way round: 1800 s + 120 s belongs to XMR to SOL, and SOL to XMR has a 10 minute lock window followed by the long ready-or-refund choice above.

Both directions: **the program's upgrade authority can change all of the above.** The escrow accounts are owned by the program, so a new program binary can move their lamports, accept a claim without the secret, or refuse every call.
Nothing in the repository shows a time delay, a multisig or a frozen program: `docs/research/xmr-sol-atomic-swap/DESIGN.md:186` says the authority "must be a multisig and then frozen" as a requirement (`docs/research/` is not published here), and the operator's runbook (not published) says the authority was handed to an owner wallet.
Who holds the authority is read from the chain (`solana program show <program id>`, the `ProgramData` account), not from this file. The program is not frozen on the evidence in the repository, and any open escrow follows whichever binary is live when it is acted on.

## 8. Conformance suite

`node prototypes/xmr-sol-atomic-swap/conformance/run.mjs --maker-url <url>`. The token comes from the environment variable named by `--token-env` (default `MAKER_API_TOKEN`) and is never printed; a token is refused over plain http to a non-local host.
Output is a pass, fail, warn, skip table with check ids and short details, plus the maker's own public address from its health answer. It sends no Solana or Monero transaction at any point.

Default checks (health and quote requests only; no request is sent to a registration route, `POST /v1/swap` or `POST /v1/rev/swap`, unless the registration opt-in is given and the network guard has passed, because a faulty or hostile maker may record a swap from any request to those routes, even a malformed one; a quote request records no swap but a maker may reserve capacity for it, so the default run is low risk, not zero effect):
health shape and cap order; unknown route; unknown swap id; token handling; for each direction the quote shape, units, `xmrAtomic` equals the request, caps, TTL, `lamports` consistency with `solPerXmr` and spread,
unique ids, unknown request field tolerated, wrong types, zero, negative and over-cap amounts refused, malformed JSON refused, a 64 KiB body refused; SOL to XMR key share proof verified with `verifyShare`.
SOL to XMR quotes must return a fresh maker share and swap id each time (`reverse.quote.fresh-share`). Optional `tiers` fields must be strictly better than the standard rate when present; the suite never sends `tierOk`.
`--reference-price` adds a price bound against a price you got elsewhere. `--wait-ttl` adds an expired quote check (about 2 minutes).

Opt in, **stagenet and devnet makers only** (this also enables the registration-route probes that are never sent by default: an unknown quote id refused, and with `--wait-ttl` an expired quote refused): `--allow-registration stagenet|devnet --solana-rpc <url>` makes the maker record a swap. In XMR to SOL that means the maker locks real SOL on its Solana network and pays gas to a throwaway address; the swap then ends as an
aborted swap on the maker's usual schedule. The suite checks the registration with the client core (`acceptMakerLock`, `acceptMakerRegistration`) and that the same quote id is refused the second time, that two registrations return different maker shares, swap ids and joint addresses (`forward.register.fresh-secrets`), and that the public status of a registered swap never shows a ready and a refund together (`*.register.one-action`). Never point it at a mainnet maker. The Monero network used to check the joint address is taken from the verified pair (mainnet only when both the Solana RPC and the maker's status say mainnet and the second flag is given, otherwise stagenet); a maker that reports `testnet` is refused because no matching Monero network is verified.

The flag is only a declaration, so the suite checks the network itself, before any request that makes a maker record a swap, and fails closed (`network.guard`): (1) the Solana RPC named by `--solana-rpc` must answer `getGenesisHash` with the devnet or testnet genesis hash; (2) the maker's own operator status (`GET /v1/status`, which needs the token) must report `stagenet` or `devnet` (or `mainnet` with the second flag; `testnet` is refused); (3) the maker's address must hold SOL on that RPC. A mainnet RPC or a maker that reports mainnet is refused unless the second flag `--allow-mainnet-registration` is also given, a mismatch between the two is refused even then, and a missing RPC, an unknown genesis hash, an unreadable or garbled answer, or a maker status without a network is refused. The maker's network is self-reported, and a funded address on a devnet RPC does not bind the maker's real Solana connection, so these checks are corroboration, not proof: point the suite only at a maker you know to be a test maker. Against an untrusted implementation, no claim about side effects is made: the suite cannot show that a maker records or locks nothing, only that it sent nothing to a registration route before the guard passed. When the guard refuses, every registration route probe is skipped and nothing is sent to those routes. The suite's tests assert this (no `POST /v1/swap` or `POST /v1/rev/swap` reaches the maker on a default run or after a refused guard, and the maker's status is read before any registration request after a pass).

**What a pass means.** Passing the suite shows that a maker answers quote, register, status and health requests in the specified shape and refuses the malformed requests the suite sends. It does **not** establish that the escrow it creates is correct on chain, that the maker completes, aborts or recovers swaps correctly, that it keeps its secrets, that it is online when a user needs it, or that it is honest. It does not test a malicious maker beyond what a registration answer shows. Do not read a pass as a safety rating or as a reason to list a maker.

Not covered: that the escrow on chain matches the registration (needs a Solana RPC; the client does this, section 5.2 step 6), anything after registration (the maker's `ready`, refund, commit and claim behaviour; only a snapshot of the public status is checked, not that the maker never has a refund and a ready outstanding together over time), price against a live market, load and rate limits.
The suite has been run only against an in-process fake built from the real request and response shapes (`conformance/conformance.test.mjs`); it has not been run against the real `maker.mjs` process, which needs a Monero wallet service and funded keys.

## 9. Gaps (the code does not do what a maker spec would want)

1. **No price or spread bound in any client.** The panels display `solPerXmr` and `spreadBps`; no code compares `lamports` with a price from elsewhere or with the requested amount (section 5.1). A maker can quote a bad rate and the client accepts it. Spread is an unvalidated `Number(E.SPREAD_BPS ?? 200)` in the maker (`maker.mjs:33`).
2. **XMR to SOL takes the program id from Silo's server** (section 5.5). A standalone client has to pin it.
3. **The SOL to XMR user side exists only in the wallet copy** (`lib/silo/atomic-swap/bob-flow.mjs`, `refunder-tx.mjs`), not in `P/client/`, and the sync test lists only six modules. The conformance suite imports `bob-flow.mjs` from there.
4. **The maker cannot be public as written**: loopback bind, mandatory token on mainnet (section 3).
5. **GET endpoints need no token and `/v1/swap/<id>` leaks a state path in its error text.**
6. **`ready` and the "XMR is confirmed" rule are client rules** (section 7). The program cannot check Monero.
7. **No `quote.expiresAt` bound, no `gasLamports` check, no `confirmations` check** on the client; the two before the last are harmless (the client waits or the swap retires), the last only costs the maker.
8. **The user's late-claim loss in XMR to SOL** depends on the maker publishing `b`; the program has no path for the user alone after `t1`, and the XMR principal can stay unrecoverable if the maker never refunds (section 7.1, F2).
9. **The upgrade authority is an owner wallet**, not a multisig and not frozen, on the repository's evidence.
10. **No client binds the listed maker key** (section 5.2, step 7). Needed before any outside maker is listed.
11. **The user's own Monero node is not required before `ready`** (section 5.3); the scan source is whatever the wallet bridge gives.
12. **Timelock acceptance and quote expiry use the local clock** (section 5.6); the claim uses the later of the two clocks, and the refund that reveals `b` uses a finalized slot's block time.

## 10. Before an outside maker is listed

An internal review of the open maker design (not published) sets six conditions. They are referenced here, not restated: (1) upgrade authority with a delay longer than the longest swap and a refusal to start swaps while an upgrade is queued; (2) an outside rebuild matched to the on-chain program hash; (3) capacity counted only at a real commitment; (4) a decision by the operator on the abandoned-swap horizon, with the remaining exposure stated in plain words; (5) the client binds the listed maker key and uses chain time (Gaps 10 and 12); (6) the standalone client sets `ready` only on the user's own node and refuses a single RPC for a claim (Gaps 11). None is met today.

## 11. What this document is not

It is not a claim that the maker is open, that the swap is private from the maker, or that any of it has been independently reviewed. It describes the interface and the checks as they are in the code today. It gives no guarantee against loss: section 7.1 lists the cases found, and a swap with any maker still depends on the maker, the clients, the chains, and the program's upgrade authority.
