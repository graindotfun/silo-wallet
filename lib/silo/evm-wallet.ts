// SPDX-License-Identifier: AGPL-3.0-only
/** EVM public zone wallet access: discovery and account read only. Silo asks the injected wallet for exactly three methods:
 * eth_requestAccounts (the user's explicit connect), eth_accounts and eth_chainId. Any other method is refused here before it
 * reaches the wallet, so this module does not request a signature, a transaction or a network switch. */
import {siloEvmAddress} from './evm.mjs';

export type SiloEip1193 = {
  request(args: {method: string; params?: unknown[]}): Promise<unknown>;
  on?(event: string, listener: (value: unknown) => void): void;
  removeListener?(event: string, listener: (value: unknown) => void): void;
};
export type SiloEvmChoice = {id: string; name: string; provider: SiloEip1193};
export type SiloEvmSession = {name: string; address: string; walletChainId: number | null; provider: SiloEip1193};

export const SILO_EVM_WALLET_METHODS = Object.freeze(["eth_requestAccounts", "eth_accounts", "eth_chainId"] as const);
type Allowed = (typeof SILO_EVM_WALLET_METHODS)[number];

async function ask(provider: SiloEip1193, method: Allowed): Promise<unknown> {
  if (!(SILO_EVM_WALLET_METHODS as readonly string[]).includes(method)) throw new Error("This wallet method is not used by Silo.");
  return provider.request({method});
}

type Injected = SiloEip1193 & {isMetaMask?: boolean; providers?: Injected[]};
const usable = (value: unknown): value is Injected => !!value && typeof (value as SiloEip1193).request === "function";

/** EIP-6963 discovery, then the legacy window.ethereum. Does not ask for account access. */
export async function siloEvmWalletChoices(scope: Window & {ethereum?: Injected} = window as Window & {ethereum?: Injected}): Promise<SiloEvmChoice[]> {
  const announced = new Map<SiloEip1193, SiloEvmChoice>();
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{info?: {name?: unknown; uuid?: unknown}; provider?: unknown}>).detail;
    if (!detail || !usable(detail.provider) || announced.has(detail.provider)) return;
    const name = typeof detail.info?.name === "string" && detail.info.name.trim() ? detail.info.name.trim().slice(0, 40) : "Browser wallet";
    announced.set(detail.provider, {id: typeof detail.info?.uuid === "string" ? detail.info.uuid : `eip6963-${announced.size}`, name, provider: detail.provider});
  };
  scope.addEventListener("eip6963:announceProvider", listener);
  try {
    scope.dispatchEvent(new Event("eip6963:requestProvider"));
    await new Promise(resolve => setTimeout(resolve, 200));
  } finally { scope.removeEventListener("eip6963:announceProvider", listener); }
  const legacy = [...(scope.ethereum?.providers ?? []), scope.ethereum].filter(usable).filter(provider => !announced.has(provider));
  const unique = [...new Set(legacy)].map((provider, index) => ({id: `injected-${index}`, name: provider.isMetaMask ? "MetaMask" : "Browser wallet", provider}));
  return [...announced.values(), ...unique];
}

const chainNumber = (value: unknown): number | null => typeof value === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(value) ? Number(BigInt(value)) : null;

/** The user's explicit connect: eth_requestAccounts, then eth_chainId for display only. The wallet's network is never changed. */
export async function connectSiloEvm(choice: SiloEvmChoice): Promise<SiloEvmSession> {
  const accounts = await ask(choice.provider, "eth_requestAccounts");
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof first !== "string") throw new Error("The wallet did not return an account.");
  let walletChainId: number | null = null;
  try { walletChainId = chainNumber(await ask(choice.provider, "eth_chainId")); } catch { walletChainId = null; }
  return {name: choice.name, address: siloEvmAddress(first), walletChainId, provider: choice.provider};
}

/** Follow account and network changes without prompting. A different account, or none, ends the session. */
export function watchSiloEvm(session: SiloEvmSession, changed: (next: SiloEvmSession | null) => void): () => void {
  const provider = session.provider;
  if (!provider.on || !provider.removeListener) return () => {};
  let active = true;
  const accounts = (value: unknown) => {
    if (!active) return;
    const first = Array.isArray(value) ? value[0] : undefined;
    let next: string | null = null;
    try { next = typeof first === "string" ? siloEvmAddress(first) : null; } catch { next = null; }
    if (next !== session.address) { active = false; changed(null); }
  };
  const chain = (value: unknown) => { if (active) changed({...session, walletChainId: chainNumber(value)}); };
  const disconnect = () => { if (active) { active = false; changed(null); } };
  provider.on("accountsChanged", accounts);
  provider.on("chainChanged", chain);
  provider.on("disconnect", disconnect);
  return () => {
    active = false;
    provider.removeListener?.("accountsChanged", accounts);
    provider.removeListener?.("chainChanged", chain);
    provider.removeListener?.("disconnect", disconnect);
  };
}
