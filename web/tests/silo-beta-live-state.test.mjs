// Candidate review, round 7 (N4): the live beta status expires on its own clock. A hung or never-answered poll cannot keep an
// old permissive status alive past its window; an answer that arrives out of order never replaces a newer one; a payment
// boundary that asks at a later time is refused even though no poll ever rejected. Pure state machine; no network, no React.
import test from 'node:test';
import assert from 'node:assert/strict';
import {initialBetaLiveState,betaLiveAnswered,betaLiveFailed,betaLiveTick,siloBetaFreshness,SILO_BETA_STALE_INTERVALS,SILO_BETA_STALE_FAILURES} from '../lib/silo/beta-live-state.mjs';
const body=(paused=false,invited=true)=>({closed:true,paused,caps:{sol:'1',xmr:'0.5',solLamports:'1000000000',xmrAtomic:'500000000000'},auditDeferred:true,notice:'n',invited});
const interval=1000,t0=1_000_000;

test('the server-rendered copy is an observation at page load with a bounded window; the window closes by the clock alone',()=>{
 let state=initialBetaLiveState({beta:body(),intervalMs:interval,now:t0});
 assert.equal(state.beta.observedAt,t0);assert.equal(state.beta.validUntil,t0+SILO_BETA_STALE_INTERVALS*interval);assert.equal(state.invited,null,'a closed beta has not confirmed this browser yet');
 assert.equal(siloBetaFreshness(state.beta,t0+SILO_BETA_STALE_INTERVALS*interval),null,'fresh at the edge of the window');
 assert.match(siloBetaFreshness(state.beta,t0+SILO_BETA_STALE_INTERVALS*interval+1),/could not be refreshed in time/,'refused one millisecond later, with no poll having failed');
 // The tick that the hook runs between polls marks it stale too, so the banner can say so.
 const ticked=betaLiveTick(state,{now:t0+SILO_BETA_STALE_INTERVALS*interval+1});assert.equal(ticked.beta.stale,true);assert.equal(betaLiveTick(state,{now:t0+interval}),state,'unchanged while fresh');
});

test('a hung request never answers: the status still expires; a later good answer renews it',()=>{
 let state=initialBetaLiveState({beta:body(),intervalMs:interval,now:t0});
 // Request 1 starts and hangs forever (no answered/failed event ever arrives for sequence 1).
 state=betaLiveTick(state,{now:t0+4*interval});assert.equal(state.beta.stale,true);assert.match(siloBetaFreshness(state.beta,t0+4*interval),/refreshed in time/);
 // Request 2 answers: fresh again, window renewed from the answer time.
 state=betaLiveAnswered(state,{sequence:2,body:body(),now:t0+4*interval+50});assert.equal(state.beta.stale,false);assert.equal(state.beta.validUntil,t0+4*interval+50+SILO_BETA_STALE_INTERVALS*interval);assert.equal(state.invited,true);
 // The hung request 1 finally answers with an old permissive body: ignored.
 const stale=betaLiveAnswered(state,{sequence:1,body:body(false),now:t0+9*interval});assert.equal(stale,state,'an older answer never replaces a newer observation');
});

test('an older answer cannot undo a newer pause; failures count towards staleness; a tick after failures refuses',()=>{
 let state=initialBetaLiveState({beta:body(),intervalMs:interval,now:t0});
 state=betaLiveAnswered(state,{sequence:3,body:body(true),now:t0+100});assert.equal(state.beta.paused,true);
 state=betaLiveAnswered(state,{sequence:2,body:body(false),now:t0+120});assert.equal(state.beta.paused,true,'the earlier request\'s permissive answer is dropped');
 state=betaLiveFailed(state,{sequence:4,now:t0+200});assert.equal(state.failures,1);assert.equal(state.beta.stale,false);
 state=betaLiveFailed(state,{sequence:5,now:t0+300});assert.equal(state.failures,SILO_BETA_STALE_FAILURES);assert.equal(state.beta.stale,true,'two failures in a row');
 assert.match(siloBetaFreshness(state.beta,t0+300),/refreshed in time/);
 state=betaLiveAnswered(state,{sequence:6,body:body(true),now:t0+400});assert.equal(state.failures,0);assert.equal(state.beta.stale,false);
 assert.equal(siloBetaFreshness(null),null,'no beta configured: nothing to check');assert.match(siloBetaFreshness({paused:false},t0),/refreshed in time/,'a status without an observation time is never fresh');
});
