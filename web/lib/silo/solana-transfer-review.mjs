import {ComputeBudgetProgram,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import {siloUnits} from './amounts.mjs';
/** Itemized cost of a prepared Solana transfer review, derived from the review and its own transaction bytes. A value that cannot
 * be established is 'unknown' and shown as "—", never as zero; anything the slice does not support is said to be unsupported.
 * Display only: nothing here builds, changes or signs a transaction. */
const digits=value=>typeof value==='string'&&/^(0|[1-9]\d{0,19})$/.test(value)?BigInt(value):null;
function priorityFee(transactionBase64){
 try{
  const message=VersionedTransaction.deserialize(Buffer.from(transactionBase64,'base64')).message;let price=null,limit=null;
  for(const ix of TransactionMessage.decompile(message).instructions){
   if(!ix.programId.equals(ComputeBudgetProgram.programId))continue;
   if(ix.data[0]===3&&ix.data.length===9&&price===null)price=ix.data.readBigUInt64LE(1);else if(ix.data[0]===2&&ix.data.length===5&&limit===null)limit=BigInt(ix.data.readUInt32LE(1));else return null;
  }
  if(price===null)return 0n;if(limit===null)return null;
  return (price*limit+999999n)/1000000n;
 }catch{return null;}
}
// The token's own transfer tax (Token-2022 transfer fee): fixed in the signed instruction for this epoch, kept by the token, so the
// recipient receives the amount minus this fee.
function tokenFeeRow(review){
 const terms=review?.terms;if(!terms?.mint)return {label:'Token transfer tax',value:'—',status:'none',note:'Not a token transfer.'};
 const fee=terms.tokenFee===null||terms.tokenFee===undefined?0n:digits(terms.tokenFee),amount=digits(terms.amount);
 if(fee===null||amount===null||fee>amount)return {label:'Token transfer tax',value:'—',status:'unknown',note:'The transfer tax could not be established.'};
 if(fee===0n)return {label:'Token transfer tax',value:'None',status:'known',note:terms.program==='token-2022'&&terms.tokenFee!==null?'This token charges a transfer tax, but it rounds to zero on this amount.':'This token has no transfer tax.'};
 return {label:'Token transfer tax',value:`${siloUnits(fee.toString(),terms.decimals)} tokens`,status:'known',note:`Set by the token and checked in the signed transaction. The recipient receives ${siloUnits((amount-fee).toString(),terms.decimals)} tokens.`};
}
export function siloTransferCosts(review){
 const sol=value=>value===null?'—':`${siloUnits(value.toString(),9)} SOL`;
 const fee=digits(review?.networkFeeRaw),rent=digits(review?.rentRaw),priority=typeof review?.transactionBase64==='string'?priorityFee(review.transactionBase64):null;
 const token=Boolean(review?.terms?.mint),amount=digits(review?.terms?.amount);
 // getFeeForMessage already includes priority: split it for display, never add it twice.
 const baseFee=fee!==null&&priority!==null&&fee>=priority?fee-priority:null;
 const rows=[
  {label:'Network fee',value:sol(baseFee),status:baseFee===null?'unknown':'known',note:'Base and signature fee quoted by the node for this exact message.'},
  {label:'Priority fee',value:sol(priority),status:priority===null?'unknown':'known',note:priority===0n?'None set in this transaction.':'From the compute-unit price and limit in this transaction.'},
  {label:'Account creation',value:sol(rent),status:rent===null?'unknown':'known',note:!token?'Not needed for SOL.':rent===0n?'The recipient already has a token account.':'Pays the rent of the recipient\'s new token account. It stays with that account; you do not get it back.'},
  tokenFeeRow(review),
  {label:'Silo fee',value:sol(0n),status:'known',note:'Silo adds no fee to transfers.'},
 ];
 const costs=[baseFee,priority,rent];const knownCosts=costs.every(value=>value!==null);
 const totalSol=knownCosts&&(!token?amount!==null:true)?costs.reduce((sum,value)=>sum+value,0n)+(token?0n:amount):null;
 const available=digits(review?.availableLamports),tokenAvailable=digits(review?.availableTokenRaw);
 const balanceAfterSol=available!==null&&totalSol!==null&&available>=totalSol?sol(available-totalSol):'—';
 const balanceAfterToken=token&&tokenAvailable!==null&&amount!==null&&tokenAvailable>=amount?`${siloUnits((tokenAvailable-amount).toString(),review.terms.decimals)} tokens`:'—';
 return Object.freeze({rows,balanceAfterSol,balanceAfterToken,balanceAfterNote:'Estimate from the balance checked for this review, assuming it succeeds and no other activity changes the wallet. Rechecked before signing.',unknown:rows.some(row=>row.status==='unknown'),totalSol:sol(totalSol),totalNote:token?'SOL leaving your wallet for fees and rent; the tokens are listed above.':'Amount plus all fees and rent.'});
}
