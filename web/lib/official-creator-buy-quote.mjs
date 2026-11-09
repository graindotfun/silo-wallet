/** Initial-curve estimate for the atomic creator buy. No wallet, RPC, signer or submission.
 * Supply, fundraising and fee policy are shared with the launch builder. A quote is not a simulation. */
import * as sdk from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import {calculateFee} from '@solana/spl-token';
import {FEE_POLICY} from './fee-policy.mjs';
import {QUOTES} from './quote-assets.mjs';
const b=value=>new BN(String(value)),ZERO=b(0),SUPPLY='1000000000000000',SELL='793100000000000';
export function quoteInitialOfficialCreatorBuy({amountIn,taxBps=200,slippageBps=100,migrateFeeRaw='0',protocolRate=FEE_POLICY.curve.protocol,platformRate=FEE_POLICY.curve.platform,creatorRate=FEE_POLICY.curve.creator}={}){
 if(typeof amountIn!=='string'||!/^[1-9]\d*$/.test(amountIn)||BigInt(amountIn)>(1n<<64n)-1n)throw Error('Creator buy requires a positive canonical raw wXMR amount.');
 if(typeof migrateFeeRaw!=='string'||!/^(0|[1-9]\d*)$/.test(migrateFeeRaw))throw Error('Canonical migration fee required.');
 if(!Number.isInteger(taxBps)||taxBps<0||taxBps>=10000||!Number.isInteger(slippageBps)||slippageBps<0||slippageBps>100)throw Error('Creator buy tax or output tolerance is outside the reviewed bounds.');
 for(const rate of [protocolRate,platformRate,creatorRate])if(!Number.isSafeInteger(rate)||rate<0)throw Error('Canonical curve fee rates required.');
 if(protocolRate+platformRate+creatorRate>=FEE_POLICY.denominator)throw Error('Curve fees consume the input.');
 const initial=sdk.Curve.getCurve(0).getInitParam({supply:b(SUPPLY),totalSell:b(SELL),totalLockedAmount:ZERO,totalFundRaising:b(QUOTES.wXMR.floor),migrateFee:b(migrateFeeRaw)});
 const quote=sdk.Curve.buyExactIn({poolInfo:{virtualA:initial.a,virtualB:initial.b,realA:ZERO,realB:ZERO,totalSellA:b(SELL),totalFundRaisingB:b(QUOTES.wXMR.floor)},amountB:b(amountIn),protocolFeeRate:b(protocolRate),platformFeeRate:b(platformRate),creatorFeeRate:b(creatorRate),shareFeeRate:ZERO,curveType:0});
 if(quote.amountB.toString()!==amountIn)throw Error('Creator buy crosses graduation and is not an exact-input launch buy.');
 const gross=BigInt(quote.amountA.amount.toString()),transferFee=calculateFee({transferFeeBasisPoints:taxBps,maximumFee:BigInt(SUPPLY)},gross),net=gross-transferFee,minOut=net*BigInt(10000-slippageBps)/10000n;
 if(minOut<=0n)throw Error('Creator buy minimum output rounds to zero.');
 const fees=Object.fromEntries(Object.entries(quote.splitFee).map(([name,value])=>[name,value.toString()]));
 const totalFee=Object.values(fees).reduce((sum,value)=>sum+BigInt(value),0n);
 return {quote:'wXMR',amountIn,quoteDecimals:12,tokenDecimals:6,taxBps,slippageBps,grossOutputRaw:String(gross),transferFeeRaw:String(transferFee),expectedNetOutputRaw:String(net),minOut:String(minOut),curveFeesRaw:fees,totalCurveFeeRaw:String(totalFee),curvePrincipalRaw:String(BigInt(amountIn)-totalFee),virtualA:initial.a.toString(),virtualB:initial.b.toString(),evidence:'initial-curve-calculation',simulated:false,submitted:false};
}
