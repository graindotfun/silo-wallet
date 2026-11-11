# Open maker endpoint: the public lane

Status: published code, off by default, and no public endpoint is announced. Whether the running maker has the lane switched on is not shown by this repository. Nothing here says a public endpoint exists. Today the maker listens on loopback only and every POST needs a bearer token that only Silo's Worker holds.

## What it is

The maker (`prototypes/xmr-sol-atomic-swap/maker/maker.mjs`) now has two lanes on the same routes:

- **Token lane.** The Silo wallet through the Worker, with `MAKER_API_TOKEN`. Same behaviour as before.
- **Public lane.** The same four POST routes without a token, plus the swap status lookup. Off unless `MAKER_PUBLIC_LANE=true`.

Same routes, not a separate path prefix, so the standalone client and the conformance suite need no change: they call `/v1/quote`, `/v1/swap`, `/v1/rev/quote`, `/v1/rev/swap` on a base URL and send no token. The lane is decided by the request alone:

| Request | Lane |
|---|---|
| valid bearer token | token |
| no `Authorization` header, public lane on, one of the public routes | public |
| any `Authorization` header that is not the token | 401, never the public lane |
| `/v1/status` without the token | 401 |
| anything else without the token, public lane on | 404 |
| public lane off, no token | 401 on everything except `/v1/health`, as before |

Public routes: `POST /v1/quote`, `POST /v1/swap`, `POST /v1/rev/quote`, `POST /v1/rev/swap`, `GET /v1/swap/<64 hex>`, `GET /v1/health`. Operator status (`/v1/status`) stays token only. Every swap record gets `lane: "public"` or `lane: "token"` (no user data; older records without the field count as token).

## How the capacity is split

`MAX_OPEN_SWAPS`, `MAX_XMR_PER_DAY` and `MAX_XMR_PER_SWAP` stay the maker's totals, and the mainnet start gate still checks them. With the public lane on, the public lane takes a bounded part of the totals and the token lane keeps the rest:

- open slots: public `MAKER_PUBLIC_MAX_OPEN`, token `MAX_OPEN_SWAPS` minus that;
- daily amount: public `MAKER_PUBLIC_MAX_XMR_PER_DAY`, token `MAX_XMR_PER_DAY` minus that;
- unpaid requests (the F-12 counters): public has its own, token keeps the existing ones, each lane counts only its own records;
- quote store: the public lane holds at most `MAKER_PUBLIC_MAX_QUOTES` quotes at once, counted over both directions together. The check and the reservation of a slot are one synchronous step before any await of a quote request, so parallel requests do not all pass the check and then insert past the ceiling; a failed or abandoned request gives its slot back. The token lane has no quote ceiling (it is the Silo Worker, with its bearer token).
- float: one XMR-equivalent number, `MAKER_PUBLIC_MAX_FLOAT_XMR`, bounds the sum of open public swaps in both directions. The token lane may not use the part of it that is not in use (it is held back from the Monero treasury check and, converted at the quote's price, from the Solana balance check). Within those counters, a full public lane does not use a slot, a daily amount or float that the accounting gives to the token lane, and the other way round.

### What is partitioned and what is shared

Partitioned by lane (counted separately, in the maker's own accounting): open swap slots, the daily amount, the unpaid counters, the principal float held back from the token lane, the quote store ceiling, the public rate buckets and the public wallet queue.

Shared by both lanes (no partition, so heavy public load can slow or disturb the token lane): the one maker process and its event loop, the Monero wallet RPC and the Monero daemon, the Solana RPC endpoints, the price feeds (CoinGecko and Kraken), the journal and the swap record directory on one disk, the admission queue (public and token admissions run one at a time through the same queue), and the Solana fee payer, which is the maker key that also pays the lock and gas and so pays for public registrations too. A full SOL balance or a stuck RPC hurts both lanes.

### Wallet access and recovery

The Monero wallet RPC opens one wallet at a time, so there is one executor for every wallet job. Two queues feed it. Recovery work (the watch loop, sweeps, refunds and the token lane) is served ahead of public jobs and is not bounded. Public lane reads (the treasury balance check in the SOL to XMR quote and registration) go into their own queue with a depth bound (`MAKER_PUBLIC_WALLET_QUEUE_DEPTH`, default 4), a deadline per job (`MAKER_PUBLIC_WALLET_DEADLINE_MS`, default 10000) and cancellation when the client disconnects. A public job that has not started is removed on its deadline or when its client goes away, and never touches the wallet. A recovery job that arrives is served before every waiting public job.

What a started public job costs a recovery job, whole job, not one call. A public wallet job is a sequence of wallet RPC calls, one after the other: (1) `close_wallet`, (2) `open_wallet` (the create fallback for the treasury wallet throws without an RPC call), (3) `refresh`, (4) the job's own call, `get_balance`, (5) `close_wallet`. Each call has the wallet client's timeout of 120 seconds. When the client disconnects or the deadline passes, the caller is released at once and the job is told to stop at the next safe stage boundary: before `open_wallet`, before `refresh` and before `get_balance` it is skipped. A call that is under way is never interrupted, and a final `close_wallet` is ATTEMPTED on every exit path (cleanup, never skipped): the cleanup `try/finally` starts before the initial close, so a failed initial close followed by a cancellation, a failed `open_wallet` followed by a throwing create fallback (the public treasury wallet's fallback throws at once) and an error in any later stage all still attempt it. An attempt is all that is promised: a close that itself fails or times out does not prove the wallet is closed, and a failed call does not prove the wallet never opened. Worst cases for a recovery job that arrives behind a started public job:

- job cancelled (abort or deadline): the call under way finishes (at most 120 s) and the cleanup close runs (at most 120 s), so at most 240 s plus the deadline (the job can only make progress until the deadline passes, so one hanging call that starts just before it is the worst case), about 250 s with the default 10 s deadline;
- job never cancelled and every call slow but within its timeout: at most 5 calls, 600 s. This needs the caller to stay connected past the deadline, which the deadline rules out, so it is the bound of the sequence and not a case the queue produces.

The delay is bounded, not removed: a flood of public requests, or a wallet RPC that stops answering, can still hold a recovery job for those seconds. Tests with deferred RPCs cover abort before refresh, abort before the balance call, abort during the balance call, the deadline, and that recovery stays ahead of cancelled and waiting public jobs.

The admission queue is shared, with the same shape of limits. Public registrations enter the one admission FIFO that the token lane also uses (`MAKER_PUBLIC_ADMISSION_QUEUE_DEPTH`, default 4, `MAKER_PUBLIC_ADMISSION_DEADLINE_MS`, default 10000). A public admission that waits is refused at once when the depth is full, and is removed on its deadline or when the client goes away, before it starts; a removed one never runs. Token admissions are not bounded or cancelled. Once an admission has started it runs its preparation (quote taken, limit check, proofs, balance, keys, chain time, daemon height, blockhash, simulation and signing, each with its own RPC timeout); the client's disconnect is checked before the quote is taken and as the last step before the swap file is written, never after that file exists and never inside a call. So a token admission can still wait behind the running public admission and up to the depth bound of waiting public ones. That is a residual shared-resource cost, listed above as shared.

Consequence to decide before mainnet: turning the lane on lowers the token lane's share unless the operator raises the totals. With the defaults (total 3 open, 0.3 XMR a day) the token lane keeps 2 open and 0.27 XMR a day. Choosing the values is the operator's call. A quote belongs to the lane it was issued in; using it from the other lane gets `quote-expired`.

With the lane off there is one pool and the code path is the old one; a test compares the new admission with the old one over many record sets.

## Configuration

All values are checked at start. A bad value stops the process with a short message (no partial start). Values are plain decimals or whole numbers: negative, `NaN`, empty, exponent notation and zero are refused.

| Variable | Default | Rule |
|---|---|---|
| `MAKER_PUBLIC_LANE` | off | `true` or `false` only |
| `MAKER_PUBLIC_MAX_OPEN` | 1 | 1 to total open minus 1 |
| `MAKER_PUBLIC_MAX_XMR_PER_SWAP` | 0.01 (or the total if lower) | at most `MAX_XMR_PER_SWAP`, at least `MIN_XMR_PER_SWAP` |
| `MAKER_PUBLIC_MAX_XMR_PER_DAY` | 0.03 (or half the total if lower) | below `MAX_XMR_PER_DAY`, at least the per swap value |
| `MAKER_PUBLIC_MAX_FLOAT_XMR` | per swap value times open slots | at least the per swap value |
| `MAKER_PUBLIC_MAX_UNPAID_OPEN` / `_PER_ADDRESS` / `_PER_DAY` | open slots / 1 / 24 | bounds the gas the maker can lose on requests that never pay |
| `MAKER_PUBLIC_RATE_QUOTE_PER_MIN`, `_BURST` | 30, 10 | one global bucket for both quote routes |
| `MAKER_PUBLIC_RATE_SWAP_PER_MIN`, `_BURST` | 10, 5 | one bucket for both registration routes |
| `MAKER_PUBLIC_RATE_STATUS_PER_MIN`, `_BURST` | 120, 30 | one bucket for the status lookup |
| `MAKER_PUBLIC_MAX_BODY` | 4096 | characters, 256 to 8192 (the token lane keeps 8192) |
| `MAKER_PUBLIC_MAX_CONCURRENT` | 8 | public requests in flight, the rest get 503 |
| `MAKER_PUBLIC_MAX_QUOTES` | 32 | public quotes outstanding at once |
| `MAKER_PUBLIC_WALLET_QUEUE_DEPTH`, `_WALLET_DEADLINE_MS` | 4, 10000 | public wallet jobs waiting, 1 to 64; deadline 500 to 60000 ms |
| `MAKER_PUBLIC_ADMISSION_QUEUE_DEPTH`, `_ADMISSION_DEADLINE_MS` | 4, 10000 | public registrations waiting in the shared admission queue, 1 to 64; deadline 500 to 60000 ms |
| `MAKER_PUBLIC_SOURCE_HEADER`, `MAKER_PUBLIC_RATE_PER_SOURCE_PER_MIN` | off | per source limit, only when both are set |
| `MAKER_PUBLIC_CORS_ORIGIN` | off | `*` or one origin; never allows the Authorization header |
| `MAKER_BUILD_HASH` | unset | `sha256:<64 hex>`; shown on `/v1/health` as the operator's own statement |

Defaults are conservative starting points, not live values. The live values are the operator's to choose and are not stated here.

Rate limits do not depend on who the caller is: they are global buckets per route. A per source limit exists only if an operator names a trusted proxy header and a rate; the maker then takes the last entry of that header, hashes it with a per process salt and keeps it in memory only. Per source limits hurt Tor users, who share a few exit addresses, and they do little against an attacker with many addresses. They are off by default for that reason.

## What the public lane shows

- `GET /v1/swap/<id>` on the public lane returns only: swap id, direction, the lock, ready, refund and claim signatures (public on chain anyway) and `state`, one of `open`, `finished`, `refunded`, `closed`. It leaves out the joint Monero address and the Monero transaction id, and it does not show the maker's internal result value. That value can record an off-chain Monero classification (for example whether the maker had sent XMR), so the response is derived only from Solana observations that the maker records independently of any Monero work. When the escrow's claim or refund is seen in its history and proven final at finalized commitment (the same proof a terminal result needs), the maker records it once (`pubSol`: kind and signature) before it does any sweep or recovery for that swap. `finished` and `refunded` follow that record, and the claim signature is that observed signature (before, it was copied only after the Monero sweep succeeded). The maker's internal result value is not read for a swap that has the record, because it is set only after Monero recovery or sweep work and would show that progress. So two swaps with identical Solana histories give the same public response whether their Monero recovery or sweep has completed, is pending or failed (regression tests in `maker-core.test.mjs` and `maker-reverse.test.mjs` compare the full response at every pass). `closed` means the escrow was never locked (proven absent at finalized), or a value outside the table; no result yet shows `open`. A swap that finished before this record existed keeps the old closed table (`completed` shows `finished`; `refunded`, `refunded-before-send`, `xmr-recovered` and `xmr-never-relayed` show `refunded`; `not-locked` shows `closed`; an unknown value shows `closed` and is never echoed). What each state reveals: `finished` and `refunded` say whether the escrow was claimed or refunded, which the claim and refund signatures already show on Solana. What is NOT claimed: that the lookup reveals nothing at all about Monero. The timing of the maker's own Solana transactions (the ready signature, the refund signature) follows what the maker saw, including a Monero deposit, and those transactions are public on Solana anyway; the lookup adds no Monero identifier, amount, address or recovery state to that.
- What the lookup does and does not do. It omits addresses and transaction ids. The swap id is a bearer lookup key: whoever holds the id can read this view, and a client that needs the Monero side reads its own Monero wallet. The route is there because a standalone client needs the status of its own swap, and the id is a random 32 byte value the user holds. It only shows swaps from the public lane; a token lane swap gets 404. The lock, ready, refund and claim signatures link the id to Solana transactions, which are public anyway.
- The same lookup on the token lane is unchanged, except that an unknown id now answers 404 `not-found` instead of an error that contained the state directory path.
- A refund attempt is an attempt, not a settlement. The maker records and sends refund transactions and keeps retrying while a swap is open, but a send can fail, be dropped or land late, and a swap counts as finished only when the result is proven at finalized commitment. Nobody should read "the maker refunds" in this document as a guarantee that a refund has settled.
- Public error answers are short codes. Anything else becomes `request-failed` or `bad-request`.
- `/v1/health` adds `publicLane` (enabled, the public caps, what the token lane keeps) only when the lane is on, and `buildHash` only when set. With the lane off, health has exactly the old keys.
- Quotes carry `t0Delta` and `t1Delta`: the refund times, in seconds after the lock, that the maker will register. They apply to both lanes.

## Listening and the reverse proxy (documentation only)

The maker still binds `127.0.0.1` and does not terminate TLS. To make it reachable, an operator puts a TLS reverse proxy in front. Nothing here changes any host.

The proxy must forward only these paths and drop everything else:

- `POST` to exactly `/v1/quote`, `/v1/swap`, `/v1/rev/quote`, `/v1/rev/swap`
- `GET /v1/swap/<64 lowercase hex>` and `GET /v1/health`
- `OPTIONS` on the same paths if CORS is on

It must not forward `/v1/status`, and it must remove the `Authorization` header on the way in, so that nothing that arrives through the proxy can ever carry the token. The token lane stays on the loopback address for the Worker's own path. Do not log request bodies or client addresses at the proxy beyond what abuse handling needs.

Untested example, nginx style:

```
client_max_body_size 4k;
location = /v1/health { proxy_pass http://127.0.0.1:38400; proxy_set_header Authorization ""; }
location ~ ^/v1/swap/[0-9a-f]{64}$ { limit_except GET OPTIONS { deny all; } proxy_pass http://127.0.0.1:38400; proxy_set_header Authorization ""; }
location ~ ^/v1/(quote|swap|rev/quote|rev/swap)$ { limit_except POST OPTIONS { deny all; } proxy_pass http://127.0.0.1:38400; proxy_set_header Authorization ""; }
location / { return 404; }
```

## What a hostile client can still do

- Fill the public lane for free. A registration costs the caller nothing in SOL to XMR, and in XMR to SOL it makes the maker lock its own SOL for about 32 minutes (30 minutes waiting for XMR plus the quote time) before the maker refunds. So a client can keep the public lane's open slots, daily amount and float busy. That stops public lane swaps. It is not meant to stop token lane swaps, and the public lane's caps are meant to bound how much the maker holds for public swaps. Both rest on the shared parts listed above (one process, one wallet RPC, one fee payer), so a flood can still slow the token lane even when its slots are untouched.
- Cost the maker gas. In XMR to SOL the maker sends 0.001 SOL to the caller's fee payer address per registration. The public unpaid counters limit this to 24 a day by default.
- Drain the public rate buckets so honest public callers get 429. Global buckets do not tell callers apart.
- Hold a public swap open by locking and doing nothing (SOL to XMR). This is the existing "hostage" case: the maker's XMR sits at the joint address until the user acts, and a lost user record means that XMR is permanently out of reach. The program has no horizon for it today. The public float cap bounds it; it does not remove it. Operators should be told this in plain words.
- Learn nothing about other users from the status lookup beyond what is public on Solana, but the maker still sees each caller's IP (or the proxy's), amount, Solana address and view key at registration. That has not changed.

## What stays true

- One maker, run by us. A second maker run by someone else is a plan and an experiment, not something this change provides.
- The escrow program is upgradeable by an owner wallet.
- Nothing proves the running maker equals the public code. `MAKER_BUILD_HASH` is the operator's own statement.
- Quotes and price come from our price sources; the client checks them (see `docs/OPEN_MAKER_PROTOCOL.md`).
- The conformance suite runs against the public lane the same way as against any maker, without a token.

## Tests

`prototypes/xmr-sol-atomic-swap/maker/maker-lanes.test.mjs` (`node --test`): configuration refusals, lane off equals the old admission, the lane partition for slots, daily amount, unpaid counters and float, the quote ceiling under parallel requests, rate limits, quote pruning, no path in errors, reduced status view, CORS, concurrency, readySeenAt, and a real maker process for the HTTP behaviour.
