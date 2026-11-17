// Plain-language status for every Convert (provider order) state. Pure and display-only: state in, words out. It never decides what
// the wallet may do (that stays in conversion-ui.mjs, conversion-attempt.mjs and the server) and never moves, signs or retires anything.
// Every sentence must hold in the worst case: a provider answer is the provider's word until this wallet or Silo's own chain check
// agrees, a refund is never promised, and a time is only ever given as "usually" with "can take longer".
// States come from lib/silo/crosschain-order.mjs (coordinator) and lib/silo/changenow-adapter.mjs (provider status map); 'hidden' is the
// Past conversions view of an order moved off the main screen.
/** @typedef {{headline:string,detail:string,nextAction:string,eta:string|null}} PlainStatus */
export const CONVERT_STATUS_STATES = Object.freeze([
  'creation-uncertain', 'waiting', 'deposit-signed', 'deposit-uncertain', 'deposit-submitted', 'provider-confirming', 'provider-exchanging',
  'provider-verifying', 'provider-sending', 'payout-reported', 'settled', 'provider-failed', 'expired', 'refund-reported', 'refund-confirmed',
  'provider-unknown', 'wallet-retired', 'hidden',
]);

/** F-21 (outside company holds the money). Shown at the Convert confirm step and inside every in-flight status. Owner approves the sentence. */
export const CONVERT_HOLD_NOTICE = 'While the order runs, the provider holds the funds, not Silo. The provider can stop an order to ask you for identity documents. Silo never asks for documents and cannot see or speed up that request. If it happens, contact the provider’s support with the order id shown in Details.';

const SUPPORT = 'contact the provider’s support with the order id shown in Details';
const USUALLY_MINUTES = 'Usually a few minutes, but it can take longer.';

/**
 * @param {string|null|undefined} state  the saved record state (or 'hidden' for an order moved off the main screen)
 * @param {{windowClosed?:boolean,canHide?:boolean,receiptConfirmed?:boolean,destinationIsXmr?:boolean,sourceLabel?:string,destLabel?:string}} [context]
 * @returns {PlainStatus}
 */
export function convertStatus(state, context = {}) {
  const { windowClosed = false, canHide = false, receiptConfirmed = false, destinationIsXmr = false } = context;
  const src = context.sourceLabel || 'coins', dst = context.destLabel || 'coins';
  switch (state) {
    case 'creation-uncertain': return {
      headline: 'We could not confirm this order was created',
      detail: 'The request may or may not have reached the provider. No funds have left your wallet for it, and Silo will not create a second order while this is unresolved.',
      nextAction: 'Tap Check order. Do not start another conversion until it answers.',
      eta: 'Usually it answers in seconds. If the provider does not answer, try again later.' };
    case 'waiting': return windowClosed ? {
      headline: 'Time to send has ended',
      detail: 'If you did not send anything, nothing left your wallet. If you did send funds, the provider may still be processing them, so this order stays tracked here until the provider says otherwise.',
      nextAction: canHide ? 'Tap Check order. If you did not send anything you can hide the order from this screen; it stays tracked and is still checked.' : 'Tap Check order.',
      eta: null } : {
      headline: `Ready for your ${src} deposit`,
      detail: `The provider has created the order and expects your ${src}. The provider is waiting to see the deposit. If you already sent it, do not send again.`,
      nextAction: 'Review and send the exact amount before the timer ends, unless you already sent it.',
      eta: 'The timer shows how long you have.' };
    case 'deposit-signed': return {
      headline: 'Your payment is signed and saved',
      detail: 'It is not confirmed as sent yet. Silo keeps the exact signed payment and will not make a second one.',
      nextAction: 'Keep Silo open while it is submitted. Do not send the same amount again by hand.',
      eta: 'Usually seconds, but it can take longer when the network is busy.' };
    case 'deposit-uncertain': return {
      headline: 'We cannot yet tell if your payment went out',
      detail: 'The payment was handed to the network but Silo did not get a clear answer, so it may have been sent. Silo will not send it a second time.',
      nextAction: 'Tap Check order to ask the provider whether it saw the deposit. Do not send the amount again.',
      eta: 'Usually the provider sees a deposit within minutes of the network confirming it, but it can take longer.' };
    case 'deposit-submitted': return {
      headline: 'Your payment was sent to the network',
      detail: 'The funds have left your wallet. The provider is waiting for the network to confirm them before it starts the exchange.',
      nextAction: 'No action needed. Silo checks the order again by itself.',
      eta: USUALLY_MINUTES };
    case 'provider-confirming': return {
      headline: 'The provider is confirming your deposit',
      detail: `Your ${src} reached the provider. It is counting network confirmations before it starts the exchange, and it holds the funds meanwhile.`,
      nextAction: 'No action needed. Silo checks the order again by itself.',
      eta: USUALLY_MINUTES };
    case 'provider-exchanging': return {
      headline: `The provider is exchanging your ${src}`,
      detail: 'The provider holds the funds while it exchanges them. This is a step where it can stop the order to ask you for identity documents. Silo cannot see or speed up that request.',
      nextAction: `No action needed. If the provider asks you for anything, or the order stalls, ${SUPPORT}.`,
      eta: 'Usually a few minutes, but it can take much longer if the provider holds the order for a check.' };
    case 'provider-verifying': return {
      headline: 'The provider is checking this order',
      detail: 'The provider holds the funds while it runs its own checks. It can ask you for identity documents. Silo cannot see that request or speed it up.',
      nextAction: `No action needed unless the provider asks you for something. If this takes longer than you expect, ${SUPPORT}.`,
      eta: 'The provider decides. It usually takes minutes, but it can take much longer.' };
    case 'provider-sending': return {
      headline: `The provider is sending your ${dst}`,
      detail: `The exchange is done and the provider is sending the ${dst} to your wallet.${destinationIsXmr ? ' Your wallet only counts it once the Monero network has confirmed it.' : ''}`,
      nextAction: 'No action needed. Silo checks the order again by itself.',
      eta: destinationIsXmr ? 'Usually a few minutes, then Monero confirmations. It can take longer.' : USUALLY_MINUTES };
    case 'payout-reported': {
      if (destinationIsXmr) return receiptConfirmed ? {
        headline: 'Your Monero wallet confirmed the XMR',
        detail: 'The provider said it sent the XMR and your own wallet confirmed that the full amount arrived.',
        nextAction: 'Nothing to do. You can start a new conversion.',
        eta: null } : {
        headline: 'The provider says it sent your XMR',
        detail: 'That is the provider’s word. Your own Monero wallet has not confirmed that it arrived.',
        nextAction: 'Tap Verify in your Monero wallet. If it says not found, sync the wallet and try again.',
        eta: 'Usually a few minutes after the provider sends, because Monero needs confirmations. It can take longer.' };
      return {
        headline: `The provider says it sent your ${dst}`,
        detail: 'That is the provider’s word. Silo is checking the Solana network itself before it calls this done.',
        nextAction: 'No action needed. Silo checks by itself.',
        eta: 'Usually a minute or two, but it can take longer.' };
    }
    case 'settled': return destinationIsXmr && !receiptConfirmed ? {
      headline: 'The provider reports this order finished',
      detail: 'Your own Monero wallet has not confirmed the XMR yet.',
      nextAction: 'Tap Verify in your Monero wallet. If it says not found, sync the wallet and try again.',
      eta: null } : {
      headline: 'Your conversion finished',
      detail: `The ${dst} arrived at your wallet and the network shows it.`,
      nextAction: 'Nothing to do. You can start a new conversion.',
      eta: null };
    case 'provider-failed': return {
      headline: 'The provider reports this order failed',
      detail: 'If you sent a deposit, the provider decides what happens to it. A refund is not guaranteed and Silo cannot start one. If you sent nothing, nothing left your wallet.',
      nextAction: `Tap Check order. If you sent funds, ${SUPPORT}.`,
      eta: 'The provider decides how long a refund takes, if there is one.' };
    case 'expired': return {
      headline: 'This order expired',
      detail: 'The provider reports no deposit arrived before the deadline. If you did not send anything, your funds are still in your wallet.',
      nextAction: `You can start a new conversion. If you did send funds to this order, ${SUPPORT}.`,
      eta: null };
    case 'refund-reported': return {
      headline: 'The provider says it refunded your deposit',
      detail: 'That is the provider’s word until the refund shows in your own wallet.',
      nextAction: `Check your wallet for the refund. If it does not show, ${SUPPORT}.`,
      eta: 'A refund can take longer than a payout. The provider decides.' };
    case 'refund-confirmed': return {
      headline: 'Your deposit was refunded',
      detail: 'The refund reached your wallet and the network shows it. The conversion did not happen.',
      nextAction: 'Nothing to do. You can start a new conversion.',
      eta: null };
    case 'provider-unknown': return {
      headline: 'The provider sent a status Silo does not recognise',
      detail: 'Silo keeps tracking the order and will not guess what the status means. Nothing moves from your wallet without your approval.',
      nextAction: `Tap Check order status again later. If it stays this way, ${SUPPORT}.`,
      eta: null };
    case 'wallet-retired': return {
      headline: 'This conversion was closed in this wallet',
      detail: 'Silo no longer follows it from here.',
      nextAction: `If you sent funds to this order, ${SUPPORT}.`,
      eta: null };
    case 'hidden': return {
      headline: 'Hidden from this screen',
      detail: 'Hiding only changes what you see. Silo still tracks and checks the order, and it comes back to the main screen if the provider shows a deposit.',
      nextAction: 'Open Past conversions to check it or show it again.',
      eta: null };
    default: return {
      headline: 'Not checked yet',
      detail: 'Silo has not heard from the provider about this order in this session. If you sent funds to it, they are still tracked.',
      nextAction: 'Tap Check order to see where it stands.',
      eta: null };
  }
}

/** Past conversions line: the support path for an order moved off the main screen. `orderId` is the provider's order id when this session has read it. */
export function convertPastSupportLine(orderId) {
  return typeof orderId === 'string' && orderId.length > 0 && orderId.length <= 128
    ? `Provider order id ${orderId}. To ask the provider about it, contact its support with this id.`
    : 'Check this order to see the provider’s order id, which its support needs.';
}
