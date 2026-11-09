export const SOL_MINT='So11111111111111111111111111111111111111112';
export const TRADING_CHAINS=Object.freeze([
 {id:'solana',name:'Solana',mode:'market-and-handoff',privacy:'Public ledger'},
 {id:'base',name:'Base',mode:'market-data',privacy:'Public ledger'},
 {id:'ethereum',name:'Ethereum',mode:'market-data',privacy:'Public ledger'},
 {id:'bsc',name:'BNB Chain',mode:'market-data',privacy:'Public ledger'},
 {id:'arbitrum',name:'Arbitrum',mode:'market-data',privacy:'Public ledger'},
 {id:'polygon',name:'Polygon',mode:'market-data',privacy:'Public ledger'},
 {id:'avalanche',name:'Avalanche',mode:'market-data',privacy:'Public ledger'},
 {id:'optimism',name:'Optimism',mode:'market-data',privacy:'Public ledger'},
]);
export function validAddress(chain,value){
 if(typeof value!=='string')return false;
 if(chain!=='solana')return TRADING_CHAINS.some(c=>c.id===chain)&&/^0x[0-9a-fA-F]{40}$/.test(value);
 if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))return false;
 const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n;
 for(const c of value)n=n*58n+BigInt(alphabet.indexOf(c));
 let bytes=0;while(n){bytes++;n>>=8n;}
 return bytes+(value.match(/^1*/)?.[0].length??0)===32;
}
export function tradingKey(chain,address){if(!validAddress(chain,address))throw Error('Invalid token address.');return `${chain}:${chain==='solana'?address:address.toLowerCase()}`;}
/** Suggestions only. No wallet, quote, signature, fee account or executable transaction is transported. */
export function validateTradingIntent(value,now=Date.now()){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid trading suggestion.');
 const fields=['v','id','network','mint','side','amount','amountUnit','slippageBps','createdAt','expiresAt'];
 if(Object.keys(value).some(k=>!fields.includes(k))||fields.some(k=>!(k in value))||value.v!==1||typeof value.id!=='string'||!/^tr_[a-f0-9]{32}$/.test(value.id)||value.network!=='solana:mainnet-beta'||!validAddress('solana',value.mint)||value.mint===SOL_MINT||!['buy','sell'].includes(value.side)||value.amountUnit!==(value.side==='buy'?'SOL':'TOKEN'))throw Error('Unsupported trading suggestion.');
 if(typeof value.amount!=='string'||!/^\d{1,12}(\.\d{1,9})?$/.test(value.amount)||Number(value.amount)<=0||!Number.isInteger(value.slippageBps)||value.slippageBps<10||value.slippageBps>500)throw Error('Invalid amount or slippage.');
 if(!Number.isSafeInteger(value.createdAt)||!Number.isSafeInteger(value.expiresAt)||value.createdAt>now+5000||value.expiresAt<=now||value.expiresAt-value.createdAt>120000||value.expiresAt<=value.createdAt)throw Error('This trading suggestion expired. Prepare it again in Grainpad.');
 return Object.freeze({...value});
}
export function makeTradingIntent({mint,side,amount,slippageBps=100},now=Date.now()){return validateTradingIntent({v:1,id:'tr_'+crypto.randomUUID().replace(/-/g,''),amountUnit:side==='buy'?'SOL':'TOKEN',network:'solana:mainnet-beta',mint,side,amount,slippageBps,createdAt:now,expiresAt:now+120000},now);}
export function siloIntentLink(intent,origin='https://silo.trading'){
 const url=new URL(origin);if(url.origin!==origin||url.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(url.hostname))throw Error('Invalid Silo origin.');
 url.pathname='/app';url.hash=`trade=${encodeURIComponent(JSON.stringify(validateTradingIntent(intent)))}`;return url.toString();
}
export function readTradingFragment(hash,now=Date.now()){
 if(typeof hash!=='string'||hash.length>2048||!hash.startsWith('#trade='))return null;
 try{return validateTradingIntent(JSON.parse(decodeURIComponent(hash.slice(7))),now);}catch{return null;}
}

/** Decimal precision comes from Silo's freshly checked mint, never sender metadata. */
export function checkedTradingAmount(intent,tokenDecimals){
 const decimals=intent.side==='buy'?9:tokenDecimals;
 if(!Number.isInteger(decimals)||decimals<0||decimals>18)throw Error('Unsupported token precision.');
 const [whole,fraction='']=intent.amount.split('.');if(fraction.length>decimals)throw Error('Amount exceeds the checked token decimal precision.');
 const raw=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0')||'0');
 if(raw<1n||raw>18446744073709551615n)throw Error('Amount exceeds the supported atomic-unit range.');return String(raw);
}
/** Replay protection is UI hygiene, not sender authentication or financial authorization. */
export function consumeTradingSuggestion(intent,storage,now=Date.now()){
 const checked=validateTradingIntent(intent,now);let prior;
 try{prior=JSON.parse(storage.getItem('silo.trading.suggestions.v1')??'[]');if(!Array.isArray(prior))prior=[];}catch{throw Error('Suggestion replay storage is unavailable. Re-enter the trade manually in Silo.');}
 const fresh=prior.filter(r=>r&&typeof r.id==='string'&&Number.isSafeInteger(r.expiresAt)&&r.expiresAt>now);
 if(fresh.length>=256)throw Error('Too many active suggestions in this session. Enter the trade manually.');
 if(fresh.some(r=>r.id===checked.id))throw Error('This suggestion was already used. Prepare a new one or enter the trade manually.');
 try{const text=JSON.stringify([...fresh,{id:checked.id,expiresAt:checked.expiresAt}]);storage.setItem('silo.trading.suggestions.v1',text);if(storage.getItem('silo.trading.suggestions.v1')!==text)throw Error();}catch{throw Error('Suggestion replay storage is unavailable. Re-enter the trade manually in Silo.');}
 return checked;
}
