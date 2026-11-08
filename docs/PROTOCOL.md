# XMR to SOL atomic swap: protocol (beta version)

This describes the beta version that is live today. A version 2 is planned and will change parts of this (for example
how the view key is shared). There is no date for it. The escrow program has had no independent external security review.

Source: `program/src/lib.rs` (escrow), `lib/silo/atomic-swap/` (client logic), `lib/silo/atomic-driver.mjs` (runner).

Window specifics (`t0`, `t1`, the bounds and margins below) will change if protocol v2 ships.

## Roles
- Bob, the maker ("refunder"): holds SOL, wants XMR.
- Alice, the user ("claimer"): holds XMR, wants SOL.

## Keys
- Alice has a spend-key share `a` with public point `A = a*G`. Bob has `b` with `B = b*G`. Both are ed25519 points, the
  same curve Monero uses.
- The swap's Monero address has spend key `A + B` and a fresh random view key `v` made for this swap. `v` is shared with
  the maker (see `README.md`).
- Each side proves it knows the discrete log of its share (a Schnorr proof of knowledge bound to the swap id and role), so
  neither can choose a share that cancels the other's.

## Escrow program (Solana)
Program id `7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS`. The swap account is a PDA derived from the refunder and the swap id.

| Instruction | Who | Effect |
|---|---|---|
| `lock(swap_id, claimer, claim_point, refund_point, amount, t0, t1)` | Bob | Creates the swap account holding `amount` lamports. Requires `amount > 0`, `now < t0 < t1`, valid distinct non-identity points. |
| `set_ready()` | Bob | Marks the swap ready (Bob saw Alice's XMR with enough confirmations). Only before `t0`, only once. |
| `claim(secret)` | anyone | Pays the SOL to the recorded claimer if `secret*G == claim_point` and the claim window is open. Publishes `a` in the event. |
| `refund(secret)` | anyone | Returns the SOL to Bob if `secret*G == refund_point` and the refund window is open. Publishes `b` in the event. |

## Windows
```
now < t0, not ready : refund only   (Bob aborts, Alice has not lost XMR)
now < t0, ready     : claim only    (normal path)
t0 <= now < t1      : claim only    (Bob went quiet; Alice claims)
t1 <= now           : refund only   (Alice went quiet; Bob refunds)
```
Successful claim and refund have mutually exclusive windows. This does not prevent scalar exposure through simulation or
rejected transactions; clients must enforce a safe reveal timing before broadcasting secret-carrying bytes.

## Flow
1. Alice requests a quote and registers `A`, its proof and `v`. Registration does not include `a`.
2. Bob locks the SOL (`lock`) with `t0`, `t1`. Alice accepts only if the timelocks are inside her bounds
   (`lib/silo/atomic-swap/swap-core.mjs`: `t0` at least 1 h and at most 3 h away, `t1` at most 26 h away, at least 1 h
   between `t0` and `t1`).
3. Alice sends XMR to the swap address. Bob waits for confirmations (10 by default) and calls `set_ready`.
4. Alice claims the SOL before `t1` (with a safety margin). The claim reveals `a`; Bob now holds `a + b` and can sweep.
5. If Alice never claims, after `t1` Bob refunds, which reveals `b`. Alice can then derive the swap address's full keys
   and recover her XMR.

## What is public
Everything on Solana: the swap account, `t0`, `t1`, the amount, both public points, and the revealed secret in the
claim or refund event. On Monero: the lock transaction, with Monero's usual privacy properties.
Whoever holds the swap's view key can also see outputs sent to the swap address.

## Honest limits
- The escrow program is upgradeable (see `SECURITY.md`).
- Getting XMR back after a missed claim needs the maker to refund. Expiry alone does not return it.
- The maker's code and servers are not published.
