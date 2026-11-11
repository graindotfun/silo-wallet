# Verify the escrow program

Since 2026-11-10 the live program runs protocol v2 (sha256 `6ac58cdc80b585290d8fa32e67a8c1cbdbac1081b0fc7b2a487e1cefc68c921e`,
265,488 bytes, upgrade transaction `3X996yrTdNsXpUYgbSUozwHCzND4Xefxh5zhuZjueTQ5DzoNBaovqERkQ9jviqwz8aPsQnAxYvm1aMGHU7iYKpER`,
slot 467605377), and `program/` holds the v2 source. How to rebuild and compare v2 is in `docs/VERIFY_BUILD_V2.md`. This page
is the record of v1 as it was on 2026-11-08 and 2026-11-09, kept unchanged below. The v1 source is `program/` at commit
`b33cc3eb33f3ad7d09c44f3121db356db2561568` (tree `75f75111781c25b612a0ac04408cb8ae8383fc07`); the hashes, slots and commands
below apply to that source, and `.github/workflows/docker-verified-build.yml` now builds it from that commit.

The live Solana escrow program for the XMR to SOL atomic swap is:

- Program id: `7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS`
- ProgramData account: `9jSbazFuWTXiC3RvnwE6Qw5ew9aBZ8wsxyTzhvY6BiwS`
- Size: 215,944 bytes
- SBF binary sha256: `4033eb70a5d4d6f7d47654d278a54633bafd5366303b7882a17032d4cbbc3515`
- solana-verify hash (trailing zero bytes removed): `6d331f7522d2fe2d1c75e90d1495a264cf7d9de26fba4c5c96834ae834daae39`
- Last deploy: slot 467051728, 2026-11-08 20:37:25 UTC, transaction
  `5gBdxnNNfjbicy4V7ZGegCXBPP8BPXRvNHbYqcMuCvmTo8vZMXXN6kq6BBt6EFsaiVd44AsurSz8F1pZ96JXzcBx`
- Previous live bytes (before that slot): sha256 `76424c24aa28d5f74e52781df0a98d95e43003ad2374c48f47acd1c21045599d`, last
  deploy slot 465229265, kept in `docs/verify-build/bins/old_live.so`

status: live program third party verifiable since 2026-11-08 (upgrade tx
`5gBdxnNNfjbicy4V7ZGegCXBPP8BPXRvNHbYqcMuCvmTo8vZMXXN6kq6BBt6EFsaiVd44AsurSz8F1pZ96JXzcBx`, slot 467051728). dump of program
`7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS`, leading 215,944 bytes, sha256
`4033eb70a5d4d6f7d47654d278a54633bafd5366303b7882a17032d4cbbc3515`, equals the docker build of this tree. the earlier state
and how we got here is kept below unchanged.

The supported check is the Docker build (section 1 and `.github/workflows/docker-verified-build.yml`). Its run after the
upgrade, 42521490252, printed `FULL MATCH` (the live dump inside the run equals both Docker builds); the secondary workflow
without Docker, run 42521481281, printed `FULL MATCH` too. Both are recorded in `docs/verify-build/hashes.json`.
How the upgrade was executed is in section 13, "Executed", of `docs/UPGRADE_TO_VERIFIED_BUILD.md`.

What this does not prove, stated plainly:

- The three environments that reproduced the build (GitHub's linux runner, a separate linux x86_64 vm, a Mac under amd64
  emulation) all used the same pinned Docker image. They show that the build repeats; they do not check the toolchain inside
  that image. A different toolchain could give different bytes. The verification trusts that pinned solana-verify base image
  by its digest; whoever does not trust it can build that image themselves and repeat the build with it.
- The program is upgradeable by a single key, the upgrade authority `8pFUuZgzab6mwXq2UqdEc2mbkDk6Wg68KSppJ4brfF4W`. A rollback
  buffer `9BFEveajgqYcBqqK8zEFisJxy8YKytTqLc8ad7Wfv1TN` holding the previous bytes (`76424c24...`) still exists under that
  key until it is closed. Closure is planned within days; that is a plan, not a binding date. With one signature the program
  could be switched back to bytes nobody outside can rebuild. Check the last deploy slot (467051728) and the hash each time you
  rely on it.

## Earlier state (before 2026-11-08, kept unchanged)

status: live program not third party verifiable. docker build is deterministic
(`4033eb70a5d4d6f7d47654d278a54633bafd5366303b7882a17032d4cbbc3515`, canonical solana-verify hash
`6d331f7522d2fe2d1c75e90d1495a264cf7d9de26fba4c5c96834ae834daae39`, 215,944 bytes), confirmed by three independent rebuilds
(github linux runner, a linux x86_64 vm, a mac under amd64 emulation). live bytes
`76424c24aa28d5f74e52781df0a98d95e43003ad2374c48f47acd1c21045599d` differ by 1,672 bytes in 38 regions: 1,668 bytes in .text
and 4 bytes in two relocation entries of .rel.dyn that point into .text. instruction level codegen difference from the macos
build host. upgrade procedure written and under review, not executed, no date.

The evidence is in `docs/verify-build/`: the hashes of each environment, the linux vm build log, both binaries, a script that
prints the 38 regions, and a differential test of the two binaries with its log.

How we got here:

- A local build of this exact `program/` directory on macOS (cargo-build-sbf 4.3.0, platform-tools v1.57, rustc 1.95.0-dev,
  target version `v0`) produced 215,944 bytes with sha256 `76424c24aa28d5f74e52781df0a98d95e43003ad2374c48f47acd1c21045599d`,
  equal to the bytes dumped from the live program (215,944 bytes, same sha256, no trailing bytes). That is internal evidence
  and cannot be repeated by a third party, which is why the live program cannot yet be verified by you.
- A run of the `verify-build` workflow on a GitHub runner (cargo-build-sbf 4.4.0, platform-tools v1.57) produced 202,872
  bytes and did **not** match. A local build with `--arch v3` gives the same size, so the newer wrapper appears to default to
  a different target version than the live program was built for.
- The next run (with `--arch v0`) produced exactly 215,944 bytes, the same size as the live program, but a **different
  sha256** (`4033eb70a5d4d6f7d47654d278a54633bafd5366303b7882a17032d4cbbc3515`). Section headers, size and strings are
  identical. The differing bytes are instruction level code generation and two relocation offsets, not embedded paths (the
  live program contains no absolute build paths).
- The workflow now mirrors the local macOS recipe: cargo-build-sbf 4.3.0 installed from crates.io
  (`cargo install cargo-build-sbf --version =4.3.0 --locked`, pinned by version, not by hash), platform-tools v1.57 with its
  own `cargo` and `rustc` at the front of PATH, `--no-rustup-override`, no `--arch` flag. That run (42490579014) gave the same
  `4033eb70...` again.
- A Docker reproducible build (`.github/workflows/docker-verified-build.yml`, solana-verify 0.5.2, digest-pinned image
  `solanafoundation/solana-verifiable-build` 4.3.0, run 42503119763) built `program/` in two separate jobs with identical
  results: 215,944 bytes, sha256 `4033eb70a5d4d6f7d47654d278a54633bafd5366303b7882a17032d4cbbc3515`. The same build was then
  repeated outside GitHub, twice on a linux x86_64 vm and twice on a Mac under amd64 emulation, with the same result.
- Linux builds agree with each other and differ from the live bytes, which were built on macOS. To make the live program
  checkable by anyone, it has to be upgraded to the Docker bytes (same source). The procedure is in
  `docs/UPGRADE_TO_VERIFIED_BUILD.md`. It has not been executed, and the live program is unchanged.
- A differential test (`docs/verify-build/c5/`, 248 runs, 1,426 steps, old and new bytes switching at every point including
  the deadlines) found identical behaviour on every path it covered. It does not cover all paths.

Until the live program equals a build anyone can repeat, this repository does not claim equivalence between this source and the
live program.

## 0. Differences from the private source of the previous live bytes

This section is about the previous live bytes (`76424c24...`), built on macOS from a private commit. The current live bytes
are the Docker build of this tree itself. Compared with the private source of that commit, `program/src/lib.rs` differs only in three comment lines (line 1 and
lines 13 and 14, same line count so no code moves) and `program/Cargo.toml` only in its `description` text. No code changed. These comment and metadata edits do not establish binary equivalence; reproduction is still pending.
Because the binary can embed source line numbers, a build of this tree is expected to give the same bytes. The local build described at the top produced the same hash from this tree.

## 1. Build the program

The supported way is the Docker build with `solana-verify` 0.5.2 in the digest-pinned image. It needs Docker on a Linux
x86_64 machine (or amd64 emulation):

```bash
cargo install solana-verify --version =0.5.2 --locked
solana-verify build program --library-name xmr_sol_swap \
  --base-image solanafoundation/solana-verifiable-build@sha256:12fd4c0a0790f0fc41ef74b0cdb6bccc167ba6137eb1adb749bac649481c86bd
shasum -a 256 program/target/deploy/xmr_sol_swap.so           # 4033eb70a5d4d6f7d47654d278a54633bafd5366303b7882a17032d4cbbc3515
solana-verify get-executable-hash program/target/deploy/xmr_sol_swap.so   # 6d331f7522d2fe2d1c75e90d1495a264cf7d9de26fba4c5c96834ae834daae39
```

Or build and compare with the chain in one step:

```bash
solana-verify verify-from-repo -u https://api.mainnet-beta.solana.com --program-id 7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS \
  https://github.com/graindotfun/silo-wallet --mount-path program --library-name xmr_sol_swap \
  --base-image solanafoundation/solana-verifiable-build@sha256:12fd4c0a0790f0fc41ef74b0cdb6bccc167ba6137eb1adb749bac649481c86bd
```

Answer no if it offers to write a verification record on chain; that write needs the upgrade authority.

Without Docker, on Linux x86_64, the toolchain recipe below gave the same bytes on GitHub's linux runner (run 42490579014):

```bash
cargo install cargo-build-sbf --version =4.3.0 --locked
cargo-build-sbf --tools-version v1.57 --install-only
cd program
PATH="$HOME/.cache/solana/v1.57/platform-tools/rust/bin:$PATH" cargo-build-sbf --tools-version v1.57 --no-rustup-override --skip-tools-install -- --locked
shasum -a 256 target/deploy/xmr_sol_swap.so
```

On a machine without `rustup`, also set `RUSTC=$HOME/.cache/solana/v1.57/platform-tools/rust/bin/rustc`. The same recipe on
macOS gave the previous live bytes (`76424c24...`), not the current ones: the host platform changes the output. Newer wrapper
versions gave different bytes in our CI (smaller with the default target, and 1,672 bytes different with `--arch v0`).

### Automated checks

`.github/workflows/docker-verified-build.yml` is the supported check. It builds `program/` twice in the pinned image on two
runners, fails unless both builds are byte-identical and equal `4033eb70...`, dumps the live program read-only and prints
`FULL MATCH` when the leading 215,944 bytes of the live program equal the build and nothing but zeros follows. If a dump was
read and differs, the run fails.

`.github/workflows/verify-build.yml` is a secondary check without Docker (the toolchain recipe above on a GitHub linux runner).
It expects the same `4033eb70...` and prints `FULL MATCH` on success. The third-party actions are pinned to full commit SHAs,
the toolchain installer script is checked against a pinned sha256, and the `cargo-build-sbf`, `platform-tools` and `rustc`
versions must equal the pins or the run fails. The toolchain binaries that the installer and `cargo install` download are not
independently hashed by this workflow.

### What a mismatch would mean

- Built hash differs from the live hash with the pinned tools: this source is not what is deployed, or the toolchain pin in
  the workflow is wrong. Do not treat the source as verified. Report it (see `SECURITY.md`).
- Raw dump differs but the dump trimmed to 215,944 bytes matches: padding only, not a mismatch.
- Different tool versions: not a finding until the exact versions above are used.

## 2. Read the hash from the chain

```bash
solana program dump -u mainnet-beta 7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS live.so
head -c 215944 live.so | shasum -a 256    # 4033eb70a5d4d6f7d47654d278a54633bafd5366303b7882a17032d4cbbc3515
solana-verify get-program-hash -u mainnet-beta 7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS   # 6d331f75...ae39
```

This dumps the deployed bytes and hashes them.

Before reading a mismatch as meaningful: the deployed account can be larger than the program because the dump may include
trailing zero padding, so compare the hash of the dump trimmed to the program size (215,944 bytes) as well as the raw dump.
A different `cargo-build-sbf`, `platform-tools` or Anchor version, a different path to the source, or a different
dependency resolution (use the committed `Cargo.lock`) also changes the binary. Only a mismatch that survives the exact
tool versions and the trimmed comparison says something about the source.

If the two hashes differ after those checks, tell us (see `SECURITY.md`).

## Notes

- The tests in `program/tests/swap.rs` run against the compiled SBF binary:
  `SBF_OUT_DIR=$PWD/target/deploy cargo test --test swap -- --test-threads=1`
- The program upgrade authority is held by the Silo team, so the program can be upgraded. A new upgrade changes the
  on-chain hash, and this file and the repository will be updated with it.
- Build of the live binary since 2026-11-08: `solana-verify` 0.5.2 in the pinned image above (cargo-build-sbf 4.3.0,
  platform-tools v1.57 inside it). The previous live binary was built on macOS with the same tool versions.
