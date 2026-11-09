import {siloEvmRecipient} from './evm-transfer.mjs';
/** Pure helpers behind the EVM send screen (components/silo-evm-send.tsx). Display and input shaping only: every safety rule
 * is enforced again by evm-transfer.mjs in the wallet and on the server. */
/** @typedef {{fields:{chainId:number;from:string;to:string;valueWei:string;nonce:number;maxFeePerGas:string;maxPriorityFeePerGas:string};symbol:string;chainName:string;maxFeeWei:string;l2FeeWei?:string;l1FeeWei?:string;maxFeeGwei?:number;balanceWei:string;priceUsd:number;valueUsd:number;maxFeeUsd:number;totalUsd:number;capUsd:number}} SiloEvmPrepared */
export function siloRecipientOrThrow(value){return siloEvmRecipient(value);}
/** A decimal text ("0.01") to wei (18 decimals); refuses empty, zero, negative, exponent and more than 18 decimals. */
export function siloEvmAmountToWei(text){
 if(typeof text!=='string'||!/^(0|[1-9]\d{0,17})(\.\d{1,18})?$/.test(text))throw Error('Enter an amount like 0.01.');
 const [whole,fraction='']=text.split('.'),wei=BigInt(whole)*10n**18n+BigInt(fraction.padEnd(18,'0'));
 if(wei===0n)throw Error('Enter an amount above zero.');
 return wei.toString();
}
/** Wei to a short decimal for display (up to 6 significant decimals, trailing zeros trimmed, never rounded up to look smaller). */
export function siloEvmWeiLabel(wei){
 const digits=BigInt(wei).toString().padStart(19,'0'),whole=digits.slice(0,-18),fraction=digits.slice(-18).slice(0,8).replace(/0+$/,'');
 return fraction?`${whole}.${fraction}`:whole;
}
const EXPLORERS=Object.freeze({1:'https://etherscan.io/tx/',8453:'https://basescan.org/tx/',56:'https://bscscan.com/tx/',4663:'https://robinhoodchain.blockscout.com/tx/'});
export function siloEvmExplorer(chainId,hash){return Object.hasOwn(EXPLORERS,chainId)&&/^0x[0-9a-f]{64}$/.test(hash)?EXPLORERS[chainId]+hash:null;}
