import {launchNetwork, type LaunchNetwork, type LaunchNetworkId} from "./networks.ts";
import type {connectRobinhoodTestnet, evmProviders, discoverEvmProviders} from "./evm-wallet.ts";
import type {walletProviders} from "../wallet.ts";

export type WalletLoaders = {
  solana(): Promise<{walletProviders: typeof walletProviders}>;
  evm(): Promise<{evmProviders: typeof evmProviders; connectRobinhoodTestnet: typeof connectRobinhoodTestnet; discoverEvmProviders?: typeof discoverEvmProviders}>;
};

const defaultWalletLoaders: WalletLoaders = {
  solana: () => import("../wallet.ts"),
  evm: () => import("./evm-wallet.ts"),
};

const STACK = {
  "solana:mainnet-beta": "solana",
  "solana:devnet": "solana",
  "robinhood:testnet": "evm",
} as const satisfies Record<LaunchNetworkId, "solana" | "evm">;

type SolanaChoices = {network: LaunchNetwork; stack: "solana"; providers: ReturnType<typeof walletProviders>};
type EvmChoices = {network: LaunchNetwork; stack: "evm"; providers: ReturnType<typeof evmProviders>};

const OPENERS = {
  async solana(networkId: LaunchNetworkId, loaders: WalletLoaders): Promise<SolanaChoices> {
    const solana = await loaders.solana();
    return {network: launchNetwork(networkId), stack: "solana", providers: solana.walletProviders()};
  },
  async evm(networkId: LaunchNetworkId, loaders: WalletLoaders): Promise<EvmChoices> {
    const evm = await loaders.evm();
    return {network: launchNetwork(networkId), stack: "evm", providers: evm.discoverEvmProviders ? await evm.discoverEvmProviders() : evm.evmProviders()};
  },
};

/** Load the wallet stack for the selected network. The other stack is not imported. */
export function walletChoices(networkId: LaunchNetworkId, loaders: WalletLoaders = defaultWalletLoaders): Promise<SolanaChoices | EvmChoices> {
  return OPENERS[STACK[networkId]](networkId, loaders);
}
