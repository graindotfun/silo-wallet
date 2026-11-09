import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {SILO_JUPITER_TARGET_ROSTER as roster,siloJupiterTarget,siloJupiterIndicativePair,SILO_TARGET_SOL_MINT as sol,SILO_TARGET_USDC_MINT as usdc} from '../lib/silo/jupiter-target-roster.mjs';
import {assertSiloAdmittedJupiterPair,SILO_JUPITER_ROUTE_POLICY} from '../lib/silo/jupiter-route-policy.mjs';
test('owner target catalogue preserves thirteen exact identities without execution admission',()=>{
 assert.equal(roster.length,13);assert.equal(new Set(roster.map(t=>t.mint)).size,13);assert.deepEqual(roster.map(t=>[t.symbol,t.decimals]),[['SOL',9],['USDC',6],['WIF',6],['BONK',5],['PENGU',6],['POPCAT',9],['FARTCOIN',6],['TRUMP',6],['PNUT',6],['BOME',6],['MEW',5],['PUMP',6],['ANSEM',6]]);
 for(const row of roster){assert.equal(String(new PublicKey(row.mint)),row.mint);assert.equal(row.releaseAccepted,false);assert.equal(siloJupiterTarget(row.mint),row);assert.ok(Object.isFrozen(row));}
 assert.equal(SILO_JUPITER_ROUTE_POLICY.tokens.length,3);assert.equal(SILO_JUPITER_ROUTE_POLICY.releaseAccepted,false);
 for(const row of roster.filter(t=>!['SOL','USDC','WIF'].includes(t.symbol)))assert.throws(()=>assertSiloAdmittedJupiterPair({network:'solana:mainnet-beta',inputMint:sol,outputMint:row.mint}));
});
test('unavailable token on either side and arbitrary holdings never create an indicative capability',()=>{
 assert.equal(siloJupiterIndicativePair(sol,usdc),true);assert.equal(siloJupiterIndicativePair(usdc,sol),true);assert.equal(siloJupiterIndicativePair(sol,sol),false);
 for(const row of roster.filter(t=>t.unavailable)){assert.equal(siloJupiterIndicativePair(sol,row.mint),false);assert.equal(siloJupiterIndicativePair(row.mint,sol),false);}
 for(const unknown of ['WIF','ANSEM','arbitrary-meme-token',undefined,null,'11111111111111111111111111111111']){assert.equal(siloJupiterTarget(unknown),null);assert.equal(siloJupiterIndicativePair(sol,unknown),false);}
});
test('Token2022 planning reasons distinguish mutable PUMP behavior and metadata-only ANSEM work',()=>{
 const pump=roster.find(t=>t.symbol==='PUMP'),ansem=roster.find(t=>t.symbol==='ANSEM');assert.equal(pump.program,ansem.program);assert.equal(pump.status,'unsupported-transfer-behavior');assert.match(pump.reason,/can change/);assert.equal(ansem.status,'token-2022-under-review');assert.match(ansem.reason,/exact mint is The Black Bull/);assert.equal(pump.unavailable,true);assert.equal(ansem.unavailable,true);
});
