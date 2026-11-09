/** Historical message economics, without new quotes, pools or simulation. */
import {Buffer} from 'buffer';
import {decodeRouteV2Steps} from '../jupiter-route-v2.mjs';
const JUP='JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export function bindSiloHistoricalJupiterTerms(tx,order,terms,{feeBps,loadedAddresses,requireMintIdentity=false}={}){
 const message=tx.message,staticKeys=message.staticAccountKeys.map(String),lookups=message.addressTableLookups;
 let keys=staticKeys;
 if(loadedAddresses){const w=loadedAddresses.writable,r=loadedAddresses.readonly;if(!Array.isArray(w)||!Array.isArray(r)||w.length!==lookups.reduce((s,x)=>s+x.writableIndexes.length,0)||r.length!==lookups.reduce((s,x)=>s+x.readonlyIndexes.length,0))throw Error('Historical lookup mapping differs.');keys=[...keys,...w.map(String),...r.map(String)];}
 // Our accepted routes keep the program static. Never infer a looked-up program.
 if(message.compiledInstructions.some(x=>x.programIdIndex>=staticKeys.length))throw Error('Historical program lookup is unsupported.');
 const swaps=message.compiledInstructions.filter(ix=>staticKeys[ix.programIdIndex]===JUP);if(swaps.length!==1)throw Error('Historical Jupiter instruction differs.');
 const ix=swaps[0],d=Buffer.from(ix.data),steps=decodeRouteV2Steps(d);
 if(steps.length!==1||![26,46].includes(steps[0].tag)||steps[0].bps!==10000||steps[0].input!==0||steps[0].output!==1||d.readUInt16LE(28)!==0||d.readUInt16LE(24)>300)throw Error('Historical route differs.');
 const amount=d.readBigUInt64LE(8),output=d.readBigUInt64LE(16),fee=d.readUInt16LE(26),minimum=output*BigInt(10000-d.readUInt16LE(24))/10000n;
 if(amount<1n||output<1n||minimum<1n||String(amount)!==terms.amount||order.inAmount!==String(amount)||order.outAmount!==String(output)||order.otherAmountThreshold!==String(minimum)||order.feeBps!==fee||feeBps!==fee||String(message.staticAccountKeys[0])!==terms.owner||order.inputMint!==terms.inputMint||order.outputMint!==terms.outputMint)throw Error('Historical swap economics differ.');
 for(const [position,mint] of [[3,terms.inputMint],[4,terms.outputMint]]){const index=ix.accountKeyIndexes[position];if(index===undefined||requireMintIdentity&&keys[index]===undefined||keys[index]!==undefined&&keys[index]!==mint)throw Error('Historical swap mint differs.');}
 return {minimumOutputRaw:String(minimum),inputRaw:String(amount),expectedOutputRaw:String(output),feeBps:fee};
}
