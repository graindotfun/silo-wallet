// Solana token code reads a global Buffer when it builds token instructions; browsers have none. Set it before those modules load.
import '../browser-buffer.mjs';
import {PublicKey,SystemProgram,ComputeBudgetProgram,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createTransferCheckedInstruction,createTransferCheckedWithFeeInstruction,unpackAccount,unpackMint,ACCOUNT_SIZE,ExtensionType,getExtensionTypes,getTransferFeeConfig,calculateEpochFee,getMemoTransfer,getAccountLen,getAccountTypeOfMintType} from '@solana/spl-token';
import {Buffer} from 'buffer';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
export {SILO_SOLANA_GENESIS} from './solana-genesis.mjs';
import {SILO_SOLANA_GENESIS} from './solana-genesis.mjs';
const eq=(a,b)=>Buffer.from(a).equals(Buffer.from(b));
const key=value=>{const k=new PublicKey(value);if(k.toBase58()!==value)throw refusal('Invalid Solana address.');return k;};
/** Token-2022 mint extensions a plain transfer may carry (owner-approved scope, 2026-10-11). Anything else is refused, so an
 * unknown or later extension fails closed. Refused on purpose: TransferHook (runs another program on every transfer),
 * NonTransferable, and InterestBearingConfig / ScaledUiAmountConfig (the wallet's displayed amount would differ from the raw
 * amount that moves). */
export const SILO_TOKEN_2022_MINT_EXTENSIONS=Object.freeze([ExtensionType.TransferFeeConfig,ExtensionType.MintCloseAuthority,ExtensionType.ConfidentialTransferMint,ExtensionType.DefaultAccountState,ExtensionType.PermanentDelegate,ExtensionType.MetadataPointer,ExtensionType.TokenMetadata,ExtensionType.GroupPointer,ExtensionType.TokenGroup,ExtensionType.GroupMemberPointer,ExtensionType.TokenGroupMember,ExtensionType.PausableConfig,ExtensionType.PermissionedBurn]);
const ACCOUNT_EXTENSIONS=Object.freeze([ExtensionType.ImmutableOwner,ExtensionType.TransferFeeAmount,ExtensionType.MemoTransfer,ExtensionType.CpiGuard,ExtensionType.ConfidentialTransferAccount,ExtensionType.PausableAccount]);
const programOf=name=>name==='token-2022'?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID;
/** Refusals written by this module carry a fixed, user-readable reason the page may show; any other error (a provider,
 * the SDK, the network) is shown only as a generic failure. */
const refusal=message=>Object.assign(Error(message),{siloRefusal:true});
export const siloRefusalMessage=error=>error instanceof Error&&/** @type {any} */(error).siloRefusal===true?error.message:null;
export function siloTransferTerms(input){
 if(!input||Object.keys(input).some(k=>!['network','owner','recipient','mint','amount','decimals','program','tokenFee'].includes(k)))throw refusal('Unexpected transfer fields.');
 if(!Object.hasOwn(SILO_SOLANA_GENESIS,input.network))throw refusal('Unsupported transfer network.');
 const owner=key(input.owner),recipient=key(input.recipient);
 if(owner.equals(recipient)||!PublicKey.isOnCurve(recipient.toBytes()))throw refusal('Choose a different recipient: it cannot be your own address and must be an ordinary wallet address.');
 if(typeof input.amount!=='string'||! /^[1-9]\d{0,19}$/.test(input.amount)||BigInt(input.amount)>18446744073709551615n)throw refusal('Invalid transfer amount.');
 const mint=input.mint==null?null:key(input.mint);
 if(!Number.isInteger(input.decimals)||input.decimals<0||input.decimals>18||(!mint&&input.decimals!==9))throw refusal('Invalid decimals.');
 // A token transfer names its program and, for a Token-2022 mint with a transfer fee, the exact fee the signed instruction asserts.
 const program=mint?(input.program??'spl'):null,tokenFee=mint?(input.tokenFee??null):null;
 if(mint&&!['spl','token-2022'].includes(program))throw refusal('Unsupported token program.');
 if(!mint&&(input.program!=null||input.tokenFee!=null))throw refusal('Unexpected token fields.');
 if(tokenFee!==null&&(program!=='token-2022'||typeof tokenFee!=='string'||!/^(0|[1-9]\d{0,19})$/.test(tokenFee)||BigInt(tokenFee)>BigInt(input.amount)))throw refusal('Invalid token transfer fee.');
 return Object.freeze({network:input.network,owner:owner.toBase58(),recipient:recipient.toBase58(),mint:mint?.toBase58()??null,amount:input.amount,decimals:input.decimals,...(mint?{program,tokenFee}:{})});
}
export function buildSiloTransfer(input,blockhash){
 const t=siloTransferTerms(input),owner=key(t.owner),recipient=key(t.recipient);key(blockhash);
 const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:200000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:0})];
 if(!t.mint)instructions.push(SystemProgram.transfer({fromPubkey:owner,toPubkey:recipient,lamports:BigInt(t.amount)}));
 else{const mint=key(t.mint),programId=programOf(t.program),source=getAssociatedTokenAddressSync(mint,owner,false,programId),destination=getAssociatedTokenAddressSync(mint,recipient,false,programId);instructions.push(createAssociatedTokenAccountIdempotentInstruction(owner,destination,recipient,mint,programId),t.tokenFee===null?createTransferCheckedInstruction(source,mint,destination,owner,BigInt(t.amount),t.decimals,[],programId):createTransferCheckedWithFeeInstruction(source,mint,destination,owner,BigInt(t.amount),t.decimals,BigInt(t.tokenFee),[],programId));}
 return new VersionedTransaction(new TransactionMessage({payerKey:owner,recentBlockhash:blockhash,instructions}).compileToV0Message());
}
/** @param {any} transaction @param {{network?: string, signed?: boolean}} options */
export function inspectSiloTransfer(transaction,{network,signed=false}={}){
 const m=transaction?.message;
 if(m?.version!==0||m.addressTableLookups.length||m.header.numRequiredSignatures!==1||transaction.serialize().length>1232)throw refusal('Unsupported transfer message.');
 const owner=m.staticAccountKeys[0].toBase58(),ix=TransactionMessage.decompile(m).instructions;let terms;
 if(ix.length===3&&ix[2].programId.equals(SystemProgram.programId)&&ix[2].data.length===12&&ix[2].data.readUInt32LE(0)===2&&ix[2].keys.length===2)terms={network,owner,recipient:ix[2].keys[1].pubkey.toBase58(),mint:null,amount:ix[2].data.readBigUInt64LE(4).toString(),decimals:9};
 else if(ix.length===4&&ix[2].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)&&ix[2].keys.length===6&&ix[3].keys.length===4&&(ix[3].programId.equals(TOKEN_PROGRAM_ID)||ix[3].programId.equals(TOKEN_2022_PROGRAM_ID))){
  const program=ix[3].programId.equals(TOKEN_2022_PROGRAM_ID)?'token-2022':'spl',data=ix[3].data,base={network,owner,recipient:ix[2].keys[2].pubkey.toBase58(),mint:ix[3].keys[1].pubkey.toBase58(),program};
  // TransferChecked (12), or for Token-2022 TransferFeeExtension (26) / TransferCheckedWithFee (1): amount, decimals, fee.
  if(data.length===10&&data[0]===12)terms={...base,amount:data.readBigUInt64LE(1).toString(),decimals:data[9],tokenFee:null};
  else if(program==='token-2022'&&data.length===19&&data[0]===26&&data[1]===1)terms={...base,amount:data.readBigUInt64LE(2).toString(),decimals:data[10],tokenFee:data.readBigUInt64LE(11).toString()};
  else throw refusal('Only native SOL or token TransferChecked transfers are supported.');
 }
 else throw refusal('Only native SOL or token transfers are supported.');
 terms=siloTransferTerms(terms);
 if(!eq(buildSiloTransfer(terms,m.recentBlockhash).message.serialize(),m.serialize()))throw refusal('Transfer differs from the approved layout.');
 if(transaction.signatures.length!==1||transaction.signatures[0].length!==64)throw refusal('Invalid signature layout.');
 const signature=transaction.signatures[0];
 if(signed?!nacl.sign.detached.verify(m.serialize(),signature,key(owner).toBytes()):signature.some(Boolean))throw refusal('Unexpected or invalid signature.');
 return {terms,blockhash:m.recentBlockhash,signature:signed?bs58.encode(signature):null};
}
/** For a token transfer, reads which token program owns the mint and, for a Token-2022 mint with a transfer fee, the fee this
 * epoch charges on the amount. The caller supplies only the mint, amount and decimals. */
export async function siloTransferProgramTerms(input,connection){
 const base=siloTransferTerms(input);if(!base.mint)return base;
 const info=await connection.getAccountInfo(key(base.mint),'confirmed');if(!info)throw refusal('Token mint not found.');
 const program=info.owner.equals(TOKEN_2022_PROGRAM_ID)?'token-2022':info.owner.equals(TOKEN_PROGRAM_ID)?'spl':null;if(!program)throw refusal('Not a token mint.');
 let tokenFee=null;
 if(program==='token-2022'){const feeConfig=getTransferFeeConfig(unpackMint(key(base.mint),info,TOKEN_2022_PROGRAM_ID));if(feeConfig){const {epoch}=await connection.getEpochInfo('confirmed');tokenFee=calculateEpochFee(feeConfig,BigInt(epoch),BigInt(base.amount)).toString();}}
 return siloTransferTerms({...base,program,tokenFee});
}
const lamports=value=>{if(!Number.isSafeInteger(value)||value<0)throw refusal('Invalid balance or fee.');return BigInt(value);};
export async function verifySiloTransferState(input,connection){
 const terms=siloTransferTerms(input);
 if(await connection.getGenesisHash()!==SILO_SOLANA_GENESIS[terms.network])throw refusal('Solana network verification failed.');
 const owner=key(terms.owner),recipient=key(terms.recipient),sender=await connection.getAccountInfo(owner,'confirmed');
 if(!sender||sender.executable||!sender.owner.equals(SystemProgram.programId)||sender.data.length)throw refusal('A funded ordinary sender is required.');
 const available=lamports(sender.lamports),receiver=await connection.getAccountInfo(recipient,'confirmed');
 if(receiver&&(receiver.executable||!receiver.owner.equals(SystemProgram.programId)||receiver.data.length))throw refusal('Recipient is not an ordinary wallet.');
 if(!terms.mint){if(available<BigInt(terms.amount))throw refusal('Insufficient SOL.');return {terms,availableLamports:available.toString(),rentLamports:'0'};}
 const mint=key(terms.mint),programId=programOf(terms.program),source=getAssociatedTokenAddressSync(mint,owner,false,programId),destination=getAssociatedTokenAddressSync(mint,recipient,false,programId),[mi,si,di]=await connection.getMultipleAccountsInfo([mint,source,destination],'confirmed');
 if(!mi||!si||mi.executable||si.executable)throw refusal('Token account unavailable.');
 if(!mi.owner.equals(programId)||!si.owner.equals(programId)||(di&&!di.owner.equals(programId)))throw refusal('Token program differs from this review.');
 const m=unpackMint(mint,mi,programId),s=unpackAccount(source,si,programId);
 if(!m.isInitialized)throw refusal('This token mint is not initialized.');
 if(m.decimals!==terms.decimals)throw refusal(`This token uses ${m.decimals} decimals, not ${terms.decimals}. Correct the decimals and review again.`);
 let expectedFee=null,permanentDelegate=false;
 if(terms.program==='token-2022'){
  const extensions=getExtensionTypes(m.tlvData);
  if(extensions.some(type=>!SILO_TOKEN_2022_MINT_EXTENSIONS.includes(type)))throw refusal('This Token-2022 token uses a feature Silo does not support (for example a transfer hook or interest-bearing amounts).');
  permanentDelegate=extensions.includes(ExtensionType.PermanentDelegate);
  const feeConfig=getTransferFeeConfig(m);
  if(feeConfig){const {epoch}=await connection.getEpochInfo('confirmed');expectedFee=calculateEpochFee(feeConfig,BigInt(epoch),BigInt(terms.amount)).toString();}
  for(const account of [s,...(di?[unpackAccount(destination,di,programId)]:[])])if(getExtensionTypes(account.tlvData).some(type=>!ACCOUNT_EXTENSIONS.includes(type)))throw refusal('A token account uses a feature Silo does not support.');
 }
 // The signed instruction asserts the token's transfer fee for this epoch; a mismatch, or a fee field on a mint without one, is refused.
 if(terms.tokenFee!==expectedFee)throw refusal(expectedFee===null?'This token has no transfer fee.':'The token transfer fee changed. Prepare a new review.');
 if(!s.isInitialized||!s.owner.equals(owner)||!s.mint.equals(mint)||s.isNative)throw refusal('Source token account cannot safely transfer.');
 if(s.isFrozen)throw refusal('Your token account for this token is frozen by its issuer.');
 if(s.delegate||s.closeAuthority)throw refusal('Your token account for this token has a delegate or close authority set, which Silo refuses.');
 if(s.amount<BigInt(terms.amount))throw refusal('Not enough of this token in your wallet for this amount.');
 if(di){if(di.executable)throw refusal('Invalid destination.');const d=unpackAccount(destination,di,programId);if(!d.isInitialized||d.isFrozen||!d.owner.equals(recipient)||!d.mint.equals(mint)||d.isNative)throw refusal('Destination token account differs.');if(terms.program==='token-2022'&&getMemoTransfer(d)?.requireIncomingTransferMemos)throw refusal('The recipient requires a memo with incoming transfers, which Silo does not add.');}
 // A Token-2022 associated account always carries ImmutableOwner plus the account extensions its mint requires.
 const accountLen=()=>getAccountLen([...new Set([ExtensionType.ImmutableOwner,...getExtensionTypes(m.tlvData).map(getAccountTypeOfMintType)])].filter(type=>type!==ExtensionType.Uninitialized));
 const rent=di?0:await connection.getMinimumBalanceForRentExemption(terms.program==='token-2022'?accountLen():ACCOUNT_SIZE,'confirmed');
 return {terms,availableLamports:available.toString(),availableTokenRaw:s.amount.toString(),rentLamports:lamports(rent).toString(),issuer:{freezeAuthority:Boolean(m.freezeAuthority),permanentDelegate}};
}
/** @param {any} input @param {any} options */
export async function prepareSiloTransfer(input,{connection,now=()=>Date.now()}={}){
 const state=await verifySiloTransferState(await siloTransferProgramTerms(input,connection),connection),latest=await connection.getLatestBlockhash('confirmed');
 if(!Number.isSafeInteger(latest.lastValidBlockHeight)||latest.lastValidBlockHeight<1)throw refusal('Missing expiry.');
 const transaction=buildSiloTransfer(state.terms,latest.blockhash),fee=lamports((await connection.getFeeForMessage(transaction.message,'confirmed')).value);
 if(fee>10000000n)throw refusal('Network fee exceeds limit.');
 if(fee+BigInt(state.rentLamports)+(state.terms.mint?0n:BigInt(state.terms.amount))>BigInt(state.availableLamports))throw refusal('Insufficient SOL for amount, fee and rent.');
 if((await connection.simulateTransaction(transaction,{sigVerify:false,commitment:'confirmed'})).value.err)throw refusal('Transfer simulation failed.');
 const checkedAt=now();return Object.freeze({terms:state.terms,issuer:state.issuer?Object.freeze({...state.issuer}):null,availableLamports:state.availableLamports,availableTokenRaw:state.availableTokenRaw??null,transactionBase64:Buffer.from(transaction.serialize()).toString('base64'),networkFeeRaw:fee.toString(),rentRaw:state.rentLamports,lastValidBlockHeight:latest.lastValidBlockHeight,checkedAt,expiresAt:checkedAt+30000});
}
/** @param {any} review @param {any} options */
export async function signSiloTransfer(review,{wallet,connection,now=()=>Date.now(),assertCurrent=()=>{},beforeWalletPrompt=()=>{},assertPrompt=()=>{},captureSigned=()=>{}}={}){
 assertCurrent();if(!review||!Number.isSafeInteger(review.checkedAt)||review.checkedAt<0||!Number.isSafeInteger(review.expiresAt)||review.expiresAt<=review.checkedAt)throw refusal('Transfer review expired.');
 let lastTime=review.checkedAt;const currentTime=()=>{const value=now();if(!Number.isSafeInteger(value)||value<lastTime)throw refusal('Transfer review expired.');lastTime=value;return value;};
 if(currentTime()>=review.expiresAt)throw refusal('Transfer review expired.');
 const original=VersionedTransaction.deserialize(Buffer.from(review.transactionBase64,'base64')),checked=inspectSiloTransfer(original,{network:review.terms.network});
 if(JSON.stringify(review.terms)!==JSON.stringify(checked.terms)||wallet.publicKey?.toBase58()!==checked.terms.owner)throw refusal('Wallet or transfer terms changed.');
 const currentState=await verifySiloTransferState(checked.terms,connection);
 const currentFee=lamports((await connection.getFeeForMessage(original.message,'confirmed')).value);
 if(currentFee.toString()!==review.networkFeeRaw||currentState.rentLamports!==review.rentRaw)throw refusal('Transfer costs changed. Prepare a new review.');
 if(currentFee+BigInt(currentState.rentLamports)+(checked.terms.mint?0n:BigInt(checked.terms.amount))>BigInt(currentState.availableLamports))throw refusal('Available SOL changed. Prepare a new review.');
 if(await connection.getBlockHeight('confirmed')>review.lastValidBlockHeight||currentTime()>=review.expiresAt)throw refusal('Transfer review expired.');
 assertCurrent();if(wallet.publicKey?.toBase58()!==checked.terms.owner)throw refusal('Wallet account changed before signing.');
 const message=Uint8Array.from(original.message.serialize());const prompt=beforeWalletPrompt();if(prompt&&typeof prompt.then==='function')await prompt;assertCurrent();if(currentTime()>=review.expiresAt)throw refusal('Transfer review expired.');if(wallet.publicKey?.toBase58()!==checked.terms.owner)throw refusal('Wallet account changed before signing.');const permit=assertPrompt();if(permit===false||permit?.then)throw refusal('Immediate synchronous transfer prompt permission required.');assertCurrent();if(wallet.publicKey?.toBase58()!==checked.terms.owner||currentTime()>=review.expiresAt)throw refusal('Transfer signing context changed or expired.');const signed=await wallet.signTransaction(original);
 // Validate bytes against the pre-prompt message, before context/expiry/RPC checks can
 // throw. A valid returned signature is a recoverable payment even if submission is held.
 if(!signed?.message||!eq(message,signed.message.serialize()))throw refusal('Wallet changed the transfer. Silo did not submit the changed bytes.');
 const result=inspectSiloTransfer(signed,{network:checked.terms.network,signed:true});
 const recovered={wire:Uint8Array.from(signed.serialize()),signature:result.signature,lastValidBlockHeight:review.lastValidBlockHeight,terms:checked.terms};
 await captureSigned(recovered);
 assertCurrent();if(wallet.publicKey?.toBase58()!==checked.terms.owner)throw refusal('Wallet account changed after signing. Submission is held.');
 if(currentTime()>=review.expiresAt)throw refusal('Transfer review expired while the wallet was open. Signed payment retained. Submission held; check saved outcome.');
 const afterHeight=await connection.getBlockHeight('confirmed');assertCurrent();
 if(!Number.isSafeInteger(afterHeight)||afterHeight>review.lastValidBlockHeight||currentTime()>=review.expiresAt)throw refusal('Transfer expired after signing. Submission is held; check the saved outcome.');
 return recovered;
}

/** Max is prepared from verified node accounts, never displayed portfolio balances. A second fresh preparation
 * validates the final amount and exact costs; no wallet signature or broadcast occurs here.
 * @param {any} input @param {any} options */
export async function prepareSiloMaxTransfer(input,{connection,now=()=>Date.now()}={}){
 const terms=await siloTransferProgramTerms({...input,amount:'1'},connection),state=await verifySiloTransferState(terms,connection);
 let amount;
 if(terms.mint)amount=state.availableTokenRaw;
 else{
  const latest=await connection.getLatestBlockhash('confirmed'),tx=buildSiloTransfer(terms,latest.blockhash);
  const fee=lamports((await connection.getFeeForMessage(tx.message,'confirmed')).value);
  amount=(BigInt(state.availableLamports)-fee-BigInt(state.rentLamports)).toString();
 }
 if(!amount||BigInt(amount)<=0n)throw refusal('No spendable balance remains after costs.');
 return prepareSiloTransfer({...input,amount},{connection,now});
}
