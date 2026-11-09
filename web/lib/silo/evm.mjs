import {keccak_256} from '@noble/hashes/sha3';
/** Grain Silo EVM public zone: chain table, address and balance reads. The server reads a native balance and ERC-20 balanceOf on a frozen,
 * in-repo token list. Nothing in this file builds or signs a transaction; the plain native transfer lives in evm-transfer.mjs
 * (shape, signing helpers) and evm-send.mjs (prepare and relay), and the browser wallet extension is never asked to sign.
 *
 * Token addresses are the issuers' canonical deployments, written in EIP-55 checksum form; tests recompute every checksum,
 * so a mistyped character fails the suite. A token is left out when its address was not certain. Decimals are pinned so the
 * relay never needs a second contract call. */
const token=(symbol,name,address,decimals)=>Object.freeze({symbol,name,address,decimals});
export const SILO_EVM_CHAINS=Object.freeze({
 1:Object.freeze({chainId:1,key:'ethereum',name:'Ethereum',symbol:'ETH',decimals:18,env:'SILO_EVM_RPC_ETHEREUM',host:'eth-mainnet.g.alchemy.com',fallback:Object.freeze({env:'SILO_EVM_RPC_ETHEREUM_FALLBACK',host:'mainnet.infura.io'}),enabled:true,tokens:Object.freeze([
  token('USDC','USD Coin','0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',6),
  token('USDT','Tether USD','0xdAC17F958D2ee523a2206206994597C13D831ec7',6),
  token('DAI','Dai Stablecoin','0x6B175474E89094C44Da98b954EedeAC495271d0F',18),
  token('WETH','Wrapped Ether','0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',18),
 ])}),
 8453:Object.freeze({chainId:8453,key:'base',name:'Base',symbol:'ETH',decimals:18,env:'SILO_EVM_RPC_BASE',host:'base-mainnet.g.alchemy.com',fallback:Object.freeze({env:'SILO_EVM_RPC_BASE_FALLBACK',host:'base-mainnet.infura.io'}),enabled:true,tokens:Object.freeze([
  token('USDC','USD Coin','0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',6),
  token('WETH','Wrapped Ether','0x4200000000000000000000000000000000000006',18),
 ])}),
 56:Object.freeze({chainId:56,key:'bnb',name:'BNB Smart Chain',symbol:'BNB',decimals:18,env:'SILO_EVM_RPC_BNB',host:'bnb-mainnet.g.alchemy.com',fallback:Object.freeze({env:'SILO_EVM_RPC_BNB_FALLBACK',host:'bsc-mainnet.infura.io'}),enabled:true,tokens:Object.freeze([
  token('USDT','Tether USD (Binance-Peg)','0x55d398326f99059fF775485246999027B3197955',18),
  token('USDC','USD Coin (Binance-Peg)','0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',18),
  token('WBNB','Wrapped BNB','0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',18),
 ])}),
 // Robinhood Chain mainnet (Arbitrum-based L2, ETH gas). Chain id, native ETH and the provider host come from
 // https://docs.robinhood.com/chain/connecting/ and eth_chainId on the public endpoint returned 0x1237 (4663). The documented Alchemy
 // host is pinned like the other chains. No token list is pinned (none verified): native balance only.
 4663:Object.freeze({chainId:4663,key:'robinhood',name:'Robinhood Chain',symbol:'ETH',decimals:18,env:'SILO_EVM_RPC_ROBINHOOD',host:'robinhood-mainnet.g.alchemy.com',enabled:true,tokens:Object.freeze([])}),
});
export const SILO_EVM_BALANCE_OF='0x70a08231';
export const SILO_EVM_REASON=/^evm:(http-\d{3}|timeout|network|parse|too-large|rpc-error|not-configured|misconfigured|mismatch)$/;
const MAX_BYTES=64*1024;

export function siloEvmChain(chainId){
 if(!Number.isSafeInteger(chainId)||!Object.hasOwn(SILO_EVM_CHAINS,chainId))return null;
 const chain=SILO_EVM_CHAINS[chainId];return chain.enabled?chain:null;
}

/** EIP-55 checksum form of a 20-byte address. Lower- or upper-case input is accepted; mixed case must already be a valid checksum. */
export function siloEvmAddress(value){
 if(typeof value!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(value))throw Error('Invalid EVM address.');
 const lower=value.slice(2).toLowerCase(),hash=keccak_256(new TextEncoder().encode(lower));
 let out='0x';
 for(let i=0;i<40;i++){const nibble=(hash[i>>1]>>(i%2?0:4))&15;out+=nibble>=8?lower[i].toUpperCase():lower[i];}
 const body=value.slice(2);
 if(body!==body.toLowerCase()&&body!==body.toUpperCase()&&value!==out)throw Error('EVM address checksum mismatch.');
 return out;
}

/** The dedicated endpoint for a chain, or null when it is not configured. Only `https://<pinned Alchemy host>/v2/<key>` is
 * accepted, so a misconfiguration can never send addresses to an unreviewed host. There is no public fallback. */
export function siloEvmRpcEndpoint(chainId,env={}){
 const chain=siloEvmChain(chainId);if(!chain)throw Error('Unsupported EVM chain.');
 return pinned(env[chain.env],chain.host,/^\/v2\/[A-Za-z0-9_-]{16,128}$/);
}
function pinned(raw,host,path){
 if(!raw)return null;
 let url;try{url=new URL(raw);}catch{throw Error('Invalid Silo EVM RPC configuration.');}
 if(url.protocol!=='https:'||url.hostname!==host||url.port||url.username||url.password||url.search||url.hash||!path.test(url.pathname))throw Error('Invalid Silo EVM RPC endpoint.');
 return url.href;
}
/** The optional second provider (reads fail over to it; a broadcast the first provider left uncertain is repeated on it, which is
 * idempotent). Pinned to one reviewed host per chain and `/v3/<key>` (Infura style); null when the chain has none or it is unset. */
export function siloEvmFallbackEndpoint(chainId,env={}){
 const chain=siloEvmChain(chainId);if(!chain)throw Error('Unsupported EVM chain.');
 if(!chain.fallback)return null;
 return pinned(env[chain.fallback.env],chain.fallback.host,/^\/v3\/[A-Za-z0-9_-]{16,128}$/);
}
/** Primary first, then the second provider when configured. A malformed second provider is ignored for reads only if the primary is
 * fine; both are validated by the callers' status view. */
export function siloEvmEndpoints(chainId,env={}){
 const primary=siloEvmRpcEndpoint(chainId,env);if(!primary)return [];
 let second=null;try{second=siloEvmFallbackEndpoint(chainId,env);}catch{second=null;}
 return second?[primary,second]:[primary];
}

/** What the page may show: every listed chain with whether reads are available. Never includes the endpoint itself. */
export function siloEvmChainStatus(env={}){
 return Object.values(SILO_EVM_CHAINS).map(chain=>{
  let configured=false;if(chain.enabled){try{configured=siloEvmRpcEndpoint(chain.chainId,env)!==null;}catch{configured=false;}}
  // `send`: this server will relay a native transfer on this chain (operator flag on, and the chain is one Silo may sign for).
  const send=configured&&env.SILO_EVM_TRANSFERS_ENABLED==='true'&&[1,8453,56,4663].includes(chain.chainId);
  let redundant=false;if(configured){try{redundant=siloEvmFallbackEndpoint(chain.chainId,env)!==null;}catch{redundant=false;}}
  return {chainId:chain.chainId,name:chain.name,symbol:chain.symbol,enabled:chain.enabled,configured,send,redundant};
 });
}

export class EvmFailure extends Error{constructor(reason){super('EVM balances are unavailable.');this.reasons=[`evm:${reason}`];}}

const quantity=value=>{if(typeof value!=='string'||!/^0x[0-9a-fA-F]{1,64}$/.test(value))throw new EvmFailure('parse');return BigInt(value).toString();};
// balanceOf returns one 32-byte word. Anything else (an EOA returns 0x, a broken token reverts) is reported as unread.
const word=value=>{if(typeof value!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(value))return null;return BigInt(value).toString();};

export async function boundedJson(response,signal){
 const reader=response.body?.getReader();if(!reader)throw new EvmFailure('parse');
 const chunks=[];let bytes=0;
 try{for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>MAX_BYTES)throw new EvmFailure('too-large');chunks.push(chunk.value);}}
 catch(error){await reader.cancel().catch(()=>{});throw error instanceof EvmFailure?error:new EvmFailure(signal.aborted?'timeout':'network');}finally{reader.releaseLock();}
 const joined=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.length;}
 try{return JSON.parse(new TextDecoder().decode(joined));}catch{throw new EvmFailure('parse');}
}

const CHAIN_ID_CALL='eth_chainId';
/** Posts one JSON-RPC batch to ONE endpoint and returns the rows by id. Redirects are refused, the answer is size bounded. */
async function postBatch(endpoint,batch,fetchImpl){
 const signal=AbortSignal.timeout(8000);let response;
 // Workers reject redirect:'error'; take redirects manually and refuse them as a non-2xx status.
 try{response=await fetchImpl(endpoint,{method:'POST',signal,redirect:'manual',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify(batch)});}
 catch(error){throw new EvmFailure(error?.name==='TimeoutError'||signal.aborted?'timeout':'network');}
 if(response.status<200||response.status>299){await response.body?.cancel().catch(()=>{});throw new EvmFailure(`http-${response.status}`);}
 const body=await boundedJson(response,signal);
 if(!Array.isArray(body)||body.length!==batch.length)throw new EvmFailure('mismatch');
 const byId=new Map();for(const row of body){if(!row||typeof row!=='object'||!Number.isSafeInteger(row.id)||row.id<0||row.id>=batch.length||byId.has(row.id))throw new EvmFailure('mismatch');byId.set(row.id,row);}
 return byId;
}
/** Runs `calls` ([[method, params], ...]) with an eth_chainId check added to the SAME batch (no extra request): an endpoint that
 * answers for another chain is refused as `mismatch`. Tries each configured provider in order; throws the LAST fixed reason. */
async function runBatch({chainId,env,calls,fetchImpl,required=[]}){
 const chain=siloEvmChain(chainId);if(!chain)throw Error('Unsupported EVM chain.');
 let endpoints;try{endpoints=siloEvmEndpoints(chainId,env);}catch{throw new EvmFailure('misconfigured');}
 if(!endpoints.length)throw new EvmFailure('not-configured');
 const batch=[...calls.map(([method,params],id)=>({jsonrpc:'2.0',id,method,params})),{jsonrpc:'2.0',id:calls.length,method:CHAIN_ID_CALL,params:[]}];
 let last=new EvmFailure('network');
 for(const endpoint of endpoints){
  try{
   const byId=await postBatch(endpoint,batch,fetchImpl);
   const id=byId.get(calls.length);
   if(!id||id.error!==undefined||typeof id.result!=='string'||!/^0x[0-9a-fA-F]{1,16}$/.test(id.result)||BigInt(id.result)!==BigInt(chain.chainId))throw new EvmFailure('mismatch');
   // A method-level error in a REQUIRED call is a provider failure too: the next provider is tried before the read is given up.
   for(const index of required){const row=byId.get(index);if(!row||row.error!==undefined)throw new EvmFailure('rpc-error');}
   return {byId,count:calls.length};
  }catch(error){last=error instanceof EvmFailure?error:new EvmFailure('network');}
 }
 throw last;
}

/** One JSON-RPC batch: eth_getBalance for the address and eth_call balanceOf(address) on each pinned token. The address is
 * used for this read only; it is not logged or stored. */
export async function loadSiloEvmBalances({chainId,address,env={},fetchImpl=fetch}){
 const chain=siloEvmChain(chainId);if(!chain)throw Error('Unsupported EVM chain.');
 const owner=siloEvmAddress(address);
 const data=SILO_EVM_BALANCE_OF+owner.slice(2).toLowerCase().padStart(64,'0');
 const calls=[['eth_getBalance',[owner,'latest']],...chain.tokens.map(pinnedToken=>['eth_call',[{to:pinnedToken.address,data},'latest']])];
 const {byId}=await runBatch({chainId,env,calls,fetchImpl,required:[0]});
 const native=byId.get(0);if(native.error!==undefined)throw new EvmFailure('rpc-error');
 return {chainId:chain.chainId,address:owner,native:{symbol:chain.symbol,decimals:chain.decimals,amount:quantity(native.result)},
  tokens:chain.tokens.map((pinnedToken,index)=>{const row=byId.get(index+1);return {symbol:pinnedToken.symbol,name:pinnedToken.name,contract:pinnedToken.address,decimals:pinnedToken.decimals,amount:row.error===undefined?word(row.result):null};})};
}

/** One JSON-RPC batch to the chain's pinned endpoint(s): `calls` is [[method, params], ...]; returns the results in order, or
 * throws a fixed `evm:` reason. Used by transfer preparation and relay; the endpoint and key never leave the server. */
export async function siloEvmRpc({chainId,env={},calls,fetchImpl=fetch}){
 if(!Array.isArray(calls)||calls.length<1||calls.length>8)throw new EvmFailure('mismatch');
 const {byId}=await runBatch({chainId,env,calls,fetchImpl,required:calls.map((_,id)=>id)});
 return calls.map((_,id)=>{const row=byId.get(id);if(!row||row.error!==undefined)throw new EvmFailure('rpc-error');return row.result;});
}
