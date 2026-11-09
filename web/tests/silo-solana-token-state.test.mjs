import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,PublicKey,SystemProgram,VersionedTransaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import {MintLayout,AccountLayout,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ExtensionType,TransferFeeConfigLayout,TRANSFER_FEE_CONFIG_SIZE,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {prepareSiloTransfer,verifySiloTransferState,inspectSiloTransfer,siloTransferTerms,SILO_SOLANA_GENESIS} from '../lib/silo/solana-transfer.mjs';
const owner=Keypair.generate(),recipient=Keypair.generate(),mint=Keypair.generate(),blockhash=Keypair.generate().publicKey.toBase58();
const terms={network:'devnet',owner:owner.publicKey.toBase58(),recipient:recipient.publicKey.toBase58(),mint:mint.publicKey.toBase58(),amount:'1000',decimals:6};
const baseMint={mintAuthorityOption:0,mintAuthority:PublicKey.default,supply:1000000n,decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default};
const baseToken={mint:mint.publicKey,owner:owner.publicKey,amount:5000n,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default};
// Token-2022 layout: the classic body, padding to 165 bytes, an account-type byte (1 mint, 2 account), then type/length/value entries.
function tlv(body,accountType,extensions){
 const parts=[body,Buffer.alloc(AccountLayout.span-body.length),Buffer.from([accountType])];
 for(const {type,data=Buffer.alloc(0)} of extensions){const head=Buffer.alloc(4);head.writeUInt16LE(type,0);head.writeUInt16LE(data.length,2);parts.push(head,data);}
 return Buffer.concat(parts);
}
const encodeMint=patch=>{const data=Buffer.alloc(MintLayout.span);MintLayout.encode({...baseMint,...patch},data);return data;};
const encodeToken=patch=>{const data=Buffer.alloc(AccountLayout.span);AccountLayout.encode({...baseToken,...patch},data);return data;};
function transferFee(basisPoints,maximumFee=1000000n,newer=null){
 const data=Buffer.alloc(TRANSFER_FEE_CONFIG_SIZE),fee={epoch:0n,maximumFee,transferFeeBasisPoints:basisPoints};
 TransferFeeConfigLayout.encode({transferFeeConfigAuthority:PublicKey.default,withdrawWithheldAuthority:PublicKey.default,withheldAmount:0n,olderTransferFee:fee,newerTransferFee:newer??fee},data);
 return {type:ExtensionType.TransferFeeConfig,data};
}
const immutable={type:ExtensionType.ImmutableOwner};
function fixture({mintPatch={},sourcePatch={},destinationPatch=null,mintProgram=TOKEN_PROGRAM_ID,sourceProgram=mintProgram,program=mintProgram,balance=10000000,mintExtensions=[],sourceExtensions=[immutable],destinationExtensions=[immutable],epoch=500}={}){
 const t22=program.equals(TOKEN_2022_PROGRAM_ID)||mintProgram.equals(TOKEN_2022_PROGRAM_ID);
 const mintData=t22?tlv(encodeMint(mintPatch),1,mintExtensions):encodeMint(mintPatch),sourceData=t22?tlv(encodeToken(sourcePatch),2,sourceExtensions):encodeToken(sourcePatch);
 const info=(data,owner)=>({owner,executable:false,lamports:2039280,data});
 let destination=null;if(destinationPatch){const body=encodeToken({owner:recipient.publicKey,amount:0n,...destinationPatch});destination=info(t22?tlv(body,2,destinationExtensions):body,program);}
 const rentSizes=[];
 return {rentSizes,getGenesisHash:async()=>SILO_SOLANA_GENESIS.devnet,getEpochInfo:async()=>({epoch}),
  getAccountInfo:async key=>key.equals(owner.publicKey)?{executable:false,owner:SystemProgram.programId,data:Buffer.alloc(0),lamports:balance}:key.equals(mint.publicKey)?info(mintData,mintProgram):null,
  getMultipleAccountsInfo:async keys=>{assert.deepEqual(keys.map(String),[String(mint.publicKey),String(getAssociatedTokenAddressSync(mint.publicKey,owner.publicKey,false,program)),String(getAssociatedTokenAddressSync(mint.publicKey,recipient.publicKey,false,program))]);return [info(mintData,mintProgram),info(sourceData,sourceProgram),destination];},
  getMinimumBalanceForRentExemption:async size=>{rentSizes.push(size);return 2039280;},getLatestBlockhash:async()=>({blockhash,lastValidBlockHeight:100}),getFeeForMessage:async()=>({value:5000}),simulateTransaction:async()=>({value:{err:null}})};
}
const t22={mintProgram:TOKEN_2022_PROGRAM_ID};
const t22Terms=(tokenFee=null)=>({...terms,program:'token-2022',tokenFee});
test('classic SPL state parses real SDK mint/account bytes and reserves ATA rent',async()=>{
 const connection=fixture(),review=await prepareSiloTransfer(terms,{connection});assert.equal(review.rentRaw,'2039280');assert.equal(review.networkFeeRaw,'5000');
 assert.deepEqual(review.terms,{...terms,program:'spl',tokenFee:null});assert.deepEqual(connection.rentSizes,[AccountLayout.span]);assert.deepEqual(review.issuer,{freezeAuthority:false,permanentDelegate:false});
 const existing=await prepareSiloTransfer(terms,{connection:fixture({destinationPatch:{}})});assert.equal(existing.rentRaw,'0');
});
test('a freeze authority is reported to the sender, not refused',async()=>{
 const review=await prepareSiloTransfer(terms,{connection:fixture({mintPatch:{freezeAuthorityOption:1,freezeAuthority:recipient.publicKey}})});
 assert.equal(review.issuer.freezeAuthority,true);
});
test('a token program that differs from the review, decimal mismatch and encumbered source accounts refuse',async()=>{
 for(const patch of [{mintProgram:TOKEN_2022_PROGRAM_ID,program:TOKEN_PROGRAM_ID},{sourceProgram:TOKEN_2022_PROGRAM_ID},{mintPatch:{decimals:9}},{mintPatch:{isInitialized:false}},{sourcePatch:{state:2}},{sourcePatch:{delegateOption:1,delegate:recipient.publicKey}},{sourcePatch:{closeAuthorityOption:1,closeAuthority:recipient.publicKey}},{sourcePatch:{owner:recipient.publicKey}},{sourcePatch:{mint:recipient.publicKey}},{sourcePatch:{amount:999n}},{sourcePatch:{isNativeOption:1,isNative:1n}}])await assert.rejects(()=>verifySiloTransferState({...terms,program:'spl',tokenFee:null},fixture(patch)));
});
test('wrong or frozen recipient token account and insufficient account rent refuse',async()=>{
 for(const patch of [{destinationPatch:{owner:owner.publicKey}},{destinationPatch:{mint:owner.publicKey}},{destinationPatch:{state:2}},{destinationPatch:{isNativeOption:1,isNative:1n}},{balance:10000}])await assert.rejects(()=>prepareSiloTransfer(terms,{connection:fixture(patch)}));
});
test('Token-2022 without a transfer fee uses TransferChecked under the Token-2022 program',async()=>{
 const connection=fixture({...t22,mintExtensions:[{type:ExtensionType.MetadataPointer,data:Buffer.alloc(64)}]}),review=await prepareSiloTransfer(terms,{connection});
 assert.deepEqual(review.terms,t22Terms(null));assert.deepEqual(connection.rentSizes,[AccountLayout.span+1+4]);
 const tx=VersionedTransaction.deserialize(Buffer.from(review.transactionBase64,'base64'));assert.deepEqual(inspectSiloTransfer(tx,{network:'devnet'}).terms,review.terms);
});
test('Token-2022 transfer tax: the epoch fee is computed, signed into the instruction and round-trips',async()=>{
 const connection=fixture({...t22,mintExtensions:[transferFee(300)]}),review=await prepareSiloTransfer(terms,{connection});
 assert.deepEqual(review.terms,t22Terms('30'));
 // The new account carries ImmutableOwner and TransferFeeAmount.
 assert.deepEqual(connection.rentSizes,[AccountLayout.span+1+4+4+8]);
 const tx=VersionedTransaction.deserialize(Buffer.from(review.transactionBase64,'base64')),ix=tx.message.compiledInstructions[3];
 assert.equal(tx.message.staticAccountKeys[ix.programIdIndex].toBase58(),TOKEN_2022_PROGRAM_ID.toBase58());
 assert.deepEqual([...ix.data.subarray(0,2)],[26,1]);assert.equal(Buffer.from(ix.data).readBigUInt64LE(11),30n);
 assert.deepEqual(inspectSiloTransfer(tx,{network:'devnet'}).terms,review.terms);
 const capped=await prepareSiloTransfer(terms,{connection:fixture({...t22,mintExtensions:[transferFee(300,7n)]})});assert.equal(capped.terms.tokenFee,'7');
});
test('a transfer fee that differs from the token, or a fee on a token without one, refuses',async()=>{
 for(const tokenFee of ['29','31',null])await assert.rejects(()=>verifySiloTransferState(t22Terms(tokenFee),fixture({...t22,mintExtensions:[transferFee(300)]})));
 await assert.rejects(()=>verifySiloTransferState(t22Terms('0'),fixture(t22)),/no transfer fee/);
 // The newer fee takes effect at its epoch: a review prepared before it no longer matches.
 const scheduled=transferFee(300,1000000n,{epoch:600n,maximumFee:1000000n,transferFeeBasisPoints:500});
 assert.equal((await verifySiloTransferState(t22Terms('30'),fixture({...t22,mintExtensions:[scheduled],epoch:599}))).terms.tokenFee,'30');
 await assert.rejects(()=>verifySiloTransferState(t22Terms('30'),fixture({...t22,mintExtensions:[scheduled],epoch:600})),/changed/);
});
test('Token-2022 features Silo cannot represent refuse: transfer hooks, non-transferable, interest-bearing, scaled amounts, unknown',async()=>{
 for(const type of [ExtensionType.TransferHook,ExtensionType.NonTransferable,ExtensionType.InterestBearingConfig,ExtensionType.ScaledUiAmountConfig,ExtensionType.ConfidentialTransferFeeConfig,999])
  await assert.rejects(()=>verifySiloTransferState(t22Terms(null),fixture({...t22,mintExtensions:[{type}]})),/does not support/);
 for(const patch of [{sourceExtensions:[immutable,{type:ExtensionType.NonTransferableAccount}]},{destinationPatch:{},destinationExtensions:[immutable,{type:ExtensionType.TransferHookAccount,data:Buffer.alloc(1)}]}])
  await assert.rejects(()=>verifySiloTransferState(t22Terms(null),fixture({...t22,...patch})),/does not support/);
});
test('a permanent delegate is reported; a recipient that requires memos refuses',async()=>{
 const review=await prepareSiloTransfer(terms,{connection:fixture({...t22,mintExtensions:[{type:ExtensionType.PermanentDelegate,data:Buffer.alloc(32,7)}]})});
 assert.equal(review.issuer.permanentDelegate,true);
 await assert.rejects(()=>verifySiloTransferState(t22Terms(null),fixture({...t22,destinationPatch:{},destinationExtensions:[immutable,{type:ExtensionType.MemoTransfer,data:Buffer.from([1])}]})),/memo/);
 assert.ok(await verifySiloTransferState(t22Terms(null),fixture({...t22,destinationPatch:{},destinationExtensions:[immutable,{type:ExtensionType.MemoTransfer,data:Buffer.from([0])}]})));
});
test('a fee field is only valid on a Token-2022 token and never above the amount',()=>{
 for(const patch of [{program:'spl',tokenFee:'1'},{program:'token-2022',tokenFee:'1001'},{program:'token-2022',tokenFee:'01'},{program:'other'},{mint:null,decimals:9,program:'spl'}])assert.throws(()=>siloTransferTerms({...terms,...patch}));
});
test('refusals name the problem: decimals, balance, frozen and delegated accounts',async()=>{
 const reason=async patch=>{try{await verifySiloTransferState({...terms,program:'spl',tokenFee:null},fixture(patch));}catch(error){return error.message;}};
 assert.match(await reason({mintPatch:{decimals:9}}),/uses 9 decimals, not 6/);
 assert.match(await reason({sourcePatch:{amount:999n}}),/Not enough of this token/);
 assert.match(await reason({sourcePatch:{state:2}}),/frozen/);
 assert.match(await reason({sourcePatch:{delegateOption:1,delegate:recipient.publicKey}}),/delegate/);
});
test('Max token uses verified source raw balance and recomputes full-amount transfer tax',async()=>{
 const {prepareSiloMaxTransfer}=await import('../lib/silo/solana-transfer.mjs');
 const plain=await prepareSiloMaxTransfer(terms,{connection:fixture()});assert.equal(plain.terms.amount,'5000');assert.equal(plain.availableTokenRaw,'5000');assert.equal(plain.availableLamports,'10000000');
 const taxed=await prepareSiloMaxTransfer(terms,{connection:fixture({...t22,mintExtensions:[transferFee(100)]})});assert.equal(taxed.terms.amount,'5000');assert.equal(taxed.terms.tokenFee,'50');
 await assert.rejects(()=>prepareSiloMaxTransfer(terms,{connection:fixture({balance:1000})}),/Insufficient SOL/);
 await assert.rejects(()=>prepareSiloMaxTransfer(terms,{connection:fixture({sourcePatch:{state:2}})}),/frozen/);
});
