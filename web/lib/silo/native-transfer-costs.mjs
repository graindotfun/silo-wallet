import {siloAmount,siloUnits} from './amounts.mjs';
/** Display-only integer arithmetic from an exact prepared review and last checked wallet total.
 * A total balance projection is not spendability or an unlock-time promise. Unknown ownership
 * gives a range because a payment to any of this wallet's other addresses retains its principal.
 * @param {any} review @param {{balance?: string|null,selfTransfer?: boolean|null,fresh?: boolean}} options */
export function siloNativeTransferCosts(review,{balance=null,selfTransfer=null,fresh=false}={}){
 if(review?.asset!=='XMR')return null;
 const amount=siloAmount(review.amount,12),fee=review.fee==='0.0'||review.fee==='0'?0n:siloAmount(review.fee,12),total=amount+fee;
 const checked=fresh&&typeof balance==='string'&&/^(0|[1-9]\d{0,19})$/.test(balance)?BigInt(balance):null;
 let balanceAfter=null;
 if(checked!==null&&checked>=total){const low=checked-total,high=checked-fee;balanceAfter=selfTransfer===true?siloUnits(high,12):selfTransfer===false?siloUnits(low,12):`${siloUnits(low,12)}–${siloUnits(high,12)}`;}
 return {total:siloUnits(total,12),arrival:siloUnits(amount,12),balanceAfter:balanceAfter??'Not checked',ownership:selfTransfer===true?'self':selfTransfer===false?'external':'unknown',note:selfTransfer===true?'This is your displayed receive address. The principal stays in this wallet; only the fee reduces its total. Funds can remain locked.':selfTransfer===false?'Estimate assumes successful payment and no other wallet activity; it is not the immediately spendable balance.':'Recipient ownership is not fully checked. The range covers an external payment or a transfer within this wallet; spendability and unlock time are not predicted.'};
}
