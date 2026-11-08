# Verify the escrow program

The live Solana escrow program for the XMR to SOL atomic swap is:

- Program id: `7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS`
- Size: 215,944 bytes
- SBF binary sha256: `76424c24aa28d5f74e52781df0a98d95e43003ad2374c48f47acd1c21045599d`

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

## 0. Differences from the deployed source

Compared with the private source of the deployed commit, `program/src/lib.rs` differs only in three comment lines (line 1 and
lines 13 and 14, same line count so no code moves) and `program/Cargo.toml` only in its `description` text. No code changed. These comment and metadata edits do not establish binary equivalence; reproduction is still pending.
Because the binary can embed source line numbers, a build of this tree is expected to give the same bytes. The local build described at the top produced the same hash from this tree.

## 1. Build the program

The live binary was built with `cargo-build-sbf 4.3.0` and `platform-tools v1.57` (Anchor 0.31.1, see `program/Cargo.lock`).
With those tools installed:

```bash
cd program
PATH="$HOME/.cache/solana/v1.57/platform-tools/rust/bin:$PATH" cargo-build-sbf --tools-version v1.57 --no-rustup-override --skip-tools-install -- --locked
shasum -a 256 target/deploy/xmr_sol_swap.so
```

Use `cargo-build-sbf 4.3.0` (`cargo install cargo-build-sbf --version =4.3.0 --locked`), with `cargo-build-sbf --tools-version v1.57 --install-only`
once to fetch platform-tools. Newer wrapper versions gave different bytes in our CI (smaller with the default target, and 1,672
bytes different with `--arch v0`). On a machine without `rustup`, also set `RUSTC=$HOME/.cache/solana/v1.57/platform-tools/rust/bin/rustc`.

The printed hash should equal the sha256 above. A different tool version can give a different hash; if so, install the
versions listed above before drawing any conclusion.

### Automated check

`.github/workflows/verify-build.yml` builds `program/` with the pinned toolchain, prints the sha256 of the built `.so` in the
public log, dumps the live program and compares the three hashes (expected, built, live). It fails loudly on any mismatch.
It can be started by hand (workflow_dispatch) and runs on pushes that touch `program/`. A green run is the evidence to look for.
This repository does not claim equivalence with the live program until a green run is linked here.

What the workflow does and does not pin: the third-party action is pinned to a full commit SHA, the toolchain installer script
is checked against a pinned sha256, and `platform-tools` and `rustc` versions must equal the pins or the run
fails. The `cargo-build-sbf` wrapper version is printed but not pinned: the pinned Agave release ships a newer wrapper (4.4.0)
than the one used for the live binary (4.3.0). If that ever changes the bytes, the comparison fails and shows it. The toolchain binaries that the installer downloads are not independently hashed by this workflow. The result lines are
exact: "prefix equal" (the leading bytes of the dump equal the build), "padding only" (extra bytes are all zero), and "FULL MATCH"
(exact-length sha256 equal for build, dump and expected value, extra bytes zero). Nothing else is claimed.

### What a mismatch would mean

- Built hash differs from the live hash with the pinned tools: this source is not what is deployed, or the toolchain pin in
  the workflow is wrong. Do not treat the source as verified. Report it (see `SECURITY.md`).
- Raw dump differs but the dump trimmed to 215,944 bytes matches: padding only, not a mismatch.
- Different tool versions: not a finding until the exact versions above are used.

## 2. Read the hash from the chain

```bash
solana program dump -u mainnet-beta 7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS /tmp/live.so && shasum -a 256 /tmp/live.so # or with solana-verify:
solana-verify get-program-hash -u mainnet-beta 7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS
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
- Build tool versions used for the live binary: platform-tools v1.57, cargo-build-sbf 4.3.0.
