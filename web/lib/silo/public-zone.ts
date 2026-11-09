import {sessionRpcFetch} from '@/lib/browser-rpc-session.mjs';
import {SILO_SOLANA_GENESIS} from './solana-transfer.mjs';
import {siloJson} from './bounded-json.mjs';
import {walletChoices} from '@/lib/chain/wallet-session';
import {TOKEN_PROGRAMS} from '@/lib/exposure-report.mjs';
import type {WalletProvider} from '@/lib/wallet';
type Network='mainnet-beta'|'devnet';
function checkedNetwork(network:Network){if(network!=='mainnet-beta'&&network!=='devnet')throw Error('Unsupported Solana network.');return network;}
export async function siloWalletChoices(network:Network='mainnet-beta'){const choices=await walletChoices(`solana:${checkedNetwork(network)}`);if(choices.stack!=='solana')throw Error('Solana wallet required.');return choices.providers;}
/** `assertCurrent` runs at every dispatch boundary (sessionRpcFetch: before, after a session wait, before a retry) and after every request and throws to stop the sequence (an automatic read withdrawn, the
 * page hidden, the wallet changed); `signal` aborts the request in flight. Already-sent requests cannot be recalled. */
export async function readSiloPublicZone(provider:WalletProvider,network:Network='mainnet-beta',{signal,assertCurrent=()=>{}}:{signal?:AbortSignal;assertCurrent?:()=>void}={}){
 checkedNetwork(network);await provider.wallet.connect();const address=provider.wallet.publicKey?.toBase58();if(!address)throw Error('No connected Solana address.');
 const read=async(method:string,params:unknown[])=>{assertCurrent();signal?.throwIfAborted();const response=await sessionRpcFetch(`/api/silo/solana/transfer?network=${network}`,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)},false,assertCurrent);const data=await siloJson(response) as {error?:unknown;result?:unknown};assertCurrent();if(!response.ok||data.error)throw Error('Public balances were not checked.');return data.result;};
 if(await read('getGenesisHash',[])!==SILO_SOLANA_GENESIS[network])throw Error('Solana network verification failed.');
 const balance=await read('getBalance',[address,{commitment:'finalized'}]) as {value?:number};
 const holdings:{mint:string;amount:string;decimals:number}[]=[];
 for(const programId of TOKEN_PROGRAMS){const data=await read('getTokenAccountsByOwner',[address,{programId},{encoding:'jsonParsed',commitment:'finalized'}]) as {value?:{account?:{data?:{parsed?:{info?:{mint?:string;owner?:string;tokenAmount?:{amount?:string;decimals?:number}}}}}}[]};
  for(const row of(data.value??[]).slice(0,64)){const info=row.account?.data?.parsed?.info,amount=info?.tokenAmount;if(info?.owner===address&&typeof info.mint==='string'&&amount&&typeof amount.amount==='string'&&Number.isInteger(amount.decimals)&&amount.decimals!>=0&&amount.decimals!<=18&&/^[0-9]{1,20}$/.test(amount.amount))holdings.push({mint:info.mint,amount:amount.amount,decimals:amount.decimals!});}
 }
 if(provider.wallet.publicKey?.toBase58()!==address)throw Error('Wallet account changed; balances were discarded.');
 return {address,network,lamports:Number.isSafeInteger(balance.value)&&balance.value!>=0?String(balance.value):null,holdings,coverage:`${network} public balances only; token accounts capped at 64 per program`};
}
