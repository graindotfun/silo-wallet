import type {Eip1193Provider, EvmScope} from "./evm-wallet.ts";
import {assertEvmSession, evmAddress, evmChainHex, type EvmSafeSession} from "./evm-transaction-safety.ts";

export type EvmWalletNetwork = Readonly<{
  chainId: number;
  name: string;
  nativeCurrency: Readonly<{name: string; symbol: string; decimals: 18}>;
  /** Public source-owned URL, never the authenticated backend RPC. */
  publicRpcUrl: string;
  explorerUrl: string;
  executable: boolean;
}>;
function publicUrl(value: string, rpc = false): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (rpc && !["/", "/rpc"].includes(url.pathname))) throw new Error("Wallet network requires a public HTTPS root endpoint without credentials.");
  return url.href;
}
/** Only an explicit user connect action may invoke this function. */
export async function connectEvmWallet(provider: Eip1193Provider, network: EvmWalletNetwork, selectAccount = false): Promise<EvmSafeSession> {
  if (network.executable !== true) throw new Error("This chain is not enabled by the source-owned adapter.");
  const chainId = evmChainHex(network.chainId);
  const rpcUrls = [publicUrl(network.publicRpcUrl, true)];
  const blockExplorerUrls = [publicUrl(network.explorerUrl)];
  if (network.nativeCurrency.decimals !== 18 || !network.name.trim() || !network.nativeCurrency.symbol.trim()) throw new Error("Invalid wallet network metadata.");
  try { await provider.request({method: "wallet_switchEthereumChain", params: [{chainId}]}); }
  catch (error) {
    const code = error && typeof error === "object" && "code" in error ? Number(error.code) : null;
    if (code !== 4902) throw error;
    await provider.request({method: "wallet_addEthereumChain", params: [{chainId, chainName: network.name, nativeCurrency: network.nativeCurrency, rpcUrls, blockExplorerUrls}]});
    // Addition is not proof that this chain became selected.
    await provider.request({method: "wallet_switchEthereumChain", params: [{chainId}]});
  }
  const chain = await provider.request({method: "eth_chainId"});
  if (typeof chain !== "string" || !/^0x[0-9a-f]+$/i.test(chain) || BigInt(chain) !== BigInt(chainId)) throw new Error("Wallet did not select the requested chain.");
  if (selectAccount) {
    try { await provider.request({method: "wallet_requestPermissions", params: [{eth_accounts: {}}]}); }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? Number(error.code) : null;
      if (code !== 4200 && code !== -32601) throw error;
    }
  }
  const accounts = await provider.request({method: "eth_requestAccounts"});
  if (!Array.isArray(accounts)) throw new Error("Wallet returned no account.");
  const session = Object.freeze({chainId: network.chainId, account: evmAddress(accounts[0]), provider});
  await assertEvmSession(session);
  return session;
}

export type EvmDiscoveredWallet = Readonly<{name: string; provider: Eip1193Provider}>;
/** Metadata-only discovery; it never connects, selects a chain or requests accounts. */
export async function discoverEvmWalletAdapters(scope: EvmScope = globalThis as EvmScope): Promise<EvmDiscoveredWallet[]> {
  const found = new Map<Eip1193Provider, string>();
  for (const provider of [...(scope.ethereum?.providers ?? []), scope.ethereum, scope.phantom?.ethereum]) {
    if (provider && typeof provider.request === "function") found.set(provider, provider.isMetaMask ? "MetaMask" : provider.isPhantom ? "Phantom" : "Browser wallet");
  }
  if (typeof window !== "undefined") {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{provider?: Eip1193Provider; info?: {name?: string}}>).detail;
      if (detail?.provider && typeof detail.provider.request === "function") found.set(detail.provider, detail.info?.name?.slice(0, 80) || "Browser wallet");
    };
    window.addEventListener("eip6963:announceProvider", listener);
    try { window.dispatchEvent(new Event("eip6963:requestProvider")); await new Promise(resolve => setTimeout(resolve, 150)); }
    finally { window.removeEventListener("eip6963:announceProvider", listener); }
  }
  return [...found].sort((a, b) => Number(/metamask/i.test(b[1])) - Number(/metamask/i.test(a[1]))).map(([provider, name]) => ({provider, name}));
}
