# Check this repository in 10 minutes

You need Node 22.22.3+ (or 24.12.0+) and the Solana CLI. Step 6 also needs Docker and takes longer than 10 minutes.

1. Dump and hash the live escrow program.
   ```bash
   solana program dump -u mainnet-beta 7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS live.so && shasum -a 256 live.so
   ```
   Since the upgrade of 2026-11-08 (slot 467051728) the team reports
   `4033eb70a5d4d6f7d47654d278a54633bafd5366303b7882a17032d4cbbc3515` for the 215,944 program bytes. A raw dump can have
   trailing zero padding, so also hash the leading 215,944 bytes: `head -c 215944 live.so | shasum -a 256`. The previous live
   bytes, before that upgrade, had sha256 `76424c24aa28d5f74e52781df0a98d95e43003ad2374c48f47acd1c21045599d`.
2. See who can upgrade the program, and when it was last upgraded.
   ```bash
   solana program show -u mainnet-beta 7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS
   ```
   The upgrade authority is `8pFUuZgzab6mwXq2UqdEc2mbkDk6Wg68KSppJ4brfF4W` and the last deploy slot is 467051728. If the slot
   is newer, the program was upgraded again and the hash in step 1 no longer applies until this repository says so. Some
   Solana CLI versions (4.3.2, for example) ask for a default keypair even for this read-only command: make a throwaway one
   with `solana-keygen new --no-bip39-passphrase -o throwaway.json` and add `-k throwaway.json`. It signs nothing.
3. Find the time windows in the code: `claim_open` and `refund_open` in `program/src/lib.rs`, and the same rules (with a safety margin)
   in `aliceNext` and `makerNext` of `lib/silo/atomic-swap/swap-core.mjs`.
4. Run the tests.
   ```bash
   npm ci && npm test
   ```
5. Check every file against the manifest.
   ```bash
   node scripts/verify-manifest.mjs
   ```
6. Rebuild the program and compare it with step 1 (Docker, Linux x86_64 or amd64 emulation).
   ```bash
   cargo install solana-verify --version =0.5.2 --locked
   solana-verify build program --library-name xmr_sol_swap \
     --base-image solanafoundation/solana-verifiable-build@sha256:12fd4c0a0790f0fc41ef74b0cdb6bccc167ba6137eb1adb749bac649481c86bd
   shasum -a 256 program/target/deploy/xmr_sol_swap.so
   ```
   The hash must equal the leading 215,944 bytes of step 1. Details, the build without Docker and the automated checks are in
   `docs/VERIFY_BUILD.md`.
