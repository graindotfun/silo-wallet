// SPDX-License-Identifier: AGPL-3.0-only
/** Solana cluster genesis hashes. A dependency-free module so identity and history checks can use them without loading the
 * transaction stack; solana-transfer.mjs re-exports the same frozen object. */
export const SILO_SOLANA_GENESIS=Object.freeze({'mainnet-beta':'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',devnet:'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'});
