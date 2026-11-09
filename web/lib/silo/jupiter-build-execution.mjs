import {Buffer} from 'buffer';
import {PublicKey,TransactionInstruction,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {assertSiloRuntimeJupiterPair} from './jupiter-route-policy.mjs';
import {inspectSiloJupiterOrder,decodeSiloJupiterTransaction,siloJupiterExecutionTerms} from './jupiter-execution.mjs';
const JUP='JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const refuse=()=>{throw Error('No-collection build contract is unsupported or held.');};
function instruction(value){if(!value||typeof value.programId!=='string'||!Array.isArray(value.accounts)||value.accounts.length>40||typeof value.data!=='string'||value.data.length>1644)refuse();const bytes=Buffer.from(value.data,'base64');if(bytes.toString('base64')!==value.data)refuse();return new TransactionInstruction({programId:new PublicKey(value.programId),keys:value.accounts.map(a=>{if(typeof a.isSigner!=='boolean'||typeof a.isWritable!=='boolean')refuse();return {pubkey:new PublicKey(a.pubkey),isSigner:a.isSigner,isWritable:a.isWritable};}),data:bytes});}
/** Concrete local assembly/inspection alternative, never calls a provider or a
 * wallet. The narrow protocol has one transaction, no tips/extra instructions,
 * no referral account and a Jupiter optional-account sentinel at fee slot 7.
 * Actual primary provider packets and independent review are still required. */
export async function inspectSiloNoCollectionBuild(packet,input,connection){
 const terms=siloJupiterExecutionTerms(input);
 if(!packet||packet.transactionVersion!==0||packet.inputMint!==terms.inputMint||packet.outputMint!==terms.outputMint||packet.inAmount!==terms.amount||packet.swapMode!=='ExactIn'||packet.platformFee!=null||packet.feeAccount!=null||packet.referralAccount!=null||packet.tipInstruction!=null||!Array.isArray(packet.computeBudgetInstructions)||packet.computeBudgetInstructions.length>2||!Array.isArray(packet.setupInstructions)||packet.setupInstructions.length>4||!Array.isArray(packet.otherInstructions)||packet.otherInstructions.length!==0)refuse();
 const block=packet.blockhashWithMetadata;if(!block||!Array.isArray(block.blockhash)||block.blockhash.length!==32||block.blockhash.some(b=>!Number.isInteger(b)||b<0||b>255)||!Number.isSafeInteger(block.lastValidBlockHeight)||block.lastValidBlockHeight<1)refuse();
 const blockhash=bs58.encode(Uint8Array.from(block.blockhash));if((await connection.isBlockhashValid(blockhash,{commitment:'confirmed'})).value!==true||await connection.getBlockHeight('confirmed')>block.lastValidBlockHeight)refuse();
 const tables=[];const mappings=packet.addressesByLookupTableAddress??{};if(typeof mappings!=='object'||Array.isArray(mappings)||Object.keys(mappings).length>4)refuse();
 for(const [address,expected]of Object.entries(mappings)){if(!Array.isArray(expected)||expected.length>256)refuse();const response=await connection.getAddressLookupTable(new PublicKey(address),{commitment:'confirmed'}),table=response?.value;if(!table||table.state.deactivationSlot!==18446744073709551615n||table.state.addresses.length!==expected.length||table.state.addresses.some((key,i)=>String(key)!==expected[i]))refuse();tables.push(table);}
 const instructions=[...packet.computeBudgetInstructions,...packet.setupInstructions,packet.swapInstruction,...(packet.cleanupInstruction?[packet.cleanupInstruction]:[])].map(instruction);
 const transaction=new VersionedTransaction(new TransactionMessage({payerKey:new PublicKey(terms.owner),recentBlockhash:blockhash,instructions}).compileToV0Message(tables));
 const bytes=transaction.serialize();if(bytes.length>1232)refuse();
 const transactionBase64=Buffer.from(bytes).toString('base64');
 const order={...packet,router:'metis',gasless:false,taker:terms.owner,signatureFeePayer:terms.owner,feeBps:0,transactionVersion:0,requestId:'local-build-no-collection',lastValidBlockHeight:block.lastValidBlockHeight,transaction:transactionBase64};
 const inspected=await inspectSiloJupiterOrder(order,terms,{registered:true,address:JUP},connection,{noCollectionBuild:true});
 return Object.freeze({...inspected,kind:'silo-jupiter-build-review-v1',protocol:'build-own-rpc-no-collection',providerRequestId:null,packet:JSON.parse(JSON.stringify(packet)),collectionEnabled:false,buybacksEnabled:false,executionEnabled:false});
}
/** Held alternative: only an independently authorized runtime can submit the
 * exact durable bytes. No wallet callback/signing or /execute request here. */
export async function submitSiloNoCollectionBuild(journal,{connection,releaseApproved=false,noCollectionPolicyApproved=false,candidateOnly=false,readDurable,beforeDispatch}={}){
 if(!releaseApproved||!noCollectionPolicyApproved||typeof readDurable!=='function')refuse();
 if(beforeDispatch!==undefined&&typeof beforeDispatch!=='function')refuse();
 if(candidateOnly!==true)assertSiloRuntimeJupiterPair(journal?.terms);else if(connection?.siloOfflineFixture!==true)refuse();
 const saved=await readDurable();if(JSON.stringify(saved)!==JSON.stringify(journal))refuse();
 if(journal?.kind!=='silo-jupiter-build-signed-v1'||journal.network!=='mainnet-beta')refuse();
 const signed=decodeSiloJupiterTransaction(journal.signedTransaction,{signed:true});
 const fresh=await inspectSiloNoCollectionBuild(journal.packet,journal.terms,connection),original=decodeSiloJupiterTransaction(fresh.transactionBase64);
 if(!Buffer.from(signed.message.serialize()).equals(Buffer.from(original.message.serialize()))||bs58.encode(signed.signatures[0])!==journal.signature)refuse();
 // Opus's review, 29 Oct 2026: beforeDispatch (the final admission/budget check) must run only AFTER every byte
 // of the signed transaction has been independently re-verified above -- exactly where the referral-order path's
 // own beforeDispatch already runs, immediately before the provider/network is asked to dispatch. Calling it any
 // earlier (as the caller used to, before this function's own deep verification) could consume a one-shot
 // admission/budget slot for a journal that this verification was always going to refuse anyway.
 if(beforeDispatch)await beforeDispatch();
 try{const signature=await connection.sendRawTransaction(Buffer.from(journal.signedTransaction,'base64'),{skipPreflight:false,maxRetries:0,preflightCommitment:'confirmed'});return {status:'unknown',signature:journal.signature,providerReported:signature===journal.signature?'submitted':'unknown'};}catch(error){if(error?.preDispatchRefusal===true)throw error;/* refused before any bytes left (round 9) */return {status:'unknown',signature:journal.signature};}
}
