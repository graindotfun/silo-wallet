import {tokenRef} from "./networks.ts";
import {ROBINHOOD_CHAIN_TESTNET, robinhoodAddChainParams, robinhoodChainIdHex} from "./robinhood-testnet.ts";

export type Eip1193Provider = {
  request(args: {method: string; params?: unknown[] | undefined}): Promise<unknown>;
  on?(event: string, listener: (value: unknown) => void): void;
  removeListener?(event: string, listener: (value: unknown) => void): void;
};

type InjectedEvm = Eip1193Provider & {isMetaMask?: boolean; isPhantom?: boolean; providers?: InjectedEvm[]};
export type EvmScope = {
  ethereum?: InjectedEvm | undefined;
  phantom?: {ethereum?: InjectedEvm} | undefined;
};
type WalletChoice = {name: string; connect(selectAccount?: boolean): Promise<RobinhoodWalletSession>};

export type RobinhoodWalletSession = {
  networkId: "robinhood:testnet";
  chainId: typeof ROBINHOOD_CHAIN_TESTNET.chainId;
  account: string;
  provider: Eip1193Provider;
};

function missingChain(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = error.code;
  return code === 4902 || code === "4902";
}

function sameChain(value: unknown, expectedHex: string): boolean {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return false;
  return BigInt(value) === BigInt(expectedHex);
}

/** Ask the injected EVM provider for Robinhood Chain testnet. Does not read a Solana wallet. */
export async function connectRobinhoodTestnet(provider: Eip1193Provider, selectAccount = false): Promise<RobinhoodWalletSession> {
  const params = robinhoodAddChainParams();
  try {
    await provider.request({method: "wallet_switchEthereumChain", params: [{chainId: params.chainId}]});
  } catch (error) {
    if (!missingChain(error)) throw error;
    await provider.request({method: "wallet_addEthereumChain", params: [params]});
  }
  const chainId = await provider.request({method: "eth_chainId"});
  if (!sameChain(chainId, robinhoodChainIdHex())) throw new Error("Wallet is not on Robinhood Chain testnet.");
  if (selectAccount) {
    try {
      await provider.request({method: "wallet_requestPermissions", params: [{eth_accounts: {}}]});
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? Number(error.code) : null;
      if (code !== 4200 && code !== -32601) throw error;
    }
  }
  const accounts = await provider.request({method: "eth_requestAccounts"});
  const account = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof account !== "string") throw new Error("The wallet did not return an account.");
  return {
    networkId: "robinhood:testnet",
    chainId: ROBINHOOD_CHAIN_TESTNET.chainId,
    account: tokenRef("robinhood:testnet", account).tokenAddress,
    provider,
  };
}

function choice(provider: Eip1193Provider, name: string): WalletChoice {
  return {name, connect: (selectAccount = false) => connectRobinhoodTestnet(provider, selectAccount)};
}
function priority(list: WalletChoice[]): WalletChoice[] {
  return list.sort((a, b) => Number(/metamask/i.test(b.name)) - Number(/metamask/i.test(a.name)));
}
export function evmProviders(scope: EvmScope = globalThis as EvmScope): WalletChoice[] {
  const providers = [...(scope.ethereum?.providers ?? []), scope.ethereum, scope.phantom?.ethereum];
  const unique = [...new Set(providers.filter((p): p is InjectedEvm => !!p && typeof p.request === "function"))];
  return priority(unique.map(p => choice(p, p.isPhantom ? "Phantom" : p.isMetaMask ? "MetaMask" : "Browser wallet")));
}
/** Discover separate injected wallets without asking for account access. MetaMask is preferred in this testnet lane. */
export async function discoverEvmProviders(scope: EvmScope = globalThis as EvmScope): Promise<WalletChoice[]> {
  if (typeof window === "undefined") return evmProviders(scope);
  const announced = new Map<Eip1193Provider, WalletChoice>();
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{info?: {name?: string}; provider?: Eip1193Provider}>).detail;
    if (detail?.provider && typeof detail.provider.request === "function") {
      announced.set(detail.provider, choice(detail.provider, detail.info?.name || "Browser wallet"));
    }
  };
  window.addEventListener("eip6963:announceProvider", listener);
  try {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    await new Promise(resolve => setTimeout(resolve, 150));
  } finally { window.removeEventListener("eip6963:announceProvider", listener); }
  return priority([...announced.values(), ...evmProviders(scope)]);
}

/** Follow wallet changes without prompting for accounts or signing. */
export function watchRobinhoodWallet(session: RobinhoodWalletSession, changed: (next: RobinhoodWalletSession | null) => void): () => void {
  const provider = session.provider;
  if (!provider.on || !provider.removeListener) return () => {};
  let active = true;
  const accountsChanged = (accounts: unknown) => {
    if (!active) return;
    try {
      const account = Array.isArray(accounts) ? accounts[0] : undefined;
      if (typeof account !== "string") { changed(null); return; }
      changed({...session, account: tokenRef("robinhood:testnet", account).tokenAddress});
    } catch { changed(null); }
  };
  const disconnect = () => {
    if (!active) return;
    active = false;
    changed(null);
  };
  const chainChanged = (chain: unknown) => {
    if (!sameChain(chain, robinhoodChainIdHex())) disconnect();
  };
  provider.on("accountsChanged", accountsChanged);
  provider.on("chainChanged", chainChanged);
  provider.on("disconnect", disconnect);
  return () => {
    active = false;
    provider.removeListener?.("accountsChanged", accountsChanged);
    provider.removeListener?.("chainChanged", chainChanged);
    provider.removeListener?.("disconnect", disconnect);
  };
}
