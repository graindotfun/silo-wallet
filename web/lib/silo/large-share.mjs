/** Whether a payment's debit (amount + network fee, atomic units) is a large share of the freshly checked unlocked balance:
 * at least a quarter, or not knowable. A large share needs the amount typed again before Send (Sol, review of baf30097, M4).
 * Unknown values never waive the check. */
export function siloLargeShare(debit,spendable){
 if(typeof debit!=='bigint'||debit<0n)return true;
 if(typeof spendable!=='string'||!/^\d{1,30}$/.test(spendable))return true;
 return debit*4n>=BigInt(spendable);
}
