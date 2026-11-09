// Closed mainnet beta guards (owner decisions, 21 October 2026): configuration and caps, invite hashing and proof cookies, the
// pause switch and the per-action cap, and the release gate's explicit audit deferral (reported, never passed).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {siloBetaConfiguration,siloBetaPublic,siloBetaUnits,siloInviteHash,siloInviteProof,siloInviteValid,siloInviteCookie,assertSiloBetaAction,siloBetaAdmission,isSiloBetaRefusal,SILO_BETA_COOKIE} from '../lib/silo/beta-guard.mjs';
import {evaluateSiloRelease} from '../lib/silo/release-gate.mjs';

const secret='x'.repeat(40),code='silo-test-invite-code-1',other='silo-test-invite-code-2';
const sha=value=>createHash('sha256').update(value).digest('hex');

test('configuration: caps in whole units become integer base units; closed only with an allowlist; paused only when set', () => {
 const open=siloBetaConfiguration({});
 assert.deepEqual([open.closed,open.paused,open.caps.sol,open.caps.xmr,open.caps.solLamports,open.caps.xmrAtomic],[false,false,'1','0.5','1000000000','500000000000']);
 const closed=siloBetaConfiguration({SILO_BETA_INVITES:sha(code)+', '+sha(other).toUpperCase(),SILO_BETA_PAUSED:'true',SILO_BETA_CAP_SOL:'0.25',SILO_BETA_CAP_XMR:'0.1'},{auditDeferred:true});
 assert.deepEqual([closed.closed,closed.paused,closed.caps.solLamports,closed.caps.xmrAtomic,closed.auditDeferred],[true,true,'250000000','100000000000',true]);
 assert.throws(()=>siloBetaConfiguration({SILO_BETA_INVITES:'not-a-hash'}),/SHA-256 hashes/);
 assert.throws(()=>siloBetaConfiguration({SILO_BETA_CAP_SOL:'1e3'}),/Invalid beta cap/);assert.throws(()=>siloBetaUnits('0.0000000001',9),/too many decimals/);
 const pub=siloBetaPublic(closed);assert.deepEqual(Object.keys(pub).sort(),['auditDeferred','caps','closed','notice','open','paused']);assert.ok(!JSON.stringify(pub).includes(sha(code)),'no hash reaches the client');
});

test('invite: a listed code yields a proof cookie that verifies; wrong code, forged proof, expired proof and other secret are refused; open beta needs none', async () => {
 const env={SILO_BETA_INVITES:sha(code),RPC_SESSION_SECRET:secret};
 const token=await siloInviteProof(secret,env,code);assert.ok(!token.includes(code)&&!token.includes(sha(code)),'the proof carries neither the code nor its full hash');
 const cookie=siloInviteCookie(token,'https://silo.trading/api/silo/invite');assert.match(cookie,new RegExp(`^${SILO_BETA_COOKIE}=.*; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800; Secure$`));
 assert.equal(await siloInviteValid(secret,env,`other=1; ${SILO_BETA_COOKIE}=${token}`),true);
 await assert.rejects(siloInviteProof(secret,env,other),/not accepted/);await assert.rejects(siloInviteProof(secret,env,'short'),/Invalid invite code/);
 assert.equal(await siloInviteValid(secret,env,`${SILO_BETA_COOKIE}=${token.slice(0,-1)}${token.endsWith('0')?'1':'0'}`),false,'a changed signature (always a different last character; replacing it with a fixed 0 left it unchanged one time in sixteen)');
 assert.equal(await siloInviteValid('y'.repeat(40),env,`${SILO_BETA_COOKIE}=${token}`),false,'another secret');
 assert.equal(await siloInviteValid(secret,env,`${SILO_BETA_COOKIE}=${token}`,Date.now()+9*3600*1000),false,'expired');
 assert.equal(await siloInviteValid(secret,env,`${SILO_BETA_COOKIE}=${token}`,Date.now()+7*3600*1000),true,'still valid inside the 8-hour window');
 {
  const renewed=await siloInviteProof(secret,env,code,Date.now()+9*3600*1000);
  assert.notEqual(renewed,token,'re-entry after expiry issues a fresh token, not the same one (a new random nonce)');
  assert.equal(await siloInviteValid(secret,env,`${SILO_BETA_COOKIE}=${renewed}`,Date.now()+9*3600*1000),true,'the replacement proof is itself valid right away');
 }
 assert.equal(await siloInviteValid(secret,{...env,SILO_BETA_INVITES:sha(other)},`${SILO_BETA_COOKIE}=${token}`),false,'the code was removed from the allowlist');
 assert.equal(await siloInviteValid(secret,env,''),false,'no cookie');
 assert.equal(await siloInviteValid(secret,{RPC_SESSION_SECRET:secret},''),true,'an open beta needs no invitation');
 assert.equal(await siloInviteHash(code),sha(code));
});

test('actions: paused stops every send and trade; the SOL cap applies per action; tokens and sells are not capped in SOL', () => {
 const beta=siloBetaConfiguration({SILO_BETA_CAP_SOL:'1'});
 assert.doesNotThrow(()=>assertSiloBetaAction(beta,{kind:'transfer',lamports:'1000000000'}));
 assert.throws(()=>assertSiloBetaAction(beta,{kind:'transfer',lamports:'1000000001'}),/Beta limit: up to 1 SOL per transfer/);
 assert.doesNotThrow(()=>assertSiloBetaAction(beta,{kind:'transfer',lamports:null}),'a token transfer is bounded elsewhere');
 assert.throws(()=>assertSiloBetaAction(siloBetaConfiguration({SILO_BETA_PAUSED:'true'}),{kind:'trade',lamports:'1'}),/paused/);
});

test('release gate: an explicit owner deferral of the independent audit is reported, never passed; anything else still blocks', () => {
 const commit='a'.repeat(40),runtime='b'.repeat(64),assets={xmr:{v:1},zec:{v:1}},origin='https://silo.trading';
 const passing=field=>({passed:true,reportSha256:'c'.repeat(64)});
 const base={commit,origin,isolatedWalletOrigin:true,runtimeFingerprint:runtime,assets,openCriticalFindings:0,openHighFindings:0,restoreRecovery:passing(),mainnetReadOnly:passing(),cspAndDelivery:passing(),noServerKeys:passing(),providerPrivacy:passing(),ownerRiskAcceptance:passing(),sendFlowReview:passing()};
 const deferred=evaluateSiloRelease({...base,independentAudit:{deferred:true,decidedBy:'owner',decidedOn:'2026-10-21',note:'No budget before the closed beta.'}},{commit,assets,origin,runtime});
 assert.deepEqual([deferred.ready,deferred.auditDeferred,deferred.reasons],[true,true,[]]);assert.match(deferred.warnings[0],/deferred by owner decision \(2026-10-21\)/);
 const missing=evaluateSiloRelease({...base},{commit,assets,origin,runtime});assert.equal(missing.ready,false);assert.match(missing.reasons.join(' '),/independentAudit requires/);
 for(const bad of [{deferred:true},{deferred:true,decidedBy:'reviewer',decidedOn:'2026-10-21',note:'x'},{deferred:true,decidedBy:'owner',decidedOn:'yesterday',note:'x'},{deferred:true,decidedBy:'owner',decidedOn:'2026-10-21',note:''}])assert.equal(evaluateSiloRelease({...base,independentAudit:bad},{commit,assets,origin,runtime}).ready,false,JSON.stringify(bad));
 const passed=evaluateSiloRelease({...base,independentAudit:passing()},{commit,assets,origin,runtime});assert.deepEqual([passed.ready,passed.auditDeferred,passed.warnings],[true,false,[]]);
});

test('fail closed (review N3): a mainnet deployment is closed with or without an allowlist, and without one nobody is admitted; a test deployment without one is open',async()=>{
 const none=siloBetaConfiguration({SILO_NETWORK:'mainnet'});assert.equal(none.closed,true);assert.equal(none.allowlisted,false);
 assert.equal(await siloInviteValid(secret,{SILO_NETWORK:'mainnet',RPC_SESSION_SECRET:secret},''),false,'no cookie, no allowlist: denied');
 const env={SILO_NETWORK:'mainnet',SILO_BETA_INVITES:sha(code),RPC_SESSION_SECRET:secret},token=await siloInviteProof(secret,env,code);
 assert.equal(await siloInviteValid(secret,{...env,SILO_BETA_INVITES:''},`${SILO_BETA_COOKIE}=${token}`),false,'the last invite removed: everyone denied, not everyone admitted');
 await assert.rejects(siloInviteProof(secret,{SILO_NETWORK:'mainnet',RPC_SESSION_SECRET:secret},code),/not accepted/);
 assert.equal(siloBetaConfiguration({}).closed,false);assert.equal(await siloInviteValid(secret,{RPC_SESSION_SECRET:secret},''),true);
 assert.deepEqual(Object.keys(siloBetaPublic(none)).sort(),['auditDeferred','caps','closed','notice','open','paused'],'the browser learns nothing about the allowlist');assert.equal(siloBetaPublic(none).open,false);
});

test('admission (review N2): invitation, pause and the SOL cap from the environment at the moment of the call; the XMR cap in piconero for the page',async()=>{
 const env={SILO_NETWORK:'mainnet',SILO_BETA_INVITES:sha(code),RPC_SESSION_SECRET:secret,SILO_BETA_CAP_SOL:'1'},token=await siloInviteProof(secret,env,code);
 const invited=new Headers({Cookie:`${SILO_BETA_COOKIE}=${token}`}),anonymous=new Headers();
 await siloBetaAdmission(env,{headers:invited,kind:'transfer',lamports:'1000000000'});
 await assert.rejects(siloBetaAdmission(env,{headers:anonymous,kind:'transfer'}),/Invitation required/);
 await assert.rejects(siloBetaAdmission(env,{headers:invited,kind:'transfer',lamports:'1000000001'}),/Beta limit: up to 1 SOL per transfer/);
 await assert.rejects(siloBetaAdmission({...env,SILO_BETA_PAUSED:'true'},{headers:invited,kind:'transfer'}),/paused/);
 await siloBetaAdmission({...env,SILO_BETA_PAUSED:'true'},{headers:invited,kind:'outcome',paused:false});
 await assert.rejects(siloBetaAdmission({...env,SILO_BETA_PAUSED:'true'},{headers:invited,kind:'outcome',paused:false,lamports:'5'}),/paused/,'an amount always brings the pause check');
 const beta=siloBetaConfiguration({SILO_BETA_CAP_XMR:'0.5'});
 assert.doesNotThrow(()=>assertSiloBetaAction(beta,{kind:'payment',xmrAtomic:'500000000000'}));
 assert.throws(()=>assertSiloBetaAction(beta,{kind:'payment',xmrAtomic:'500000000001'}),/Beta limit: up to 0.5 XMR per payment/);
});

test('round 7 (N1): two redemptions of the same code in the same second are two proofs; a nonce is required and bound by the signature',async()=>{
 const env={SILO_NETWORK:'mainnet',SILO_BETA_INVITES:sha(code),RPC_SESSION_SECRET:secret},now=Date.now();
 const a=await siloInviteProof(secret,env,code,now),b=await siloInviteProof(secret,env,code,now);
 assert.notEqual(a,b,'distinct proofs at an identical timestamp');assert.equal(a.split('.')[0],b.split('.')[0],'same expiry');assert.notEqual(a.split('.')[2],b.split('.')[2],'different nonces');
 assert.equal(await siloInviteValid(secret,env,`${SILO_BETA_COOKIE}=${a}`),true);assert.equal(await siloInviteValid(secret,env,`${SILO_BETA_COOKIE}=${b}`),true);
 const [expires,prefix,,signature]=a.split('.');const swapped=`${expires}.${prefix}.${b.split('.')[2]}.${signature}`;assert.equal(await siloInviteValid(secret,env,`${SILO_BETA_COOKIE}=${swapped}`),false,'a nonce from another proof under this signature is refused');
 assert.equal(await siloInviteValid(secret,env,`${SILO_BETA_COOKIE}=${expires}.${prefix}.${signature}`),false,'the old three-part shape is no longer a proof');
 await assert.rejects(siloInviteProof(secret,env,code,now,'short'),/Invalid invite nonce/);
});


test('round 9: the policy is read after the proof wait, a pause that flips during it refuses, a changed allowlist is re-verified, and refusals are typed',async()=>{
 const code='silo-stale-invite-1',base={SILO_NETWORK:'mainnet',SILO_BETA_INVITES:sha(code),RPC_SESSION_SECRET:secret,SILO_BETA_CAP_SOL:'1'},token=await siloInviteProof(secret,base,code),headers=new Headers({Cookie:`${SILO_BETA_COOKIE}=${token}`});
 // The environment flips to paused the moment the proof verification reads the secret (that is during the admission's own wait).
 let reads=0;const flipping=new Proxy({...base},{get(target,key){if(key==='RPC_SESSION_SECRET')reads++;if(key==='SILO_BETA_PAUSED')return reads>0?'true':undefined;return target[key];}});
 await assert.rejects(siloBetaAdmission(flipping,{headers,kind:'swap',lamports:'5'}),error=>{assert.match(error.message,/paused/);assert.equal(error.siloBetaRefusal,true);assert.equal(error.preDispatchRefusal,true);assert.equal(error.code,'beta-paused');return true;},'the pause that arrived during the proof check is seen');
 // The allowlist changes during the wait: the proof is checked again against the allowlist of the moment and refused.
 let secretReads=0;const other=sha('a-different-code-entirely-9');const rotating=new Proxy({...base},{get(target,key){if(key==='RPC_SESSION_SECRET')secretReads++;if(key==='SILO_BETA_INVITES')return secretReads>0?other:target[key];return target[key];}});
 await assert.rejects(siloBetaAdmission(rotating,{headers,kind:'swap'}),error=>{assert.match(error.message,/Invitation required/);assert.equal(error.code,'beta-invite');return true;});
 // Typed refusals for the cap too; a passing admission returns the configuration read after the wait.
 await assert.rejects(siloBetaAdmission({...base,SILO_BETA_CAP_SOL:'0.000000001'},{headers,kind:'swap',lamports:'5'}),error=>error.code==='beta-cap'&&isSiloBetaRefusal(error));
 const admitted=await siloBetaAdmission(base,{headers,kind:'swap',lamports:'5'});assert.equal(admitted.paused,false);assert.equal(isSiloBetaRefusal(Error('x')),false);
});

test('round 10 (B1): a configuration that keeps changing under the admission ends in a typed refusal after the bounded passes, never in an admission on a stale check',async()=>{
 const {SILO_BETA_ADMISSION_PASSES}=await import('../lib/silo/beta-guard.mjs');
 const code='silo-churning-invite-1',base={SILO_NETWORK:'mainnet',SILO_BETA_INVITES:sha(code),RPC_SESSION_SECRET:secret,SILO_BETA_CAP_SOL:'1'},token=await siloInviteProof(secret,base,code),headers=new Headers({Cookie:`${SILO_BETA_COOKIE}=${token}`});
 // The allowlist is different on every read, while this browser's code is always on it: no two reads agree, so the membership
 // cannot be verified against a stable configuration. The proof check itself is run exactly once per pass.
 let listReads=0,secretReads=0;const churning=new Proxy({...base},{get(target,key){if(key==='RPC_SESSION_SECRET')secretReads++;if(key==='SILO_BETA_INVITES')return sha(code)+','+sha('rotating-'+listReads++);return target[key];}});
 await assert.rejects(siloBetaAdmission(churning,{headers,kind:'swap',lamports:'5'}),error=>{assert.match(error.message,/could not be verified against a stable/);assert.equal(error.code,'beta-unverified');assert.equal(error.siloBetaRefusal,true);assert.equal(error.preDispatchRefusal,true);assert.ok(isSiloBetaRefusal(error));return true;});
 assert.equal(secretReads,SILO_BETA_ADMISSION_PASSES,'one proof check per bounded pass, then the refusal');
 // Churn that stops within the budget: the pass that sees a stable configuration decides (admitted here, the code is on the list).
 let stableAfter=2,reads=0;const settling=new Proxy({...base},{get(target,key){if(key==='SILO_BETA_INVITES'){reads++;return reads>stableAfter*3?target[key]:sha(code)+','+sha('early-'+reads);}return target[key];}});
 const admitted=await siloBetaAdmission(settling,{headers,kind:'swap',lamports:'5'});assert.equal(admitted.closed,true);
 // A beta that closes on every pass under an uninvited browser is refused, not admitted under the open rule it started in.
 let networkReads=0;const closing=new Proxy({...base,SILO_NETWORK:undefined},{get(target,key){if(key==='SILO_NETWORK')return networkReads++%2===0?undefined:'mainnet';return target[key];}});
 await assert.rejects(siloBetaAdmission(closing,{headers:new Headers(),kind:'swap',lamports:'5'}),error=>['beta-unverified','beta-invite'].includes(error.code)&&error.preDispatchRefusal===true);
});

