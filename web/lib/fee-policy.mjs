import {PUBLISHED_REWARDS_SPLIT} from './rewards-split-policy.mjs';
/** Rates use millionths. Policy values are not evidence of platform activation. */
export const FEE_POLICY = Object.freeze({
 denominator:1_000_000,
 // Approved launch economics (owner, 30 Sep 2026): 0.25% protocol + 0.75% Grainpad + 0.25% creator = 1.25%.
 curve:Object.freeze({protocol:2500,platform:7500,creator:2500}),
 cpmm:Object.freeze({trade:2500,creator:10000,protocolShare:120000,fundShare:40000}),
});
export const feePercent = rate => `${rate / (FEE_POLICY.denominator / 100)}%`;
export const CURVE_FEE_DISCLOSURE = `${feePercent(FEE_POLICY.curve.protocol)} protocol + ${feePercent(FEE_POLICY.curve.platform)} Grainpad + ${feePercent(FEE_POLICY.curve.creator)} token creator = ${feePercent(Object.values(FEE_POLICY.curve).reduce((a,b)=>a+b,0))} base curve fee.`;
export const CPMM_FEE_DISCLOSURE = `After graduation, the selected CRRS5 configuration charges ${feePercent(FEE_POLICY.cpmm.trade)} CPMM trade fee plus a separate ${feePercent(FEE_POLICY.cpmm.creator)} creator fee in the quote asset. These replace the curve split. The Fee Key receives LP-fee rights, not the creator fee. Creator fees require an enabled migrated pool; exact amounts depend on trade direction and rounding.`;
/** The Grainpad platform rate PlatformConfig carries from setup 1a until the rewards `configure` transaction
 * sets the approved rate. Accepted only on a not-yet-configured platform. */
export const LEGACY_PLATFORM_RATE = 2500;
/** The approved launch economics in one place. Tests pin every value; a change needs a reviewed economics PR. */
export const LAUNCH_ECONOMICS = Object.freeze({
 curveTotal: FEE_POLICY.curve.protocol + FEE_POLICY.curve.platform + FEE_POLICY.curve.creator,
 holderTax: Object.freeze({minimumBps:100,maximumBps:300,stepBps:10,defaultBps:100,token:'Token-2022 transfer fee, withheld in the launched token'}),
 holderTaxSplit: Object.freeze({holdersBps:PUBLISHED_REWARDS_SPLIT.holdersBps,grainReserveBps:PUBLISHED_REWARDS_SPLIT.grainBurnBps,grainpadBps:PUBLISHED_REWARDS_SPLIT.grainpadBps}),
 cpmmCreatorFee: FEE_POLICY.cpmm.creator,
 grainpadPostGraduation: 'Fee Key claims on the locked initial LP (unproven until a real claim)',
});
