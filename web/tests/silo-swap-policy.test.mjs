import bs58 from 'bs58';
import test from 'node:test';import assert from 'node:assert/strict';
import {siloSwapInput,siloSwapQuoteRequest,reviewSiloSwapQuote,siloSwapRevenueScenario} from '../lib/silo/swap-policy.mjs';
const sol='So11111111111111111111111111111111111111112',usdc='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',referral='11111111111111111111111111111111',account=bs58.encode(new Uint8Array(32).fill(2));
const terms={network:'solana:mainnet-beta',inputMint:sol,outputMint:usdc,amount:'1000000000'};
const quote={inputMint:sol,outputMint:usdc,inAmount:terms.amount,swapMode:'ExactIn',outAmount:'1000000',otherAmountThreshold:'990000',feeBps:100,feeMint:sol};
const proof={referralAccount:referral,verifiedFeeAccount:{referralAccount:referral,address:account,mint:sol,registered:true}};
test('Silo quotes request exactly 100 bps without a wallet address or signing payload',()=>{
 const request=siloSwapQuoteRequest(terms,{referralAccount:referral});const url=new URL(request.url);
 assert.equal(url.pathname,'/swap/v2/order');assert.equal(url.searchParams.get('referralFee'),'100');assert.equal(url.searchParams.has('taker'),false);assert.equal(url.searchParams.get('referralAccount'),referral);
 assert.throws(()=>siloSwapQuoteRequest(terms),/referral account/);
});
test('Silo rejects native privacy assets, wrong networks and invalid uint64 amounts',()=>{
 for(const change of [{network:'testnet'},{inputMint:'XMR'},{inputMint:'22222222222222222222222222222222'},{outputMint:sol},{amount:'-1'},{amount:'0'},{amount:'1.5'},{amount:'18446744073709551616'}])assert.throws(()=>siloSwapInput({...terms,...change}));
});
test('quotes cannot silently omit collection, change the rate, mint, amount or minimum',()=>{
 const review=reviewSiloSwapQuote(quote,terms,proof);assert.equal(review.feeLabel,'1%');assert.equal(review.retainedRateBps,80);assert.equal(review.executionEnabled,false);
 for(const change of [{feeBps:0},{feeBps:99},{feeBps:'100'},{feeMint:account},{inAmount:'1'},{swapMode:'ExactOut'},{otherAmountThreshold:'1000001'},{errorCode:1}])assert.throws(()=>reviewSiloSwapQuote({...quote,...change},terms,proof));
 for(const changed of [undefined,{...proof,verifiedFeeAccount:{...proof.verifiedFeeAccount,registered:false}},{...proof,verifiedFeeAccount:{...proof.verifiedFeeAccount,mint:usdc}},{...proof,verifiedFeeAccount:{...proof.verifiedFeeAccount,referralAccount:account}}])assert.throws(()=>reviewSiloSwapQuote(quote,terms,changed),/verified/);
});
test('revenue planning distinguishes user fee from retained revenue',()=>{
 assert.deepEqual(siloSwapRevenueScenario('10000000'),{grossFeeRaw:'100000',estimatedProviderShareRaw:'20000',estimatedSiloRetainedRaw:'80000'});
});
