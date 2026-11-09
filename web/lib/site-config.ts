import {PLATFORM_SETTINGS} from "./platform-settings.mjs";
import {OFFICIAL_ARTWORK} from "./official-artwork.mjs";
import {MONERO_NARRATIVE,moneroRecordSummary} from "./monero-record-status.mjs";
export const SITE = {
  name: "Grainpad",
  subtitle: "Monero launch records",
  projectWallet: PLATFORM_SETTINGS.founder,
  origin: "https://grainpad.fun",
  twitter: "https://x.com/GrainXMR",
  discord: "https://discord.gg/PPDYqv4KWa",
  github: "https://github.com/graindotfun/grainpad",
  twitterHandle: "GrainXMR",
  tokenName: "Grainpad",
  tokenSymbol: "GRAIN",
  maxCost: "0.022",
  description: `Grainpad is a Solana launchpad on Raydium LaunchLab. ${MONERO_NARRATIVE} ${moneroRecordSummary()} GRAIN is the project token, with no XMR backing.`,
};
export function identityPolicy(owner: string) {
  return {owner, admin: PLATFORM_SETTINGS.admin, artworkHash: OFFICIAL_ARTWORK.sha256, siteHost: new URL(SITE.origin).hostname, twitterHandle: SITE.twitterHandle};
}
export type Network = "devnet" | "mainnet-beta";
export const NETWORKS = {
  devnet: { label: "Devnet · test funds", rpc: "https://api.devnet.solana.com", genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" },
  "mainnet-beta": { label: "Mainnet · real SOL", rpc: "https://solana-rpc.publicnode.com", genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" },
};
