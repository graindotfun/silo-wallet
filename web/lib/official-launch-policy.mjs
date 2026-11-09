/** Browser-safe official GRAIN launch policy. No SDK, wallet, transaction or network imports.
 * The next mint and its metadata hash are not source pins. Signing stays locked. */
export const OFFICIAL_LAUNCH_SIGNING_ENABLED=true;
export const OFFICIAL_GENERATION=2;
/** Retired compatibility name. The current mint is not published in browser-safe policy. */
export const OFFICIAL_MINT_CANDIDATE=null;
export const OFFICIAL_LOOKUP_TABLE='GdrHQNhwy7veVC9evQ6YtSwrrjjkqKuHtaV4mfE1X7je';
/** Dedicated relaunch creator. Not the platform admin. Signs create and the creator buy, and pays their SOL. */
export const OFFICIAL_LAUNCH_CREATOR='8A6UdaWWvHnRBGYiJyyiGYyVzSN43dJRCfQx6eJqBJSz';
/** wXMR ATA and LaunchLab creator-fee vault for that creator. They replace the admin's copies in the lookup extension. */
export const OFFICIAL_CREATOR_WXMR_ATA='M94RDaJL8TWjjLmJY8vStdzZbzou5Ugh9EnHWia9pLJ';
export const OFFICIAL_CREATOR_FEE_VAULT='3ySTV5J5EBBRXMmqBHjsneJzLNxAdwyMnHB7GJdSqQw9';
export const OFFICIAL_LOOKUP_EXTENSION_ADDRESSES=Object.freeze([
 'GC1ZWMKnnPBGmTkoNNKnR17SbqZwMN9coSWgW3UH5JSr',
 '5Lh6KLbaacCtZqntCEuvXJhYGgJiD4P33fHv5vo9Da2o',
 '7n3UcnhbCj6prgTnMgPx44fg3aM92xrv7PZwUp6GLFQk',
 '2DPAtwB8L12vrMRExbLuyGnC7n2J5LNoZQSejeQGpwkr',
 OFFICIAL_CREATOR_FEE_VAULT,
 OFFICIAL_CREATOR_WXMR_ATA,
]);
/** Owner approved 0.145 wXMR on 2026-10-05. Minimum is net of the 2% token transfer
 * fee, with 1% output tolerance against the initial curve. Fresh simulation remains required. */
export const OFFICIAL_CREATOR_BUY_SLIPPAGE_BPS=100;
export const OFFICIAL_DECLARED_CREATOR_BUY=Object.freeze({quote:'wXMR',amountIn:'145000000000',minOut:'20697151482236'});
/** The admin permanently funds the 137-byte wXMR allow account in the launch transaction. */
export const OFFICIAL_PUBLIC_ADMISSION=Object.freeze({quote:'wXMR',allowRentLamports:1346200,maximumAdminDebitLamports:1346200,minimumAdminRemainingLamports:650240});
/** Mainnet rent is (128 + data bytes) * 5080. Sizes are from an unsigned local run of the
 * mainnet LaunchLab, Token-2022 and ATA programs. Metadata lives inside the mint account.
 * The wXMR ATA rent is locked before create and is not part of the create debit. */
export const OFFICIAL_LAUNCH_CREATOR_RENT=Object.freeze({
 mintWithMetadata:3388360,pool:2829560,grainVault:1554480,wxmrVault:1488440,grainAta:1574800,creatorFeeVault:1488440,networkFee:17600,wxmrAtaAlreadyRequired:1488440,
});
const rent=OFFICIAL_LAUNCH_CREATOR_RENT;
export const OFFICIAL_LAUNCH_CREATOR_DEBIT_LAMPORTS=rent.mintWithMetadata+rent.pool+rent.grainVault+rent.wxmrVault+rent.grainAta+rent.creatorFeeVault+rent.networkFee;
/** Measured debit is exact. The cap allows 0.005 SOL of headroom for a 1-lamport fee or simulation difference. */
export const OFFICIAL_LAUNCH_DEBIT_HEADROOM_LAMPORTS=5_000_000;
export const OFFICIAL_LAUNCH_PINS=Object.freeze({
 name:'Grainpad',symbol:'GRAIN',taxBps:200,maximumDebitLamports:OFFICIAL_LAUNCH_CREATOR_DEBIT_LAMPORTS+OFFICIAL_LAUNCH_DEBIT_HEADROOM_LAMPORTS,
 creator:OFFICIAL_LAUNCH_CREATOR,creatorBuy:OFFICIAL_DECLARED_CREATOR_BUY,lookupTable:OFFICIAL_LOOKUP_TABLE,
 lookupExtension:OFFICIAL_LOOKUP_EXTENSION_ADDRESSES,
 computeUnitLimit:260000,computeUnitPriceMicroLamports:10000,generation:OFFICIAL_GENERATION,
 unsignedPacketBytes:911,maximumUnsignedPacketBytes:960,
});
const PIN_FIELDS=['taxBps','maximumDebitLamports'];
export function missingOfficialLaunchPins(pins=OFFICIAL_LAUNCH_PINS){
 const missing=[];
 if(!Number.isSafeInteger(pins?.taxBps))missing.push('taxBps');
 if(!Number.isSafeInteger(pins?.maximumDebitLamports)||pins.maximumDebitLamports<1)missing.push('maximumDebitLamports');
 return PIN_FIELDS.filter(field=>missing.includes(field));
}
export function assertOfficialLaunchPins(pins=OFFICIAL_LAUNCH_PINS){
 const missing=missingOfficialLaunchPins(pins);
 if(missing.length)throw Error(`Official launch preparation is locked until these production values are approved: ${missing.join(', ')}.`);
}
export function assertOfficialLaunchSigningEnabled(){if(!OFFICIAL_LAUNCH_SIGNING_ENABLED)throw Error('Official GRAIN launch signing is locked. Nothing was signed or sent.');}
/** cap is the separately approved official-launch ceiling. Null is not the pilot cap. */
export function assertOfficialLaunchDebit(debit,cap){
 if(!Number.isSafeInteger(cap)||cap<1)throw Error('Official launch spending cap is not approved. The GRAINU pilot ceiling does not apply. Nothing was sent.');
 if(!Number.isSafeInteger(debit)||debit<0||debit>cap)throw Error('Official launch cost exceeds the approved spending cap or could not be verified. Nothing was sent.');
}
