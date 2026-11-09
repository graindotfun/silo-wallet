// Sol, review of 15a0afbf (R6-M3): the admission-scope rule of the release gate, tested through lib/silo/release-gate.mjs alone so
// the same file runs against older gates (it imports nothing added later). An older gate that ignores the admission scope
// releases an open runtime on invite-reviewed evidence and fails the "held" cases behaviourally, not by a missing import.
import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateSiloRelease} from '../lib/silo/release-gate.mjs';
const commit='c'.repeat(40),origin='https://silo.example',assets={xmr:{},zec:{}},runtime='d'.repeat(64),report={passed:true,reportSha256:'e'.repeat(64)};
const evidence=scope=>({commit,origin,isolatedWalletOrigin:true,assets,runtimeFingerprint:runtime,...(scope===undefined?{}:{admissionScope:scope}),openCriticalFindings:0,openHighFindings:0,
 ...Object.fromEntries(['independentAudit','restoreRecovery','mainnetReadOnly','cspAndDelivery','noServerKeys','providerPrivacy','ownerRiskAcceptance','sendFlowReview'].map(f=>[f,report]))});
const ready=(scope,admission)=>evaluateSiloRelease(evidence(scope),{commit,assets,origin,runtime,admission}).ready;
test('broadening admission beyond the reviewed scope is held',()=>{
 assert.equal(ready('invite','open'),false,'invite-reviewed evidence, open runtime: held');
 assert.equal(ready(undefined,'open'),false,'evidence naming no scope (all earlier evidence), open runtime: held');
 assert.equal(ready(null,'open'),false,'a null scope is invite, not open');
});
test('narrowing and matching scopes release',()=>{
 for(const [scope,admission] of [['invite','invite'],[undefined,'invite'],['open','open'],['open','invite']])assert.equal(ready(scope,admission),true,`${scope} evidence, ${admission} runtime`);
});
test('unknown scopes are refused',()=>{
 assert.equal(ready('everyone','invite'),false);assert.equal(ready('open','public'),false);
});
