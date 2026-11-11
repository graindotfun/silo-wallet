# Swap maker

The maker service for the no-bridge XMR/SOL swap (`maker.mjs`). Operator notes are in a runbook that is not published here. Paths such as `docs/...` in this file are under the repository root; the maker itself is at `web/prototypes/xmr-sol-atomic-swap/maker/`.

## Retention of swap records

The maker writes one record file per swap. A record holds per-swap data (the user's Solana refund address, signatures, and until the swap is finished the one-time view key), so it is not kept forever.

- A swap is finished when its result is proven at finalized commitment, no send attempt is still open and the maker's secrets are already removed.
- 14 days after that, the file is reduced to the swap id, direction, outcome, finish time, the creation day, the amounts and the escrow identity (the PDA, and for a SOL to XMR swap the user's refund address, which the upgrade check needs to prove the escrow is gone). The file stays (the journal and the quiesce check count files); the details go.
- A record whose funds could still be at risk (open, waiting for proof, an unsettled attempt, a secret still present) is never changed automatically.
- The rule runs at start and then every hour. A clock earlier than 10 Nov 2026, or a finish time in the future, prunes nothing.
- Older finished records without a finish time use the file's last change time.

One line for the privacy page: "The swap maker deletes the details of a finished swap after 14 days and keeps only its outcome and amounts."

The journal (`journal.jsonl`) is separate: it is not rotated by this rule.

## Public lane

Optional, off by default: the same routes without a token, with its own caps. See `docs/OPEN_MAKER_PUBLIC_LANE.md`.
