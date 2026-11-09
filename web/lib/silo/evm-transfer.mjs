import {serializeTransaction,parseTransaction,recoverTransactionAddress} from 'viem';
import {siloEvmAddress,siloEvmChain} from './evm.mjs';
/** Grain Silo EVM native transfer: the one transaction shape this wallet can build, sign or relay.
 * A plain EIP-1559 (type 2) transfer of the chain's native asset to an externally owned address: no calldata, no access list,
 * exactly 21,000 gas, an explicit chain id (EIP-155 replay protection), and fee ceilings per chain. Nothing here approves a
 * token, calls a contract, signs a message or typed data. The same validators run in the browser (before signing), on the
 * server (before relaying) and in tests, so no layer has to trust another's claim.
 * Viem is used only to serialize, parse and recover the signer of that one shape; the signature itself is made in
 * native-keyring.mjs inside the unlocked session. */
export const SILO_EVM_TRANSFER_GAS=21000n;
/** Chains this wallet may sign for. Robinhood Chain (4663) is an Arbitrum-based L2 with ETH gas; plain transfers there cost exactly 21,000 gas (checked on recent mainnet receipts, no L1 gas component for a transfer). */
export const SILO_EVM_TRANSFER_CHAINS=Object.freeze([8453,1,56,4663]);
const GWEI=1_000_000_000n;
/** Ceilings, in wei per gas, for maxFeePerGas and maxPriorityFeePerGas. A prepared fee above them is refused, not clamped silently. */
export const SILO_EVM_FEE_CEILING=Object.freeze({8453:{maxFee:50n*GWEI,priority:5n*GWEI},1:{maxFee:300n*GWEI,priority:10n*GWEI},56:{maxFee:20n*GWEI,priority:5n*GWEI},4663:{maxFee:GWEI,priority:GWEI/10n}});
const REFUSED=new Set(['0x0000000000000000000000000000000000000000','0x000000000000000000000000000000000000dEaD']);
const MAX_VALUE=(1n<<96n)-1n;
const fail=(message,reason)=>Object.assign(Error(message),{siloEvm:reason});
const wei=(value,name,allowZero=false)=>{
 if(typeof value!=='string'||!/^(0|[1-9]\d{0,29})$/.test(value))throw fail(`Invalid ${name}.`,'amount');
 const big=BigInt(value);if((!allowZero&&big===0n)||big>MAX_VALUE)throw fail(`Invalid ${name}.`,'amount');return big;
};
/** The destination every transfer refuses regardless of who asks: the zero address, the conventional burn address, and a contract is refused separately (prepare reads its code). */
export function siloEvmRecipient(value){
 let canonical;try{canonical=siloEvmAddress(value);}catch{throw fail('Enter a valid Ethereum-style address (0x followed by 40 characters).','address');}
 if(REFUSED.has(canonical))throw fail('That address cannot receive funds. Enter your own wallet address.','address');
 return canonical;
}
/** Validated, frozen transfer fields. All amounts are decimal strings in wei so they survive JSON exactly. */
export function siloEvmTransferFields(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw fail('Invalid transfer.','shape');
 const keys=['chainId','from','to','valueWei','nonce','maxFeePerGas','maxPriorityFeePerGas'];
 if(Object.keys(input).length!==keys.length||keys.some(key=>!Object.hasOwn(input,key)))throw fail('Invalid transfer.','shape');
 if(!SILO_EVM_TRANSFER_CHAINS.includes(input.chainId)||!siloEvmChain(input.chainId))throw fail('This network is not available for sending.','chain');
 let from;try{from=siloEvmAddress(input.from);}catch{throw fail('Invalid sender address.','address');}
 const to=siloEvmRecipient(input.to);
 if(from===to)throw fail('Choose a different address from your own.','address');
 if(!Number.isSafeInteger(input.nonce)||input.nonce<0||input.nonce>4294967295)throw fail('Invalid transfer.','nonce');
 const valueWei=wei(input.valueWei,'amount'),maxFee=wei(input.maxFeePerGas,'fee'),priority=wei(input.maxPriorityFeePerGas,'fee',true);
 const ceiling=SILO_EVM_FEE_CEILING[input.chainId];
 if(maxFee>ceiling.maxFee||priority>ceiling.priority||priority>maxFee)throw fail('Network fees are too high right now. Try again later.','fee-ceiling');
 return Object.freeze({chainId:input.chainId,from,to,valueWei:valueWei.toString(),nonce:input.nonce,maxFeePerGas:maxFee.toString(),maxPriorityFeePerGas:priority.toString()});
}
/** Most the transfer can cost in fees, in wei (gas limit times maxFeePerGas). */
export const siloEvmMaxFeeWei=fields=>SILO_EVM_TRANSFER_GAS*BigInt(fields.maxFeePerGas);
/** The unsigned type-2 transaction object for these validated fields. */
export function siloEvmUnsignedTransaction(fields){
 const f=siloEvmTransferFields(fields);
 return {type:'eip1559',chainId:f.chainId,nonce:f.nonce,to:f.to,value:BigInt(f.valueWei),data:'0x',gas:SILO_EVM_TRANSFER_GAS,maxFeePerGas:BigInt(f.maxFeePerGas),maxPriorityFeePerGas:BigInt(f.maxPriorityFeePerGas),accessList:[]};
}
export const siloEvmSigningBytes=fields=>serializeTransaction(siloEvmUnsignedTransaction(fields));
export const siloEvmSerializeSigned=(fields,signature)=>serializeTransaction(siloEvmUnsignedTransaction(fields),signature);

/** Parses a signed raw transaction and proves it is exactly the one permitted shape. Returns the validated fields plus the
 * recovered signer as `from`. Used by the relay: it never forwards bytes it has not decoded and checked itself. */
export async function siloEvmVerifySigned(raw,{expectChainId=null}={}){
 if(typeof raw!=='string'||!/^0x02[0-9a-f]{100,600}$/.test(raw))throw fail('Invalid signed transfer.','raw');
 let tx;try{tx=parseTransaction(raw);}catch{throw fail('Invalid signed transfer.','raw');}
 if(tx.type!=='eip1559'||tx.gas!==SILO_EVM_TRANSFER_GAS||(tx.data!==undefined&&tx.data!=='0x')||(tx.accessList?.length??0)!==0||tx.r===undefined||tx.s===undefined)throw fail('Unsupported transaction.','shape');
 if(!Number.isSafeInteger(tx.chainId)||(expectChainId!==null&&tx.chainId!==expectChainId))throw fail('Unsupported network.','chain');
 let from;try{from=await recoverTransactionAddress({serializedTransaction:raw});}catch{throw fail('Invalid signature.','signature');}
 const fields=siloEvmTransferFields({chainId:tx.chainId,from:siloEvmAddress(from),to:tx.to??'',valueWei:String(tx.value??0n),nonce:tx.nonce??-1,maxFeePerGas:String(tx.maxFeePerGas??0n),maxPriorityFeePerGas:String(tx.maxPriorityFeePerGas??0n)});
 return fields;
}

// One-time review tickets: the confirm screen asks the session to sign exactly the fields it displayed, once.
const reviews=new WeakMap();
const canonical=fields=>JSON.stringify(siloEvmTransferFields(fields));
/** Called when the review screen is shown. The returned ticket signs only these exact fields, once. */
export function createSiloEvmTransferTicket(fields){const ticket=Object.freeze({});reviews.set(ticket,canonical(fields));return ticket;}
/** Consumes the ticket (a second use fails) and requires the fields to equal the reviewed ones exactly. */
export function consumeSiloEvmTransferTicket(ticket,fields){
 const expected=ticket&&typeof ticket==='object'?reviews.get(ticket):undefined;
 reviews.delete(ticket);
 if(expected===undefined||expected!==canonical(fields))throw fail('The reviewed transfer changed. Review it again.','ticket');
}
