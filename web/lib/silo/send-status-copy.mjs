// Plain-language status for a Solana send that is not simply "Sent". Pure and display-only: it never signs, submits, retries or retires a
// payment (the journal in silo-transfer-journal and the component keep those rules). Wording keeps what the component already said.
/** @typedef {{headline:string,detail:string,nextAction:string,eta:string|null}} PlainStatus */
export const SEND_STATUS_STATES = Object.freeze([
  'prepared', 'signing-unknown', 'signed', 'submitted', 'uncertain', 'expired', 'finalized', 'failed', 'failing', 'held-other-network', 'recovery-found',
]);
/** @param {string} state @param {{label?:string}} [context] label = "0.05 SOL" style amount label of the saved payment */
export function sendStatus(state, context = {}) {
  const label = context.label || 'This payment';
  switch (state) {
    case 'prepared': return {
      headline: 'Review saved, nothing signed',
      detail: 'An unsigned review was reserved before a wallet prompt. Nothing has been signed and nothing has left your wallet.',
      nextAction: 'You can cancel it before signing.', eta: null };
    case 'signing-unknown': return {
      headline: 'We cannot tell if this was signed',
      detail: 'The wallet prompt started, but no returned signature was captured. New payments remain held. Preserve this record; do not replace it.',
      nextAction: 'Tap Find existing signing outcome. It only reads public history and cannot prove a payment does not exist.',
      eta: 'Usually the search answers in seconds, but it can take longer.' };
    case 'signed': return {
      headline: `${label} is signed and saved`,
      detail: 'Silo is checking whether Solana received it. Nothing is sent twice: the saved payment is the same one each time.',
      nextAction: 'Tap Check now, or leave this open. If it takes too long you can retry the identical saved payment.',
      eta: 'Usually seconds to a minute, but it can take longer when the network is busy.' };
    case 'submitted': return {
      headline: `Sending ${label}`,
      detail: 'Solana accepted the payment and Silo is waiting for it to confirm.',
      nextAction: 'No action needed. Silo keeps checking.',
      eta: 'Usually under a minute, but it can take longer when the network is busy.' };
    case 'uncertain': return {
      headline: 'We cannot yet tell if Solana received it',
      detail: 'Solana did not acknowledge the submission. The exact payment stays saved while Silo keeps checking, and new payments wait.',
      nextAction: 'Tap Check now. Do not send the amount again by hand.',
      eta: 'Usually the next check answers within a minute, but it can take longer.' };
    case 'expired': return {
      headline: `${label} expired before it confirmed`,
      detail: 'The outcome is not proven yet, so this exact payment stays saved and new payments wait.',
      nextAction: 'Tap Check now to see its final outcome before another payment.', eta: null };
    case 'finalized': return {
      headline: 'Sent',
      detail: `${label} is confirmed on Solana.`,
      nextAction: 'Nothing to do. The transaction signature is shown below.', eta: null };
    case 'failed': return {
      headline: 'Not sent',
      detail: 'The network rejected this transfer. Only the network fee was charged.',
      nextAction: 'You can review and send again.', eta: null };
    case 'failing': return {
      headline: 'The transfer is failing',
      detail: 'Solana reports an error for this transfer. Silo is waiting for the final result.',
      nextAction: 'Tap Check now. Wait for the final answer before another payment.',
      eta: 'Usually under a minute, but it can take longer.' };
    case 'held-other-network': return {
      headline: 'This payment is on another network',
      detail: 'This saved payment belongs to a different Solana network than the one selected.',
      nextAction: 'Switch to its network to check it.', eta: null };
    case 'recovery-found': return {
      headline: 'An earlier signed payment was found',
      detail: 'An exact previously signed payment was found and saved. It has not been confirmed yet, and submission and retries remain held.',
      nextAction: 'Tap Check now to reconcile it.', eta: null };
    default: return {
      headline: 'Not confirmed yet',
      detail: 'Silo keeps checking this payment.',
      nextAction: 'Tap Check now, or leave this open.', eta: null };
  }
}
