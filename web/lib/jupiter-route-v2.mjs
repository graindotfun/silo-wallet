/** Exact decoder for the reviewed Jupiter `route_v2` instruction (discriminator bb64facc31c4af14).
 * Only the two-step SOL⇄wXMR⇄token shapes Grainpad supports are accepted; any other step variant,
 * extra data, index pattern or account slice is an unknown layout and fails closed.
 *
 * Data: [0..8) discriminator, in u64, quoted out u64, slippage u16, platform fee u16, positive fee u16,
 * then Vec<RoutePlanStepV2> (u32 length) of {swap: Swap enum, bps u16, input_index u8, output_index u8}.
 * Accounts: 10 fixed accounts, then one contiguous slice per step, each starting with that step's DEX program. */
import {Buffer} from 'buffer';
import {PublicKey} from '@solana/web3.js';
import * as sdk from '@raydium-io/raydium-sdk-v2';
import {CPMM_CONFIG} from './launch-instructions.mjs';
import {solPaymentAsset} from './sol-payment-assets.mjs';
export const JUPITER_ROUTE_V2_DISCRIMINATOR='bb64facc31c4af14';
const CLMM='CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',LAUNCHPAD=String(sdk.LAUNCHPAD_PROGRAM),CPMM=String(sdk.CREATE_CPMM_POOL_PROGRAM),TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',SYSTEM='11111111111111111111111111111111',JUPITER='JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
/** Swap enum tags observed in official route_v2 packets (LaunchLab, CLMM) and Jupiter's IDL order (RaydiumCP).
 * extra = bytes of variant data; LaunchLab carries share_fee_rate:u64 which must be zero. */
export const ROUTE_V2_VARIANTS=Object.freeze({
 26:{name:'RaydiumClmm',program:CLMM,extra:0,venue:'Raydium CLMM'},
 46:{name:'RaydiumCP',program:CPMM,extra:0,venue:'Raydium CP'},
 81:{name:'RaydiumLaunchlabBuy',program:LAUNCHPAD,extra:8,venue:'Raydium Launchlab',side:'buy'},
 82:{name:'RaydiumLaunchlabSell',program:LAUNCHPAD,extra:8,venue:'Raydium Launchlab',side:'sell'},
});
// Recorded LaunchLab and CLMM slices end with a Jupiter-program placeholder;
// recorded Raydium CP slices end at the observation account (14 accounts).
const FIXED_ACCOUNTS=10,LAUNCHLAB_SLICE=21,CPMM_SLICE=14,CLMM_MIN=12,CLMM_MAX=20;
/** Decodes the route plan; throws on any unknown variant, non-zero variant data or trailing bytes. */
export function decodeRouteV2Steps(data){
 if(!(data instanceof Uint8Array)||data.length<34||Buffer.from(data.subarray(0,8)).toString('hex')!==JUPITER_ROUTE_V2_DISCRIMINATOR)throw Error('Unknown route_v2 header.');
 const view=Buffer.from(data),count=view.readUInt32LE(30);if(count<1||count>4)throw Error('Unknown route_v2 step count.');
 const steps=[];let at=34;
 for(let i=0;i<count;i++){
  if(at>=view.length)throw Error('Truncated route_v2 step.');
  const tag=view[at],variant=ROUTE_V2_VARIANTS[tag];if(!variant)throw Error(`Unknown route_v2 swap variant ${tag}.`);
  at++;if(at+variant.extra+4>view.length)throw Error('Truncated route_v2 step.');
  const extra=view.subarray(at,at+variant.extra);if(extra.some(Boolean))throw Error(`Unsupported ${variant.name} parameters.`);at+=variant.extra;
  steps.push({tag,...variant,bps:view.readUInt16LE(at),input:view[at+2],output:view[at+3]});at+=4;
 }
 if(at!==view.length)throw Error('Trailing route_v2 data.');
 return steps;
}
const pda=(seeds,program)=>String(PublicKey.findProgramAddressSync(seeds,new PublicKey(program))[0]);
/** Verifies that the approved pool step consumes exactly the verified pool, its vaults and the owner's accounts.
 * Returns a list of failed check names (empty when the route matches). */
export function inspectRouteV2(swap,{side,scope,owner,platformId,baseAta,wsolAta,quoteAta,paymentAsset='SOL'}){
 const payment=solPaymentAsset(paymentAsset),failed=[];let steps;
 try{steps=decodeRouteV2Steps(swap.data);}catch(e){return ['route-steps:'+e.message];}
 const nativeVenue=scope.venue,native=side==='buy'?1:0,keys=swap.keys.map(k=>String(k.pubkey)),meta=swap.keys;
 if(steps.length!==2)return ['route-step-count'];
 // Order: buy SOL→wXMR (CLMM) then wXMR→token (pool); sell token→wXMR (pool) then wXMR→SOL (CLMM).
 steps.forEach((s,i)=>{
  if(s.bps!==10000)failed.push(`step-${i}-bps`);
  if(s.input!==i||s.output!==i+1)failed.push(`step-${i}-indices`);
  const expectedVenue=i===native?nativeVenue:'Raydium CLMM';if(s.venue!==expectedVenue)failed.push(`step-${i}-venue`);
  if(s.side&&s.side!==side)failed.push(`step-${i}-direction`);
 });
 if(failed.length)return failed;
 // Contiguous slices: each starts with its step's DEX program; the CLMM slice length varies with tick arrays.
 const nativeLength=nativeVenue==='Raydium CP'?CPMM_SLICE:LAUNCHLAB_SLICE,starts=[FIXED_ACCOUNTS];
 if(native===0)starts.push(FIXED_ACCOUNTS+nativeLength);else{const next=keys.indexOf(steps[1].program,FIXED_ACCOUNTS+1);starts.push(next);}
 const ends=[starts[1],keys.length],slices=starts.map((s,i)=>({start:s,end:ends[i]}));
 if(starts[1]<=FIXED_ACCOUNTS||slices.some((s,i)=>keys[s.start]!==steps[i].program))return ['route-slice-boundary'];
 const nativeSlice=slices[native],clmmSlice=slices[1-native];
 if(nativeSlice.end-nativeSlice.start!==nativeLength)failed.push('native-slice-length');
 const clmmLength=clmmSlice.end-clmmSlice.start;if(clmmLength<CLMM_MIN||clmmLength>CLMM_MAX)failed.push('clmm-slice-length');
 if(nativeVenue==='Raydium Launchlab'&&keys[nativeSlice.end-1]!==JUPITER)failed.push('native-slice-terminator');
 if(failed.length)return failed;
 const at=(slice,offset)=>keys[slice.start+offset],writable=(slice,offset)=>meta[slice.start+offset].isWritable===true;
 const expectSlice=(slice,expected,label)=>{for(const [offset,key,mustWrite] of expected){if(at(slice,offset)!==key)failed.push(`${label}-account-${offset}`);else if(mustWrite&&!writable(slice,offset))failed.push(`${label}-writable-${offset}`);}};
 const p=scope.poolAccounts||{};
 if(nativeVenue==='Raydium Launchlab'){
  if(!p.vaultA||!p.vaultB||!p.creator)return ['scope-pool-accounts'];
  const L=new PublicKey(LAUNCHPAD),wxmr=scope.quoteMint;
  expectSlice(nativeSlice,[[0,LAUNCHPAD],[1,owner,true],[2,String(sdk.getPdaLaunchpadAuth(L).publicKey)],[3,scope.configId],[4,platformId],[5,scope.pool,true],[6,baseAta,true],[7,quoteAta,true],[8,p.vaultA,true],[9,p.vaultB,true],[10,scope.mint],[11,wxmr],[12,scope.tokenProgram],[13,TOKEN],[14,pda([Buffer.from('__event_authority')],LAUNCHPAD)],[15,LAUNCHPAD],[16,owner],[17,SYSTEM],[18,String(sdk.getPdaPlatformVault(L,new PublicKey(platformId),new PublicKey(wxmr)).publicKey),true],[19,String(sdk.getPdaCreatorVault(L,new PublicKey(p.creator),new PublicKey(wxmr)).publicKey),true]],'launchlab');
 }else if(nativeVenue==='Raydium CP'){
  if(!p.vaultA||!p.vaultB||!p.observation||!p.mintA)return ['scope-pool-accounts'];
  const baseIsA=p.mintA===scope.mint,baseVault=baseIsA?p.vaultA:p.vaultB,quoteVault=baseIsA?p.vaultB:p.vaultA,buy=side==='buy';
  expectSlice(nativeSlice,[[0,CPMM],[1,owner],[2,String(sdk.CREATE_CPMM_POOL_AUTH)],[3,CPMM_CONFIG],[4,scope.pool,true],[5,buy?quoteAta:baseAta,true],[6,buy?baseAta:quoteAta,true],[7,buy?quoteVault:baseVault,true],[8,buy?baseVault:quoteVault,true],[9,buy?TOKEN:scope.tokenProgram],[10,buy?scope.tokenProgram:TOKEN],[11,buy?scope.quoteMint:scope.mint],[12,buy?scope.mint:scope.quoteMint],[13,p.observation,true]],'cpmm');
 }else return ['native-venue'];
 // CLMM leg moves only SOL⇄wXMR between the owner's WSOL and wXMR accounts.
 expectSlice(clmmSlice,[[0,CLMM],[1,owner],[3,payment.pool,true],[4,side==='buy'?wsolAta:quoteAta,true],[5,side==='buy'?quoteAta:wsolAta,true],[9,TOKEN]],'clmm');
 for(let i=clmmSlice.start;i<clmmSlice.end;i++)if([scope.pool,scope.launchPool,scope.mint,baseAta,LAUNCHPAD,CPMM].includes(keys[i]))failed.push(`clmm-foreign-account-${i-clmmSlice.start}`);
 // The approved pool is consumed only at its slot, and nowhere else in the instruction.
 const poolAt=keys.flatMap((k,i)=>k===scope.pool?[i]:[]),slot=nativeSlice.start+(nativeVenue==='Raydium CP'?4:5);
 if(poolAt.length!==1||poolAt[0]!==slot)failed.push('pool-slot');
 if(keys.slice(0,FIXED_ACCOUNTS).some((k,i)=>i!==7&&i!==9&&[scope.pool,scope.launchPool].includes(k))||keys[9]!==JUPITER)failed.push('fixed-accounts');
 return failed;
}
