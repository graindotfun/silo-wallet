# Upgrade the escrow program to a verifiable Docker build

internal procedure, published for transparency. tracker is our release operator role. astra is an internal model review lane, not an audit.

**Status: procedure only (revision 3, after Astra round 2), under review. Nothing in this file has been executed on chain, and
there is no date.** It needs, in this order: the maker admission gate of `docs/MAKER_ADMISSION_GATE_SPEC.md` (revision 2 of
the spec) implemented, reviewed and deployed; every row of the signing checklist (section 9) ticked; an approval record that
includes explicit acceptance of the residual risk of section 8.4; and the tracker to run the steps that need no signature by
the upgrade authority. Only the program upgrade authority holder signs. A plain summary is `docs/OWNER_SUMMARY_UPGRADE.md`;
what internal review found is in `docs/REVIEW_HISTORY.md`; the build evidence is in `docs/verify-build/`.

## 1. Why this is an upgrade

The live program was built on macOS. Its bytes cannot be reproduced on Linux with the same tool versions (see
`docs/VERIFY_BUILD.md`: same size, identical section headers and strings, 1,672 bytes different in 38 regions: 1,668 in `.text` and 4 in
two relocation entries of `.rel.dyn`; `docs/verify-build/diff-regions.py` prints them). A third party
can only reproduce a build made inside a pinned container. So the way to make the program verifiable is to build the **same
source** with `solana-verify build` in a digest-pinned image and put **those** bytes on chain. The code and the account layout
do not change. The bytes do, so this is a real program upgrade with the same care as any other upgrade.

## 2. Acceptance criteria (fixed before any build, part of the approval)

These values are written here and copied into the approval record **before** anything is built or written. Every
build, buffer and dump in this procedure is compared with **these constants**, never with values produced by the same run
(a CI run's own `hashes.json` only says what that run built; any commit, including protocol v2, builds deterministically and
matches its own metadata). **Any mismatch stops the procedure.** Changing any value makes a different candidate: new review,
new approval.

| Id | Item | Required value |
|---|---|---|
| A1 | Program id | `7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS` |
| A2 | ProgramData account | `9jSbazFuWTXiC3RvnwE6Qw5ew9aBZ8wsxyTzhvY6BiwS`, data length 215,989 (45-byte header + 215,944 program bytes) |
| A3 | Upgrade authority | `8pFUuZgzab6mwXq2UqdEc2mbkDk6Wg68KSppJ4brfF4W` (held by the Silo team, equals `SECURITY.md`) |
| A4 | Source commit (this repository) | `e8684f369d1d1139b0f7f53bb89563d96543bca8` |
| A5 | `program/` git tree at A4 | `75f75111781c25b612a0ac04408cb8ae8383fc07` |
| A6 | Source files at A4 (sha256) | `program/Cargo.lock` `0db6d21009b36221c77155ecc00bb6f3a69eed4125918154ee1e8e1fef978ed2`, `program/Cargo.toml` `602a58b1774043924a0ca96eb31f5d78fa14f7b14b95a852cc3e8a527b709d92`, `program/src/lib.rs` `322dccf4a0d353142381ab435df721162bee8006a4f1bbd18c5d36af23d5ebd0` |
| A7 | Build image | `solanafoundation/solana-verifiable-build@sha256:12fd4c0a0790f0fc41ef74b0cdb6bccc167ba6137eb1adb749bac649481c86bd` |
| A8 | Build tool | `solana-verify` 0.5.2, crate sha256 `100996e26394122ef5358ec756f76ea1b41aab8dd959de8b10091b5017329a7c` |
| A9 | Candidate size | exactly 215,944 bytes |
| A10 | Candidate file sha256 (`sha256sum` of the exact `.so`) | `4033eb70a5d4d6f7d47654d278a54633bafd5366303b7882a17032d4cbbc3515` |
| A11 | Candidate solana-verify hash (`get-executable-hash`, trailing zeros trimmed) | `6d331f7522d2fe2d1c75e90d1495a264cf7d9de26fba4c5c96834ae834daae39` |
| A12 | Live bytes before (rollback target) | 215,944 bytes, sha256 `76424c24aa28d5f74e52781df0a98d95e43003ad2374c48f47acd1c21045599d`, last deploy slot 465229265 |
| A13 | Live solana-verify hash before (rollback buffer check) | **Open until step 0.6.** Computed only from the A12-bounded file (exactly the leading 215,944 bytes of the dump, sha256 = A12), two ways that must agree, and written into the approval record **before approval and before any buffer write**. After that it is a fixed constant like the others. Blank, disagreeing or changed: stop. |
| A14 | Mainnet genesis hash | `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` |

Two hash conventions: A10 and A12 are `sha256sum` of the exact bytes; A11 and A13 are solana-verify hashes (sha256 of the bytes
with trailing zero bytes removed). They are different values. Compare A10 only with a `sha256sum` result and A11 only with a
solana-verify result; never compare one convention with the other. The convention was reproduced offline for A11 on 8 Nov 2026:
the 215,944-byte candidate ends in 15 zero bytes; sha256 of the remaining 215,929 bytes is `6d331f75...`, equal to A11.

Build command: `solana-verify build <repo>/program --library-name xmr_sol_swap --base-image <A7>` (mount path `program`,
`/build` in the container). A build from a later commit is accepted only if `git rev-parse <commit>:program` equals A5 (same
input bytes) and the output equals A9, A10 and A11.

## 3. Source equivalence: what is and is not proven

The live bytes (A12) and the candidate (A10) were built from different checkouts on different platforms. Equivalence rests on
a direct comparison of the source, made offline on 8 Nov 2026, not on build metadata.

| Claim | Status | Evidence |
|---|---|---|
| The live program was built from private commit `cb0f0247e3006997c9588ddc39de0242edca6eb4` | Internal evidence, one machine | A local macOS build (cargo-build-sbf 4.3.0, platform-tools v1.57) of that `program/` directory gave A12, equal to the chain dump. Not reproduced by any CI. |
| The private `program/` has not changed since `cb0f0247e` | Proven (git) | Its tree is `d72afb6814dc88d19b00ceeabf6fc5dfa74a5267` at `cb0f0247e` and on private `main` today; `cb0f0247e` is the only commit touching it. |
| This repository's `program/` (A5) equals that source except comments and metadata | Proven (file diff) | `Cargo.lock` identical (A6 hash on both sides); `tests/swap.rs` identical (`d32effc4...` on both sides); `src/lib.rs` differs in three `//!` crate-doc comment lines only (line 1 and lines 13 and 14, same line count, so no code or line number moves); `Cargo.toml` differs in its `description` text only. `program/` is unchanged in this repository since its initial commit. |
| The comment and description edits do not change the bytes | Internal evidence, one machine | The same macOS build of this repository's tree also gave A12 (see `docs/VERIFY_BUILD.md`). |
| Dependencies are the same and locked | Proven (lockfile) | 708 dependency entries, all from the crates.io registry, each with a checksum in `Cargo.lock`; no git or path dependencies; nothing vendored. Direct pins: `anchor-lang =0.31.1`, `solana-curve25519 =2.2.7`. |
| Linux builds of A5 give A10 | Proven (CI, same toolchain) | Two Docker jobs (run 42503119763) and one non-Docker runner build (run 42490579014) all gave A10. |
| The macOS and Linux binaries behave the same | **Not proven by the build.** | No binary equivalence proof exists for the 1,672 differing bytes (instruction-level code generation and two relocation offsets). Covered by behaviour instead: section 6 runs the same tests against both binaries and rehearses old accounts under the new binary and the reverse; the differential test in `docs/verify-build/c5/` found identical behaviour on every path it covered, which is not all paths. |
| Either compiler is correct | Not proven | Out of scope; the same trust as any Solana program build. |

### 3.1 Effective build inputs (C4)

Source files alone do not fix a Rust build. These are every input that can change the bytes, for both builds, with the evidence
source of each row. The command outputs are in `BUILD_INPUTS.txt` of the internal review packet (offline, git and file reads only; not
published because it lists paths of the private repository).

| Input | Candidate (Docker, A4) | Live (macOS, private `cb0f0247e`) | Evidence source |
|---|---|---|---|
| Workspace manifest | `program/Cargo.toml` has its own `[workspace]` table, so it is the workspace root and no parent manifest is read. No `[profile]` section: the default release profile of cargo-build-sbf applies. | Same file except `description` (section 3); same `[workspace]`, no `[profile]`. | `git show A4:program/Cargo.toml`; `SOURCE_COMPARISON.txt` diff (internal review packet) |
| Lockfile | `program/Cargo.lock`, sha256 in A6 | identical bytes | A6; `SOURCE_COMPARISON.txt` |
| Build scripts | no `build.rs` in `program/`; dependency build scripts are inside the 708 checksummed crates | same | `git ls-tree -r` of both commits (no `build.rs` under the program directory) |
| Cargo config (`.cargo/config`, `.cargo/config.toml`) | none anywhere in this repository at A4. The workflow mounts only `program/` at `/build`, so the only other places Cargo reads are `/.cargo` and `$CARGO_HOME` inside image A7, fixed by its digest. | none anywhere in the private repository at `cb0f0247e` (whole tree). User level on the macOS build machine today: `~/.cargo` holds `bin`, `git`, `registry` only, no config file. Not recorded at build time. | `git ls-tree -r` of both commits; local listing 8 Nov 2026 |
| Toolchain config (`rust-toolchain`, `rust-toolchain.toml`) | none in the repository; toolchain = image A7 (host rust 1.97.1, cargo-build-sbf 4.3.0, platform-tools v1.57 whose rustc compiles the program) | none in the private repository; cargo-build-sbf 4.3.0 with platform-tools v1.57 (rustc 1.95.0-dev, target `v0`) selected by putting its `rust/bin` at the front of `PATH` (or `RUSTC` on a machine without rustup) | `git ls-tree -r`; image config history (internal review packet); `docs/VERIFY_BUILD.md` recipe |
| Environment (`RUSTFLAGS`, `CARGO_*`) | the workflow sets none (its `env:` holds ids, hashes and versions only) | the recipe sets only `PATH` (and `RUSTC` without rustup); no `RUSTFLAGS` or `CARGO_*` in that machine's shell today; not recorded at build time | workflow file; `docs/VERIFY_BUILD.md`; local `env` check 8 Nov 2026 |
| Features and flags | default features; `solana-verify build <repo>/program --library-name xmr_sol_swap --base-image A7` | default features; `cargo-build-sbf --tools-version v1.57 --no-rustup-override --skip-tools-install -- --locked` | section 2; `docs/VERIFY_BUILD.md` |

What this proves and does not: for the candidate, every input is either in the A5 tree or inside the digest-pinned image, so
the independent rebuild (step 0.3) checks all of them at once. For the live build, the repository side is proven by git; the
machine side (user-level Cargo config and environment at build time) is internal evidence from one machine, checked as it is
today, not as it was then. That is acceptable here because the live bytes are only the rollback target, identified by their
hash (A12), not by how they were built.

## 4. What the Docker build proves, and its trust inputs

- It proves **repeatability**: two separate jobs on two runners, sharing the same digest-pinned image and toolchain, produced
  byte-identical output. It does **not** prove compiler correctness, and it is not an independent toolchain: both jobs used the
  same image.
- The workflow sends no transaction, holds no key and makes no on-chain write. It **does** write files on the runners (build
  output, `build.json`, `hashes.json`, a read-only dump of the live program) and **uploads them as workflow artifacts**.
- Trust inputs that remain:
  - the published image A7 (pinned by digest; its own build inputs were fixed when the Solana Foundation built it);
  - `solana-verify` A8 (crate pinned by hash, built with `--locked`, so its dependencies come from crates.io with checksums);
  - `apt` packages on the runner (unpinned; used only to compile `solana-verify`, not the program);
  - crates.io downloads of the program's dependencies at build time (network access; integrity checked by the `Cargo.lock`
    checksums); GitHub runners and the commit-pinned actions.
- Not vendored, by decision: vendoring the crates would change the build input and make a new candidate. The independent
  rebuild (step 0.3) removes "only GitHub built it"; a different resolution or tampered input would change the bytes and fail
  A10.

## 5. Roles, signers and money

| Who | Does |
|---|---|
| Astra (internal model review lane) | Closure check of this revision before anything runs. |
| Upgrade authority holder | Approves the record (SOL amounts below, the window, the upgrade). Checks the buffer independently. Builds and signs the upgrade on their own machine with `8pFUu...`. Closes any buffer after hand-over. Signs a rollback and, later, the optional verification PDA. |
| Tracker (release operator) | Everything else: checks, backups, admission close and drain, buffer writes, hand-over, post-checks, release log. It never holds or asks for the upgrade authority key and never prepares a transaction for the authority holder to sign. |

Named accounts (written into the approval record before the window):

| Role | Account | Notes |
|---|---|---|
| Buffer fee payer | `T_FEE`, the tracker's fee payer, named by address | Pays the buffer rent and the write fees. |
| Buffer authority while writing | `T_BUF`, a tracker key, named by address | Only it can close the buffer before hand-over. |
| Buffer address | from `buffer-upgrade.json`, a keypair file generated for this buffer | Lets a failed write resume into the same buffer. |
| Buffer authority after hand-over | A3 | From then on only the authority holder can use or close it. There is no tracker-only cleanup after hand-over. |
| Upgrade fee payer and signer | the authority holder's own signer | Pays the upgrade fee. |
| Spill (receives the consumed buffer's lamports) | the authority holder's own address, named | In the Solana CLI versions we know, `program upgrade` uses its fee payer as the spill account. This is not assumed: step 0.5 records, with the authority holder's exact CLI version, which account received the lamports, and step 3.3 has them check the spill account before signing. The ~1.098 SOL funded by `T_FEE` therefore ends with the authority holder, not with the tracker. |
| Close recipient | before hand-over: `T_FEE`; after hand-over: the authority holder's address | Always passed explicitly with `--recipient`. |

Amounts (refresh on the day with `solana rent 215981`): each buffer is 37 + 215,944 = 215,981 bytes; rent-exempt minimum read
on 8 Nov 2026: 1,097,833,720 lamports (about 1.098 SOL). Two buffers are held during the window (upgrade and rollback, section
7), about 2.196 SOL, plus write fees. The approval record covers these amounts and their destinations.

## 6. Before the window (no mainnet writes)

0.1 **Approval record.** Copy section 2 and the named accounts of section 5 into the approval record (an entry in the internal
release log). It is drafted beforehand and completed with A13 from step 0.6; only a record in which A13 is filled can be approved.

0.2 **CI artifact.** Download the `docker-verified-build` artifact of run 42503119763. Check against the constants, not against
`hashes.json`: `hashes.json` `commit` equals A4 and `program_tree` equals A5; `deterministic` is `true`; `wc -c xmr_sol_swap.so`
equals A9; `sha256sum xmr_sol_swap.so` equals A10; `solana-verify get-executable-hash xmr_sol_swap.so` equals A11.

0.3 **Independent rebuild (required).** On a Linux x86_64 machine with Docker,
outside GitHub, from a fresh clone: `git status --porcelain --ignored` is empty (no `program/target`, no untracked `.cargo`),
`git rev-parse A4:program` equals A5, `sha256sum` of the three files equals A6, `docker image inspect` of A7 shows that digest,
then build with the command of section 2. Output must equal A9, A10, A11. The log names the machine and records the effective
inputs of section 3.1 as seen there.

Run on 8 Nov 2026 (`docs/verify-build/`): two builds on a separate linux x86_64 vm outside GitHub and two builds on a Mac under
amd64 emulation, all equal to A9, A10 and A11. The vm built from a source archive of A4, not from a fresh clone; its log prints
the sha256 of the three files of A6, which match. Emulation is another execution path: a mismatch there would have stopped the
procedure until explained. Whether these runs close C3 is for the closure review.

0.4 **Behaviour on both binaries.** Run `program/tests/swap.rs` (it runs against a compiled SBF file via `SBF_OUT_DIR`) once
with the candidate (A10) and once with the rollback copy (A12, from step 0.6). Same tests, same results.

0.5 **Rehearsal, both directions.** Two parts, because the program checks its declared id (`declare_id!` is A1, so the bytes
cannot execute under a fresh devnet program id). **Every claim about execution, including what happens in and after the upgrade
slot, rests only on part (a).** Part (b) proves CLI mechanics only.
- *(a) Execution, in a `solana-program-test` bank at the declared id A1* (the differential test in `docs/verify-build/c5/`
  does this):
  - Account compatibility: create escrows with the OLD bytes in every state (locked not ready, ready, past t0, past t1), swap
    the program to the NEW bytes, then claim and refund them and check the wrong-window refusals; then the reverse: escrows
    created under NEW, claimed and refunded under OLD (this is the rollback direction).
  - Upgrade-slot behaviour: load OLD as an upgradeable program at A1, create an escrow, upgrade it to NEW through the loader's
    upgrade instruction in slot N, send a claim and a refund that reach the program in slot N and record the exact result, then
    advance to slot N+1 and later and record from which slot NEW executes. If the bank cannot model the loader's visibility
    rule faithfully, the log says so and the slot-boundary behaviour stays **not proven**; the procedure does not depend on it
    (section 8.2 assumes the program may refuse transactions for a few slots around the upgrade).
  - Run on 8 Nov 2026: `docs/verify-build/c5/` (248 runs, 1,426 compared steps, 0 divergences, binaries switched before every
    step in both directions, deadlines included). It switches with a real loader upgrade followed by a slot warp, so the
    behaviour inside the upgrade slot itself is **not proven** by it. It covers the paths in its scripts, not all paths.
- *(b) CLI mechanics on devnet* with a throwaway program id and throwaway authority (nothing executes the escrow program here):
  write a buffer from the candidate with `--buffer buffer-upgrade.json`, interrupt it once and resume it into the same buffer,
  run the buffer checks of step 2, hand the authority over, upgrade, dump and compare, record which account received the buffer
  lamports (spill) with the authority holder's CLI version, and confirm whether that CLI version offers `--sign-only` /
  `--dump-transaction-message` for `program upgrade`. Repeat the upgrade back to the old bytes.

0.6 **Rollback copy and A13** (before approval; after the genesis check of step 2.0).

```bash
solana program dump -u "$RPC" 7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS live-v1-dump.so
wc -c < live-v1-dump.so                        # 215,944 or more; every byte after 215,944 is zero
head -c 215944 live-v1-dump.so > live-v1-76424c24.so   # the A12-bounded file; the only file used from here on
sha256sum live-v1-76424c24.so                  # equals A12, otherwise stop
solana-verify get-executable-hash live-v1-76424c24.so   # A13, way 1
python3 -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read().rstrip(b'\\0')).hexdigest())" live-v1-76424c24.so   # A13, way 2
```

Both ways must print the same value; that value is written into the approval record as A13 (step 0.1) and is fixed from then on.
The rollback buffer (step 2.3), the rollback rehearsal (step 0.4) and any rollback are made from `live-v1-76424c24.so` only,
never from the raw dump. Store both files in the release evidence folder and give the authority holder a copy.

0.7 **Maker admission gate.** The change of `docs/MAKER_ADMISSION_GATE_SPEC.md` (revision 2: including the write-ahead lock
record R9, the blockhash rule R10, the record-preservation rule R11 and tests T11 to T15) is implemented, reviewed, deployed
(by the tracker, after approval) and tested on stagenet/devnet. Without it there is no safe way to close admission (section 8.1 below explains
why the current maker cannot), and this procedure does not start.

## 7. The window

### Step 1. Close admission and drain (tracker)

1. Create the drain file on the maker's server (see the spec). The maker keeps running: claims, refunds, ready and XMR sweeps
   keep working; only new quotes and new swaps are refused. Do not stop the maker. Do not turn off the swap flag of Silo's
   hosted service: its claim relay also requires it, so turning it off would hold users' claims. No hosted service change is
   needed: it cannot open a swap without the maker.
2. Wait until the quiesce check of the spec (section 4 of the spec, revision 2) prints OK: admission closed, nothing in flight,
   every maker swap file proven final, void or never signed by its classification rules, and no escrow account with the maker
   as refunder on chain at a finalized slot. **A swap file with an empty `lockSig` and no account at its address is not "never
   locked"**: its lock may have been accepted by the RPC with the answer lost, may have landed and been settled, or may still
   land late. Such a file stays NOT OK until the check has positive evidence (outcome, expiry of the lock's blockhash, or a
   durable never-signed record). Nothing is deleted or edited to make the check pass: swap files, journals and secrets are
   backed up before the window and kept. A maker swap lasts at most t1 = 4 hours after its lock plus one refund.
3. List every other escrow of the program (`getProgramAccounts` A1, data size 194; strangers can lock directly, the program is
   permissionless). They are not blocking, see 8.2, but their ready flag, t0 and t1 are recorded.

### Step 2. Write and verify the upgrade buffer and the rollback buffer (tracker)

2.0 **Cluster check, before any write.** `RPC` is set once for the whole session. `solana genesis-hash -u "$RPC"` must print
A14. A placeholder name or URL is not a check.

2.1 **Write.**

```bash
solana-keygen new --no-bip39-passphrase -o buffer-upgrade.json     # buffer address only, not an authority
solana program write-buffer xmr_sol_swap.so -u "$RPC" --buffer buffer-upgrade.json \
  --fee-payer <T_FEE signer> --buffer-authority <T_BUF signer>
```

If the write fails: do not start a second buffer. `solana program show --buffers --buffer-authority <T_BUF> -u "$RPC"` lists
what exists; resume with the same `--buffer buffer-upgrade.json`, or close it
(`solana program close <BUFFER> --authority <T_BUF signer> --recipient <T_FEE> -u "$RPC"`) and start again.

2.2 **Verify the buffer** (all must pass; any failure: close it as above, stop, report):

```bash
solana account <BUFFER> -u "$RPC" --output json        # owner is BPFLoaderUpgradeab1e11111111111111111111111
solana account <BUFFER> -u "$RPC" --output-file buffer.bin
wc -c < buffer.bin                                      # exactly 215,981 = 37 + A9 (the buffer's capacity)
head -c 4 buffer.bin | xxd -p                           # 01000000: account type Buffer
head -c 5 buffer.bin | tail -c 1 | xxd -p               # 01: authority present (bytes 5..36 are the authority, = T_BUF)
tail -c +38 buffer.bin | head -c 215944 | sha256sum     # equals A10 (sha256 convention)
solana-verify get-buffer-hash -u "$RPC" <BUFFER>        # equals A11 (solana-verify convention)
```

The 37-byte header offset is valid only after the owner and type checks above. The size check is against the ProgramData
capacity read on the day: `solana account 9jSb... -u "$RPC"` data length must still equal A2 (215,989), so 215,944 program
bytes fit with no `extend`. A candidate of any other size is a different candidate and stops the procedure.

2.3 **Rollback buffer (hot rollback).** Same steps with `buffer-rollback.json` and the A12-bounded file `live-v1-76424c24.so` of
step 0.6; its checks are A12 (sha256) and the fixed A13 (solana-verify). It is handed to A3 together with the upgrade buffer,
so an emergency rollback needs one signature by the authority holder and does not wait for a drain.

### Step 3. Final re-check, hand-over, the upgrade authority holder signs

3.1 **Final re-check (tracker, immediately before the hand-over, within about 10 minutes of signing):** the quiesce check again
(OK); ProgramData still A2, authority A3, live bytes A12, last deploy slot 465229265; both buffers unchanged (step 2.2 again);
no listed escrow (maker or stranger) has t0 or t1 within 15 minutes of the planned signing time, otherwise postpone. A snapshot
does not freeze the program; it is the last check, not a lock. Escrows created after this snapshot cannot be checked; that is
the residual risk of section 8.4.

3.2 **Hand-over:** `solana program set-buffer-authority <BUFFER> --new-buffer-authority A3 --buffer-authority <T_BUF signer>
-u "$RPC"` for both buffers; `solana program show <BUFFER>` shows authority A3 and data length 215,944. If the result is
ambiguous: read the buffer's authority and the signature status before doing anything else; never resend blindly.

3.3 **Upgrade authority holder, on their own machine with their own CLI and their own RPC.** The tracker gives them only the
BUFFER address and the CI run URL; they compare everything with the approval record, not with the message.

```bash
solana genesis-hash -u "$RPC"                          # A14
solana account <BUFFER> -u "$RPC" --output-file buffer.bin
# owner, type, authority A3 and length as in step 2.2; then:
tail -c +38 buffer.bin | head -c 215944 | sha256sum    # A10
solana-verify get-buffer-hash -u "$RPC" <BUFFER>       # A11
solana program upgrade <BUFFER> 7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS -u "$RPC" \
  --upgrade-authority <authority signer> --fee-payer <authority signer>
```

They type the upgrade command themselves; nobody hands them a prepared or encoded transaction. Before approving the signature
they check what it does: program A1, ProgramData A2, buffer `<BUFFER>`, spill = their own address, authority A3 (with
`--sign-only` / `--dump-transaction-message` if step 0.5 confirmed their CLI offers it, otherwise on the hardware wallet
screen). The program upgrade authority holder signs only if every value they read themselves equals the approval record.

### Step 4. After the upgrade (fail closed)

All must pass **before** admission reopens:

```bash
solana confirm -v <signature> -u "$RPC"                                   # finalized, no error
solana program dump -u "$RPC" 7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS after.so
head -c 215944 after.so | sha256sum                                        # A10, zeros after byte 215,944
solana-verify get-program-hash -u "$RPC" 7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS                   # A11
solana program show -u "$RPC" 7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS # authority A3, last deploy slot newer than 465229265
solana account <BUFFER> -u "$RPC"                                          # gone (consumed); the spill account received its lamports
```

Then the quiesce check once more (strangers' escrows still readable), then remove the drain file. The next swap after the
window is a small test swap by the team; if it fails, close admission again and go to the rollback decision. Log the slot, the
signature, A10, A11, the dump hash and the times. The rollback buffer stays with A3 for an observation period (for example 48
hours), then the authority holder closes it with `--recipient` their own address.

If any post-check fails, or the result is unclear: admission stays closed, the authority holder is told and decides on a
rollback.

### Failure and ambiguity rules

| Situation | Rule |
|---|---|
| Buffer write interrupted | Resume into the same buffer keypair, or close it to `T_FEE`. Never create a second buffer without listing and accounting for the existing one. |
| Buffer check fails | Close it to `T_FEE` (tracker still authority), stop, report. |
| Hand-over unclear | Read the buffer authority and signature status before anything else. If the authority is A3, only the authority holder can close the buffer. |
| Upgrade transaction unclear (timeout, no answer) | Admission stays closed. Check signature status, live bytes and last deploy slot, and whether the buffer still exists. Live = A10 and buffer gone: it landed, go to step 4. Live = A12 and buffer still there with authority A3: it did not land; wait until the signature is not found and its blockhash has expired before the authority holder signs again. Anything else: stop, report, no retry. |
| Post-check fails | Admission stays closed; rollback decision by the authority holder. |
| Quiesce check NOT OK on a swap file it cannot prove (for example an empty `lockSig` and no account) | Admission stays closed and the window waits. Resolve only with the evidence of the spec (outcome, blockhash expiry, durable never-signed record); never delete, move or edit the file to make the check pass. If no evidence can be found, the file stays NOT OK and the authority holder is told. |

## 8. Admission, open escrows and compatibility

### 8.1 What the current maker can and cannot do

The maker's start gate (`createStartGate` in the private maker source) closes only on failed configuration checks (sweep
address, caps, API token) or while monero-wallet-rpc is unreachable before the initial successful address check; once the
address has validated, the answer is cached and nothing at run time can close it. There is no operator pause. Closing it by
configuration needs a restart, which can interrupt an admission between storing a swap and locking its SOL, and a closed start
gate also holds XMR sweeps. Hence the admission gate of `docs/MAKER_ADMISSION_GATE_SPEC.md` is a hard prerequisite.

### 8.2 Escrows that cannot be drained

The program is permissionless: anyone can lock an escrow directly, with their own refunder, at any time, and the program has no
pause instruction (adding one is a logic change, out of scope). Zero escrows globally cannot be guaranteed and is not
required. Instead this upgrade relies on proven compatibility:

- Same source (section 3), so the same account type and size (194 bytes, same Anchor discriminator), same PDA seeds, same
  instruction data and error codes, same time windows. Escrows created under the old bytes are read and settled by the new
  bytes in the same way, and the reverse; step 0.5 tests both directions and step 0.4 tests both binaries.
- Each transaction runs entirely on one binary; nothing is half applied. Around the upgrade the program may refuse transactions
  (expected: in the upgrade slot only; to be measured at the declared id in step 0.5a, not on devnet). This procedure assumes
  the refusal can last a few slots and does not promise that a refused transaction can simply be retried. See 8.4.
- This same-source upgrade must not introduce any stricter account validation, new account type, size or discriminator. Any
  such change belongs to protocol v2 and needs its own compatibility review.

### 8.3 Emergency path

Drain before the upgrade is the planned path, not the only one. If the new binary itself blocked claim or refund, open escrows could not be
settled until a rollback, so waiting for a drain would be wrong. The hot rollback buffer (step 2.3) lets the authority holder sign
the rollback at once, with admission closed and without a drain; the old binary settles escrows created under the new one (tested in
step 0.5). Planned rollback otherwise follows the same steps as the upgrade, with A12 and A13 as the expected values. A rollback
restores working bytes and loses verifiability again.

### 8.4 Deadlines, exposed secrets and the residual risk (R-1)

A refused transaction is not harmless for every instruction. `claim` carries the claimer's scalar `a` and `refund` carries the
refunder's scalar `b`. Once signed bytes holding a scalar have been sent to an RPC node or simulated, the scalar must be treated
as public, even if the transaction then fails: it may be recorded on chain as a failed transaction, and the nodes have seen it.

- A claim refused shortly before t1 and retried at or after t1 fails for good: from t1 only refund is open, and the refunder
  now knows `a`, so he can take the XMR and refund the SOL.
- A not-ready refund refused shortly before t0 and retried at or after t0 fails for good: from t0 only claim is open, and the
  claimer now knows `b`, so she can take the XMR and claim the SOL.
- Byte compatibility cannot undo an exposure or reopen a window. No retry promise is made.

Who is protected and how:

| Escrows | Protection |
|---|---|
| The maker's (all Silo users) | None open at signing: admission closed, quiesce check OK (zero escrows with the maker as refunder or claimer on chain, every swap file proven), re-checked within about 10 minutes of signing (step 3.1). |
| Strangers' escrows listed at the snapshot | Signing time kept at least 15 minutes away from every listed t0 and t1 (step 3.1, C10). |
| Strangers' escrows created after the last snapshot | **Not protected.** The program is permissionless and has no pause; anyone can lock an escrow with a t0 or t1 seconds after the signing time. |

**Residual risk R-1 (needs explicit acceptance in the approval record, C16).** A client outside Silo that uses the program directly,
and sends a claim or a not-ready refund within seconds of that escrow's deadline exactly while the upgrade takes effect, can lose
that swap: its secret is exposed and its window closes before a retry can land. It cannot touch Silo users (no maker escrow is
open) and it needs a client that already reveals at the last moment, which is unsafe without any upgrade (congestion or an RPC
outage does the same; the program's own documentation tells clients to keep a safe reveal margin). It cannot be removed without
a pause instruction, which is a logic change outside this same-source upgrade. Plain wording: *"For a moment
(expected under a second, at most a few seconds) the swap program will refuse transactions. Our own users are not affected,
because we finish all our swaps before it. Someone outside Silo who uses the program directly and waits until the last second
before a deadline could lose that swap during that moment. We cannot prevent this, because the program is open to everyone and
has no pause button."*

## 9. Signing checklist (minimum conditions before the program upgrade authority holder signs)

| # | Condition | Evidence |
|---|---|---|
| C1 | Section 2 constants and section 5 named accounts are in the approved approval record | approval record in the internal release log |
| C2 | CI artifact equals A4, A5, A9, A10, A11 and is deterministic | step 0.2 output |
| C3 | Independent rebuild outside GitHub, from a clean fresh clone, equals A9, A10, A11 from A5, with its effective inputs recorded. Runs done 8 Nov 2026 on a linux x86_64 vm and a Mac under amd64 emulation (step 0.3); closure to be confirmed in review. | `docs/verify-build/` |
| C4 | Source equivalence (section 3) and effective build inputs (section 3.1: workspace manifest, lockfile, build scripts, Cargo config, toolchain config, environment, flags) recorded for both builds, each row with its evidence source | sections 3 and 3.1; `SOURCE_COMPARISON.txt` and `BUILD_INPUTS.txt` in the internal review packet (not published); step 0.3 log |
| C5 | Same test results on both binaries; compatibility passed in both directions; upgrade-slot behaviour measured at the declared id (or recorded as not proven) | step 0.4 log; step 0.5a: `docs/verify-build/c5/` |
| C6 | Devnet CLI mechanics drill passed (resume, header checks, hand-over, spill account observed, upgrade and back). No execution claim rests on it. | step 0.5b log |
| C7 | Rollback file is exactly the leading 215,944 bytes of the dump with sha256 A12; A13 computed from that file in two ways that agree and written into the approval record before approval and before any buffer write; rollback buffer written from that file | step 0.6, approval record |
| C8 | Maker admission gate (spec revision 2) deployed and tested, including T11 to T15: lock accepted with the answer lost, late landing, crash between storing the file and sending the lock, an empty `lockSig` with no account stays NOT OK, the check changes nothing on disk | spec acceptance tests, deploy record |
| C9 | Quiesce check OK under the spec's classification rules at the drain and again within about 10 minutes of signing; no file was accepted on an empty `lockSig` alone; every ambiguous file resolved by evidence, none deleted; state directory backed up | step 1.2 and 3.1 output, backup record |
| C10 | No listed escrow has t0 or t1 within 15 minutes of the signing time | step 3.1 list |
| C11 | Both buffers checked (owner, type, authority, length, A10/A11 and A12/A13) by the tracker and the upgrade buffer again by the authority holder | step 2.2, 2.3, 3.3 |
| C12 | Genesis hash A14 checked on the authority holder's RPC | step 3.3 |
| C13 | Rent refreshed; fee payer, buffer authority, spill and close recipients named; amounts in the approval record | section 5 |
| C14 | The authority holder builds and inspects the upgrade themselves (program, ProgramData, buffer, spill, authority) | step 3.3 |
| C15 | Astra closure check of this revision passed | review record |
| C16 | Residual risk R-1 (section 8.4) explicitly accepted in the approval record | approval record |

## 10. Sequencing with protocol v2

Protocol v2 (in development, not in this repository) stays on hold and is not affected by this procedure except as follows:
its preflight and tests expect the live program to be the old build (`76424c24...`, the `OLD_SHA` constant of its preflight and
bank test scripts, the "old artifact" of its upgrade test, and its rollback target). After this upgrade those expectations are stale and must be re-bound
to A10/A11 (and the compatibility tests rerun with the Docker artifact as the old binary) before v2 can proceed. v2 must be
built only through the Docker workflow and follow this procedure with its own constants.

## 11. Public verification (later, separate decision)

Once the repository is public (a separate decision, not part of this procedure):

```bash
solana-verify verify-from-repo -u "$RPC" --program-id 7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS \
  <public repo https url> --commit-hash e8684f369d1d1139b0f7f53bb89563d96543bca8 --mount-path program \
  --library-name xmr_sol_swap \
  --base-image solanafoundation/solana-verifiable-build@sha256:12fd4c0a0790f0fc41ef74b0cdb6bccc167ba6137eb1adb749bac649481c86bd
```

It rebuilds and compares with the chain. It then offers to write a verification PDA on chain; that write must be signed by the
upgrade authority to count, so the program upgrade authority holder signs it (answer no at the prompt until then, or prepare
it with `solana-verify export-pda-tx` for the authority holder to inspect and sign). Submitting to the public verification
service is a publication and needs its own approval.

## 12. What this procedure does not cover

No change to the program logic (protocol v2), no change of upgrade authority, no multisig, no freeze, no
publication of the repository, no change to the maker beyond the separately reviewed admission gate.
