# Plain summary: making the swap program verifiable

internal procedure, published for transparency. tracker is our release operator role. astra is an internal model review lane, not an audit.

One page, plain language. The full procedure is `docs/UPGRADE_TO_VERIFIED_BUILD.md`. The upgrade itself has not happened and
has no date.

## What the upgrade is

The XMR/SOL swap program on Solana works, but it was compiled on a Mac, and nobody else can rebuild those exact bytes. So
nobody outside can check that the program on chain is the code we show. We rebuild the **same code** inside a sealed, public
build box (a pinned Docker image). Anyone can repeat that build and get the same bytes; it has been repeated on GitHub's linux
runners, on a separate linux machine and on a Mac under emulation, with the same result (`docs/verify-build/`). We then replace
the program's bytes with those. The code does not change and old swaps keep working, but the bytes do, so it is a real upgrade,
and only the program upgrade authority holder can sign it.

## What can go wrong, and what protects against it

| Risk | Protection |
|---|---|
| Wrong bytes get signed | The expected fingerprints are written down before anything is built. The bytes are checked by the CI, by independent builds outside GitHub, by the tracker, and by the upgrade authority holder on their own machine before signing. Any mismatch stops everything. |
| A Silo swap is in progress during the switch | The maker stops taking new swaps (a switch only root on the maker's server can flip), finishes or refunds every open swap, and a check must prove that none is left. A swap whose record is unclear counts as "not finished" until proven. Nothing is deleted to make the check pass. |
| The new bytes misbehave | Both versions are tested on the same tests, and old swaps are tested on the new bytes and the reverse. A differential test (248 runs, 1,426 steps) found identical behaviour on every path it covered; it does not cover all paths. A copy of the old bytes sits ready, so the program can be switched back with one signature. |
| Someone outside Silo is caught by the switch | See the residual risk below. |

## The steps that need the upgrade authority holder

1. Approve the approval record: the fixed fingerprints, the accounts involved, and about 2.2 SOL held for two buffers during
   the window (most of it comes back).
2. Accept the residual risk below, explicitly, in that record.
3. On the day, on their own computer: check the network fingerprint and the buffer's fingerprint independently, type the
   upgrade command themselves, and sign only if every value matches the record. Nobody sends them a ready-made transaction.
4. After the checks pass: a small test swap by the team. Later, close the rollback buffer (its SOL comes back).
5. If anything looks wrong at any point: swaps stay closed and the upgrade authority holder decides on switching back.

## Residual risk to be accepted

For a moment (expected under a second, at most a few seconds) the swap program will refuse transactions. Our own users are not
affected, because we finish all our swaps before it. Someone outside Silo who uses the program directly and waits until the last
second before a deadline could lose that swap during that moment. We cannot prevent this, because the program is open to
everyone and has no pause button. Adding one would change the program's logic, which this upgrade does not do.

## Gates that are still open

| Gate | State |
|---|---|
| Maker "stop new swaps" switch: built, reviewed, deployed and tested | Written; failed internal review once (2 high, 1 medium); being fixed, not re-reviewed, not deployed |
| Independent rebuild outside GitHub | Done on a linux x86_64 vm and a Mac under amd64 emulation; closure to be confirmed in review |
| Tests: both versions, old and new swaps both ways, the moment of the switch | Differential test done (`docs/verify-build/c5/`); the moment inside the upgrade slot is not measured by it |
| Practice run of the commands on devnet | Open (tracker) |
| Fingerprint of the old bytes (A13) recorded before approval | Open (tracker) |
| Closure review of the procedure | Open (Astra) |
| Approval of the upgrade, the SOL amounts and the risk above | Open (upgrade authority holder) |
