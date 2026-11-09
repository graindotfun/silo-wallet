import {Buffer} from 'buffer';
import {transactionAddressKeys} from './transaction-addresses.mjs';
export const COMPUTE_PROGRAM='ComputeBudget111111111111111111111111111111';
export const LIGHTHOUSE_PROGRAM='L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function decodeReviewedTransaction(transaction,addressContext){
 const m=transaction?.message;
 if(m?.version!==0)throw Error('Unsupported message version or address lookup tables.');
 const keys=transactionAddressKeys(transaction,addressContext).map((key,i)=>({key,signer:m.isAccountSigner(i),writable:m.isAccountWritable(i)}));
 if(new Set(keys.map(k=>k.key)).size!==keys.length)throw Error('Duplicate account keys.');
 const instructions=m.compiledInstructions.map((ix,index)=>{
  if(!keys[ix.programIdIndex]||[...ix.accountKeyIndexes].some(i=>!keys[i]))throw Error('Invalid instruction account index.');
  return {index,programId:keys[ix.programIdIndex].key,accounts:[...ix.accountKeyIndexes].map(i=>keys[i]),dataHex:Buffer.from(ix.data).toString('hex')};
 });
 const compute=instructions.filter(ix=>ix.programId===COMPUTE_PROGRAM).map(ix=>{
  const data=Buffer.from(ix.dataHex,'hex'),kind=data[0];
  return {index:ix.index,kind,...(kind===2&&data.length===5?{unitLimit:data.readUInt32LE(1)}:{}),...(kind===3&&data.length===9?{microLamports:data.readBigUInt64LE(1).toString()}:{}),dataHex:ix.dataHex};
 });
 return {addressLookups:addressContext?.fingerprint||null,payer:keys[0]?.key,signers:keys.filter(k=>k.signer).map(k=>k.key),blockhash:m.recentBlockhash,keys,instructions,compute,bytes:transaction.serialize().length};
}
const identity=ix=>({programId:ix.programId,accounts:ix.accounts,dataHex:ix.dataHex});
/** Decode and diff before validating so rejected changes remain visible in diagnostics. */
export function inspectWalletTransaction(before,transaction,addressContext,{allowDefaultZeroPrice=false,allowVerifiedLookupRemap=false}={}){
 let after;try{after=decodeReviewedTransaction(transaction,addressContext);}catch(e){return {valid:false,reasons:[e.message],before,after:null,added:[],removed:[],computeBefore:before.compute,computeAfter:[]};}
 const a=before.instructions,b=after.instructions;
 const dp=Array.from({length:a.length+1},()=>Array(b.length+1).fill(0));
 for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)dp[i][j]=same(identity(a[i]),identity(b[j]))?1+dp[i+1][j+1]:Math.max(dp[i+1][j],dp[i][j+1]);
 const added=[],removed=[],matched=[];let i=0,j=0;
 while(i<a.length||j<b.length){
  if(i<a.length&&j<b.length&&same(identity(a[i]),identity(b[j]))){matched.push({originalIndex:i,returnedIndex:j});i++;j++;}
  else if(j<b.length&&(i===a.length||dp[i][j+1]>=dp[i+1][j]))added.push(b[j++]);
  else removed.push(a[i++]);
 }
 const reasons=[];
 // Wallets may recompile an otherwise identical v0 message and move the same
 // accounts between static keys and a verified on-chain lookup table. Callers
 // may accept that packaging change only after resolving the returned message;
 // every semantic key, privilege and instruction remains checked below.
 if(before.addressLookups!==after.addressLookups&&allowVerifiedLookupRemap!==true)reasons.push('Verified address lookup mapping changed.');
 if(before.payer!==after.payer)reasons.push('Fee payer changed.');
 if(!same(before.signers,after.signers))reasons.push('Required signers changed.');
 if(before.blockhash!==after.blockhash)reasons.push('Recent blockhash changed.');
 if(before.keys.some(k=>!after.keys.some(next=>same(k,next))))reasons.push('Original account privileges changed or an account was removed.');
 if(removed.length)reasons.push('An original instruction was removed, changed or reordered.');
 if(added.some(ix=>![COMPUTE_PROGRAM,LIGHTHOUSE_PROGRAM].includes(ix.programId)))reasons.push('An added instruction uses an unapproved program.');
 if(after.bytes>1232)reasons.push('Returned transaction exceeds 1,232 bytes.');
 // Solana rejects repeated compute-setting variants; do not rely on a last-wins interpretation.
 const seen=new Set();
 for(const ix of after.compute){
  const length=ix.dataHex.length/2;
  if(![1,2,3,4].includes(ix.kind)||length!==(ix.kind===3?9:5)||seen.has(ix.kind)||b[ix.index].accounts.length)reasons.push('Invalid or duplicate ComputeBudget instruction.');
  seen.add(ix.kind);
  if(ix.unitLimit!==undefined&&(ix.unitLimit<1||ix.unitLimit>1400000))reasons.push('Invalid compute unit limit.');
 }
 const defaultZeroPrice=allowDefaultZeroPrice===true&&before.compute.some(ix=>ix.unitLimit!==undefined)&&!before.compute.some(ix=>ix.kind===3)&&!after.compute.some(ix=>ix.kind===3);
 if(!after.compute.some(ix=>ix.unitLimit!==undefined)||(!after.compute.some(ix=>ix.microLamports!==undefined)&&!defaultZeroPrice))reasons.push('Explicit compute limit and price are required.');
 return {valid:!reasons.length,reasons,payerBefore:before.payer,payerAfter:after.payer,signersBefore:before.signers,signersAfter:after.signers,blockhashBefore:before.blockhash,blockhashAfter:after.blockhash,bytesBefore:before.bytes,bytesAfter:after.bytes,matched,added,removed,computeBefore:before.compute,computeAfter:after.compute};
}
export function assertWalletTransaction(before,transaction,addressContext,options={}){
 const diff=inspectWalletTransaction(before,transaction,addressContext,options);
 if(!diff.valid)throw Object.assign(Error(`Wallet returned a different transaction outside the approved structure. ${diff.reasons.join(' ')} Nothing was sent.`),{decodedDiff:diff});
 return diff;
}
/** Compare the complete account state, including raw platform bytes, rather than selected fields. */
export function sameSimulatedAccount(a,b){
 const data=x=>Buffer.isBuffer(x?.data)?x.data.toString('base64'):x?.data?.[0];
 const absent=x=>!x||(x.lamports===0&&data(x)===''&&!x.executable&&String(x.owner)==='11111111111111111111111111111111');
 if(absent(a)||absent(b))return absent(a)&&absent(b);
 return String(a.owner)===String(b.owner)&&a.lamports===b.lamports&&a.executable===b.executable&&data(a)===data(b);
}
