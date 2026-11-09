/** A browser swap flow's refusal result (candidate review, round 10, Sol's B2). A typed pre-dispatch refusal, whether it came
 * from the execution preflight (the fresh simulation after capture) or from the submission itself, is reported as
 * `status:'refused'` with the phase it happened in; `status:'unknown'` stays reserved for a dispatch that may have started.
 * `earlierSubmission` says whether this flow instance had already dispatched these exact signed bytes before the refused
 * attempt, so the screen never writes "nothing was sent" over an earlier uncertain submission. The signed journal is kept. */
export function siloSwapRefused(row,error,{phase,earlierSubmission=false}){
 if(error?.preDispatchRefusal!==true)throw Error('Only a typed pre-dispatch refusal is reported as refused.');
 if(phase!=='preflight'&&phase!=='submission')throw Error('Refusal phase differs.');
 return {status:'refused',signature:row.signature,held:true,error:error.message,code:typeof error.code==='string'?error.code:'beta',phase,earlierSubmission:earlierSubmission===true};
}
/** The one sentence the screens show for a refused outcome. `retry` marks the screens' explicit retry of a saved approved row
 * (an earlier page may have submitted it), which is reported like an earlier submission by this instance. */
export function siloSwapRefusalMessage(outcome,{retry=false}={}){
 const reason=typeof outcome?.error==='string'&&outcome.error?outcome.error:'the beta rules refused this swap.';
 const where=outcome?.phase==='preflight'?'before its final check':'before submission';
 if(retry||outcome?.earlierSubmission===true)return `Refused now, ${where}: ${reason} The signed swap is kept. An earlier submission of it may have reached the network; check its outcome before anything else.`;
 return `Refused ${where}: ${reason} The signed swap is kept; nothing was sent.`;
}
