# Review history of the upgrade procedure

internal procedure, published for transparency. tracker is our release operator role. astra is an internal model review lane, not an audit.

This page covers `docs/UPGRADE_TO_VERIFIED_BUILD.md`, `docs/MAKER_ADMISSION_GATE_SPEC.md` and the maker change that spec
describes. The procedure failed internal review twice. The maker change failed its review once. Nothing in them has been
executed on chain.

## Round 1: failed

| Finding | Severity | What it was | State |
|---|---|---|---|
| No immutable acceptance criteria | High | The procedure accepted the bytes to sign by comparing a CI run with its own output (`hashes.json`). Any commit builds deterministically and matches its own metadata, so that comparison could not show that the right program was being signed. | Fixed in revision 2: fixed constants (commit, `program/` tree, file hashes, image digest, tool hash, size, sha256, solana-verify hash, rollback target, genesis hash) written before any build. Every check compares with them; a changed value is a new candidate and a new review. |
| Pause and drain incomplete | Medium, blocked signing | The maker had no way to stop new swaps at run time without a restart, its admission check could race, and stopping it would also stop refunds. The procedure could not prove that no Silo swap was open at the moment of the upgrade. | Answered in revision 2 with a design for a maker admission gate (`docs/MAKER_ADMISSION_GATE_SPEC.md`) and a read-only quiesce check. Its implementation is still open, see below. |

## Round 2: failed

| Finding | Severity | What it was | State |
|---|---|---|---|
| Ambiguous lock evidence | Medium, blocked signing (part 1) | The quiesce check counted a swap file with no recorded lock signature and no account on chain as "never locked". The maker writes the signature only after the send returns, so a lock accepted with the answer lost leaves no signature and can still land. | Fixed in revision 3 of the procedure and revision 2 of the spec: every swap file needs positive evidence (final, outcome proven, expired write-ahead record, never signed, or expired by process boundary); anything else stays NOT OK. New rules: sign, record, then send; recent blockhash only; swap files, journals and secrets are never deleted or edited to pass the check. New tests T11 to T15. |
| Permissionless timing risk | Medium, blocked signing (part 2) | The procedure promised that a transaction refused during the upgrade could simply be retried. A claim or refund carries a secret; once sent it must be treated as public, and near a deadline a retry can come too late. Anyone can use the program directly, and it has no pause. | Fixed in revision 3: the promise was removed. Silo's own swaps are closed and proven settled before signing, listed escrows of others are kept 15 minutes away from their deadlines, and the remaining risk to escrows created by others after the last check is named (R-1) and has to be accepted explicitly in the approval record. |

Smaller items of round 2 (execution claims resting on a devnet drill, effective build inputs, how the rollback hash is
computed, the rebuild outside GitHub) were also changed in revision 3.

## Maker admission gate implementation: failed once

The implementation of the spec was reviewed once and failed with 2 high and 1 medium findings. It is being fixed. It has not been
re-reviewed and it is not deployed. The upgrade procedure does not start without it (step 0.7, C8).

## Current state

| Item | State |
|---|---|
| Procedure revision 3 and spec revision 2 | Closure review of round 2 findings not yet done |
| Maker admission gate | Being fixed after a failed review |
| Rebuilds outside GitHub | Done, `docs/verify-build/` |
| Differential test of the two binaries | Done for the paths it covers, `docs/verify-build/c5/` |
| The upgrade | Not executed, no date |
