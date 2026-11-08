// SPDX-License-Identifier: AGPL-3.0-only
// One rule for "is this Monero node on the network this wallet is for", used everywhere a node is contacted: when the wallet
// engine opens (xmr-adapter) and when fees are read (xmr-unsigned-fee-read). The node's `get_info` must carry the selected
// network's flag and none of the others, and when it reports `nettype` that must agree too. This applies to a node typed by
// hand exactly as to the configured one; nothing else about the node is trusted here.
export const SILO_XMR_NETWORKS=Object.freeze(['stagenet','mainnet']);
const NETTYPES=Object.freeze({stagenet:'stagenet',mainnet:'mainnet'});

/** Throws unless `info` (a monerod get_info body) describes exactly `network`. Returns the network. */
export function assertSiloXmrNodeNetwork(info,network){
 if(!SILO_XMR_NETWORKS.includes(network))throw Error('Unsupported Monero network.');
 if(!info||typeof info!=='object'||Array.isArray(info))throw Error('Node did not verify the selected Monero network.');
 const flags=network==='stagenet'?info.stagenet===true&&info.mainnet!==true&&info.testnet!==true:info.mainnet===true&&info.stagenet!==true&&info.testnet!==true;
 const nettype=info.nettype===undefined||info.nettype===NETTYPES[network];
 if(!flags||!nettype)throw Error('Node did not verify the selected Monero network.');
 return network;
}
