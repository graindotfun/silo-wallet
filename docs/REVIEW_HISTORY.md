# Review history of the upgrade procedure

internal procedure, published for transparency. tracker is our release operator role. astra is an internal model review lane, not an audit.

This page covers `docs/UPGRADE_TO_VERIFIED_BUILD.md`, `docs/MAKER_ADMISSION_GATE_SPEC.md` and the maker change that spec
describes, and the stopped-maker window that was used instead. In plain terms:

- The upgrade procedure failed internal review in round 1 (no fixed acceptance criteria; pause and drain incomplete) and in
  round 2 (ambiguous lock evidence; permissionless timing risk; rehearsal; process order).
- A separate review of the stopped-maker window procedure also failed: stopping the maker before proving it quiet could strand
  a swap; five minutes is not proof that a lock's blockhash has expired; two scans do not prevent a later escrow.
- The maker admission gate implementation failed its review once (2 high, 1 medium) and was fixed. Its refund path fix is still
  under review.
- The upgrade was nevertheless executed on 2026-11-08, by the decision of the upgrade authority holder, with the maker stopped
  and the residual risk stated in section 13 of `docs/UPGRADE_TO_VERIFIED_BUILD.md`. The maker remains stopped (see "Executed"
  below).

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

Smaller items of round 2 (execution claims resting on a devnet drill, the rehearsal, the order of the process steps, effective
build inputs, how the rollback hash is computed, the rebuild outside GitHub) were also changed in revision 3.

## Stopped-maker window procedure: failed

A shorter procedure for the window, with the maker stopped instead of the admission gate, was reviewed separately and failed:

| Finding | What it was |
|---|---|
| Stop before proof | Stopping the maker before proving that it is quiet could strand a swap. |
| Blockhash expiry | Waiting five minutes is not proof that the blockhash of a possible unrecorded lock has expired. |
| Later escrows | Two scans do not prevent an escrow created after them. |

What was done about them in the window: every one of the maker's 5 swap files was final and no escrow of anyone was open in any
scan (two before the buffer hand-over, two in the signing page seconds before signing). The last point cannot be removed without
a pause instruction; it is the residual risk of section 13.3 of `docs/UPGRADE_TO_VERIFIED_BUILD.md`.

## Maker admission gate implementation: failed once, fixed

The implementation of the spec was reviewed once and failed with 2 high and 1 medium findings. It was fixed: the lock is
simulated unsigned and then signed in memory, absence of a lock needs fresh and coherent evidence, and funding transactions
that are not escrows are classified. Its refund path fix is still under review. It is not deployed and was not used for the
upgrade.

## Current state

| Item | State |
|---|---|
| Procedure revision 3 and spec revision 2 | Failed rounds 1 and 2, findings answered in revision 3; executed in a variant by the upgrade authority holder's decision |
| Stopped-maker window procedure | Failed its separate review; executed anyway with the residual risk stated (section 13 of the procedure) |
| Maker admission gate | Fixed after a failed review; refund path fix still under review; not deployed, not used for the upgrade |
| Rebuilds outside GitHub | Done, `docs/verify-build/` |
| Differential test of the two binaries | Done for the paths it covers, `docs/verify-build/c5/` |
| The upgrade | Executed 2026-11-08, slot 467051728, variant "maker stopped" (see "Executed") |
| The maker | Stopped since the window, not restarted, until the refund path is reviewed and a decision is documented |

## Executed

Executed on 2026-11-08: upgrade transaction
`5gBdxnNNfjbicy4V7ZGegCXBPP8BPXRvNHbYqcMuCvmTo8vZMXXN6kq6BBt6EFsaiVd44AsurSz8F1pZ96JXzcBx`, slot 467051728, block time
2026-11-08 20:37:25 UTC. The full record is section 13 of `docs/UPGRADE_TO_VERIFIED_BUILD.md`.

- Variant: the maker was stopped instead of closing admission with the admission gate, because the gate was not deployed.
  Finalized escrow scans found zero open escrows, of anyone: twice before the buffer hand-over (20:20 and 20:25 UTC) and
  twice in the signing page seconds before signing (20:30:39 and 20:30:44 UTC). The maker's 5 swap files were all final and its journal unchanged.
- Buffers: the upgrade buffer `2HUNn1Q3QXuLnR6Ndh6nCxnLbfZY7uy8JQxgBKSvhDSU` (Docker build, consumed by the upgrade) and the
  rollback buffer `9BFEveajgqYcBqqK8zEFisJxy8YKytTqLc8ad7Wfv1TN` (previous bytes, still held by the upgrade authority), both
  written and verified on mainnet beforehand.
- Signing: the authority key lives in a browser wallet, so a local signing page in the authority holder's own browser built the
  single upgrade transaction, decoded every field (23 rows), required green checks, simulated it and refused to send if the
  wallet changed the message. The wallet did once (it added two compute budget instructions); the page stopped and nothing was
  sent, and the page was then changed to build those two instructions itself. Nothing was handed over as an opaque
  transaction. This replaces the CLI command of step 3.3 of the procedure.
- Residual risk accepted by the upgrade authority holder: the last scans were seconds before signing and the signature landed
  at 20:37:25 UTC, minutes later. An escrow created by someone outside Silo in those minutes could have been caught by the
  upgrade (R-1). None existed in any scan.
- Result: the live program equals the Docker build (`4033eb70a5d4d6f7d47654d278a54633bafd5366303b7882a17032d4cbbc3515`);
  Docker workflow run 42521490252 after the upgrade: `FULL MATCH`.
- The maker stays stopped until the refund path has been reviewed and a decision is documented.
