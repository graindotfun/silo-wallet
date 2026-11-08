# Silo wallet core

status: the escrow program live on solana now runs the bytes anyone can rebuild: sha256
`4033eb70a5d4d6f7d47654d278a54633bafd5366303b7882a17032d4cbbc3515` (canonical solana-verify hash
`6d331f7522d2fe2d1c75e90d1495a264cf7d9de26fba4c5c96834ae834daae39`), built from `program/` in a pinned docker image and
reproduced in three independent environments. upgraded on 2026-11-08 in transaction
`5gBdxnNNfjbicy4V7ZGegCXBPP8BPXRvNHbYqcMuCvmTo8vZMXXN6kq6BBt6EFsaiVd44AsurSz8F1pZ96JXzcBx`, slot 467051728; the previous
bytes (`76424c24aa28d5f74e52781df0a98d95e43003ad2374c48f47acd1c21045599d`) differed by 1,672 bytes of compiler output and are
kept in `docs/verify-build/bins/` with a differential test. verify it yourself: `docs/VERIFY_IN_10_MINUTES.md`.
the hosted xmr to sol swap is paused while the maker is stopped after the upgrade; it will be re-enabled after the maker restart review.

swap caps and maker quotas are maker policy, not program code, so do not rely on them (see `docs/WHAT_THE_MAKER_CAN_DO.md`).

Repository: https://github.com/graindotfun/silo-wallet

Source for the parts of Silo that hold your keys and move your money. Silo is a self-custody wallet: wallet seeds
and spend keys are made and kept on your device, and the wallet code in this repository does not send them to a server.

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

This is a deliberately small cut. It lets you read, build and check the code that matters most.
It is not the whole product.

## What is here

| Path | What it is |
|---|---|
| `lib/silo/native-keyring.mjs`, `native-keyring-store.mjs` | On-device key creation, encryption and the signing guard for Solana and EVM keys |
| `lib/silo/local-envelope.mjs`, `legacy-envelopes.mjs` | The encrypted envelope format (passphrase-based) and its reader for older envelopes |
| `lib/silo/device-unlock.mjs`, `one-unlock.mjs` | Unlocking with the device (passkey) and the single-passphrase flow |
| `lib/silo/unified-backup.mjs` | One backup file for the whole wallet, and restore |
| `lib/silo/xmr-adapter.mjs` and the `xmr-*` helpers | The Monero side of the wallet: address review, fee bounds, confirmations |
| `lib/silo/evm-wallet.ts`, `evm.mjs` | The EVM side of the wallet |
| `lib/silo/atomic-swap/`, `atomic-driver.mjs`, `atomic-pending.mjs` | The client for the XMR to SOL atomic swap |
| `lib/silo/release-gate.mjs` | The release gate: real funds stay locked unless release evidence matches the exact build |
| `program/` | The Solana escrow program used by the atomic swap, with its tests |
| `components/` | The screens for unlock, backup and the atomic swap |
| `tests/` | Tests that run on their own, with no network |

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

## What is not here

The hosted service (accounts, sync, the swap maker, conversion providers, operations) is not part of this repository.
The wallet client talks to Silo's hosted session and RPC endpoints for chain reads; those endpoints are not published here.
Solana send and swap signing needs a release-ticket flow that is not in this cut, so in this repository
`signReviewedTransfer` and `signReviewedManaged` refuse to sign. Test-network signing is held off, the same as in the
production build.

## Status and honest limits

Silo is in an open beta with small caps. The hosted service enforces the caps; the code in this repository does not enforce a
holding cap by itself. It has not had an independent external
security audit. Read the code, run the tests, and report problems (see `SECURITY.md`). Do not treat this repository as a
statement that the software is safe.

## More documents

- `docs/VERIFY_IN_10_MINUTES.md`: a few commands to check the live program, rebuild it, and check this repository.
- `docs/PROTOCOL.md`: the XMR to SOL swap protocol (beta version).
- `docs/WHAT_THE_MAKER_CAN_DO.md`: what the swap maker can and cannot do.
- `docs/VERIFY_BUILD.md`: reproducing the escrow program build, and its current status.
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

See `docs/VERIFY_BUILD.md`. In short: since 2026-11-08 the live program equals the Docker build of `program/`, so you can
rebuild this source and compare it with the bytes on chain (see the status at the top).

## Licence

AGPL-3.0-only, see `LICENSE`. Other licences that apply to parts of the tree are in `NOTICE` and `LICENSES/`. The name Silo and the logo are not licensed, see `TRADEMARK.md`.
The escrow program under `program/` declares its own licence in `program/Cargo.toml`.
Third-party licences: the vendored `vendor/bigint-buffer-js` is GPL-3.0-only (see its `package.json`).

## Compatibility note

A few stored identifiers still contain the word "grain" (for example backup format names such as `grain-silo-unified-backup-v1`
and the encryption scope `grain-silo`). They are part of the file and key formats that existing wallets already use, so
renaming them would make existing backups and wallets unreadable. They are intentionally unchanged.
