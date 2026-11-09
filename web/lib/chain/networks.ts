import {NETWORKS} from "../site-config.ts";
import {ROBINHOOD_CHAIN_TESTNET} from "./robinhood-testnet.ts";

/**
 * Product network identity.
 *
 * Existing Solana rows keep the cluster name already stored in
 * `launch_index.network` and `launches/{network}/{mint}` (`mainnet-beta` or
 * `devnet`). This module does not rewrite those rows. A second chain uses a
 * different network id so an address string cannot collide with a Solana mint.
 *
 * Solana clusters are identified by genesis hash. Robinhood testnet uses the
 * published chain id and public RPC in `robinhood-testnet.ts`. Mainnet is not
 * configured.
 */
export const LAUNCH_NETWORKS = {
  "solana:mainnet-beta": {
    id: "solana:mainnet-beta",
    family: "solana",
    label: "Solana mainnet",
    recordNetwork: "mainnet-beta",
    chainId: null,
    genesis: NETWORKS["mainnet-beta"].genesis,
    execution: "live",
  },
  "solana:devnet": {
    id: "solana:devnet",
    family: "solana",
    label: "Solana devnet",
    recordNetwork: "devnet",
    chainId: null,
    genesis: NETWORKS.devnet.genesis,
    execution: "closed",
  },
  "robinhood:testnet": {
    id: "robinhood:testnet",
    family: "evm",
    label: ROBINHOOD_CHAIN_TESTNET.chainName,
    recordNetwork: null,
    chainId: ROBINHOOD_CHAIN_TESTNET.chainId,
    rpcUrl: ROBINHOOD_CHAIN_TESTNET.rpcUrl,
    currencySymbol: ROBINHOOD_CHAIN_TESTNET.currencySymbol,
    blockExplorerUrl: ROBINHOOD_CHAIN_TESTNET.blockExplorerUrl,
    genesis: null,
    execution: "planned",
  },
} as const;

export type LaunchNetworkId = keyof typeof LAUNCH_NETWORKS;
export type LaunchNetwork = (typeof LAUNCH_NETWORKS)[LaunchNetworkId];
export type ChainFamily = LaunchNetwork["family"];

export type TokenRef = {
  readonly networkId: LaunchNetworkId;
  readonly tokenAddress: string;
};

export type TransactionRef = {
  readonly networkId: LaunchNetworkId;
  readonly transactionHash: string;
};

const SOLANA_ACCOUNT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{87,88}$/;
const EVM_ACCOUNT = /^0x[0-9a-fA-F]{40}$/;
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;

const TOKEN_ADDRESS: Record<ChainFamily, (value: string) => string> = {
  solana(value) {
    if (!SOLANA_ACCOUNT.test(value)) throw new Error("Solana token address must be a base58 account.");
    return value;
  },
  evm(value) {
    if (!EVM_ACCOUNT.test(value)) throw new Error("EVM token address must be a 20-byte hex address.");
    return value.toLowerCase();
  },
};

const TRANSACTION_HASH: Record<ChainFamily, (value: string) => string> = {
  solana(value) {
    if (!SOLANA_SIGNATURE.test(value)) throw new Error("Solana transaction hash must be a base58 signature.");
    return value;
  },
  evm(value) {
    if (!EVM_HASH.test(value)) throw new Error("EVM transaction hash must be a 32-byte hex hash.");
    return value.toLowerCase();
  },
};

export function isLaunchNetworkId(value: string): value is LaunchNetworkId {
  return Object.hasOwn(LAUNCH_NETWORKS, value);
}

export function launchNetwork(networkId: LaunchNetworkId): LaunchNetwork {
  return LAUNCH_NETWORKS[networkId];
}

export function listLaunchNetworks(): readonly LaunchNetwork[] {
  return Object.values(LAUNCH_NETWORKS);
}

export function tokenRef(networkId: LaunchNetworkId, tokenAddress: string): TokenRef {
  const network = launchNetwork(networkId);
  return {networkId, tokenAddress: TOKEN_ADDRESS[network.family](tokenAddress)};
}

export function transactionRef(networkId: LaunchNetworkId, transactionHash: string): TransactionRef {
  const network = launchNetwork(networkId);
  return {networkId, transactionHash: TRANSACTION_HASH[network.family](transactionHash)};
}

export function sameToken(left: TokenRef, right: TokenRef): boolean {
  return left.networkId === right.networkId && left.tokenAddress === right.tokenAddress;
}

export function sameTransaction(left: TransactionRef, right: TransactionRef): boolean {
  return left.networkId === right.networkId && left.transactionHash === right.transactionHash;
}

/**
 * Storage key for a launch that already uses the Solana cluster name.
 * Matches `launchRecordKey` in `lib/launch-registration.mjs`. Robinhood has
 * no record network yet, so this throws instead of inventing a row.
 */
export function existingLaunchRecordKey(networkId: LaunchNetworkId, tokenAddress: string): string {
  const network = launchNetwork(networkId);
  if (network.recordNetwork == null) throw new Error(`${networkId} has no launch records.`);
  const ref = tokenRef(networkId, tokenAddress);
  return `launches/${network.recordNetwork}/${ref.tokenAddress}`;
}
