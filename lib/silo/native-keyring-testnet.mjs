// SPDX-License-Identifier: AGPL-3.0-only
// The production build's stand-in for './native-keyring-testnet.mjs' (vite.config.ts aliases it unless
// SILO_BUILD_TEST_NETWORK_SIGNING=true at build time). It carries no inspector, no key use and no marker: a mainnet beta
// build has no path that signs on a test network, whatever its runtime configuration says.
export const SILO_TEST_NETWORK_SIGNING_BUILD=false;
export function signTestNetworkTransaction(){throw Error('Test-network signing is not part of this build.');}
