/**
 * Robinhood mainnet reference data, verified against official docs on 2026-10-13.
 * https://docs.robinhood.com/chain/connecting/
 * https://docs.robinhood.com/chain/protocol-contracts/
 * Public RPC is for inspection and wallet configuration, not production indexing.
 * This module does not enable creation, trading, deployment or signing.
 */
export const ROBINHOOD_CHAIN_MAINNET = {
  networkId: "robinhood:mainnet",
  chainId: 4663,
  chainName: "Robinhood Chain",
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  currencySymbol: "ETH",
  currencyDecimals: 18,
  blockExplorerUrl: "https://robinhoodchain.blockscout.com",
  wethAddress: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
} as const;

// Owner deployment verified at finalized block 0x53ee201 on 2026-10-14.
// Transaction: 0x22e310153c0dd503a47d185a70af320d5b2c019ab46fcd3786e7c296ea4dc0ad
export const ROBINHOOD_MAINNET_FACTORY_ADDRESS: string | null = "0x9dc366555a7a5b6194b2724e974f1b917005deee";

export function robinhoodMainnetAddChainParams() {
  const network = ROBINHOOD_CHAIN_MAINNET;
  return {
    chainId: "0x" + network.chainId.toString(16), chainName: network.chainName,
    nativeCurrency: {name: network.currencySymbol, symbol: network.currencySymbol, decimals: network.currencyDecimals},
    rpcUrls: [network.rpcUrl], blockExplorerUrls: [network.blockExplorerUrl],
  };
}
