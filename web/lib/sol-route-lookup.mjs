/** Grainpad-controlled address lookup table for the direct SOL route.
 * The third-party table is refused. No table is created or funded here.
 * An owner signature is required before official-token creation. */
import {PublicKey,SystemProgram,SYSVAR_RENT_PUBKEY,TransactionInstruction,TransactionMessage,VersionedTransaction,AddressLookupTableProgram,AddressLookupTableAccount} from '@solana/web3.js';
import {ASSOCIATED_TOKEN_PROGRAM_ID,NATIVE_MINT,TOKEN_2022_PROGRAM_ID,TOKEN_PROGRAM_ID} from '@solana/spl-token';
import * as sdk from '@raydium-io/raydium-sdk-v2';
import {QUOTES} from './quote-assets.mjs';
import {CPMM_CONFIG} from './launch-instructions.mjs';
import {SOL_WXMR_CLMM_POOL} from './sol-route-scope.mjs';
const CLMM_PROGRAM_ID='CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
import {grainpadPlatformId} from './platform-policy.mjs';
import {PLATFORM_SETTINGS} from './platform-settings.mjs';
import {REFUSED_THIRD_PARTY_SOL_LOOKUP,GRAINPAD_SOL_LOOKUP_TABLE} from './sol-route-lookup-policy.mjs';
export {REFUSED_THIRD_PARTY_SOL_LOOKUP,GRAINPAD_SOL_LOOKUP_TABLE};
const JUPITER='JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const LIGHTHOUSE='L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const EVENT='D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf';
const ACTIVE=18446744073709551615n;
const unavailable=message=>Object.assign(Error(message),{code:'lookup-unavailable'});
function unique(values){return [...new Set(values.map(value=>new PublicKey(value).toBase58()))];}
/** Addresses that exist before the official mint. Tick arrays and the token pool stay out: ticks move, and the pool does not exist yet. */
export function preCreationLookupAddresses(clmm){
 if(!clmm?.configId||!clmm?.vaultA||!clmm?.vaultB||!clmm?.observationId)throw Error('SOL/wXMR pool accounts are required before a lookup table can be reviewed.');
 const platform=grainpadPlatformId(),wxmr=new PublicKey(QUOTES.wXMR.mint),program=sdk.LAUNCHPAD_PROGRAM;
 const bitmap=sdk.getPdaExBitmapAccount(new PublicKey(CLMM_PROGRAM_ID),new PublicKey(SOL_WXMR_CLMM_POOL)).publicKey;
 return unique([
  CLMM_PROGRAM_ID,SOL_WXMR_CLMM_POOL,clmm.configId,clmm.vaultA,clmm.vaultB,clmm.observationId,bitmap,
  TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,SystemProgram.programId,SYSVAR_RENT_PUBKEY,NATIVE_MINT,wxmr,
  JUPITER,EVENT,LIGHTHOUSE,program,sdk.getPdaLaunchpadAuth(program).publicKey,platform,sdk.getPdaPlatformVault(program,platform,wxmr).publicKey,
  sdk.CREATE_CPMM_POOL_PROGRAM,sdk.CREATE_CPMM_POOL_AUTH,new PublicKey(CPMM_CONFIG),
 ]);
}
export function assertGrainpadLookupTable({tableAddress,table,authority=PLATFORM_SETTINGS.admin,required=[]}){
 if(!tableAddress)throw unavailable('Grainpad SOL route lookup table is not approved. An owner signature is required before official-token creation. Nothing was created.');
 if(tableAddress===REFUSED_THIRD_PARTY_SOL_LOOKUP)throw unavailable('Refusing the third-party SOL lookup table. Its authority can change or deactivate it outside Grainpad.');
 const state=table?.state;if(!state?.addresses)throw unavailable('Grainpad SOL route lookup table is missing on chain.');
 if(BigInt(state.deactivationSlot)!==ACTIVE)throw unavailable('Grainpad SOL route lookup table is deactivated.');
 if(!state.authority||state.authority.toBase58()!==authority)throw unavailable('Grainpad SOL route lookup table authority is not the Grainpad admin.');
 const have=new Set(state.addresses.map(value=>value.toBase58()));
 const missing=required.filter(value=>!have.has(new PublicKey(value).toBase58()));
 if(missing.length)throw unavailable('Grainpad SOL route lookup table is missing required addresses.');
 return {tableAddress,authority:state.authority.toBase58(),active:true,addresses:state.addresses.length};
}
/** Exact unsigned create and extend instructions for one recent slot. The table address changes if the slot changes, so this review is rebuilt at signing. Nothing is submitted. */
export function unsignedSolLookupReview({recentSlot,addresses,authority=new PublicKey(PLATFORM_SETTINGS.admin)}){
 if(!Number.isSafeInteger(recentSlot)||recentSlot<1)throw Error('Lookup table review needs the recent slot. The table address is derived from that slot.');
 if(!Array.isArray(addresses)||addresses.length<1||addresses.length>256)throw Error('Lookup table review needs the pre-creation address list.');
 const payer=authority;
 const [create,table]=AddressLookupTableProgram.createLookupTable({authority,payer,recentSlot});
 const extends_=[];
 for(let at=0;at<addresses.length;at+=20)extends_.push(AddressLookupTableProgram.extendLookupTable({payer,authority,lookupTable:table,addresses:addresses.slice(at,at+20).map(value=>new PublicKey(value))}));
 const instructions=[create,...extends_];
 return {tableAddress:table.toBase58(),authority:payer.toBase58(),payer:payer.toBase58(),recentSlot,addresses:[...addresses],instructionCount:instructions.length,instructions,submitted:false,liveSend:false,rebuildIfSlotChanges:true,signatureRequiredBeforeOfficialCreation:true};
}
export function compileLookupReview(review,{blockhash}){
 const payer=new PublicKey(review.payer);
 const tx=new VersionedTransaction(new TransactionMessage({payerKey:payer,recentBlockhash:blockhash,instructions:review.instructions}).compileToV0Message());
 return {bytes:tx.serialize().length,signatures:tx.message.header.numRequiredSignatures,transaction:tx};
}
export function lookupAccount(tableAddress,addresses,{authority=PLATFORM_SETTINGS.admin,deactivationSlot=ACTIVE}={}){
 return new AddressLookupTableAccount({key:new PublicKey(tableAddress),state:{deactivationSlot,lastExtendedSlot:1,lastExtendedSlotStartIndex:0,authority:new PublicKey(authority),addresses:addresses.map(value=>new PublicKey(value))}});
}
export function packetBytes(instructions,{payer,blockhash,tables=[]}){
 const tx=new VersionedTransaction(new TransactionMessage({payerKey:new PublicKey(payer),recentBlockhash:blockhash,instructions}).compileToV0Message(tables));
 return tx.serialize().length;
}
export {TransactionInstruction};
