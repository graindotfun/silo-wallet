/** Payment currencies are independent of the existing token launch pair. */
export const SOL_PAYMENT_ASSETS=Object.freeze({
 SOL:Object.freeze({symbol:'SOL',mint:'So11111111111111111111111111111111111111112',decimals:9,pool:'CgHuN3ajFijPidxiWStiDBUBkchWGNb8tVTGaNgYx9UJ'}),
 USDC:Object.freeze({symbol:'USDC',mint:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',decimals:6,pool:'FvqiTGa9q8heDBzp6YFuNedfvreouR7Vj1JmMPvJAC7C',config:'FMrUDGjEe1izXPbn8SZPNjMfB5JvvhVq5ymmpZDebB5R'}),
});
export function solPaymentAsset(symbol='SOL'){
 if(typeof symbol!=='string'||!Object.hasOwn(SOL_PAYMENT_ASSETS,symbol))throw Error('Choose SOL or native Solana USDC.');
 return SOL_PAYMENT_ASSETS[symbol];
}
/** Display currency never changes when a route temporarily becomes unavailable. */
export function solPaymentDisplay(quote,selected,balances){
 const routed=quote.symbol==='wXMR',asset=routed?solPaymentAsset(selected):quote;
 return {symbol:asset.symbol,decimals:asset.decimals,balance:balances?(routed?(asset.symbol==='USDC'?balances.usdc:balances.sol):balances.quote):null};
}
/** Refuse an unavailable currency route before a direct pool amount can be reinterpreted as that currency. */
export async function readSolPaymentEstimate({quoteSymbol,routingAvailable,routingReason,readRouted,readDirect}){
 if(quoteSymbol!=='wXMR')return readDirect();
 if(!routingAvailable)throw Error(routingReason||'This payment route is currently unavailable.');
 return readRouted();
}
