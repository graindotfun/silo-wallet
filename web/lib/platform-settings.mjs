import {assertHolderRewardsOperational} from './rewards-policy.mjs';
/** Dedicated v1 admin. Changing admin derives a new PlatformConfig. */
// On-chain platform image set by the owner-signed admin update (Grain logo, served by the site).
export const PLATFORM_IMAGE='https://grainpad.fun/brand/grain-logo-512.png';
const ADMIN='FuAqW3zEPjVFVeE8ditPabjU5iJbF3BzE2i4djrvWQFM';
// Finalized combined custody handoff: collector claims fees; the founder keeps
// revenue, admin and vesting. Source pins accept only the finalized collector.
export const PLATFORM_CLAIM_AUTHORITY='BxJZSApDy7i4VVAQSRCL5FQJ2RCCP676PUWKYEcY1Z6i';
export const PLATFORM_REVENUE_RECIPIENT=ADMIN;
// Approved Token-2022 transfer-fee collection authority, configured before custody handoff.
export const PLATFORM_TRANSFER_AUTHORITY='BxJZSApDy7i4VVAQSRCL5FQJ2RCCP676PUWKYEcY1Z6i';
// Future FeeKey custody finalized to the same collector; LP principal remains locked.
export const PLATFORM_FEEKEY_AUTHORITY='BxJZSApDy7i4VVAQSRCL5FQJ2RCCP676PUWKYEcY1Z6i';
// Legacy setup 1b (untaxed SOL/wXMR admission) is SUPERSEDED — DO NOT SIGN. There is no flag that reopens it:
// the only setup path is the rewards setup (docs/release/SETUP_PATH.md). 1a is already finalized.
export const LEGACY_SETUP='superseded-do-not-sign';
export const TOKEN_CREATION_ENABLED=true;
export function setupSigningEnabled(){return false;}
export function assertTokenCreationEnabled(mode='rewards'){if(!TOKEN_CREATION_ENABLED)throw Error('Token creation is locked pending separate approval.');if(!['rewards','classic-sol-v1'].includes(mode))throw Error('Unsupported launch mode.');if(mode==='rewards')assertHolderRewardsOperational();}
export const PLATFORM_SETTINGS={admin:ADMIN,transferAuthority:PLATFORM_TRANSFER_AUTHORITY,claimAuthority:PLATFORM_CLAIM_AUTHORITY,revenueRecipient:PLATFORM_REVENUE_RECIPIENT,feeWallet:PLATFORM_CLAIM_AUTHORITY,feeKeyWallet:PLATFORM_FEEKEY_AUTHORITY,vestingWallet:ADMIN,founder:ADMIN,authorityModel:'single-founder-key',walletProvenance:'Dedicated admin wallet, separate from the fee collector wallet.',planned:'squads-multisig+timelock'};
