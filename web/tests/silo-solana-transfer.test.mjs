import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,TransactionMessage,VersionedTransaction,SystemProgram} from '@solana/web3.js';
import {Buffer} from 'buffer';
import {TOKEN_2022_PROGRAM_ID} from '@solana/spl-token';
import {buildSiloTransfer,inspectSiloTransfer,siloTransferTerms,prepareSiloTransfer,SILO_SOLANA_GENESIS,signSiloTransfer} from '../lib/silo/solana-transfer.mjs';
import {signSiloTransferDurably,saveSiloTransferJournal,readSiloTransferJournal,reconcileSiloTransferJournal,SILO_TRANSFER_JOURNAL_KEY} from '../lib/silo/solana-transfer-journal.mjs';
const owner=Keypair.generate(),recipient=Keypair.generate(),mint=Keypair.generate(),blockhash=Keypair.generate().publicKey.toBase58();
const terms={network:'devnet',owner:owner.publicKey.toBase58(),recipient:recipient.publicKey.toBase58(),mint:null,amount:'1000',decimals:9};
const build=()=>buildSiloTransfer(terms,blockhash);
const connection=()=>({getGenesisHash:async()=>SILO_SOLANA_GENESIS.devnet,getAccountInfo:async key=>key.equals(owner.publicKey)?{executable:false,owner:SystemProgram.programId,data:Buffer.alloc(0),lamports:100000}:null,getLatestBlockhash:async()=>({blockhash,lastValidBlockHeight:100}),getFeeForMessage:async()=>({value:5000}),simulateTransaction:async()=>({value:{err:null}}),getBlockHeight:async()=>90});
const storage=()=>{const map=new Map();return {getItem:k=>map.has(k)?map.get(k):null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};};
async function signedPayment(){const c=connection(),review=await prepareSiloTransfer(terms,{connection:c});return signSiloTransfer(review,{connection:c,wallet:{publicKey:owner.publicKey,signTransaction:async tx=>{tx.sign([owner]);return tx;}}});}
test('strict SOL and classic SPL layouts round-trip with exact terms',()=>{
 assert.deepEqual(inspectSiloTransfer(build(),{network:'devnet'}).terms,terms);
 const spl={...terms,mint:mint.publicKey.toBase58(),decimals:6,program:'spl',tokenFee:null};assert.deepEqual(inspectSiloTransfer(buildSiloTransfer(spl,blockhash),{network:'devnet'}).terms,spl);
});
test('extra instructions, Token2022 and changed compute prices fail closed',()=>{
 for(const alter of [ix=>ix.push(SystemProgram.transfer({fromPubkey:owner.publicKey,toPubkey:recipient.publicKey,lamports:1})),ix=>{ix[0].data.writeUInt32LE(300000,1);}]){
  const ix=TransactionMessage.decompile(build().message).instructions;alter(ix);const tx=new VersionedTransaction(new TransactionMessage({payerKey:owner.publicKey,recentBlockhash:blockhash,instructions:ix}).compileToV0Message());assert.throws(()=>inspectSiloTransfer(tx,{network:'devnet'}));
 }
 const ix=TransactionMessage.decompile(buildSiloTransfer({...terms,mint:mint.publicKey.toBase58(),decimals:6},blockhash).message).instructions;ix[3].programId=TOKEN_2022_PROGRAM_ID;
 assert.throws(()=>inspectSiloTransfer(new VersionedTransaction(new TransactionMessage({payerKey:owner.publicKey,recentBlockhash:blockhash,instructions:ix}).compileToV0Message()),{network:'devnet'}));
});
test('invalid amount, recipient, decimal and hidden transfer fields are rejected',()=>{
 for(const patch of [{amount:'0'},{amount:'01'},{amount:'18446744073709551616'},{amount:'1e3'},{recipient:terms.owner},{network:'testnet'},{decimals:6},{feeAccount:terms.recipient}])assert.throws(()=>siloTransferTerms({...terms,...patch}));
});
test('wrong chain, insufficient fee reserve and simulation failure prevent preparation',async()=>{
 for(const patch of [{getGenesisHash:async()=>SILO_SOLANA_GENESIS['mainnet-beta']},{getFeeForMessage:async()=>({value:100000})},{simulateTransaction:async()=>({value:{err:{InstructionError:[0,'fail']}}})}])await assert.rejects(()=>prepareSiloTransfer(terms,{connection:{...connection(),...patch}}));
});
test('exact owner signature succeeds; wallet mutation and expired review are refused',async()=>{
 const c=connection(),review=await prepareSiloTransfer(terms,{connection:c,now:()=>1000}),wallet={publicKey:owner.publicKey,signTransaction:async tx=>{tx.sign([owner]);return tx;}};
 const signed=await signSiloTransfer(review,{wallet,connection:c,now:()=>1001});assert.equal(inspectSiloTransfer(VersionedTransaction.deserialize(signed.wire),{network:'devnet',signed:true}).signature,signed.signature);
 await assert.rejects(()=>signSiloTransfer(review,{wallet,connection:c,now:()=>31001}));
 // An approval that returns after the review expired is discarded, even though every check before it passed (audit phase A, low).
 {let clock=1001;const slow={...wallet,signTransaction:async tx=>{clock=31002;return wallet.signTransaction(tx);}};
  await assert.rejects(()=>signSiloTransfer(review,{wallet:slow,connection:c,now:()=>clock}),/expired while the wallet was open/);}
 await assert.rejects(()=>signSiloTransfer(review,{wallet:{...wallet,signTransaction:async tx=>{tx.message.recentBlockhash=Keypair.generate().publicKey.toBase58();tx.sign([owner]);return tx;}},connection:c,now:()=>1001}));
 const changingWallet={publicKey:owner.publicKey,signTransaction:async tx=>{tx.sign([owner]);changingWallet.publicKey=recipient.publicKey;return tx;}};await assert.rejects(()=>signSiloTransfer(review,{wallet:changingWallet,connection:c,now:()=>1001}));
});
test('signed durable receipt blocks replacements and survives reload/unknown status',async()=>{
 const signed=await signedPayment(),s=storage(),c=connection(),row=saveSiloTransferJournal(s,signed);assert.equal(readSiloTransferJournal(s).signature,row.signature);assert.throws(()=>saveSiloTransferJournal(s,signed));
 const pending=await reconcileSiloTransferJournal(s,{...c,getSignatureStatuses:async()=>({value:[null]})},{network:'devnet'});assert.equal(pending.state,'unknown');assert.ok(readSiloTransferJournal(s));
 const done=await reconcileSiloTransferJournal(s,{...c,getSignatureStatuses:async()=>({value:[{confirmationStatus:'finalized',err:null,slot:90}]}),getTransaction:async()=>({slot:90,transaction:{signatures:[row.signature],message:VersionedTransaction.deserialize(Buffer.from(row.wire,'base64')).message},meta:{err:null,fee:5000}})},{network:'devnet'});assert.equal(done.state,'finalized');assert.equal(readSiloTransferJournal(s),null);
 s.setItem(SILO_TRANSFER_JOURNAL_KEY,'broken');assert.throws(()=>readSiloTransferJournal(s));
});
test('mutable expiry metadata cannot release a still valid signed transaction',async()=>{
 const s=storage();saveSiloTransferJournal(s,await signedPayment());const c={...connection(),getBlockHeight:async()=>200,getSignatureStatuses:async()=>({value:[null]}),isBlockhashValid:async()=>({value:true}),getTransaction:async()=>assert.fail('valid blockhash cannot be released')};
 assert.equal((await reconcileSiloTransferJournal(s,c,{network:'devnet'})).state,'unknown');assert.ok(readSiloTransferJournal(s));
});
test('malformed or incomplete historical status stays held even after blockhash expiry',async()=>{
 const s=storage();saveSiloTransferJournal(s,await signedPayment());
 await assert.rejects(reconcileSiloTransferJournal(s,{...connection(),getSignatureStatuses:async()=>({value:[]})},{network:'devnet'}),/Historical status/);assert.ok(readSiloTransferJournal(s));
 const c={...connection(),getBlockHeight:async()=>200,getSignatureStatuses:async()=>({value:[null]}),isBlockhashValid:async()=>({value:false}),getTransaction:async()=>null};
 assert.equal((await reconcileSiloTransferJournal(s,c,{network:'devnet'})).state,'unknown');assert.ok(readSiloTransferJournal(s));
});
test('storage failure refuses durable acceptance before relay',async()=>{
 const signed=await signedPayment(),s={...storage(),setItem(){throw Error('quota');}};let relayed=false;
 assert.throws(()=>{saveSiloTransferJournal(s,signed);relayed=true;},/quota/);assert.equal(relayed,false);
});

test('a signing context changed while approval was open cannot return accepted signed bytes',async()=>{
 const c=connection(),review=await prepareSiloTransfer(terms,{connection:c,now:()=>1000});let current=true;
 const wallet={publicKey:owner.publicKey,signTransaction:async tx=>{tx.sign([owner]);current=false;return tx;}};
 await assert.rejects(()=>signSiloTransfer(review,{wallet,connection:c,now:()=>1001,assertCurrent:()=>{if(!current)throw Error('Signing context changed.');}}),/Signing context changed/);
});

test('a saved payment is only reconciled on the network the page selected; another label is held (audit phase B, FA-03)',async()=>{
 const s=storage();saveSiloTransferJournal(s,await signedPayment());
 const expired={...connection(),getBlockHeight:async()=>200,getSignatureStatuses:async()=>({value:[null]}),isBlockhashValid:async()=>({value:false}),getTransaction:async()=>null};
 assert.equal((await reconcileSiloTransferJournal(s,expired,{network:'mainnet-beta'})).state,'held-other-network');assert.ok(readSiloTransferJournal(s),'not cleared');
 await assert.rejects(reconcileSiloTransferJournal(s,expired),/Select the network/);assert.ok(readSiloTransferJournal(s));
});
test('module refusals carry a readable reason; other errors do not',async()=>{
 const {siloRefusalMessage}=await import('../lib/silo/solana-transfer.mjs');
 let caught;try{siloTransferTerms({...terms,recipient:terms.owner});}catch(error){caught=error;}
 assert.equal(siloRefusalMessage(caught),'Choose a different recipient: it cannot be your own address and must be an ordinary wallet address.');
 assert.equal(siloRefusalMessage(Error('provider said https://rpc.invalid/?api-key=secret')),null);assert.equal(siloRefusalMessage('x'),null);
});
test('Max SOL uses verified balance minus exact fee; changed balance/costs cannot authorize a stale maximum',async()=>{
 const {prepareSiloMaxTransfer}=await import('../lib/silo/solana-transfer.mjs');
 const c=connection(),review=await prepareSiloMaxTransfer(terms,{connection:c,now:()=>1000});
 assert.equal(review.terms.amount,'95000');assert.equal(review.availableLamports,'100000');assert.equal(review.networkFeeRaw,'5000');assert.equal(Object.isFrozen(review),true);
 let signed=0;const wallet={publicKey:owner.publicKey,signTransaction:async()=>{signed++;}};
 await assert.rejects(()=>signSiloTransfer(review,{wallet,connection:{...c,getFeeForMessage:async()=>({value:6000})},now:()=>1001}),/costs changed/);
 await assert.rejects(()=>signSiloTransfer(review,{wallet,connection:{...c,getAccountInfo:async k=>k.equals(owner.publicKey)?{executable:false,owner:SystemProgram.programId,data:Buffer.alloc(0),lamports:90000}:null},now:()=>1001}));assert.equal(signed,0);
 await assert.rejects(()=>prepareSiloMaxTransfer(terms,{connection:{...c,getFeeForMessage:async()=>({value:100000})}}),/No spendable/);
});

// Disposable local test payment only; no user wallet, RPC, relay or funds.
for(const mode of ['offline','false','async','missing','row-change','context-change','success'])test(`terminal retirement ${mode} preserves recovery unless exact synchronous permission succeeds`,async()=>{
 const s=storage(),row=saveSiloTransferJournal(s,await signedPayment()),before=s.getItem(SILO_TRANSFER_JOURNAL_KEY);
 const c={...connection(),getSignatureStatuses:async()=>({value:[{confirmationStatus:'finalized',err:null,slot:90}]}),getTransaction:async()=>({slot:90,transaction:{signatures:[row.signature],message:VersionedTransaction.deserialize(Buffer.from(row.wire,'base64')).message},meta:{err:null,fee:5000}})};
 let called=0;
 const beforeRetire=async(saved,result)=>{called++;assert.equal(s.getItem(SILO_TRANSFER_JOURNAL_KEY),before);assert.deepEqual(saved,row);assert.equal(result.state,'finalized');if(mode==='offline')throw Error('offline');if(mode==='missing')return null;if(mode==='row-change'){s.setItem(SILO_TRANSFER_JOURNAL_KEY,JSON.stringify({...row,createdAt:row.createdAt+1}));return ()=>{};}return ()=>{if(mode==='context-change')throw Error('context changed');return mode==='false'?false:mode==='async'?Promise.resolve():undefined;};};
 if(mode==='success'){assert.equal((await reconcileSiloTransferJournal(s,c,{network:'devnet',beforeRetire})).state,'finalized');assert.equal(readSiloTransferJournal(s),null);}
 else {await assert.rejects(reconcileSiloTransferJournal(s,c,{network:'devnet',beforeRetire}));assert.ok(readSiloTransferJournal(s));if(mode!=='row-change')assert.equal(s.getItem(SILO_TRANSFER_JOURNAL_KEY),before);}
 assert.equal(called,1);
});

for(const bad of ['nan','negative','throw'])test(`returned fixed local signature survives ${bad} post-wallet clock`,async()=>{
 const fixed=await signedPayment(),c=connection(),review=await prepareSiloTransfer(terms,{connection:c,now:()=>1000}),s=storage();let returned=false;
 const now=()=>{if(!returned)return 1000;if(bad==='throw')throw Error('synthetic clock failure');return bad==='nan'?NaN:-1;};
 await assert.rejects(signSiloTransferDurably(review,{storage:s,connection:c,now,wallet:{publicKey:owner.publicKey,signTransaction:async()=>{returned=true;return VersionedTransaction.deserialize(fixed.wire);}}}));
 const saved=readSiloTransferJournal(s);assert.equal(saved.signature,fixed.signature);assert.equal(saved.wire,Buffer.from(fixed.wire).toString('base64'));assert.equal(saved.submissionApproved,false);assert.equal(saved.createdAt,1000);
});
