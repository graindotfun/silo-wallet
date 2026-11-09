import {PublicKey} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync,unpackAccount} from '@solana/spl-token';
import {sha256} from '@noble/hashes/sha256';
import {Buffer} from 'buffer';
// Layout and V2 ATA derivation checked against published @jup-ag/referral-sdk 0.3.0.
export const SILO_REFERRAL_PROGRAM='REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3';
export const SILO_REFERRAL_PROJECT='DkiqsTrw1u1bYFumumC7sCG2S8K25qc2vemJFHyW2wJc';
export const SILO_SOL_MINT='So11111111111111111111111111111111111111112';
export const SILO_USDC_MINT='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MAINNET_GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const discriminator=Buffer.from(sha256(new TextEncoder().encode('account:ReferralAccount')).slice(0,8));
function account(wire){
 if(!wire||wire.executable!==false||!Array.isArray(wire.data)||wire.data[1]!=='base64'||typeof wire.data[0]!=='string'||wire.data[0].length>4096)throw Error('Referral account data unavailable.');
 const data=Buffer.from(wire.data[0],'base64');if(data.toString('base64')!==wire.data[0])throw Error('Invalid account encoding.');
 return {data,owner:new PublicKey(wire.owner),executable:false,lamports:wire.lamports};
}
export async function verifySiloFeeAccount({referralAccount,beneficiary,feeMint,read}){
 if(![SILO_SOL_MINT,SILO_USDC_MINT].includes(feeMint))throw Error('This fee mint is not enabled.');
 const referral=new PublicKey(referralAccount),partner=new PublicKey(beneficiary),mint=new PublicKey(feeMint);
 if(await read('getGenesisHash',[])!==MAINNET_GENESIS)throw Error('Solana mainnet was not verified.');
 const address=getAssociatedTokenAddressSync(mint,referral,true,TOKEN_PROGRAM_ID);
 const result=await read('getMultipleAccounts',[[referral.toBase58(),address.toBase58()],{encoding:'base64',commitment:'finalized'}]);
 if(!Number.isSafeInteger(result?.context?.slot)||!Array.isArray(result.value)||result.value.length!==2)throw Error('Fee account verification unavailable.');
 const info=account(result.value[0]),bytes=info.data;
 if(!info.owner.equals(new PublicKey(SILO_REFERRAL_PROGRAM))||bytes.length<75||!bytes.subarray(0,8).equals(discriminator)||!new PublicKey(bytes.subarray(8,40)).equals(partner)||!new PublicKey(bytes.subarray(40,72)).equals(new PublicKey(SILO_REFERRAL_PROJECT))||bytes.readUInt16LE(72)!==8000)throw Error('Referral program, beneficiary, project or revenue split differs.');
 // Optional name follows the fixed fields; refuse malformed layouts rather than guessing a later schema.
 const named=bytes[74];if(named!==0&&named!==1)throw Error('Unsupported referral layout.');
 let end=75;
 if(named===1){if(bytes.length<79)throw Error('Truncated referral name.');const length=bytes.readUInt32LE(75);if(length>128||79+length>bytes.length)throw Error('Invalid referral name.');end=79+length;}
 if(bytes.subarray(end).some(x=>x!==0))throw Error('Unsupported referral trailing fields.');
 const token=unpackAccount(address,account(result.value[1]),TOKEN_PROGRAM_ID);
 if(!token.isInitialized||token.isFrozen||!token.owner.equals(referral)||!token.mint.equals(mint)||token.delegate||token.closeAuthority)throw Error('Fee token account is not an unencumbered initialized referral V2 account.');
 return {referralAccount:referral.toBase58(),address:address.toBase58(),mint:mint.toBase58(),registered:true,beneficiary:partner.toBase58(),slot:result.context.slot,partnerShareBps:8000};
}
