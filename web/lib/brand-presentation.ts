// Presentation metadata only. Transaction networks and policy are defined separately.
export const BRAND_CHAIN = {
  label: 'Solana',
  networkLabel: 'Solana mainnet',
  explorerLabel: 'Solana Explorer',
} as const;

// Publishing the UI never activates these claims by itself. The overview endpoint
// additionally requires current platform policy and a published verify-launch PASS.
export const HERO_FEATURES = {pairedLaunches: true, onChainRules: true} as const;
