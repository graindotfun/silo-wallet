# Silo ZEC core (upstream librustzcash)

A thin wasm-bindgen layer over the maintained Zcash wallet stack. Account derivation, scanning, note storage, input
selection, fees, change (including the Orchard turnstile), proving and transaction building come from upstream
`zcash_client_backend` 0.25.0-pre.1 and `zcash_client_sqlite` 0.23.0-pre.1, both released crates.io versions with NU6.2, NU6.3 and
Ironwood support. This crate binds them for the browser. It holds no network policy, journal or release logic; those stay
in `lib/silo`.

## What Silo maintains

- `src/lib.rs`, `src/sync.rs`: the bindings and an in-memory block cache.
- `patches/zcash_client_sqlite-0.23.0-pre.1.patch`:
  - moves the store to rusqlite 0.40, whose bundled SQLite builds for `wasm32-unknown-unknown` through `sqlite-wasm-rs`;
  - enables rusqlite's `fallible_uint` and `serialize`;
  - makes the extension authorizer fail closed. rusqlite 0.40 now reports a failure to install it.
- `patches/schemerz-rusqlite-0.370.0.patch`: moves the migration runner to the same rusqlite.
- `CRATES.sha256`: checksums of the two crates.io sources that are patched. Everything else resolves from `Cargo.lock`.
- `fixture-chain/`: test-only generator of a synthetic testnet chain. It writes notes to a public test phrase with
  upstream's own test helpers: an Orchard note before NU6.3 and an Ironwood note after it.

## Runtime requirements

These are the same as for the current WebZjs engine:

- Upstream scanning decrypts on a rayon pool and waits on channels. The core therefore runs in a dedicated module worker
  (the page's main thread may not block), which calls `initThreadPool(n)`.
- The page must be cross-origin isolated.
- CSP needs `worker-src 'self' blob:` and `'wasm-unsafe-eval'`.
- Shared memory is capped at 1 GiB.

Silo receives and spends only in Orchard and Ironwood. No Sapling proving parameters are shipped; a proposal that would
need a Sapling proof fails in the builder.

## Build and test

```
scripts/silo/build-zec-core.sh   # nightly-2026-09-15 + rust-src, wasm-bindgen-cli 0.2.129, LLVM clang
scripts/silo/test-zec-core.sh    # native fixture scan and spend, then Chromium (PLAYWRIGHT_MODULE, CHROMIUM_PATH)
scripts/silo/test-zec-migration.sh # native-only ZIP-318 planning, commit, preparation proof and SQLite reopen
SILO_MIGRATION_FULL=1 scripts/silo/test-zec-migration.sh # full synthetic mining, reorg, expiry, cancel and balances
```

The build remaps paths. Two builds from different directories produced the same bytes.

The test uses only public BIP39 test phrases and a synthetic chain. Transactions go only to the local fixture server,
which records them and forwards nothing. No live network is contacted.

The separate migration probe uses a synthetic 1 ZEC Orchard note and the same upstream SQLite
store. It has no browser binding or send operation. The default run exercises the first preparation proof. The full mode drives the upstream state
machine, proves and synthetically mines all transfers, reopens after each mined transaction,
checks a preparation reorg/re-mine, and branches into cancellation and expiry checks. This is
not a live-chain or proof-of-work acceptance test. See
`docs/security/SILO_CONTINUATION_2026_10_08.md` for the integration work and acceptance evidence
that remain required before offering pool migration to users.

NU7 testnet compatibility is now included via published upstream prereleases; see docs/security/SILO_NU7_ENGINE_UPDATE.md for exact evidence and pending browser/funded acceptance. Native read-only source is in native-readonly/. Real-money release stays held.
