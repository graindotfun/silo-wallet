# XMR to SOL atomic swap: protocol (beta version)

This describes the XMR to SOL direction, which uses the v1 instructions of the escrow program. The live program runs
protocol v2 since 2026-11-10; v2 keeps these instructions unchanged and adds a separate set for the SOL to XMR direction,
described in `docs/VERIFY_BUILD_V2.md` (section 2). Both directions are open to users in the beta. A later protocol version could change how the view key is shared; there is no date for it. The
escrow program has had no independent external security review.

Source: `program/src/lib.rs` (escrow), `lib/silo/atomic-swap/` (client logic), `lib/silo/atomic-driver.mjs` (runner).

Window specifics (`t0`, `t1`, the bounds and margins below) are those of the XMR to SOL direction.

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
now < t0, not ready : refund only   (Bob aborts: Alice recovers her XMR only if Bob refunds)
now < t0, ready     : claim only    (normal path)
t0 <= now < t1      : claim only    (Bob went quiet; Alice claims)
t1 <= now           : refund only   (Alice went quiet; Bob refunds)
```
`refund` needs `b`, so only Bob can call it before `b` is public, and it pays only Bob. Alice has no instruction of her own that returns
her XMR. Before `t0` and not ready, Alice has not lost her XMR only if Bob refunds, and that is not forced. What Alice can and cannot do alone:
she can claim the SOL from `t0` to `t1` (Silo keeps a margin before `t1`) if her client is online and an independent Solana node answers;
she cannot refund, cannot move the XMR from the shared address without `b`, and cannot make Bob refund.

Successful claim and refund have mutually exclusive windows. This does not prevent scalar exposure through simulation or
rejected transactions; clients must enforce a safe reveal timing before broadcasting secret-carrying bytes.

## Flow
1. Alice requests a quote and registers `A`, its proof and `v`. Registration does not include `a`.
2. Bob locks the SOL (`lock`) with `t0`, `t1`. Alice accepts only if the timelocks are inside her bounds
   (`lib/silo/atomic-swap/swap-core.mjs`: `t0` at least 1 h and at most 3 h away, `t1` at most 26 h away, at least 1 h
   between `t0` and `t1`).
3. Alice sends XMR to the swap address. Bob waits for confirmations (10 by default) and calls `set_ready`.
4. Alice claims the SOL before `t1` (with a safety margin). The claim reveals `a`; Bob now holds `a + b` and can sweep.
5. If Alice never claims, after `t1` Bob can refund, which reveals `b`. Only then can Alice derive the swap address's full keys
   and recover her XMR. Nothing in the program makes Bob do this.

## What is public
Everything on Solana: the swap account, `t0`, `t1`, the amount, both public points, and the revealed secret in the
claim or refund event. On Monero: the lock transaction, with Monero's usual privacy properties.
Whoever holds the swap's view key can also see outputs sent to the swap address.

## Honest limits
- The escrow program is upgradeable (see `SECURITY.md`).
- Getting XMR back after a missed claim needs the maker to refund. Expiry alone does not return it. In XMR to SOL, Alice sends the XMR
  and has no refund of her own: if Bob never refunds, her XMR can stay at the shared address for good. If Bob aborts early and refunds,
  Alice recovers only if her client sees the refund and the sweep works (two Monero fees).
- In SOL to XMR the user locks SOL and can refund it herself while the swap is not ready, and after the claim window if it is; after the
  maker's claim she collects the XMR with the swap record saved on her device. See `docs/WHAT_THE_MAKER_CAN_DO.md`, "What you can lose, by direction".
- The maker's code is in `web/prototypes/xmr-sol-atomic-swap/maker/`; its servers and configuration are not published.
