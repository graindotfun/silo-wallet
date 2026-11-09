/** An affirmative choice is tied to one immutable review/retained payment. It cannot survive a new review,
 * a changed wallet or network, or switch from signing to retrying. Context invalidation is also enforced by the caller. */
export function siloActionConsent(subject,action){
 if(!subject||typeof subject!=='object'||!['send','retry','swap'].includes(action))throw Error('An exact action review is required.');
 return Object.freeze({subject,action,binding:JSON.stringify(subject)});
}
export function assertSiloActionConsent(consent,subject,action){
 if(!consent||consent.subject!==subject||consent.action!==action||consent.binding!==JSON.stringify(subject))throw Error('Approve this exact action before continuing.');
}
