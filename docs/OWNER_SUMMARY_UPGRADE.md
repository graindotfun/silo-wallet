# Plain summary: making the swap program verifiable

internal procedure, published for transparency. tracker is our release operator role. astra is an internal model review lane, not an audit.

One page, plain language. The full procedure is `docs/UPGRADE_TO_VERIFIED_BUILD.md`. The upgrade was executed on 2026-11-08;
what changed against the plan below is in "Status after the upgrade" at the end.

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

The program is open to everyone and has no pause button. Adding one would change the program's logic, which this upgrade does
not do. On 2026-11-08 the last two escrow scans were seconds before signing (20:30:39 and 20:30:44 UTC) and found no escrow of
anyone; the signature landed at 20:37:25 UTC, minutes later. The risk is that someone outside Silo created an escrow in those
minutes and sent a claim or refund near its deadline exactly as the upgrade took effect. None existed in any scan. Our own users
were not affected: the maker was stopped and had no open swap.

## Status after the upgrade (2026-11-08)

The upgrade was made on 2026-11-08 in transaction
`5gBdxnNNfjbicy4V7ZGegCXBPP8BPXRvNHbYqcMuCvmTo8vZMXXN6kq6BBt6EFsaiVd44AsurSz8F1pZ96JXzcBx` (slot 467051728). The live program
now equals the Docker build, so anyone can rebuild it and compare. It was done in a simpler variant than the plan above: the
maker was stopped instead of using the "stop new swaps" switch, which was not ready, and, because the authority key lives in
a browser wallet, the upgrade was built and checked field by field in a local signing page in the authority holder's own
browser and signed in that wallet, instead of a typed command. The full record is section 13 of `docs/UPGRADE_TO_VERIFIED_BUILD.md`.

| Item | State |
|---|---|
| Live program equals the Docker build | Done, checked on chain after the upgrade |
| Open swaps at signing | None, of anyone, in finalized scans before the hand-over and twice just before signing |
| Residual risk above | Accepted by the upgrade authority holder before signing; the gap between the last scan and the upgrade was minutes |
| Maker "stop new swaps" switch | Not deployed and not used |
| Old bytes, for switching back | In a rollback buffer held by the upgrade authority holder, and in `docs/verify-build/bins/old_live.so` |
| Maker | Stopped, until the refund path is reviewed and a decision is documented; no new XMR to SOL swaps until then |
| Team test swap after the upgrade | Not made yet, waits for the maker |
| Closing the rollback buffer | Later |
