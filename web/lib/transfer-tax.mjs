import {calculateFee,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID} from '@solana/spl-token';

/** Select by the chain's epoch, never by an SDK's assumed slots-per-epoch. */
export function activeTransferFee(config,epoch){
 if(!config||!Number.isSafeInteger(epoch)||epoch<0)throw Error('Current transfer-tax configuration and epoch are required.');
 const fee=BigInt(epoch)>=config.newerTransferFee.epoch?config.newerTransferFee:config.olderTransferFee;
 if(!Number.isInteger(fee.transferFeeBasisPoints)||fee.transferFeeBasisPoints<0||fee.transferFeeBasisPoints>=10000||fee.maximumFee<0n)throw Error('Unsupported transfer tax.');
 return fee;
}
export function transferTax(fee,gross){return fee?calculateFee(fee,gross):0n;}
/** Smallest gross transfer delivering this exact net amount; SPL fees round up. */
export function grossForNet(fee,net){
 if(!fee)return net;
 const denominator=BigInt(10000-fee.transferFeeBasisPoints);
 const uncapped=(net*10000n+denominator-1n)/denominator;
 const gross=net+(uncapped-net>fee.maximumFee?fee.maximumFee:uncapped-net);
 if(gross-transferTax(fee,gross)!==net)throw Error('Net transfer amount cannot be represented.');
 return gross;
}
export function baseTokenProgram(pool){
 if(pool.mintProgramFlag===1)return TOKEN_2022_PROGRAM_ID;
 if(pool.mintProgramFlag===0)return TOKEN_PROGRAM_ID;
 throw Error('Unsupported base token program.');
}
