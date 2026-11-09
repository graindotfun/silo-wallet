import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,ComputeBudgetProgram,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {buildSiloTransfer} from '../lib/silo/solana-transfer.mjs';
import {siloTransferCosts} from '../lib/silo/solana-transfer-review.mjs';
const owner=Keypair.generate().publicKey.toBase58(),recipient=Keypair.generate().publicKey.toBase58(),mint=Keypair.generate().publicKey.toBase58(),blockhash=Keypair.generate().publicKey.toBase58();
const reviewOf=(terms,extra={})=>({terms,transactionBase64:Buffer.from(buildSiloTransfer(terms,blockhash).serialize()).toString('base64'),networkFeeRaw:'5000',rentRaw:'0',...extra});
test('SOL transfer: every cost is itemized from the review and its own bytes; the total includes the amount',()=>{
 const costs=siloTransferCosts(reviewOf({network:'devnet',owner,recipient,mint:null,amount:'1000000000',decimals:9}));
 const row=label=>costs.rows.find(r=>r.label===label);
 assert.equal(row('Network fee').value,'0.000005 SOL');assert.equal(row('Priority fee').value,'0.0 SOL');assert.equal(row('Priority fee').note,'None set in this transaction.');
 assert.equal(row('Token transfer tax').status,'none');assert.equal(costs.unknown,false);assert.equal(costs.totalSol,'1.000005 SOL');
});
test('classic SPL transfer: rent is shown, no transfer tax, the SOL total excludes the tokens',()=>{
 const costs=siloTransferCosts(reviewOf({network:'devnet',owner,recipient,mint,amount:'25',decimals:6,program:'spl',tokenFee:null},{rentRaw:'2039280'}));
 assert.equal(costs.rows.find(r=>r.label==='Account creation').value,'0.00203928 SOL');
 const tax=costs.rows.find(r=>r.label==='Token transfer tax');assert.equal(tax.status,'known');assert.equal(tax.value,'None');assert.equal(costs.totalSol,'0.00204428 SOL');
});
test('Token-2022 transfer tax is shown before approval with what the recipient receives',()=>{
 const costs=siloTransferCosts(reviewOf({network:'devnet',owner,recipient,mint,amount:'1000',decimals:2,program:'token-2022',tokenFee:'30'}));
 const tax=costs.rows.find(r=>r.label==='Token transfer tax');
 assert.equal(tax.status,'known');assert.equal(tax.value,'0.3 tokens');assert.match(tax.note,/receives 9\.7 tokens/);assert.equal(costs.unknown,false);
 const zero=siloTransferCosts(reviewOf({network:'devnet',owner,recipient,mint,amount:'1000',decimals:2,program:'token-2022',tokenFee:'0'})).rows.find(r=>r.label==='Token transfer tax');
 assert.equal(zero.value,'None');assert.match(zero.note,/rounds to zero/);
 const broken=siloTransferCosts({...reviewOf({network:'devnet',owner,recipient,mint,amount:'1000',decimals:2,program:'token-2022',tokenFee:'30'}),terms:{network:'devnet',owner,recipient,mint,amount:'1000',decimals:2,program:'token-2022',tokenFee:'2000'}});
 assert.equal(broken.unknown,true);
});
test('a cost that cannot be established is unknown and shown as a dash, never as zero, and the total is unknown',()=>{
 const base=reviewOf({network:'devnet',owner,recipient,mint:null,amount:'1',decimals:9});
 for(const broken of [{networkFeeRaw:undefined},{rentRaw:'-1'},{transactionBase64:'not bytes'}]){
  const costs=siloTransferCosts({...base,...broken});
  assert.equal(costs.unknown,true);assert.equal(costs.totalSol,'—');assert.ok(costs.rows.some(r=>r.status==='unknown'&&r.value==='—'));
 }
});

test('priority fee is split out of the node total, never counted twice',()=>{
 const terms={network:'devnet',owner,recipient,mint:null,amount:'1000000000',decimals:9};
 const instructions=TransactionMessage.decompile(buildSiloTransfer(terms,blockhash).message).instructions.filter(ix=>!ix.programId.equals(ComputeBudgetProgram.programId));
 const tx=new VersionedTransaction(new TransactionMessage({payerKey:Keypair.fromSeed(new Uint8Array(32)).publicKey,recentBlockhash:blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:200000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:1000}),...instructions]}).compileToV0Message());
 const costs=siloTransferCosts(reviewOf(terms,{transactionBase64:Buffer.from(tx.serialize()).toString('base64'),networkFeeRaw:'5200'}));
 assert.equal(costs.rows.find(r=>r.label==='Network fee').value,'0.000005 SOL');
 assert.equal(costs.rows.find(r=>r.label==='Priority fee').value,'0.0000002 SOL');
 assert.equal(costs.totalSol,'1.0000052 SOL');
 const inconsistent=siloTransferCosts(reviewOf(terms,{transactionBase64:Buffer.from(tx.serialize()).toString('base64'),networkFeeRaw:'100'}));
 assert.equal(inconsistent.unknown,true);assert.equal(inconsistent.totalSol,'—');
});
test('balance after is a review-snapshot estimate with fees/rent, never unknown-as-zero',()=>{
 const sol=siloTransferCosts(reviewOf({network:'devnet',owner,recipient,mint:null,amount:'1000',decimals:9},{availableLamports:'100000'}));assert.equal(sol.balanceAfterSol,'0.000094 SOL');assert.match(sol.balanceAfterNote,/Estimate/);
 const token=siloTransferCosts(reviewOf({network:'devnet',owner,recipient,mint,amount:'25',decimals:6,program:'spl',tokenFee:null},{availableLamports:'10000000',availableTokenRaw:'100',rentRaw:'2039280'}));assert.equal(token.balanceAfterSol,'0.00795572 SOL');assert.equal(token.balanceAfterToken,'0.000075 tokens');
 const unknown=siloTransferCosts(reviewOf({network:'devnet',owner,recipient,mint:null,amount:'1000',decimals:9}));assert.equal(unknown.balanceAfterSol,'—');
});
