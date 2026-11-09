/** Unsigned estimate, NOT a fee limit or transaction/input-selection proof.
 * Math follows Monero wallet2 estimate_rct_tx_size / calculate_fee_from_weight.
 * Scope: HF16, CLSAG, Bulletproof+, ring16, view tags, one recipient+change.
 * No transaction is built, signed, reserved or relayed by this module.
 * The exact SDK-created review must still recheck its fee and affordability.
 */
export const SILO_XMR_FEE_MODEL=Object.freeze({version:'hf16-single-recipient-estimate-v1',hardFork:16,ringSize:16,maxInputs:128,maxAgeMs:30000,upstreamRelease:'v0.18.4.4',upstreamCommit:'516e5355a103a2bf0b7e10328ebcaa2945019445'});
const U64=18446744073709551615n;
function atomic(value){if(typeof value==='number'){if(!Number.isSafeInteger(value))throw Error('Fee data is not exact.');value=String(value);}if(typeof value!=='string'||!/^[1-9]\d{0,19}$/.test(value)||BigInt(value)>U64)throw Error('Fee data is outside bounds.');return BigInt(value);}
function count(value){if(!Number.isInteger(value)||value<1||value>SILO_XMR_FEE_MODEL.maxInputs)throw Error('Input count is outside the estimate model.');return value;}
/** Monero's approximate serialization weight; two outputs have no BP clawback.
 * extraBytes44 is upstream WalletImpl's pubkey+encrypted-payment-ID estimate.
 * extraBytes110 allows two additional public keys; neither is a guaranteed
 * upper bound on the final SDK serialization, offsets or selected inputs.
 */
export function siloXmrEstimatedWeight(inputs,extraBytes=44){
 count(inputs);if(![44,110].includes(extraBytes))throw Error('Unsupported extra estimate.');
 return BigInt(7+inputs*(1+6+16*2+32)+2*(6+32)+extraBytes+1+(2*(6+1)+6)*32+3+inputs*(16*32+64)+2+32*inputs+8*2+32*2+4);
}
function fee(rate,weight,quantum){const raw=rate*weight;if(raw>U64)throw Error('Estimated fee overflow.');const rounded=((raw+quantum-1n)/quantum)*quantum;if(rounded>U64)throw Error('Estimated fee overflow.');return rounded;}
/** Priority0 is automatic: do not assume which of the four daemon tiers the
 * SDK chooses. Return the full tier/model range; it is not an affordability
 * check. Explicit priorities1..4 use their named daemon tier.
 */
export function siloXmrUnsignedFeeModel({inputCount,priority,feeEstimate,hardFork,checkedAt,now=Date.now()}){
 count(inputCount);if(hardFork!==16||!Number.isInteger(priority)||priority<0||priority>4)throw Error('Fee model or priority unsupported.');
 if(!Number.isSafeInteger(checkedAt)||!Number.isSafeInteger(now)||now<checkedAt||now-checkedAt>=SILO_XMR_FEE_MODEL.maxAgeMs)throw Error('Fee estimate is stale.');
 if(!feeEstimate||feeEstimate.status!=='OK'||feeEstimate.untrusted!==false||!Array.isArray(feeEstimate.fees)||feeEstimate.fees.length!==4)throw Error('Fresh primary fee tiers unavailable.');
 const tiers=feeEstimate.fees.map(atomic),quantum=atomic(feeEstimate.quantization_mask);
 if(tiers.some((v,i)=>i>0&&v<tiers[i-1]))throw Error('Fee tiers are not ordered.');
 const lowRate=priority?tiers[priority-1]:tiers[0],highRate=priority?lowRate:tiers[3];
 return Object.freeze({kind:'unsigned-model-estimate',networkFeeLowRaw:String(fee(lowRate,siloXmrEstimatedWeight(1),quantum)),networkFeeHighRaw:String(fee(highRate,siloXmrEstimatedWeight(inputCount,110),quantum)),checkedAt,expiresAt:checkedAt+SILO_XMR_FEE_MODEL.maxAgeMs,priorityLabel:priority?['Slow','Normal','Fast','Fastest'][priority-1]:'Automatic priority · all reported tiers',model:SILO_XMR_FEE_MODEL,exact:false,feeLimit:false,affordabilityChecked:false,transactionBuilt:false});
}
/** Local SDK output facts only. Never return key images, output identities,
 * private amounts or the count to a remote node. Refuse incomplete flags.
 */
export function siloXmrAvailableInputCount(outputs){
 if(!Array.isArray(outputs)||outputs.length<1||outputs.length>SILO_XMR_FEE_MODEL.maxInputs)throw Error('Available inputs cannot be estimated.');
 for(const output of outputs){
  if(output?.getAccountIndex?.()!==0||output.getIsSpent?.()!==false||output.getIsFrozen?.()!==false||output.getIsLocked?.()!==false)throw Error('Available input state was not checked.');
  const amount=output.getAmount?.();if(typeof amount!=='bigint'||amount<=0n||amount>U64)throw Error('Available input amount was not checked.');
 }
 return outputs.length;
}
