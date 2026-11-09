/** Shared production/test swap builder. Integer amounts only. No network or signing side effects. */
import './browser-buffer.mjs';
import {Buffer} from 'buffer';
import {PublicKey} from '@solana/web3.js';
import {NATIVE_MINT,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import * as s from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import {QUOTES,quoteByMint} from './quote-assets.mjs';
import {readRewardMarket} from './rewards-market.mjs';
import {baseTokenProgram,activeTransferFee,transferTax,grossForNet} from './transfer-tax.mjs';
const zero=new BN(0);
export function cpmmId(mint,config,quoteMint=NATIVE_MINT){const pair=[mint,quoteMint].sort((a,b)=>Buffer.compare(a.toBuffer(),b.toBuffer()));return s.getCpmmPdaPoolId(s.CREATE_CPMM_POOL_PROGRAM,config,...pair).publicKey;}
export async function readMarket(connection,mint,platformId){
 const candidates=Object.values(QUOTES).map(q=>s.getPdaLaunchpadPoolId(s.LAUNCHPAD_PROGRAM,mint,new PublicKey(q.mint)).publicKey);
 const accounts=await connection.getMultipleAccountsInfo(candidates,'confirmed');
 const matches=accounts.flatMap((acc,i)=>acc?.owner.equals(s.LAUNCHPAD_PROGRAM)?[{poolId:candidates[i],pool:s.LaunchpadPool.decode(acc.data)}]:[]);
 if(matches.length!==1)throw Error('Verified launch pool not found or ambiguous.');
 const {poolId,pool}=matches[0],quote=quoteByMint(pool.mintB);
 if(!pool.mintA.equals(mint)||!pool.platformId.equals(platformId)||![0,1].includes(pool.mintProgramFlag)||pool.configId.toBase58()!==quote.config||pool.mintDecimalsB!==quote.decimals||pool.mintDecimalsA!==6)throw Error('This market does not match the Grainpad launch policy.');
 const [ca,pa,ma]=await connection.getMultipleAccountsInfo([pool.configId,platformId,mint],'confirmed');
 if(!ca?.owner.equals(s.LAUNCHPAD_PROGRAM)||!pa?.owner.equals(s.LAUNCHPAD_PROGRAM)||!ma?.owner.equals(baseTokenProgram(pool)))throw Error('Invalid market configuration.');
 const config=s.LaunchpadConfig.decode(ca.data),platform=s.PlatformConfig.decode(pa.data);
 if(pool.mintProgramFlag===1)return readRewardMarket(connection,{mint,platformId,collector:platform.transferFeeExtensionAuth});
 if(pool.status===1)return {route:'graduating',poolId,pool,config,platform,quote};
 if(pool.status===0)return {route:'curve',poolId,pool,config,platform,quote};
 if(pool.status!==2)throw Error('Unsupported market state.');
 const id=cpmmId(mint,platform.cpConfigId,pool.mintB),cp=await connection.getAccountInfo(id,'confirmed');
 if(!cp?.owner.equals(s.CREATE_CPMM_POOL_PROGRAM))throw Error('Graduated pool is not available yet.');
 const r=await s.Raydium.load({connection,owner:PublicKey.default,disableFeatureCheck:true,disableLoadToken:true});
 const cpData=await r.cpmm.getRpcPoolInfo(id.toBase58(),true);
 if(!cpData.configId.equals(platform.cpConfigId)||![cpData.mintA.toBase58(),cpData.mintB.toBase58()].includes(mint.toBase58())||![cpData.mintA.toBase58(),cpData.mintB.toBase58()].includes(quote.mint)||!cpData.mintProgramA.equals(TOKEN_PROGRAM_ID)||!cpData.mintProgramB.equals(TOKEN_PROGRAM_ID))throw Error('Invalid graduated market.');
 return {route:'cpmm',poolId:id,pool,config,platform,cpData,quote};
}
export function swapInstruction(market,owner,mint,side,amount,slippageBps=100,exactOut=false,options={}){
 if(!['buy','sell'].includes(side))throw Error('Choose Buy or Sell.');
 if(!Number.isInteger(slippageBps)||slippageBps<0||slippageBps>2000)throw Error('Slippage must be between 0 and 20%.');
 const n=new BN(amount.toString());if(n.lten(0))throw Error('Enter a positive amount.');
 if(exactOut&&side!=='buy')throw Error('Exact output is only used for buybacks.');
 const quoteMint=market.pool.mintB,tokenProgram=baseTokenProgram(market.pool);
 const taxed=market.pool.mintProgramFlag===1,fee=taxed?activeTransferFee(market.transferFeeConfig,market.epoch):null;
 let tax=0n;
 const token=getAssociatedTokenAddressSync(mint,owner,false,tokenProgram),sol=options.quoteAccount||getAssociatedTokenAddressSync(quoteMint,owner);
 const min=x=>x.muln(10000-slippageBps).divn(10000),max=x=>x.muln(10000+slippageBps).addn(9999).divn(10000);
 let instruction,input,output,maximum,minimum,fees=null,priceImpactBps=null,spotPrice=null;
 /** @type {Record<string,string>} */ let feeAssets={};
 if(market.route==='curve'){
  const {pool,config,platform,poolId}=market;
  const args={poolInfo:pool,protocolFeeRate:config.tradeFeeRate,platformFeeRate:platform.feeRate,creatorFeeRate:platform.creatorFeeRate,curveType:config.curveType,shareFeeRate:zero};
  // The SDK returns gross A and its exact-output helper double-adds A's fee.
  // Compute transfer tax once, then use its untaxed curve math.
  const grossOut=exactOut?new BN(grossForNet(fee,BigInt(n.toString())).toString()):null;
  if(grossOut?.gt(pool.totalSellA.sub(pool.realA)))throw Error('This amount crosses graduation. Reduce the buy size.');
  if(side==='sell')tax=transferTax(fee,BigInt(n.toString()));
  const netIn=n.sub(new BN(tax.toString()));
  if(netIn.lten(0))throw Error('Amount is entirely consumed by transfer tax.');
  const quote=exactOut?s.Curve.buyExactOut({...args,amountA:grossOut}):side==='buy'?s.Curve.buyExactIn({...args,amountB:n}):s.Curve.sellExactIn({...args,amountA:netIn});
  if(side==='buy')tax=transferTax(fee,BigInt(quote.amountA.amount.toString()));
  fees=Object.fromEntries(Object.entries(quote.splitFee).map(([k,v])=>[k,v.toString()]));
  input=exactOut?quote.amountB:n;output=side==='buy'?quote.amountA.amount.sub(new BN(tax.toString())):quote.amountB;
  if(exactOut)output=n;
  if(!input||!output||output.lten(0))throw Error('Amount is too small for this market.');
  if(side==='buy'&&!exactOut&&quote.amountB&&quote.amountB.lt(n))throw Error('This amount crosses graduation. Reduce the buy size.');
  maximum=exactOut?max(input):input;minimum=exactOut?output:min(output);
  if(minimum.lten(0))throw Error('Minimum output rounds to zero. Increase the amount or reduce slippage.');
  const a=BigInt(pool.virtualA.sub(pool.realA).toString()),b=BigInt(pool.virtualB.add(pool.realB).toString());
  const feeTotal=Object.values(fees).reduce((sum,n)=>sum+BigInt(n),0n);
  const ideal=side==='buy'?(BigInt(input.toString())-feeTotal)*a/b:(BigInt(input.toString())-tax)*b/a;
  const actual=BigInt(output.toString())+(side==='sell'?feeTotal:tax);
  priceImpactBps=ideal>0n?Number((ideal-actual)*10000n/ideal):0;
  spotPrice={numerator:b.toString(),denominator:a.toString()};
  const fn=exactOut?s.buyExactOutInstruction:side==='buy'?s.buyExactInInstruction:s.sellExactInInstruction;
  instruction=fn(s.LAUNCHPAD_PROGRAM,owner,s.getPdaLaunchpadAuth(s.LAUNCHPAD_PROGRAM).publicKey,pool.configId,pool.platformId,poolId,token,sol,pool.vaultA,pool.vaultB,mint,quoteMint,tokenProgram,TOKEN_PROGRAM_ID,s.getPdaPlatformVault(s.LAUNCHPAD_PROGRAM,pool.platformId,quoteMint).publicKey,s.getPdaCreatorVault(s.LAUNCHPAD_PROGRAM,pool.creator,quoteMint).publicKey,exactOut?output:input,exactOut?maximum:minimum,zero);
 }else if(market.route==='cpmm'){
  const p=market.cpData,c=p.configInfo,inputMint=side==='buy'?quoteMint:mint,outputMint=side==='buy'?mint:quoteMint,baseIn=p.mintA.equals(inputMint);
  const feeOnInput=p.feeOn===s.FeeOn.BothToken||(p.feeOn===s.FeeOn.OnlyTokenA&&baseIn)||(p.feeOn===s.FeeOn.OnlyTokenB&&!baseIn);
  const creatorFee=p.enableCreatorFee?c.creatorFeeRate:zero;
  if(!(baseIn?p.mintA:p.mintB).equals(inputMint)||!(baseIn?p.mintB:p.mintA).equals(outputMint)||!(baseIn?p.mintProgramA:p.mintProgramB).equals(side==='buy'?TOKEN_PROGRAM_ID:tokenProgram)||!(baseIn?p.mintProgramB:p.mintProgramA).equals(side==='buy'?tokenProgram:TOKEN_PROGRAM_ID))throw Error('Invalid graduated token programs.');
  if(side==='sell')tax=transferTax(fee,BigInt(n.toString()));
  const curveAmount=new BN((exactOut?grossForNet(fee,BigInt(n.toString())):BigInt(n.toString())-tax).toString());
  if(curveAmount.lten(0))throw Error('Amount is entirely consumed by transfer tax.');
  const q=(exactOut?s.CurveCalculator.swapBaseOutput:s.CurveCalculator.swapBaseInput)(curveAmount,baseIn?p.baseReserve:p.quoteReserve,baseIn?p.quoteReserve:p.baseReserve,c.tradeFeeRate,creatorFee,c.protocolFeeRate,c.fundFeeRate,feeOnInput);
  fees={tradeFee:q.tradeFee.toString(),creatorFee:q.creatorFee.toString()};feeAssets={tradeFee:side==='buy'?'quote':'base',creatorFee:feeOnInput?(side==='buy'?'quote':'base'):(side==='buy'?'base':'quote')};
  if(side==='buy')tax=transferTax(fee,BigInt(q.outputAmount.toString()));
  input=exactOut?q.inputAmount:n;output=exactOut?n:side==='buy'?q.outputAmount.sub(new BN(tax.toString())):q.outputAmount;maximum=exactOut?max(input):input;minimum=exactOut?output:min(output);
  if(output.lten(0)||minimum.lten(0))throw Error('Amount is too small for this market.');
  instruction=(exactOut?s.makeSwapCpmmBaseOutInstruction:s.makeSwapCpmmBaseInInstruction)(s.CREATE_CPMM_POOL_PROGRAM,owner,s.CREATE_CPMM_POOL_AUTH,p.configId,market.poolId,side==='buy'?sol:token,side==='buy'?token:sol,baseIn?p.vaultA:p.vaultB,baseIn?p.vaultB:p.vaultA,side==='buy'?TOKEN_PROGRAM_ID:tokenProgram,side==='buy'?tokenProgram:TOKEN_PROGRAM_ID,inputMint,outputMint,p.observationId,maximum,minimum);
 }
 if(!instruction)throw Error('Graduating to Raydium, trading paused.');
 if(taxed){fees={...fees,transferFee:String(tax)};feeAssets.transferFee='base';}
 return {instruction,input:BigInt(input.toString()),output:BigInt(output.toString()),maximum:BigInt(maximum.toString()),minimum:BigInt(minimum.toString()),route:market.route,fees,feeAssets,transferTaxBps:fee?.transferFeeBasisPoints??0,priceImpactBps,spotPrice};
}
