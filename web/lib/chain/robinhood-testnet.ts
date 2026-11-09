/**
 * Robinhood Chain testnet, as published on 2026-09-30:
 * https://docs.robinhood.com/chain/connecting/
 * https://docs.robinhood.com/chain/add-network-to-wallet/
 *
 * The docs name chain id 46630, public RPC
 * https://rpc.testnet.chain.robinhood.com, currency symbol ETH, and explorer
 * host explorer.testnet.chain.robinhood.com. ETH is the native gas token, so
 * the wallet currency uses 18 decimals. Mainnet chain 4663 is not configured.
 */
export const ROBINHOOD_CHAIN_TESTNET = {
  chainId: 46630,
  chainName: "Robinhood Chain Testnet",
  rpcUrl: "https://rpc.testnet.chain.robinhood.com",
  currencySymbol: "ETH",
  currencyDecimals: 18,
  blockExplorerUrl: "https://explorer.testnet.chain.robinhood.com",
} as const;

export function robinhoodChainIdHex(): string {
  return `0x${ROBINHOOD_CHAIN_TESTNET.chainId.toString(16)}`;
}

/** EIP-3085 parameters for wallet_addEthereumChain. Testnet only. */
export function robinhoodAddChainParams() {
  return {
    chainId: robinhoodChainIdHex(),
    chainName: ROBINHOOD_CHAIN_TESTNET.chainName,
    nativeCurrency: {
      name: ROBINHOOD_CHAIN_TESTNET.currencySymbol,
      symbol: ROBINHOOD_CHAIN_TESTNET.currencySymbol,
      decimals: ROBINHOOD_CHAIN_TESTNET.currencyDecimals,
    },
    rpcUrls: [ROBINHOOD_CHAIN_TESTNET.rpcUrl],
    blockExplorerUrls: [ROBINHOOD_CHAIN_TESTNET.blockExplorerUrl],
  };
}
