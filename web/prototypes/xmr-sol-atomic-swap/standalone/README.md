# Standalone swap client, both directions (reference software)

A small command line program, and the same logic as libraries (`swap-lib.mjs` for SOL to XMR, `swap-lib-xmr-sol.mjs` for XMR to SOL), that completes a swap in either direction against a maker URL you choose.
It uses only three things you supply: a maker URL, your own Solana RPC URL and your own Monero wallet RPC (plus, for `start`, a Monero node URL
to read the chain height). It makes no request to any Silo or Grain server and has no default endpoint of any kind.

## What this is, and what it is not

- **Today the live Silo maker is reachable only through Silo's own server.** It listens on localhost and, when its token is set, every POST needs
  that token, which only Silo's server holds. So this client cannot swap against the live Silo maker today. It works against a maker that exposes
  `POST /v1/rev/quote` and `POST /v1/rev/swap` as the maker code in `../maker/` does: a test maker you run, or a public maker if one is published later.
- This is reference software with test evidence (below), not a reviewed product. It has not been independently reviewed. Use test networks before mainnet.
- Both directions are covered: SOL to XMR (`--direction sol-xmr`, the default) and XMR to SOL (`--direction xmr-sol`). XMR to SOL moves your XMR out of your own wallet, so read its section before using it.
- Your SOL goes into the swap program, not to the maker. The program is upgradeable by an owner wallet; `start` reads the upgrade authority from the
  chain and prints it before you are asked anything. A swap is one maker run by one operator: the maker can stall or refuse, and quotes are its own.

## Install

No install step of its own. It runs from a checkout of this repository, with the repository's Node dependencies (Node 22): `@solana/web3.js`, `bs58`, `@noble/*`.
It imports the same modules the Silo wallet runs for the swap decisions (what is safe to send, and when), without a copy of them:
`lib/silo/atomic-swap/bob-flow.mjs`, `refunder-tx.mjs`, `lib/silo/atomic-reverse-driver.mjs`, `client/reverse-core.mjs`, `client/keys.mjs`, `client/swap-core.mjs`,
and two small maker-side helpers for counting XMR at an address (`maker/maker-core.mjs`, `maker/maker-reverse.mjs`).

**This client is not free of logic of its own.** Besides the shared decisions it contains code that exists only here and is part of what you trust: the encrypted recovery file and its locking, the funding reservation and its reconciliation with your wallet (XMR to SOL), the sweep of the shared address through your wallet RPC, the client-side quote checks, and the chain-time clock. The timing constants it enforces come from `client/swap-core.mjs` and `client/reverse-core.mjs`; a test asserts they equal the ones in `lib/silo/atomic-swap/`, which the Silo flows use.

## Setup

Put the endpoints in the environment (flags work too, but URLs often contain keys and flags land in shell history). The tool never prints them.

| Variable | Meaning |
|---|---|
| `SWAP_MAKER_URL` | the maker, for example `https://maker.example` (https, or http on localhost only) |
| `SWAP_MAKER_TOKEN` | only if that maker requires a bearer token; sent as given, never stored or printed |
| `SWAP_SOLANA_RPC_URL` | your Solana RPC |
| `SWAP_MONERO_WALLET_RPC_URL` | your `monero-wallet-rpc`, started with `--wallet-dir` (it creates watch and spend wallet files there) |
| `SWAP_MONERO_NODE_URL` | your Monero node, used by `start` to read the chain height |
| `SWAP_MONERO_RPC_LOGIN_FILE` | optional: a file holding `user:password` for the wallet RPC |
| `SWAP_RECORD_PASSPHRASE` | the passphrase of the encrypted swap file (at least 12 characters). Alternatives: `--record-passphrase-file FILE` (mode 0600), or the tool asks on a terminal without showing what you type. There is no way to run without one. |

You also need a Solana key file (the Solana CLI format) that holds the SOL to swap, and a Monero address of yours on the same network.
`--network devnet` means Solana devnet or a local validator together with Monero stagenet. `--network mainnet` means both mainnets. It has no default:
the tool checks the genesis hash of your Solana RPC and your Monero address against it and refuses a mismatch.

## Commands

```
node standalone/silo-swap.mjs quote   --xmr 0.01
node standalone/silo-swap.mjs start   --xmr 0.01 --network devnet --keypair KEY.json --xmr-address ADDR --record swap.json \
    --maker-address MAKER_SOLANA_ADDRESS --max-sol-per-xmr 8 --own-node [--max-sol 0.5] [--max-spread-bps 500] [--yes] [--detach]
node standalone/silo-swap.mjs resume  --record swap.json --keypair KEY.json --own-node [--detach]
node standalone/silo-swap.mjs status  --record swap.json
node standalone/silo-swap.mjs refund  --record swap.json --keypair KEY.json
```

- `quote` sends one request, to the maker, and prints the checked terms. Nothing is stored.
- `start` checks the cluster and the program, asks for a quote, checks it, prints the terms and the refund times, and asks you to type `lock`
  (or pass `--yes`). Only then it reads the Monero height, writes the swap file, registers with the maker, checks the maker's answer, and locks.
  It then keeps running until the swap settles (about 35 minutes or more). `--detach` returns once the SOL is locked; continue with `resume`.
- `resume` continues from the swap file at any point. A lock is never repeated; a refund waits for its time.
- `status` reads the chain and says what the next step would be. It signs, sends and writes nothing.
- `refund` makes one pass that can send only a refund, and only when the swap rules allow one right now. It never sends a lock or a confirmation. If the maker has already claimed, the same pass also moves the XMR to your address (that is the recovery path of the shared driver), through your wallet RPC.
- `status` reads the chain and your wallet RPC. It sends no transaction and writes nothing to the swap file, but it is not free of side effects: it opens and closes wallets in your wallet RPC and creates the view-only wallet file there if it is missing.
- `resume` and `refund` repeat the start checks (network named in the file, cluster, the pinned program, the destination address) before anything is signed.

Exit codes: 0 XMR received, 3 swap ended without XMR (SOL refunded or never locked), 4 still in progress, 2 refused by a check, 1 other error.

## Three things you must supply, and why

- **Your own Monero node (`--own-node`).** This flag is your statement, not a check: the tool cannot verify that the node behind your wallet RPC is independent of the maker, of Grain or of anyone else, and it does not claim so. The tool sends your confirmation to the swap program when your Monero wallet shows the maker's XMR, and after
  that the maker can take your SOL. A remote node can show a view-only wallet a payment that does not exist. So the node behind your wallet RPC must be one
  you run yourself. `start` and `resume` refuse without `--own-node`. `--remote-node-ok` proceeds with a node that is not yours, prints a loud warning
  and is at your own risk: you can lose the SOL. `status` and `refund` never send a confirmation and need neither flag.
- **The maker's Solana address (`--maker-address` or `SWAP_MAKER_ADDRESS`).** That key is the only key that can ever take your SOL from the escrow. The
  quote is refused when it names another address. Where the address comes from is up to you: a maker list entry you verified, or the operator's own
  statement. This client does not import the signed list verifier (`web/lib/silo/maker-list/`), so the address is a flag today.
  `--allow-unverified-maker` skips the check and is not recommended.
- **A price limit (`--max-sol-per-xmr` and/or `--max-sol`).** No client can know the market price offline, so the limit comes from you. The price checked is
  the SOL the quote charges per XMR, whatever price fields the maker states. `start` refuses without one.

## Time

Every deadline (quote expiry, the maker's timelocks, the signer's lock check, refund timing) is judged by chain time read from your Solana RPC, never by
the local clock alone. A difference of more than a minute between your clock and chain time is reported. A chain-time reading is used for at most two minutes; if reads keep failing the offset is dropped and the tool refuses to decide anything until it can read chain time again (it retries, and stops after repeated failures; `resume` continues).

## What it checks before any SOL is locked

Before anything is stored: the cluster matches `--network`; the pinned program is deployed at the pinned address; the destination is a valid address of
the right network; the quote is for the direction and amount you asked, within the program's ceiling and your `--max-sol`; it has not expired and does
not stay open longer than 15 minutes (chain time); the maker's share proof verifies; the maker is not your own wallet; the maker address is the one you named; the price is within your limit; if a price and spread are stated, the spread is
within `--max-spread-bps` (default 500) and the price adds up to the SOL charged. Unknown optional quote fields (for example `tiers`, including entries with `rate`, `min`, `spreadBps`, `lamports`) are ignored and never change what is charged: the
quote's own amount must equal the amount you asked for, and the client never sends `tierOk`.

After the maker registers, still before the lock (the same rules Silo's wallet applies): the maker's terms equal the quote; the timelocks have the agreed
shape (t0 about three hours out, a two hour claim window); the joint Monero address equals A + B; the escrow address derives from the pinned program id.
The signer then re-checks every transaction against the swap file and signs only the three reviewed layouts (lock, ready, refund) for the pinned program.

## The refund time

Shown before you confirm, and exact after registration. "Allowed" below means the swap rules permit a refund transaction; it does not mean the refund is done. The refund is a transaction this tool sends while it runs (`resume` or `refund`, with your swap file, passphrase and key file) and Solana must confirm it.

- **Before you send the confirmation (the "ready" step):** a refund is allowed about 30 minutes after the lock only when a completed check of the shared Monero address found no XMR. A check that failed or timed out proves nothing and does not start that path. Separately, from 15 minutes before t0 (ten minutes before the confirm-by time, which is t0 minus 5 minutes) this tool may try a refund when the payment does not allow confirming (no payment, too short, or fewer than 10 confirmations). A payment of the full amount with 10 confirmations keeps priority: it still gets your confirmation until the confirm-by time, and is not refunded before then.
- **After the confirmation is sent:** a refund is allowed only after the maker's claim window has closed: not before t1 plus 5 minutes, and if the maker committed late, up to one more hour. The maker can take the SOL only inside that window, and only after your confirmation.

**Refunds are made by this tool, from your swap file, passphrase and key file.** Keep all three until the swap is finished.

## XMR to SOL

```
node standalone/silo-swap.mjs quote --direction xmr-sol --xmr 0.01 --min-sol-per-xmr 6
node standalone/silo-swap.mjs start --direction xmr-sol --xmr 0.01 --network devnet --sol-address SOL_ADDRESS --xmr-address YOUR_XMR_ADDRESS \
    --monero-wallet FUNDING_WALLET --monero-wallet-password-file PW.txt --maker-address MAKER_SOLANA_ADDRESS --min-sol-per-xmr 6 --record swap.json [--second-solana-rpc URL] [--yes] [--detach]
node standalone/silo-swap.mjs resume --record swap.json [--detach]
node standalone/silo-swap.mjs status --record swap.json
```

Needs from you: a Solana address that receives the SOL (no key file: the claim is signed by a throwaway fee payer key kept in the swap file, and the maker funds its
fee with a gas top-up, so you can start with zero SOL), a Monero wallet in your wallet RPC's folder that holds the XMR (`--monero-wallet`, password from a file), and a Monero
address of yours that gets the XMR back if the swap fails. `SWAP_SECOND_SOLANA_RPC_URL` or `--second-solana-rpc` adds a second Solana RPC.

Order of events, with what stops each step:
1. Quote, checks (amount equals the request, gas top-up large enough for your claim fee, expiry and TTL by chain time, price at or above `--min-sol-per-xmr`, spread bound, price fields add up), terms printed, confirmation.
2. Swap file written (swap secrets, throwaway fee payer key) before the maker is asked to register. The maker's answer is checked by the core (share proof, joint address, escrow address from the pinned program, timelock bounds, amounts) and its Solana address must equal `--maker-address`.
3. The maker locks SOL. **Nothing is paid until this tool has read that escrow through your own Solana RPC and every field matches** (program owner, you as claimer, both key shares, amount, timelocks, the maker as counterparty) and the fee payer holds the minimum claim fee.
4. **The one XMR payment**, from your wallet RPC: asks you again (type `pay`, or `--yes`) and shows the amount, the shared address, the claim deadline and what happens if you miss it. Then: the wallet builds the transaction without relaying; the intent, txid and transaction are written to the swap file; only then it is relayed. A record that says "payment may have gone out" is never paid again: `resume` looks at the recorded intent and the wallet's own outgoing transfers, relays the same recorded transaction if it never left (and never after the funding deadline), and otherwise does nothing. Whether the payment left is decided by its txid alone, never by the destination the wallet remembers (a wallet that rescanned can report an outgoing transaction without one); a wallet or RPC error counts as "unknown", never as "not sent". "Abandoned" (funding deadline passed before the relay) is not final: every resume and status pass looks the txid up again, and a payment that turns up anywhere continues as paid.
5. The claim: built from the core, signed by the throwaway fee payer, broadcast through your own Solana RPC (and the second one if given), retried every minute inside the window. **There is no relay.** A loud warning appears from one hour before the claim deadline.

**You must claim before t1.** The tool claims for you while it runs; keep it running or run `resume`. If you miss t1 the maker may refund its SOL after t1, and the refund reveals what the tool needs to move your XMR back to your own address (`resume` does it). If the maker stays silent after t1, you cannot move your XMR alone.

**The claim reveals a secret, and one RPC sees it before anyone else.** The claim transaction carries your secret `a` in the clear. The RPC you send it to sees it before it lands. If the claim then does not land before t1 (the RPC drops it, delays it, or the network is congested), a party that saw `a` and also controls the maker can, after refunding its own SOL with `b`, take your XMR with `a` and `b`: you would lose the XMR and get no SOL. That is why this tool never sends a claim at or after t1 minus 5 minutes, and why the claim is retried every minute before that. With one RPC you rely on that one operator to forward and not to collude with the maker. `--second-solana-rpc` (a different operator) makes the claim reach both, which lowers the chance that it is dropped; it does not remove the exposure, because both operators see `a`. This is the exposure described for the wallet's own XMR to SOL claim in the threat model; this client adds no relay and no new trust, and keeps it as small as two independent RPCs allow.

The Monero side of this direction does not require a node you run yourself (your claim never depends on what a node says about your payment), but a remote node learns your wallet's addresses and payments. Your own node is better for privacy too.

## Your files

- The swap file is **encrypted** (AES-256-GCM, key from your passphrase with scrypt N=32768 r=8 p=1, a fresh nonce for every write). Everything about the swap is inside the encryption: the secrets (refund or claim secret, shared view key, throwaway fee payer key), the signed XMR payment (a relayable transaction), addresses, the maker URL and timestamps. **In the clear** is only the envelope header: the format name, the cipher, the key derivation parameters and salt, the nonce, the direction (`sol-xmr` or `xmr-sol`) and the network name. The header is authenticated: changing any byte of it or of the ciphertext makes the file fail to open. A wrong passphrase fails the same way. There is no plain text fallback and older plain text swap files are not read. Without the passphrase the file is useless to you as well, so keep the passphrase safe (not in the same place as the file); a swap whose file or passphrase is lost can not be refunded or collected by this tool.
  What encryption does not do: it does not hide that a swap file exists, its size, its modification times, or the direction and network; while the tool runs, the decrypted record is in its memory, and your wallet RPC receives keys (below).
  The file is mode 0600, written atomically (temp file in the same folder, created exclusively and never through a symbolic link, flushed, renamed, folder flushed) and before the maker is told anything. A temp file left by a crash is removed only if it is a plain file of yours; a symbolic link, another user's file or a loose mode is refused. The swap file itself must also be a plain file of yours with mode 0600 or tighter.
- One owner at a time: each running session writes its own lock entry next to the swap file (`<file>.lock.h.<token>`, complete or not at all) and then looks at every other entry. A second session in the same program is refused (it never re-enters the lock). An entry whose owner is a running process is never taken over, and an entry whose owner is certainly gone (process id missing, or reused with another start time) is replaced. **Only a confirmed "file not found" counts as an entry that vanished.** Any other problem with a competing entry (a read error such as EIO or EACCES, a symbolic link, a directory, a file of another user, garbled content) makes this session back off and report the swap as busy; it never takes the swap on a guess. The record is read only after the lock is taken, and every save checks that the session still holds its entry.
- One payment owner: the funding reservation (`<file>.intent`) is created exclusively and carries the creating run's unique token. Only the run that created it may build and send the XMR payment, and it checks immediately before the transfer that it still holds the swap lock and that the reservation still carries its own token. A run that finds the same wallet's reservation made by another run builds nothing: it relays the other run's recorded transaction by txid if one is on file (through the usual deadline and escrow checks), otherwise it stops and tells you. A reservation left by a run that is gone is taken over only by a run that holds the swap lock. The built transaction is written to the swap file only if the file is still at the revision this run last wrote (checked under the lock, just before the write; it is a check, not an operating system compare-and-swap).
- Files next to the swap file, and what each one shows to someone who copies your disk or a backup:
  - `<file>`: the encrypted swap file (everything about the swap). Clear: the header only.
  - `<file>.intent`: the funding reservation (wallet, amount, joint address, claim token, creator). **Encrypted and authenticated with the same envelope and passphrase.** Clear: the header only, which shows the direction and network. Its existence and size show that a payment was reserved.
  - `<file>.lock.h.<token>`: a lock entry (process id, process start time, random token, time). No payment data. It shows that a session ran, when, and which process id.
  - `<file>.lock` (older versions only): a process id.
  - `<file>.tmp`, `<file>.intent.tmp.*`, `<file>.lock.tmp.*`: temporary files of an atomic write, removed right after. Temporary intent files are already encrypted; a crash can leave one.
  - `<file>.intent.old.*`: a taken-over reservation, removed at once.
  - Wallet files in your wallet RPC folder (below).
  File names and modification times are not hidden by any of this.
- The key file is read, never printed, and a loose file mode is reported.
- Monero wallet files named `silo-swap-watch-*` (view only) and `silo-swap-spend-*` (after the maker's claim, holds the spend key) stay in your wallet
  RPC's folder. Their password is derived from the swap's view key. Remove them once the swap is done and the XMR has arrived.
- The tool does not delete the swap file. Keep it until you have the XMR or the refund.

## What this tool does not do or check

- **No Tor.** Connections go directly to the endpoints you gave. Your Solana RPC, your Monero node and wallet RPC, and the maker see your network address. The tool neither uses Tor nor checks that you do.
- **Your Monero node is not verified.** `--own-node` is your statement. The tool cannot tell whether the node is yours or independent of Grain or the maker.
- **Your wallet RPC receives private keys.** To watch the shared address it is given the view key; to sweep after the maker's claim it is given the spend key; XMR to SOL opens your funding wallet with its password. Wallet files named `silo-swap-*` stay in its folder. Run the wallet RPC yourself, on a machine you trust.
- **`status` is not read-only for the wallet RPC** (it opens and closes wallets and may create the view-only wallet file), and **`refund` can also sweep** post-claim XMR to your address.
- **Redirects are refused** for the maker, the Solana RPC(s), the wallet RPC and the node.
- **Errors are printed as fixed codes.** Anything that did not come from this tool's own checks is shown as a short code (for example `network-unreachable`), never as the raw message, and every line is scrubbed of the endpoints, tokens and passwords you gave and of long hex or base58 strings (except the public addresses shown on purpose in the terms).
- The live Silo maker (see the top of this file).
- Any review. Nothing here has been reviewed by an outside party, and a green test run is not a review.

## Tests and evidence

Hardening tests (`swap-envelope.test.mjs` and the "771" tests in the other two files) cover: the file is never plain text (scan), a wrong passphrase, tampering, symlink and loose-mode refusals; two sessions in one process (also with two funding wallets) cannot both pay, and a payment reserved from one wallet is refused from another; a payment is refused when the quote expires or the escrow changes while you confirm; credential-bearing errors never reach the output; the shared timing constants are equal.

Unit tests: `node --test prototypes/xmr-sol-atomic-swap/standalone/swap-lib.test.mjs` (SOL to XMR) and `.../swap-lib-xmr-sol.test.mjs` (XMR to SOL) run the library against a fake maker, a fake Solana chain and a fake wallet RPC:
the full path, refusal before locking for each wrong quote or registration answer, a maker that stalls (refund at the right time, never early), a crash and
resume, optional quote fields, token handling, and a recording fetcher that proves no request leaves the three supplied endpoints.
XMR to SOL tests add: refusal before paying for each wrong escrow field, no second payment after a crash at every step around the transfer (before the relay, after the relay, after completion, stale record write, past the funding deadline), the claim retried, a refund recovery, and no request outside the supplied endpoints.
The end to end runs on a local validator with Monero stagenet are test evidence, not a review; their logs are not part of this repository.
