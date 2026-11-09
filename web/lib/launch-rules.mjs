import {Buffer} from 'buffer';
import {PublicKey} from '@solana/web3.js';
import BN from 'bn.js';
import * as sdk from '@raydium-io/raydium-sdk-v2';
import {QUOTES,quoteAsset} from './quote-assets.mjs';
const b=x=>new BN(String(x));
export const RULE_GROUP=0;
export const RULE_DEFINITIONS=[
 [0,0,'0','Constant-product curve'],
 [1,0,'1','CPMM migration'],[2,0,'0','Creator fee charged in quote asset'],
 [3,0,'1000000000000000','1 billion tokens / 6 decimals'],
 [4,0,'793100000000000','793.1 million curve tokens'],
 [5,0,null,'Exact graduation quote amount'],
 [6,0,'0','No reserved or vesting allocation'],[7,0,'0','Zero cliff'],[8,0,'0','Zero unlock period'],
 [9,0,'0','Legacy SPL token'],[10,0,'0','No transfer fee'],[16,1,'206900','At least 20.69% of supply migrates'],
];
export function launchConstraints(symbol){const q=quoteAsset(symbol);return RULE_DEFINITIONS.map(([field,op,value])=>({field,op,value:b(value??q.floor)}));}
export function ruleAddresses(platformId,symbol){const config=new PublicKey(quoteAsset(symbol).config);return {config,allow:sdk.getPdaPlatformAllowConfig(sdk.LAUNCHPAD_PROGRAM,platformId,config).publicKey,rule:sdk.getPdaPlatformCurveRule(sdk.LAUNCHPAD_PROGRAM,platformId,config).publicKey};}
export function launchRuleInstructions(owner,platformId){return [...Object.keys(QUOTES).flatMap(symbol=>{const a=ruleAddresses(platformId,symbol);return [sdk.createPlatformAllowConfigIns(sdk.LAUNCHPAD_PROGRAM,owner,platformId,a.config,a.allow),sdk.createPlatformCurveRuleIns(sdk.LAUNCHPAD_PROGRAM,owner,platformId,a.config,a.rule),sdk.updatePlatformCurveRuleIns(sdk.LAUNCHPAD_PROGRAM,owner,platformId,a.config,a.rule,RULE_GROUP,launchConstraints(symbol))];}),sdk.updatePlatformConfig(sdk.LAUNCHPAD_PROGRAM,owner,platformId,{type:'updateRestrictGlobalConfig',value:b(1)}),sdk.updatePlatformConfig(sdk.LAUNCHPAD_PROGRAM,owner,platformId,{type:'updateRestrictCurveParam',value:b(1)})];}
export function expectedRuleAccounts(platformId){return Object.keys(QUOTES).flatMap(symbol=>{const a=ruleAddresses(platformId,symbol);return [a.config,a.allow,a.rule];});}
/** Validate both quotes in a single RPC snapshot. Missing or extra groups fail closed. */
export function assertRuleAccounts(platformId,accounts){
 if(accounts.length!==6)throw Error('Both quote configurations, allowlists and rules must be read.');
 return Object.keys(QUOTES).map((symbol,i)=>{
  const q=quoteAsset(symbol),a=ruleAddresses(platformId,symbol),[config,allow,rule]=accounts.slice(i*3,i*3+3);
  for(const account of [config,allow,rule])if(!account?.owner.equals(sdk.LAUNCHPAD_PROGRAM))throw Error(`${symbol} configuration or rule is missing or has an invalid owner.`);
  const cfg=sdk.LaunchpadConfig.decode(config.data),al=decodeAllowConfig(allow.data),r=sdk.PlatformCurveRule.decode(rule.data);
  if(!cfg.mintB.equals(new PublicKey(q.mint))||cfg.tradeFeeRate.toString()!=='2500'||cfg.curveType!==0)throw Error(`${symbol} global configuration changed.`);
  if(!al.platformId.equals(platformId)||!al.configId.equals(a.config)||!r.platformId.equals(platformId)||!r.configId.equals(a.config))throw Error(`${symbol} rule account identity mismatch.`);
  const expected=launchConstraints(symbol),groups=r.groups;
  if(groups.length!==1||groups[0].groupId!==RULE_GROUP||groups[0].constraints.length!==expected.length||expected.some((c,j)=>{const x=groups[0].constraints[j];return x.field!==c.field||x.op!==c.op||!x.value.eq(c.value);}))throw Error(`${symbol} on-chain launch rules differ from the approved policy.`);
  return {symbol,quoteMint:q.mint,decimals:q.decimals,config:a.config.toBase58(),allowlist:a.allow.toBase58(),rule:a.rule.toBase58(),group:RULE_GROUP,constraints:expected.map((c,j)=>({...c,value:c.value.toString(),description:RULE_DEFINITIONS[j][3]}))};
 });
}
export function rpcAccount(value){return value?{...value,owner:new PublicKey(value.owner),data:Buffer.from(value.data[0],'base64')}:null;}

export function decodeAllowConfig(data){if(data.length!==137)throw Error('Invalid allowlist account size.');return {platformId:new PublicKey(data.subarray(9,41)),configId:new PublicKey(data.subarray(41,73))};}
