/** Source/runtime acceptance is distinct from compact integrity and primary
 * inspection. The production defaults remain held. A trusted server/signer
 * adapter must bind reviewed policy to its exact source/runtime, never request JSON. */
/** @type {Readonly<{protocol:string,sourceAccepted:boolean,runtimeAccepted:boolean,providerPrivacyReviewed:boolean,signerReviewed:boolean,transportReviewed:boolean,recoveryReviewed:boolean,historicalReceiptReviewed:boolean}>} */
export const SILO_SHARED_EXECUTION_ACCEPTANCE=Object.freeze({protocol:'shared-serial-v1',sourceAccepted:false,runtimeAccepted:false,providerPrivacyReviewed:false,signerReviewed:false,transportReviewed:false,recoveryReviewed:false,historicalReceiptReviewed:false});
export function assertSiloSharedExecutionAccepted(policy=SILO_SHARED_EXECUTION_ACCEPTANCE){if(policy?.protocol!=='shared-serial-v1'||['sourceAccepted','runtimeAccepted','providerPrivacyReviewed','signerReviewed','transportReviewed'].some(field=>policy[field]!==true))throw Error('Shared execution source/runtime review is held.');return true;}
export function assertSiloSharedRecoveryAccepted(policy=SILO_SHARED_EXECUTION_ACCEPTANCE){if(policy?.protocol!=='shared-serial-v1'||policy.recoveryReviewed!==true||policy.providerPrivacyReviewed!==true)throw Error('Shared recovery runtime review is held.');return true;}
