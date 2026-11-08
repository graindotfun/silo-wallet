# Build evidence for the escrow program

Raw evidence behind the status in `docs/VERIFY_BUILD.md`. Everything here can be checked with the files in this folder and
public tools. Nothing here was signed or sent to a chain.

| Path | What it is |
|---|---|
| `hashes.json` | Summary: source commit, `program/` tree, image, the result of each environment, the two binaries with their sha256, the difference and the differential test result. |
| `github-runner/` | `hashes.json`, `build-a.json`, `build-b.json` from the `docker-verified-build` workflow run 42503119763 on GitHub's linux runners (two separate jobs). |
| `linux-vm/` | `hashes.json` and the full `build.log` of two builds on a separate linux x86_64 vm (ubuntu 24.04), outside GitHub. |
| `mac-amd64-emulation/` | `hashes.json` of two builds on a Mac (aarch64) running the linux/amd64 image under emulation (Colima with Rosetta). No full log was kept for these runs. |
| `bins/old_live.so` | The live program bytes: the leading 215,944 bytes of a mainnet dump, sha256 `76424c24aa28d5f74e52781df0a98d95e43003ad2374c48f47acd1c21045599d`. |
| `bins/new_verified.so` | The Docker build of `program/`, sha256 `4033eb70a5d4d6f7d47654d278a54633bafd5366303b7882a17032d4cbbc3515`. |
| `diff-regions.py` | Prints the 38 regions where the two binaries differ (offset, length, section, bytes). |
| `c5/upgrade_equivalence.rs` | Source of the differential test between the two binaries. |
| `c5/c5-run-full-20261108.log` | Full log of one run of that test. |

All three environments built commit `e8684f369d1d1139b0f7f53bb89563d96543bca8` (`program/` tree
`75f75111781c25b612a0ac04408cb8ae8383fc07`) with `solana-verify` 0.5.2 in the image
`solanafoundation/solana-verifiable-build@sha256:12fd4c0a0790f0fc41ef74b0cdb6bccc167ba6137eb1adb749bac649481c86bd`, and all six
builds gave 215,944 bytes with sha256 `4033eb70a5d4d6f7d47654d278a54633bafd5366303b7882a17032d4cbbc3515` (solana-verify hash
`6d331f7522d2fe2d1c75e90d1495a264cf7d9de26fba4c5c96834ae834daae39`). The linux vm built from a source archive of that commit;
its log prints the sha256 of `program/Cargo.toml`, `program/Cargo.lock` and `program/src/lib.rs`, which equal the files at that
commit. All three used the same pinned image, so they show that the build repeats, not that the toolchain inside the image is
correct.

## Check it yourself

```bash
shasum -a 256 docs/verify-build/bins/*.so
python3 docs/verify-build/diff-regions.py
```

The script reports 1,672 differing bytes in 38 regions: 1,668 bytes in `.text` (code) and 4 bytes in `.rel.dyn`, where two
relocation entries hold different offsets into the code. Section headers, sizes and all other sections are identical. A
region is a run of differing bytes in which each differing byte is at most 16 bytes after the previous one.

## The differential test (c5)

`c5/upgrade_equivalence.rs` loads both binaries at the declared program id under the upgradeable loader in a
`solana-program-test` bank, runs scripted instruction sequences (lock, ready, claim, refund, wrong secrets, wrong windows,
malformed data, several escrows at once, deadlines t0 and t1), and switches between the binaries with a real loader upgrade
instruction before every step, in both directions, and twice in a row for the multi escrow script. After every step it compares
the transaction result, the program logs and the full state of every escrow account and balance with a run on the old bytes
only. A canary test checks that the harness's upgrade really changes the code that runs (old bytes, then a memo program, then
the new bytes). The logged run: 248 runs, 1,426 compared steps, 0 divergences, and no compute unit difference between the old only and new
only runs.

What it does not show: it covers only the paths in its scripts, not all paths. A switch is followed by a slot warp, so it does
not measure what the program does inside the slot of the upgrade itself. It runs in a test bank, not on mainnet.

To run it, copy it into `program/tests/` and run, from `program/`:

```bash
OLD_SO=$PWD/../docs/verify-build/bins/old_live.so NEW_SO=$PWD/../docs/verify-build/bins/new_verified.so \
  cargo test --test upgrade_equivalence -- --nocapture --test-threads=1
```

It is kept here, not in `program/tests/`, because any change under `program/` changes the source tree that the build above is
pinned to.

## What was changed in these files

Local paths in the c5 log were replaced with `<build dir>`. The provider and host name of the linux vm were removed from its
`hashes.json`. Nothing else was edited.
