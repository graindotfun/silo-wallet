import bs58 from 'bs58';
import {siloProviderSwapFeeBps} from './revenue-policy.mjs';
/** Jupiter /order referral accepts partner fees; owner policy is 100 bps (owner decision 4 Nov 2026, replacing 50), the total referral fee charged to the
 * user with no additional Silo fee beyond it (earlier: 50bps 29 Oct 2026, replacing an unapproved 70bps
 * proposal -- see revenue-policy.mjs's own comment for the full history).
 * Separate Silo swap scope. This module cannot sign, broadcast or collect a fee. */
export const SILO_SWAP_FEE_BPS=siloProviderSwapFeeBps('jupiter');
export const SILO_SWAP_FEE_LABEL='1%';
// Jupiter's documented Referral Program split (verify against the live /order response's own feeBps/feeMint
// before trusting this for revenue accounting -- reviewSiloSwapQuote below already does, per quote).
export const SILO_SWAP_PROVIDER_SHARE_BPS=2000;
const UINT64_MAX=18446744073709551615n;
const mint=value=>{try{if(typeof value!=='string'||value.length<32||value.length>44)return false;const bytes=bs58.decode(value);return bytes.length===32&&bs58.encode(bytes)===value;}catch{return false;}};
function amount(value){if(typeof value!=='string'||! /^[1-9]\d{0,19}$/.test(value)||BigInt(value)>UINT64_MAX)throw Error('Invalid swap amount.');return value;}
export function siloSwapInput(input){
 if(input?.network!=='solana:mainnet-beta'||!mint(input.inputMint)||!mint(input.outputMint)||input.inputMint===input.outputMint)throw Error('Only a supported Solana mint pair can be quoted; native XMR/ZEC need a separate conversion provider.');
 return Object.freeze({network:input.network,inputMint:input.inputMint,outputMint:input.outputMint,amount:amount(input.amount)});
}
/** Quote-only request: no taker, wallet address, signatures or transaction execution. */
export function siloSwapQuoteRequest(input,{referralAccount}={}){
 const terms=siloSwapInput(input);
 if(!mint(referralAccount))throw Error('A configured Silo referral account is required.');
 const query=new URLSearchParams({inputMint:terms.inputMint,outputMint:terms.outputMint,amount:terms.amount,referralAccount,referralFee:String(SILO_SWAP_FEE_BPS)});
 return Object.freeze({terms,url:`https://api.jup.ag/swap/v2/order?${query}`});
}
/** Registration proof must come from an on-chain account verifier, never the user's quote form. */
export function reviewSiloSwapQuote(quote,terms,{referralAccount,verifiedFeeAccount}={}){
 terms=siloSwapInput(terms);
 if(quote?.errorCode!=null||quote?.inputMint!==terms.inputMint||quote?.outputMint!==terms.outputMint||quote?.inAmount!==terms.amount||quote?.swapMode!=='ExactIn')throw Error('Swap quote differs from the requested terms.');
 if(quote.feeBps!==SILO_SWAP_FEE_BPS)throw Error('The provider did not apply the exact 1% Silo fee; no zero-fee fallback is allowed.');
 if(![terms.inputMint,terms.outputMint].includes(quote.feeMint))throw Error('Fee mint is outside the quoted pair.');
 if(!mint(referralAccount)||verifiedFeeAccount?.referralAccount!==referralAccount||verifiedFeeAccount?.mint!==quote.feeMint||verifiedFeeAccount?.registered!==true||!mint(verifiedFeeAccount?.address))throw Error('Fee collection account has not been verified for this mint.');
 amount(quote.outAmount);amount(quote.otherAmountThreshold);
 if(BigInt(quote.otherAmountThreshold)>BigInt(quote.outAmount))throw Error('Invalid minimum received.');
 return Object.freeze({...terms,feeBps:SILO_SWAP_FEE_BPS,feeLabel:SILO_SWAP_FEE_LABEL,feeMint:quote.feeMint,feeAccount:verifiedFeeAccount.address,expectedOutputRaw:quote.outAmount,minimumOutputRaw:quote.otherAmountThreshold,executionEnabled:false,provider:'Jupiter Swap V2',providerRevenueShareBps:SILO_SWAP_PROVIDER_SHARE_BPS,retainedRateBps:SILO_SWAP_FEE_BPS*(10000-SILO_SWAP_PROVIDER_SHARE_BPS)/10000,privacy:'Public Solana swap; not a private or cross-chain conversion.'});
}
/** Planning arithmetic only. Settlement receipts determine actual revenue and rounding. */
export function siloSwapRevenueScenario(volumeRaw){
 const volume=BigInt(amount(volumeRaw)),gross=volume*BigInt(SILO_SWAP_FEE_BPS)/10000n;
 const provider=gross*BigInt(SILO_SWAP_PROVIDER_SHARE_BPS)/10000n;
 return {grossFeeRaw:String(gross),estimatedProviderShareRaw:String(provider),estimatedSiloRetainedRaw:String(gross-provider)};
}
