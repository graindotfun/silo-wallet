/** Browser-safe cap rules for EVM native sends (no network, no keys). Shared by the server (prepare, relay) and the wallet, which
 * re-checks the hard ceiling right before it signs. */
const fail=(message,reason)=>Object.assign(Error(message),{siloEvm:reason});
const micro=usd=>BigInt(Math.round(usd*1e6));
/** The per-transfer cap in dollars. 100 is a hard ceiling in the code; the operator variable SILO_EVM_CAP_USD can only LOWER it
 * (a whole number from 1 to 100; anything else, including a larger number, leaves 100). The cap is per transfer and does not
 * accumulate: it limits one signed transfer, not a day or a wallet. */
export const SILO_EVM_CAP_USD_DEFAULT=100;
export const SILO_EVM_CAP_USD_MAX=100;
export function siloEvmCapUsd(env={}){const value=env.SILO_EVM_CAP_USD;return typeof value==='string'&&/^[1-9]\d{0,2}$/.test(value)&&Number(value)<=SILO_EVM_CAP_USD_MAX?Number(value):SILO_EVM_CAP_USD_DEFAULT;}
/** Volatility margin: for the cap the asset is valued 5% above the price shown, so a price that moves up a little between the
 * review and the inclusion cannot take the transfer over the limit. Prices are also at most 60 s old (5 min when the source is down). */
export const SILO_EVM_PRICE_MARGIN_BPS=500n;
/** The cap applies to what can leave the wallet in one transfer: the amount PLUS the largest fee the transaction allows (including the
 * Base data fee estimate), valued at the price plus the volatility margin. Used by prepare, by the relay (value plus the L2 fee
 * ceiling) and, with the hard ceiling, by the browser right before signing. Throws a fixed refusal. */
/** @param {{valueWei:string|bigint;feeWei?:string|bigint;priceUsd:number;capUsd:number}} input */
export function siloEvmAssertCap({valueWei,feeWei=0n,priceUsd,capUsd}){
 if(!(priceUsd>0))throw fail('A price for this asset is unavailable, so the transfer cannot be checked against the beta limit. Try again shortly.','price');
 const priceMicro=micro(priceUsd)*(10_000n+SILO_EVM_PRICE_MARGIN_BPS)/10_000n;
 if((BigInt(valueWei)+BigInt(feeWei))*priceMicro/10n**18n>BigInt(capUsd)*1_000_000n)throw fail(`Beta limit: up to $${capUsd} per transfer, including the network fee.`,'beta-cap');
}
