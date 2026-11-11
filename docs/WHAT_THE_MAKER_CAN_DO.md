# What the swap maker can and cannot do

In an XMR to SOL swap, Silo's swap maker is the other side of the trade. The maker holds the SOL, you hold the XMR.
This page lists what that role can and cannot do, as far as the code in this repository shows. It is not a promise about
anything outside this repository.

The live program (protocol v2, since 2026-11-10) also has instructions for the opposite direction, SOL to XMR, where you
hold the SOL and the maker holds the XMR. Both directions are open to users in the beta, with caps of 0.05 XMR per swap
and 0.3 XMR per day. There is one maker, run by the Silo team: the role is not open to other parties yet. Its rules are in `docs/VERIFY_BUILD_V2.md` (section 2). In short: the maker can claim your SOL only after
you confirmed its XMR lock and after it committed to the claim on chain, and the claim reveals the maker's key part, which
lets Silo sweep the XMR into your wallet. Until you confirm, you can refund at any time.

## What the maker does
- Locks the SOL in the escrow program, before you send any XMR, for you to claim.
- Confirms it has seen your Monero payment to the swap's one-time address, then marks the escrow ready.
- If the swap is completed, sweeps the Monero from that one-time address after your SOL claim reveals your key part.
- If the swap is not completed, refunds the SOL lock, which reveals the maker's key part and lets you recover your XMR.

## What the maker sees
- The swap's own one-time view key. It is a fresh random key made for this swap only, not your wallet's view key.
- The lock transaction on that address: its id, amount, timing, confirmations and public shape, and the amount of any
  other output ever sent to that one-time address.

## What the maker cannot do
- It cannot touch your Silo wallet, your other addresses, your other outputs or your key images. The view key it holds
  is not derived from your wallet.
- It cannot spend the Monero at the swap address before your SOL claim reveals your key part.
- It cannot take the SOL back once the escrow is ready and you can still claim, until the claim window ends
  (see `docs/PROTOCOL.md`).

## What the claim reveals, by design
Your SOL claim publishes your key part of the swap's spend key inside a Solana transaction. That is what lets the maker
sweep the Monero. It is not your ordinary wallet spend key. Silo's client also posts a copy of the claim to Silo's server.

## Deadlines and refunds
- There is a claim deadline. Silo tries the SOL claim while it is open and your Monero wallet is unlocked. Cancelling
  the unlock leaves Silo locked and stops swap processing.
- After the deadline, getting your XMR back needs the maker to return the SOL lock and reveal its key part. Expiry alone
  does not return your XMR.

## What is policy, not on-chain
- Beta caps on swap size and any quotas (per swap, per user or per day) are maker policy, not program code. The escrow
  program does not enforce them, so do not rely on them.
- An earlier version of the maker code is already public in this repository's published history (`maker.mjs`, 14,397 bytes,
  XMR to SOL only). The maker code at the commit the live app runs, for both directions, is in
  `web/prototypes/xmr-sol-atomic-swap/maker/` (`maker.mjs` is 33,559 bytes there; the SOL to XMR side is
  `maker-reverse.mjs`). Its servers, its configuration and the running process are not published. That the running maker
  equals that code is not proven: nothing in this repository lets you check the bytes it runs. This repository does not claim
  anything about what the maker keeps or deletes after a swap.

## Planned
A future protocol version could split the view key so the maker cannot watch the address on its own. There is no date.
