# Silo wallet core

status: the escrow program live on solana runs protocol v2 since 2026-11-10: sha256
`6ac58cdc80b585290d8fa32e67a8c1cbdbac1081b0fc7b2a487e1cefc68c921e` (265,488 bytes, canonical solana-verify hash
`bef3a3e89d71a171c65d1f38b8d8c88dc4e5c5840e881733195defbab962f812`), the docker build of `program/` in the same pinned image
as v1. upgraded in transaction `3X996yrTdNsXpUYgbSUozwHCzND4Xefxh5zhuZjueTQ5DzoNBaovqERkQ9jviqwz8aPsQnAxYvm1aMGHU7iYKpER`,
finalized slot 467605377. the v1 bytes it replaced (`4033eb70a5d4d6f7d47654d278a54633bafd5366303b7882a17032d4cbbc3515`, live
from 2026-11-08) are kept in `docs/verify-build/bins/new_verified.so` and in a rollback buffer for an observation period.
how to rebuild and compare, and what v2 changed: `docs/VERIFY_BUILD_V2.md`.
both swap directions are open to users in a beta: xmr to sol (v1 instructions, kept unchanged in v2) and sol to xmr (the
instructions v2 added). there is no bridge: each swap is an on-chain escrow on solana plus a monero address whose spend key
needs both parties' key shares. the beta caps are 0.05 xmr per swap and 0.3 xmr per day. both directions are served by one
swap maker, run by the Silo team. other parties cannot act as maker in Silo yet, and there is no admission process for them. the program is upgradeable by one owner key (`8pFUuZgzab6mwXq2UqdEc2mbkDk6Wg68KSppJ4brfF4W`), so the
bytes on chain can be replaced; check the last deploy slot and the hash each time you rely on them.
the maker code at the live app commit is in `web/prototypes/xmr-sol-atomic-swap/maker/` (both directions). that the running
maker process equals that code is not proven. the maker is a separate service and nothing here lets you check its running
bytes.
the wallet web app is published too: `web/` holds the browser code of https://silo.trading/app at commit `b9463c7f`, the commit the live site runs. a clean rebuild of that commit gave the same sha256 for all 145 files the page loads, and the monero engine rebuilds from `web/` alone to the served bytes. you cannot rebuild the rest of the app from this repository alone yet. what you can and cannot check: `docs/VERIFY_APP.md`.

swap caps and maker quotas are maker policy, not program code, so do not rely on them (see `docs/WHAT_THE_MAKER_CAN_DO.md`).

what a user can lose: in xmr to sol you send xmr to a shared monero address after the maker locks its sol, and you have no refund of your own. if you miss the claim window, or the maker stops, getting your xmr back depends on the maker refunding, which nothing in the program forces; the xmr can stay unrecoverable. in sol to xmr the sol is refundable by you before the swap is ready, and after the maker's claim you collect the xmr with the swap record saved on your device. both directions depend on the program's upgrade authority. the cases are listed in `docs/WHAT_THE_MAKER_CAN_DO.md` ("What you can lose, by direction"). start small.

Repository: https://github.com/graindotfun/silo-wallet

Source for the parts of Silo that hold your keys and move your money, and in `web/` the source of the whole wallet web
app. Silo is a self-custody wallet: wallet seeds and spend keys are made and kept on your device, and the wallet code in
this repository does not send them to a server.

## What an XMR to SOL swap shares with the swap maker

This is by design, and you should know exactly what it is.

For a no-bridge XMR to SOL swap, Silo creates a one-time Monero address for that swap only. Its private view key is a
fresh random key made for that swap (`lib/silo/atomic-swap/alice-flow.mjs`, `swapRequest`). It is not your wallet's view
key and has no mathematical link to your wallet, your subaddresses or your other transactions. It is shared with the swap
maker so the maker can watch the lock on that single-use address and later collect the Monero after your SOL claim.

What the maker learns: that swap's lock transaction (its id, amount, timing, confirmations and public shape), and the
amount of any other output ever sent to that one-time address. What the maker does not learn from the key: your wallet,
your other addresses, your other transactions, or your key images. A view key alone does not let the maker spend.
Your wallet's own seed and keys do not leave your device.

Registration does not expose the swap's spend-key share `a`. The SOL claim exposes it on purpose inside a Solana
transaction, which lets the maker sweep the XMR at the shared address. It is not the user's ordinary wallet spend key.
The client broadcasts the claim transaction itself and also posts a copy to Silo's server (`atomic-driver.mjs`), so
Silo's server also sees `a` at that point.

What the maker keeps after a swap is the maker's own business and is outside this repository. This repository does not
claim that the maker deletes the swap keys.

Planned improvement: a future protocol version could split the view key so that the maker cannot watch the address on its
own. There is no date for it.

The SOL to XMR direction (in the code, in the v2 program and open to users in the beta) shares the same kind of key: Silo
makes a fresh one-time view key for the swap and shares it with the maker, so both sides can watch the one-time address
(`web/lib/silo/atomic-swap/bob-flow.mjs`, `reverseRegisterRequest`). There your wallet's Solana key signs the lock, the
ready confirmation and any refund (`web/lib/silo/atomic-swap/refunder-tx.mjs`), so your Solana address is linked on chain to
that swap. The maker's SOL claim reveals the maker's key share, which lets Silo sweep the XMR into your wallet.

The top-level `lib/`, `components/` and `tests/` are a small cut of the wallet core that you can read, build and test on
its own. `web/` is the whole browser app at the commit the live site runs. Neither is the whole product: the server side is
not here (see "What is not here").

## What is here

| Path | What it is |
|---|---|
| `lib/silo/native-keyring.mjs`, `native-keyring-store.mjs` | On-device key creation, encryption and the signing guard for Solana and EVM keys |
| `lib/silo/local-envelope.mjs`, `legacy-envelopes.mjs` | The encrypted envelope format (passphrase-based) and its reader for older envelopes |
| `lib/silo/device-unlock.mjs`, `one-unlock.mjs` | Unlocking with the device (passkey) and the single-passphrase flow |
| `lib/silo/unified-backup.mjs` | One backup file for the whole wallet, and restore |
| `lib/silo/xmr-adapter.mjs` and the `xmr-*` helpers | The Monero side of the wallet: address review, fee bounds, confirmations |
| `lib/silo/evm-wallet.ts`, `evm.mjs` | The EVM side of the wallet |
| `lib/silo/atomic-swap/`, `atomic-driver.mjs`, `atomic-pending.mjs` | The client for the XMR to SOL atomic swap (this cut has the XMR to SOL direction only; `web/` has both directions) |
| `lib/silo/release-gate.mjs` | The release gate: real funds stay locked unless release evidence matches the exact build |
| `program/` | The Solana escrow program used by the atomic swap (protocol v2, the live bytes since 2026-11-10), with its tests |
| `components/` | The screens for unlock, backup and the atomic swap |
| `tests/` | Tests that run on their own, with no network |
| `web/` | The wallet web app at commit `b9463c7f`, the one https://silo.trading/app serves: screens, styles, browser code and 89 test files, the Monero and Zcash engine build scripts, and the swap maker code at the same commit (both swap directions). Files are unchanged from that commit except two comments (see `docs/VERIFY_APP.md`) |
| `scripts/verify-app.mjs`, `docs/verify-app/` | Fetches the files the live site serves and compares their sha256 with the recorded build of that commit |

## What this code can still do

This tree is not signing-disabled as a whole. Only the reviewed-ticket Solana send and swap signing in `native-keyring.mjs`
and the test-network signing are held off. Still present:

- `lib/silo/atomic-swap/sol.mjs` (`send`) signs and broadcasts Solana escrow transactions with signers it is given,
  which is how the swap client locks, claims and refunds.
- Atomic swap claims and refunds, and transfers through an external wallet, remain.
- `lib/silo/xmr-adapter.mjs` creates and relays Monero payments and sweeps, and its `backup` returns the wallet seed
  to the calling code so it can be encrypted into the backup file. Recovery material is exposed to the caller, by design.
- `revealSecretKey` in `native-keyring.mjs` returns a Solana secret key after the passphrase is entered (export, so nobody
  is locked in).

`web/` is the live code, so there nothing is held off beyond what production holds off: `signReviewedTransfer` and
`signReviewedManaged` in `web/lib/silo/native-keyring.mjs` sign after the client consumes a release ticket
(`solana-transfer-client-flow.mjs`, `jupiter-managed-client-flow.mjs`), and the EVM and Bitcoin send paths are present.
Test-network signing stays out of production builds: `web/vite.config.ts` replaces `native-keyring-testnet.mjs` with
`native-keyring-testnet.held.mjs`.

## What is not here

The hosted service (accounts, sync, conversion providers, operations) is not part of this repository. That includes the
server side of the Worker that serves https://silo.trading (its API routes and server modules), its configuration and its
secrets, and the deploy scripts. The wallet client talks to Silo's hosted session and RPC endpoints for chain reads; the
code behind those endpoints is not published here.
The swap maker code as it is at the live app commit is in `web/prototypes/xmr-sol-atomic-swap/maker/`, for both swap
directions. The maker runs as a separate service and is deployed on its own; this repository does not claim the running
process is identical to that code, and that is not proven. The SOL to XMR direction is switched on by a maker setting and a
server setting that are not in this repository. The caps (0.05 XMR per swap, 0.3 XMR per day) are policy of the maker and the
hosted service, not program code. There is one maker, run by the Silo team, and a maker admission process for other parties
does not exist yet.
In the top-level cut, Solana send and swap signing needs a release-ticket flow that is not in the cut, so there
`signReviewedTransfer` and `signReviewedManaged` refuse to sign. Test-network signing is held off, the same as in the
production build.

## Status and honest limits

Silo is in an open beta with small caps (0.05 XMR per swap, 0.3 XMR per day). The hosted service and the maker enforce the caps; the code in this repository does not enforce a
holding cap by itself. It has not had an independent external
security audit. Read the code, run the tests, and report problems (see `SECURITY.md`). Do not treat this repository as a
statement that the software is safe.

## More documents

- `docs/VERIFY_APP.md`: compare the wallet web app the site serves with `web/`, the build recipe, and what you cannot check yet.
- `docs/VERIFY_IN_10_MINUTES.md`: a few commands to check the live program, rebuild it, and check this repository.
- `docs/PROTOCOL.md`: the XMR to SOL swap protocol (beta version).
- `docs/WHAT_THE_MAKER_CAN_DO.md`: what the swap maker can and cannot do.
- `docs/VERIFY_BUILD_V2.md`: rebuilding the live v2 program and comparing it with the chain, what v2 changed, the upgrade of 2026-11-10 and its rollback buffer.
- `docs/verify-build-v2/`: the recorded values of the v2 build and the chain read after the upgrade.
- `docs/VERIFY_BUILD.md`: the v1 program build and how it was made verifiable (history).
- `docs/verify-build/`: the build evidence (hashes of each environment, both binaries, the differing regions, the differential test).
- `docs/UPGRADE_TO_VERIFIED_BUILD.md`: the procedure for upgrading the live program to the Docker build, and how it was executed on 2026-11-08.
- `docs/MAKER_ADMISSION_GATE_SPEC.md`: the maker change that procedure depends on (design).
- `docs/OWNER_SUMMARY_UPGRADE.md`: a plain summary of that upgrade.
- `docs/REVIEW_HISTORY.md`: what internal review found in those documents and what is still open.

## Run the tests

Needs Node 22.22.3 or newer (or 24.12.0 or newer).

```bash
npm ci
npm test
npm run typecheck
```

## Verify the escrow program

See `docs/VERIFY_BUILD_V2.md`. In short: since 2026-11-10 the live program is the Docker build of `program/` (protocol v2),
so you can rebuild this source and compare it with the bytes on chain (see the status at the top). The v1 record is in
`docs/VERIFY_BUILD.md`.

## Licence

AGPL-3.0-only, see `LICENSE`. Other licences that apply to parts of the tree are in `NOTICE` and `LICENSES/`. The name Silo and the logo are not licensed, see `TRADEMARK.md`.
The escrow program under `program/` declares its own licence in `program/Cargo.toml`.
Third-party licences: the vendored `vendor/bigint-buffer-js` is GPL-3.0-only (see its `package.json`).

## Compatibility note

A few stored identifiers still contain the word "grain" (for example backup format names such as `grain-silo-unified-backup-v1`
and the encryption scope `grain-silo`). They are part of the file and key formats that existing wallets already use, so
renaming them would make existing backups and wallets unreadable. They are intentionally unchanged.
