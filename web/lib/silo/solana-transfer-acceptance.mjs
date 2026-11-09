/** Source-controlled native transfer boundary. Neither request JSON, an account
 * login nor the Jupiter private trial can turn these reviews into acceptance.
 *
 * Activation for the closed mainnet beta (owner's decision, 22 October 2026, after the candidate review rounds 6-10 on
 * claude/silo-mainnet-beta-candidate-20261021): the five reviews are accepted in source. This alone opens nothing: a mainnet
 * send still needs release evidence for this exact commit and runtime (config.release.ready, which binds
 * SILO_PAYMENT_AUTHORITY=local-beta through the runtime fingerprint), SILO_SOLANA_TRANSFERS_ENABLED=true, the reviewed origin
 * https://silo.trading, the closed-beta invitation, the pause and the caps. Reverting this line holds every send again. */
export const SILO_TRANSFER_RELEASE_ORIGIN='https://silo.trading';
export const SILO_TRANSFER_NATIVE_ACCEPTANCE=Object.freeze({protocol:'silo-native-transfer-review-v1',sourceAccepted:true,runtimeAccepted:true,signerReviewed:true,transportReviewed:true,recoveryReviewed:true});
export function assertSiloNativeTransferAccepted(){if(['sourceAccepted','runtimeAccepted','signerReviewed','transportReviewed','recoveryReviewed'].some(key=>SILO_TRANSFER_NATIVE_ACCEPTANCE[key]!==true))throw Error('Native transfer source/runtime acceptance is held.');return true;}
