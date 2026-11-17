// Presentation helpers for the No bridge amount field (both directions). They never touch a quote, a signature or an amount that
// is signed: the typed string goes to the maker's quote request exactly as before, as {xmr:<typed string>}.
export const ATOMIC_CHIP_AMOUNTS=['0.001','0.01','0.05'];
/** Same shape and same value both panels have always sent to /api/silo/atomic/quote and /rev-quote. */
export const atomicQuoteBody=amount=>({xmr:amount});
/** Quick amounts that fit under the beta cap (all of them when the cap is not known; the server still enforces it). */
export function atomicChipAmounts(capXmr){
 const cap=Number(capXmr);
 return ATOMIC_CHIP_AMOUNTS.filter(value=>!(typeof capXmr==='string'&&Number.isFinite(cap)&&cap>0)||Number(value)<=cap);
}
const SHAPE=/^\d{1,4}(\.\d{1,12})?$/;
/** True when a well-formed amount is above the beta cap. Advice only: the server still decides, and its message still shows. */
export function atomicOverCap(amount,capXmr){
 const cap=Number(capXmr);
 return typeof amount==='string'&&SHAPE.test(amount)&&typeof capXmr==='string'&&Number.isFinite(cap)&&cap>0&&Number(amount)>cap;
}
// lead = the one line that says what happens; safety = the one safety line; note = one short visible pointer to the condition folded under
import {REVERSE_IF_FAILS} from './atomic-reverse-terms.mjs';
// "How it works" (Astra M2, PR 730); line = the full timing text, shown under "How it works".
export const ATOMIC_DIRECTION_TEXT={
 'xmr-sol':{title:'Swap from XMR to SOL',lead:'Swap XMR for SOL directly, with no bridge and no account.',note:'Waiting for the timer alone does not return your XMR: finish or follow the steps shown.',line:'You send XMR from your Monero wallet and receive SOL in your Silo Solana wallet. Usually about 30 minutes after you confirm the payment while Silo stays open and unlocked; it can take longer. If you close Silo, return before the shown deadline and stay until the claim is observed; retry if needed.'},
 'sol-xmr':{title:'Swap from SOL to XMR',lead:'Swap SOL for XMR directly, with no bridge and no account.',safety:`${REVERSE_IF_FAILS} Silo needs this swap saved on this device or in a backup.`,note:'Network fee and refund timing: see How it works.',line:'You send SOL from your Silo wallet and receive XMR in your Monero wallet. Usually about 40 minutes while Silo stays open and your wallets remain available; it can take longer. You can close the page once your SOL shows as locked. Return before the shown deadline and stay until confirmation is observed; retry if needed.'}
};
