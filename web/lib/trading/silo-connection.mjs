import {validateTradingIntent,readTradingFragment,checkedTradingAmount,SOL_MINT} from './intent.mjs';
export const SILO_INCOMING_TRADE_STORAGE='silo.trading.incoming.v1';
/** Session-only intake survives wallet connection/remount. No financial authority. */
export function receiveTradingSuggestion(hash,storage,now=Date.now()){
 if(hash.startsWith('#trade=')){const suggestion=readTradingFragment(hash,now);if(!suggestion){storage.removeItem(SILO_INCOMING_TRADE_STORAGE);throw Error('Trading suggestion expired or invalid.');}const text=JSON.stringify(suggestion);storage.setItem(SILO_INCOMING_TRADE_STORAGE,text);if(storage.getItem(SILO_INCOMING_TRADE_STORAGE)!==text)throw Error('Suggestion storage unavailable.');return suggestion;}
 const text=storage.getItem(SILO_INCOMING_TRADE_STORAGE);if(text===null)return null;
 try{if(text.length>2048)throw Error();return validateTradingIntent(JSON.parse(text),now);}catch{storage.removeItem(SILO_INCOMING_TRADE_STORAGE);throw Error('The saved suggestion expired or became invalid. Prepare it again.');}
}
export function tradingSuggestionTerms(suggestion,decimals,owner,now=Date.now()){
 const intent=validateTradingIntent(suggestion,now);
 if(intent.slippageBps>300)throw Error('This Silo route supports at most 3% slippage. Prepare a new suggestion.');
 return {network:'solana:mainnet-beta',owner,inputMint:intent.side==='buy'?SOL_MINT:intent.mint,outputMint:intent.side==='buy'?intent.mint:SOL_MINT,amount:checkedTradingAmount(intent,decimals),slippageBps:intent.slippageBps};
}
/** Exact correlation after the wallet creates its own review; never a signer capability. */
export function tradingReviewMatches(intent,review,decimals){
 if(!intent||!review?.capture||!review?.contract)return false;
 try{const amount=checkedTradingAmount(intent,decimals),c=review.capture,t=c.terms,d=review.contract;
 return t.inputMint===(intent.side==='buy'?SOL_MINT:intent.mint)&&t.outputMint===(intent.side==='buy'?intent.mint:SOL_MINT)&&t.amount===amount&&d.inputRaw===amount&&d.inputMint===t.inputMint&&d.outputMint===t.outputMint&&d.owner===t.taker&&d.slippageBps===intent.slippageBps&&c.slippageBps===intent.slippageBps&&c.requestedSlippageBps===intent.slippageBps;
 }catch{return false;}
}
