// Minimal monero-wallet-rpc / monerod JSON-RPC client (no dependencies).
// Reuses the native-XMR vault's hardened client (timeouts, digest auth, no replay of wallet
// mutations). See ../PROVENANCE.md. `url` may end in /json_rpc; the client wants the base URL.
import { rpcClient } from './monero-rpc.mjs';
export function rpc(url, opts = {}) {
  return rpcClient(url.replace(/\/json_rpc$/, ''), { timeoutMs: 120_000, ...opts });
}
export const DAEMON = process.env.XMR_DAEMON ?? 'http://kernal.eu:38089/json_rpc';
export const atomic = (xmr) => BigInt(Math.round(xmr * 1e12));
export const fmt = (a) => (Number(a) / 1e12).toFixed(12);
export async function daemonHeight() { return (await rpc(DAEMON)('get_info')).height; }
export async function getTx(txid) {
  const r = await fetch(DAEMON.replace('/json_rpc', '/get_transactions'), { method: 'POST', body: JSON.stringify({ txs_hashes: [txid] }) });
  return r.json();
}
