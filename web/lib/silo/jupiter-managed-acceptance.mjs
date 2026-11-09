import {SILO_TRIAL_ORIGIN,siloPrivateTrialLimitsReady} from './trial-policy.mjs';
/** One source-controlled provider/wallet contract, not per-mint AMM admission.
 * Discovery and captured quotes never confer signing or transport authority. */
export const SILO_MANAGED_RELEASE_ORIGIN='https://silo.trading';
export const SILO_MANAGED_EXECUTION_ACCEPTANCE=Object.freeze({protocol:'managed-v1',trialOnly:false,scope:'compatible-solana-native-v1',nativeSigningReviewed:false,sourceAccepted:false,runtimeAccepted:false,providerPrivacyReviewed:false,signerReviewed:false,transportReviewed:false,recoveryReviewed:false,historicalReceiptReviewed:false});
/** @param {any} policy */
export function assertSiloManagedExecutionAccepted(policy=SILO_MANAGED_EXECUTION_ACCEPTANCE){if(policy?.protocol!=='managed-v1'||['sourceAccepted','runtimeAccepted','providerPrivacyReviewed','signerReviewed','transportReviewed'].some(k=>policy[k]!==true))throw Error('Managed Jupiter source/runtime review is held.');return true;}
/** @param {any} policy */
export function assertSiloManagedRecoveryAccepted(policy=SILO_MANAGED_EXECUTION_ACCEPTANCE){if(policy?.protocol!=='managed-v1'||policy.recoveryReviewed!==true||policy.historicalReceiptReviewed!==true||policy.providerPrivacyReviewed!==true)throw Error('Managed Jupiter recovery review is held.');return true;}

/** Source-controlled gate, distinct from the limited private trial. No request,
 * UI configuration or serialized ticket can turn these review flags on. */
export function assertSiloManagedNativeReleaseAccepted(policy=SILO_MANAGED_EXECUTION_ACCEPTANCE){
 if(policy?.trialOnly!==false||policy.scope!=='compatible-solana-native-v1'||policy.nativeSigningReviewed!==true)throw Error('Native Jupiter release review is held.');
 assertSiloManagedExecutionAccepted(policy);assertSiloManagedRecoveryAccepted(policy);return true;
}

/** Approved historical issuer/source fingerprints for read-only reconciliation.
 * Add reviewed releases here explicitly; request JSON cannot supply this list. */
export const SILO_MANAGED_RECOVERY_SOURCE_FINGERPRINTS=Object.freeze([]);

/** Exact independently reviewed issuer pairs for read-only recovery after a
 * runtime change. Empty until an actual issued release is reviewed. The HMAC
 * issuer must remain available; this never grants signing or transport. */
export const SILO_MANAGED_RECOVERY_ISSUERS=Object.freeze([]);

/** Candidate source contract for the strictly capped owner trial only. Runtime
 * authority additionally requires the independent exact-candidate trial packet.
 * The ordinary/public/native execution policy above remains held. */
export const SILO_MANAGED_PRIVATE_TRIAL_ACCEPTANCE=Object.freeze({protocol:'managed-v1',trialOnly:true,scope:'sol-usdc-owner-trial-v1',sourceAccepted:true,runtimeAccepted:true,providerPrivacyReviewed:true,signerReviewed:true,transportReviewed:true,recoveryReviewed:true,historicalReceiptReviewed:true});
export function siloManagedServerPolicy(env){return env?.SILO_ORIGIN===SILO_TRIAL_ORIGIN&&siloPrivateTrialLimitsReady(env)?SILO_MANAGED_PRIVATE_TRIAL_ACCEPTANCE:SILO_MANAGED_EXECUTION_ACCEPTANCE;}
export function siloManagedBrowserPolicy(origin){return origin===SILO_TRIAL_ORIGIN?SILO_MANAGED_PRIVATE_TRIAL_ACCEPTANCE:SILO_MANAGED_EXECUTION_ACCEPTANCE;}
