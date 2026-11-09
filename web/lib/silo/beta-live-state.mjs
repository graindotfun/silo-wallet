/** The live closed-beta status as the page keeps it (candidate review, round 7, N4): a pure state machine the hook drives.
 *
 * A status is a fact observed at a time (`observedAt`) and is good for a bounded window (`validUntil`). It expires on its own
 * when that time passes, whether or not any later request finished, failed or hung: the page's clock is checked at every
 * payment boundary (prepare, submit, relay). A later poll that answers out of order never replaces a newer observation
 * (`sequence`), a request runs with a timeout, and a page that comes back from the background re-reads at once. Nothing here
 * touches the network or React. */
export const SILO_BETA_POLL_INTERVAL_MS=60000,SILO_BETA_FETCH_TIMEOUT_MS=15000,SILO_BETA_STALE_INTERVALS=3,SILO_BETA_STALE_FAILURES=2;

/** @param {{beta:any,intervalMs?:number,now?:number}} options */
export function initialBetaLiveState({beta,intervalMs=SILO_BETA_POLL_INTERVAL_MS,now=Date.now()}){
 // The server-rendered copy counts as an observation made at page load; the first poll replaces it.
 return Object.freeze({beta:beta?{...beta,stale:false,observedAt:now,validUntil:now+SILO_BETA_STALE_INTERVALS*intervalMs}:null,invited:beta?.closed?null:true,checkedAt:null,observedAt:beta?now:null,validUntil:beta?now+SILO_BETA_STALE_INTERVALS*intervalMs:null,sequence:0,failures:0,intervalMs});
}
/** A poll answered (`sequence` is the number the hook gave that request when it started). Older answers are ignored. */
export function betaLiveAnswered(state,{sequence,body,now=Date.now()}){
 if(sequence<state.sequence)return state;
 const validUntil=now+SILO_BETA_STALE_INTERVALS*state.intervalMs;
 return Object.freeze({...state,sequence,failures:0,checkedAt:now,observedAt:now,validUntil,invited:body.invited===true,beta:{closed:body.closed,paused:body.paused,caps:body.caps,auditDeferred:body.auditDeferred,notice:body.notice,stale:false,observedAt:now,validUntil}});
}
/** A poll failed, timed out or was aborted. The last good observation stays, but its own clock keeps running. */
export function betaLiveFailed(state,{sequence,now=Date.now()}){
 if(sequence<state.sequence)return state;
 return betaLiveTick(Object.freeze({...state,sequence,failures:state.failures+1}),{now});
}
/** Time passed (a timer tick, a resumed page, a payment boundary): mark the status stale once its window closed or after
 * repeated failures. Pure; returns the same state when nothing changed. */
export function betaLiveTick(state,{now=Date.now()}={}){
 if(!state.beta)return state;
 const stale=state.failures>=SILO_BETA_STALE_FAILURES||(state.validUntil!==null&&now>state.validUntil);
 if(stale===Boolean(state.beta.stale))return state;
 return Object.freeze({...state,beta:{...state.beta,stale}});
}
/** The question every payment boundary asks, against the clock at that moment: is this status fresh enough to act on?
 * Returns null when it is, otherwise the sentence the page shows. Also refuses a status that carries no observation time. */
export function siloBetaFreshness(beta,now=Date.now()){
 if(!beta)return null;
 if(beta.stale||typeof beta.validUntil!=='number'||now>beta.validUntil)return 'The beta status could not be refreshed in time; wait a moment and try again. Your funds and backups stay available.';
 return null;
}
