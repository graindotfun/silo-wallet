# Verify the escrow program, protocol v2

Since 2026-11-10 the live Solana escrow program runs protocol v2. This page says how to rebuild it from `program/` and compare
it with the chain, what changed from v1, and how the upgrade and its rollback were set up. The v1 record stays in
`docs/VERIFY_BUILD.md` and `docs/UPGRADE_TO_VERIFIED_BUILD.md`.

status: v2 is live on mainnet. Both directions are open to users in the beta: XMR to SOL uses the v1 instructions, which v2
keeps unchanged, and SOL to XMR uses the strict instructions that v2 adds.

## The live program

| | |
|---|---|
| Program id | `7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS` |
| ProgramData account | `9jSbazFuWTXiC3RvnwE6Qw5ew9aBZ8wsxyTzhvY6BiwS` |
| Program size | 265,488 bytes |
| sha256 of the program bytes | `6ac58cdc80b585290d8fa32e67a8c1cbdbac1081b0fc7b2a487e1cefc68c921e` |
| solana-verify hash (sha256 of the bytes with trailing zero bytes removed, 265,473 bytes) | `bef3a3e89d71a171c65d1f38b8d8c88dc4e5c5840e881733195defbab962f812` |
| Upgrade transaction | `3X996yrTdNsXpUYgbSUozwHCzND4Xefxh5zhuZjueTQ5DzoNBaovqERkQ9jviqwz8aPsQnAxYvm1aMGHU7iYKpER` |
| Upgrade slot (finalized, last deploy slot of the program) | 467605377, 2026-11-10 05:37:37 UTC |
| Upgrade authority (unchanged) | `8pFUuZgzab6mwXq2UqdEc2mbkDk6Wg68KSppJ4brfF4W` |
| Previous live bytes (v1, live from 2026-11-08 to 2026-11-10) | 215,944 bytes, sha256 `4033eb70a5d4d6f7d47654d278a54633bafd5366303b7882a17032d4cbbc3515`, solana-verify hash `6d331f7522d2fe2d1c75e90d1495a264cf7d9de26fba4c5c96834ae834daae39`, kept in `docs/verify-build/bins/new_verified.so` |

We read these values from mainnet with a public RPC on 2026-11-10: the ProgramData account holds a 45-byte header and
265,488 program bytes, the header names slot 467605377 and the authority above, the program bytes hash to `6ac58cdc...`, and
the upgrade transaction is finalized in slot 467605377 without error.

## 1. Rebuild and compare

The supported way is the Docker build with `solana-verify` 0.5.2 in the digest-pinned image, the same image and tool as v1.
It needs Docker on a Linux x86_64 machine (or amd64 emulation):

```bash
cargo install solana-verify --version =0.5.2 --locked
shasum -a 256 program/Cargo.toml program/Cargo.lock program/src/lib.rs
#   1273f8e2cb4bfe5a563e421ce9241f659fee50c6b6288d9a00df22ff4b16d738  program/Cargo.toml
#   0db6d21009b36221c77155ecc00bb6f3a69eed4125918154ee1e8e1fef978ed2  program/Cargo.lock
#   66b6d6116756afebd7408eb073fe725cd9f24dbd84a3374c6e6402813cc8dfc7  program/src/lib.rs
solana-verify build program --library-name xmr_sol_swap \
  --base-image solanafoundation/solana-verifiable-build@sha256:12fd4c0a0790f0fc41ef74b0cdb6bccc167ba6137eb1adb749bac649481c86bd
shasum -a 256 program/target/deploy/xmr_sol_swap.so                       # 6ac58cdc80b585290d8fa32e67a8c1cbdbac1081b0fc7b2a487e1cefc68c921e
solana-verify get-executable-hash program/target/deploy/xmr_sol_swap.so   # bef3a3e89d71a171c65d1f38b8d8c88dc4e5c5840e881733195defbab962f812
```

Then read the live bytes and compare:

```bash
solana program dump -u mainnet-beta 7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS /tmp/live.so
head -c 265488 /tmp/live.so | shasum -a 256          # 6ac58cdc80b585290d8fa32e67a8c1cbdbac1081b0fc7b2a487e1cefc68c921e
solana-verify get-program-hash -u mainnet-beta 7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS   # bef3a3e8...f812
solana program show -u mainnet-beta 7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS               # Last Deployed In Slot: 467605377
```

Or build and compare in one step:

```bash
solana-verify verify-from-repo -u https://api.mainnet-beta.solana.com --program-id 7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS \
  https://github.com/graindotfun/silo-wallet --mount-path program --library-name xmr_sol_swap \
  --base-image solanafoundation/solana-verifiable-build@sha256:12fd4c0a0790f0fc41ef74b0cdb6bccc167ba6137eb1adb749bac649481c86bd
```

Answer no if it offers to write a verification record on chain; that write needs the upgrade authority. If the last deploy
slot is newer than 467605377, the program was changed again and the hashes on this page no longer apply until this
repository says so. Some Solana CLI versions ask for a default keypair even for read-only commands: make a throwaway one
with `solana-keygen new --no-bip39-passphrase -o /tmp/throwaway.json` and add `-k /tmp/throwaway.json`. It signs nothing.

### The automated check

`.github/workflows/v2-docker-verified-build.yml` (manual start, and on pull requests that change `program/` or the workflow) does the same on GitHub's runners:

1. Two jobs on two runners check out the same commit. Each checks that `program/src` holds only `lib.rs`, that the git tree
   id of `program/src` is `c283cb13876de54fb2c26f941f196b28f7235182`, and that the three build inputs have the sha256 values
   above. Any other source stops the run.
2. Each job installs `solana-verify` 0.5.2 from a crate file pinned by sha256, pulls the digest-pinned image and builds
   `program/` (mounted at `/build`).
3. The compare job fails unless both builds are byte-identical, 265,488 bytes, sha256 `6ac58cdc...` and solana-verify hash
   `bef3a3e8...`. It then dumps the live program read-only from the public RPC and prints `FULL MATCH` when the leading
   265,488 program bytes equal the build and only zero bytes follow. If a dump was read and differs, the run fails. If no
   dump could be read, it warns and does not compare.
4. It uploads the `.so` and a `hashes.json` with every value it used.

It holds no key, signs nothing and sends no transaction.

Expected result of a run on this repository: `DETERMINISTIC`, `EXPECTED` and `FULL MATCH`.

Rebuild of 2026-11-11, from the files of this branch (the three input hashes above matched): `solana-verify` 0.5.2 with the
digest-pinned image on a Mac (arm64) running Docker under amd64 emulation gave `program/target/deploy/xmr_sol_swap.so` of
265,488 bytes, sha256 `6ac58cdc80b585290d8fa32e67a8c1cbdbac1081b0fc7b2a487e1cefc68c921e`, solana-verify hash
`bef3a3e89d71a171c65d1f38b8d8c88dc4e5c5840e881733195defbab962f812`. A read-only dump of the live program the same day (last
deploy slot still 467605377) is byte-identical to that build over all 265,488 bytes. So the program source in this repository
builds to the bytes that are live. This is one more repetition by the team that made the build; the check that counts is
yours, or the public workflow run once it exists.

This workflow has not yet run in this public repository. The pinned values come from the same workflow run on the same
three input files in Silo's private source repository (CI run 42527425569, two jobs, both 265,488 bytes with sha256
`6ac58cdc...`). The values that run recorded are in `docs/verify-build-v2/hashes.json`. That run is not publicly viewable,
so until the public workflow has run, the public evidence is your own rebuild and the chain read above.

`.github/workflows/verify-build.yml` is a secondary check without Docker (the toolchain recipe in `docs/VERIFY_BUILD.md`,
section 1). For v1 it gave the same bytes as Docker on GitHub's runner. For v2 it now expects `6ac58cdc...`, but it has not
run for v2, so whether that recipe reproduces the v2 bytes is not known yet.

`.github/workflows/docker-verified-build.yml` now rebuilds v1 from the last v1 commit (`b33cc3eb33f3ad7d09c44f3121db356db2561568`,
`program/` tree `75f75111781c25b612a0ac04408cb8ae8383fc07`) and compares the result with the rollback buffer below.

### What a mismatch would mean

- Your build differs from `6ac58cdc...` with the pinned image: start by checking the three input hashes. If they match and the
  build still differs, report it (see `SECURITY.md`).
- The live dump differs from the build but the dump trimmed to 265,488 bytes matches: padding only, not a mismatch.
- The last deploy slot is newer than 467605377: the program was upgraded again. This page does not describe it.

## 2. What changed from v1 to v2

Only `program/src/lib.rs` and the `description` text in `program/Cargo.toml` differ from v1. `program/Cargo.lock` is the same
file. In `lib.rs` every line of v1 code is kept: compared with the v1 source, v2 only adds lines (a header comment, the new
instructions, their account types and helpers) and one blank line becomes the start of a new block. The v1 instructions
(`lock`, `set_ready`, `claim`, `refund`) and the v1 account type `Swap` work as before, and so do escrows that v1 created.

v2 adds a separate "strict" family for the SOL to XMR direction, where the user holds SOL and the maker holds XMR:

| Instruction | Who | Effect |
|---|---|---|
| `lock_strict(swap_id, claimer, claim_point, refund_point, amount, t0, t1)` | the SOL side (refunder) | Same checks as `lock`, into a `StrictSwap` account at the PDA seed `swap-strict`. A different discriminator and seed, so a strict escrow can never be read as a v1 escrow. |
| `set_ready_strict()` | refunder | Marks the swap ready. Only before `t0`, only once. |
| `claim_commit_strict()` | the claimer, signed | Carries no secret. Allowed once, while ready and before `t1`. Records `claim_committed_at` on chain. |
| `claim_strict(secret)` | anyone | Pays the recorded claimer if `secret*G == claim_point`, only after a commit and for `CLAIM_WINDOW_S` (3,600 seconds) after it. |
| `refund_strict(secret)` | anyone | Returns the SOL to the refunder if `secret*G == refund_point`, any time while not ready; once ready, only from `t1` on and, if a commit exists, only after its window has ended. |

The windows of the strict family, with `W = CLAIM_WINDOW_S`:

```
claim  : ready && committed != 0 && now <  committed + W
refund : !ready || (now >= t1 && (committed == 0 || now >= committed + W))
```

The two are disjoint in every state. The reason for the two-step claim: the claimer sends the secret only after the
deadline for it is a number on chain, and a claim that did not land can be sent again, because the refund cannot open
before `claim_committed_at + W`. In the strict family a claim always needs ready, which v1 does not require after `t0`.

Tests: `program/tests/swap.rs` (v1 paths, unchanged), `program/tests/strict.rs` (the strict family) and
`program/tests/upgrade.rs` (escrows written by the v1 binary are claimed and refunded by the v2 binary). They run against a
compiled SBF binary, for example `SBF_OUT_DIR=$PWD/target/deploy cargo test --test strict -- --test-threads=1` inside
`program/`. `tests/upgrade.rs` needs both binaries and two environment variables (see its header); without them it skips.

Two comments in the build inputs are out of date and are kept unchanged on purpose. The `description` in `Cargo.toml` and
line 1 of `lib.rs` still describe the program as a devnet prototype, and the `description` uses a word this project no
longer uses for the swap. The program is live on mainnet and has had no independent external security review. The text is
kept because these files are pinned by sha256 and the live bytes were built from exactly these files; changing a comment
needs a new build and a new comparison, which will come with the next program change.

## 3. How the upgrade was done

The procedure follows the v1 upgrade in `docs/UPGRADE_TO_VERIFIED_BUILD.md`, with the v2 file:

1. The SOL to XMR direction stayed off, and new XMR to SOL swaps were stopped at the maker for the window.
2. The ProgramData account was extended by 49,544 bytes (265,488 minus 215,944) so it can hold v2. An extend redeploys the
   existing bytes and moves the last deploy slot; it does not change them.
3. The v2 Docker build (sha256 `6ac58cdc...`) was written to an upgrade buffer and handed to the upgrade authority.
4. A second buffer was written with the v1 Docker bytes (`4033eb70...`) as the rollback target.
5. The upgrade authority signed the upgrade (transaction `3X996...iYKpER`, slot 467605377). The upgrade buffer was used up
   and its rent returned.
6. After-checks: the live bytes equal `6ac58cdc...`, the authority is unchanged, and read-only simulations of a v1
   instruction (`lock`) and a v2 instruction (`lock_strict`) were both accepted. Then XMR to SOL swaps were reopened.

## 4. The rollback buffer

To be able to return to v1 quickly if v2 misbehaves, a buffer holding the v1 Docker bytes stays open during an observation
period:

- Rollback buffer `D5aHjv8SVQNyoJmAySxQYKPv93HTFE2rZ4scanwcJJia`: its program bytes are the v1 Docker build (leading 215,944
  bytes sha256 `4033eb70...`, solana-verify hash `6d331f75...`, read from mainnet on 2026-11-10). Its authority is a separate
  buffer key, not the upgrade authority. A rollback would need two steps: hand the buffer to the upgrade authority, then an
  upgrade signed by that authority. Either would be visible on chain, and the last deploy slot would change.
- When the observation period ends, the plan is to close this buffer and return its rent. That is a plan, not a binding date.
- The older rollback buffer from the v1 upgrade, `9BFEveajgqYcBqqK8zEFisJxy8YKytTqLc8ad7Wfv1TN`, is still open as of
  2026-11-10. It holds the v1 bytes built on macOS (`76424c24...`), which nobody outside can rebuild, under the upgrade
  authority. Its closure is planned; until then the program could be switched to those bytes with one signature.

`.github/workflows/docker-verified-build.yml` rebuilds v1 and prints `ROLLBACK BUFFER MATCH` when the bytes in
`D5aHjv8S...` equal that build. You can check it by hand too:

```bash
solana account -u mainnet-beta D5aHjv8SVQNyoJmAySxQYKPv93HTFE2rZ4scanwcJJia --output-file /tmp/rbuf.bin
tail -c +38 /tmp/rbuf.bin | head -c 215944 | shasum -a 256   # 4033eb70a5d4d6f7d47654d278a54633bafd5366303b7882a17032d4cbbc3515
```

(A buffer account has a 37-byte header: 4-byte tag, 1-byte option, 32-byte authority.)

## What this does not prove

- The Docker builds that defined the pinned values ran in one pinned image. They show that the build repeats, not that the
  toolchain inside that image is correct. Whoever does not trust the image can build it themselves and repeat the build.
- The program is upgradeable by a single key. With that key, and the rollback buffers above, it can be changed. Check the
  last deploy slot and the hash each time you rely on them.
- A matching hash shows which source is deployed. It does not show that the source is correct. The program has had no
  independent external security review.
- Caps on swap size and quotas are maker and server policy, not program code (see `docs/WHAT_THE_MAKER_CAN_DO.md`).
