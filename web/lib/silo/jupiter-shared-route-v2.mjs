/** Schema foundation only. Primary-owned Anchor IDL establishes serialization,
 * not deployed program rounding, account safety, settlement or route admission. */
import {Buffer} from 'buffer';
export const SILO_SHARED_JUPITER_V2_SCHEMA=Object.freeze({
 version:1,program:'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
 discriminator:'d19853937cfed8e9',idlAccount:'C88XWfp26heEmDkmfSzeXP7Fd7GQJ2j9dDTUsyiZbUTa',
 primarySlot:455756094,idlSha256:'82a3907455712fa9c2104d1b8fb8a2649cc4d96789d4c16a572ed343981b9f4e',
 accountBytesSha256:'a18d24fb033d8f9274a0cb710d5bf511eca6249526cd00ba80c1954cb1fe1097',
 fixedAccounts:12,maxInstructionBytes:45,maxSteps:2,maximumSlippageBps:300,
});
const variants=Object.freeze({26:'RaydiumClmm',40:'RaydiumClmmV2'});
/** Raw instruction bytes only: caller/provider graph labels never substitute
 * for signed instruction fields. Unknown shapes fail closed. */
export function decodeSiloSharedJupiterRouteV2(data){
 if(!(data instanceof Uint8Array)||data.length!==SILO_SHARED_JUPITER_V2_SCHEMA.maxInstructionBytes)throw Error('Shared Jupiter serial instruction size differs.');
 const d=Buffer.from(data);if(d.subarray(0,8).toString('hex')!==SILO_SHARED_JUPITER_V2_SCHEMA.discriminator)throw Error('Shared Jupiter discriminator differs.');
 const authorityId=d[8],input=d.readBigUInt64LE(9),quotedOutput=d.readBigUInt64LE(17),slippageBps=d.readUInt16LE(25),feeBps=d.readUInt16LE(27),positiveSlippageFeeBps=d.readUInt16LE(29),count=d.readUInt32LE(31);
 if(input===0n||quotedOutput===0n||slippageBps>SILO_SHARED_JUPITER_V2_SCHEMA.maximumSlippageBps||feeBps!==0||positiveSlippageFeeBps!==0||count!==2)throw Error('Shared Jupiter economics or route count is outside the foundation.');
 const steps=[];let at=35;
 for(let i=0;i<count;i++){
  const tag=d[at++];if(!Object.hasOwn(variants,tag))throw Error('Shared Jupiter DEX variant is unsupported.');
  const bps=d.readUInt16LE(at),inputIndex=d[at+2],outputIndex=d[at+3];at+=4;
  if(bps!==10000||inputIndex!==i||outputIndex!==i+1)throw Error('Shared Jupiter route must be two serial unsplit legs.');
  steps.push(Object.freeze({tag,name:variants[tag],bps,inputIndex,outputIndex}));
 }
 if(at!==d.length)throw Error('Unconsumed shared Jupiter instruction.');
 return Object.freeze({instruction:'shared_accounts_route_v2',schema:SILO_SHARED_JUPITER_V2_SCHEMA,authorityId,inputRaw:String(input),quotedOutputRaw:String(quotedOutput),slippageBps,feeBps,positiveSlippageFeeBps,steps:Object.freeze(steps),minimumOutputRaw:null,roundingVerified:false,accountMappingVerified:false,programBehaviorVerified:false,admission:false,executableSupport:false,releaseAccepted:false});
}
