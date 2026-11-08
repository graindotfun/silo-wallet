# Security

## Report a problem

For `graindotfun/silo-wallet`, email hello@silo.trading with the subject "Security". Please include what you found, the steps to reproduce it, and which
file or commit it affects. If you want to send sensitive details, ask for a way to do that in your initial message.

Do not open a public issue for a security problem, and do not test against other people's funds or accounts.

## What to expect

We will reply to confirm we received your report. Please give us 90 days from your initial message to fix the problem
before you publish details; if we need longer we will say so and explain why, and if a fix ships earlier we will
tell you. We will credit you in the fix notes if you want that.

There is no bug bounty at this time.

## Upgrade authority of the escrow program

The XMR to SOL escrow program is upgradeable. Its upgrade authority is held by the Silo team at
`8pFUuZgzab6mwXq2UqdEc2mbkDk6Wg68KSppJ4brfF4W`. Any change to the program will be announced before it ships. We make no
promise, and give no date, to freeze the program or to move the authority to a multisig.

## Scope

The key sharing in an XMR to SOL swap (see "What an XMR to SOL swap shares with the swap maker" in `README.md`) is a documented design property, not a vulnerability. A way to learn more than that section says is.


The `graindotfun/silo-wallet` repository only. The hosted service is not in scope for outside testing.
Never send or paste a real seed, view key, spend key or transaction key into a report.
