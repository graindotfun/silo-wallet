# Check this repository in 10 minutes

You need Node 22.22.3+ (or 24.12.0+) and the Solana CLI.

1. Dump and hash the live escrow program.
   ```bash
   solana program dump -u mainnet-beta 7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS live.so && shasum -a 256 live.so
   ```
   The team reports `76424c24aa28d5f74e52781df0a98d95e43003ad2374c48f47acd1c21045599d` for the 215,944 program bytes. A raw
   dump can have trailing zero padding, so also hash the leading 215,944 bytes: `head -c 215944 live.so | shasum -a 256`.
2. See who can upgrade the program.
   ```bash
   solana program show -u mainnet-beta 7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS
   ```
   The upgrade authority is `8pFUuZgzab6mwXq2UqdEc2mbkDk6Wg68KSppJ4brfF4W`.
3. Find the time windows in the code: `claim_open` and `refund_open` in `program/src/lib.rs`, and the same rules in
   `lib/silo/atomic-swap/swap-core.mjs`.
4. Run the tests.
   ```bash
   npm ci && npm test
   ```
5. Check every file against the manifest.
   ```bash
   node scripts/verify-manifest.mjs
   ```

Whether this source builds to the live bytes is what `docs/VERIFY_BUILD.md` and the `verify-build` workflow are for.
Until a run of that workflow is green and linked there, treat the source as not verified against the live program.
