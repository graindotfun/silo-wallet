# Maker conformance suite

Checks that a swap maker endpoint answers health, quote, register and status requests in the shape written in `docs/OPEN_MAKER_PROTOCOL.md`
and refuses the malformed requests the suite sends. Run: `node web/prototypes/xmr-sol-atomic-swap/conformance/run.mjs --maker-url <url>` (`--help` lists options).
Its tests run against an in-process fake: `node --test web/prototypes/xmr-sol-atomic-swap/conformance/conformance.test.mjs`.

## What a pass does not mean

A pass means the maker's answers fit the interface. It does **not** show that:

- the escrow the maker creates is correct on chain, or that the maker locks, releases, refunds or recovers correctly over a whole swap;
- the maker is honest, online when a user needs it, or keeps its secrets;
- a user cannot lose funds with it. The spec lists the loss cases found, including XMR that stays unrecoverable if a maker never refunds (section 7.1);
- the maker is safe to list. The suite does not test a malicious maker beyond what a registration answer shows.

It has been run only against the in-process fake, not against the real maker process.

## Safe by default

Without options the suite sends health and quote requests only: nothing is sent to a registration route (`POST /v1/swap`, `POST /v1/rev/swap`), not even a malformed probe, because a faulty maker may record a swap from any request there. It sends no Solana or Monero transaction. `--allow-registration stagenet|devnet` makes
the maker record a swap (XMR to SOL: it locks SOL). It then also needs `--solana-rpc <url>`, and before any registration the suite itself checks the
Solana genesis hash, the maker's own reported network (token needed) and that the maker address is funded on that network. The network answers are self-reported or corroboration only, so use a maker you know is a test maker. Any doubt refuses and sends
nothing to a registration route. A mainnet RPC or maker is refused unless `--allow-mainnet-registration` is also given. Do not use that for a quick test.
