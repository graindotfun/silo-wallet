const SOL='So11111111111111111111111111111111111111112',U64=18446744073709551615n;
function raw(x){if(typeof x!=='string'||!/^(0|[1-9]\d{0,19})$/.test(x)||BigInt(x)>U64)throw Error('Swap cost unavailable.');return BigInt(x);}
/** Primary-reviewed wallet costs. Provider/pool deductions are in output, not charged twice. */
export function siloSwapCostSummary(review){
 const c=review.contract,network=raw(review.networkFeeRaw),rent=raw(review.createdTokenAccountRentRaw),input=raw(c.inputRaw),quoted=raw(c.quotedOutputRaw),minimum=raw(c.minimumOutputRaw);
 if(minimum>quoted||network<5000n)throw Error('Swap economics differ.');
 const cost=network+rent,total=(c.inputMint===SOL?input:0n)+cost;
 if(total>U64)throw Error('Total SOL cost exceeds supported range.');
 const netMinimum=c.outputMint===SOL?minimum-cost:null,netExpected=c.outputMint===SOL?quoted-cost:null;
 return Object.freeze({networkFeeRaw:String(network),rentRaw:String(rent),additionalSolRaw:String(cost),totalSolRequiredRaw:String(total),netSolMinimumRaw:netMinimum===null?null:String(netMinimum),netSolExpectedRaw:netExpected===null?null:String(netExpected),netSolMayBeNegative:netMinimum!==null&&netMinimum<0n,feesIncludedInOutput:true,estimated:true});
}
