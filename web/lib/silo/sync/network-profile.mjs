/** Account vault network profiles (owner decision Q2, 18 October 2026). `mainnet` is the product profile and the default
 * everywhere; nothing about it changed. `test-networks` holds the same structure for Solana devnet and Monero stagenet
 * wallets so packaged surfaces can produce real-network account evidence without labelling a test wallet as mainnet.
 * A test-network vault is accepted only by an account runtime explicitly configured for staging test-network vaults; a
 * mainnet client refuses to unwrap one, and a test-network client refuses a mainnet vault. The server cannot read the
 * encrypted profile, so the label it enforces is sent in plaintext at vault creation and checked against the decrypted
 * profile by every client. */
export const VAULT_NETWORK_PROFILES=Object.freeze({
 mainnet:Object.freeze({label:'mainnet',xmr:'mainnet',solana:'mainnet-beta',native:'mainnet'}),
 'test-networks':Object.freeze({label:'test-networks',xmr:'stagenet',solana:'devnet',native:'devnet'}),
});
export function vaultNetworkProfile(label='mainnet'){
 const profile=Object.hasOwn(VAULT_NETWORK_PROFILES,label)?VAULT_NETWORK_PROFILES[label]:null;
 if(!profile)throw Error('Unknown vault network profile.');return profile;
}
/** Profile of a stored keys object: combined/native keys carry the profile label; a Monero-only legacy keys object carries
 * its Monero network. */
export function profileOfKeys(keys){
 if(keys?.zone==='xmr')return keys.network==='stagenet'?VAULT_NETWORK_PROFILES['test-networks']:keys.network==='mainnet'?VAULT_NETWORK_PROFILES.mainnet:null;
 return Object.hasOwn(VAULT_NETWORK_PROFILES,keys?.network)?VAULT_NETWORK_PROFILES[keys.network]:null;
}
/** True when a decrypted vault profile is exactly this network profile. */
export const profileMatches=(profile,expected)=>profile?.xmrNetwork===expected.xmr&&profile?.solanaNetwork===expected.solana;
