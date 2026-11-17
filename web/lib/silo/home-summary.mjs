// Home headline and its private/public line (owner, 10 Nov 2026, direction C "plain ledger"). Display only: every number arrives
// already formatted from the Home screen's existing reads (siloUnits for balances, siloUsd over the display-only price estimate).
// Nothing here is used for an amount that is signed or sent.

/**
 * @param {{anyOpen:boolean,concealed:boolean,totalText:string|null}} input
 * @returns {string} the headline without its full stop (the screen adds the orange dot)
 */
export function siloHomeHeadline({anyOpen,concealed,totalText}){
 if(!anyOpen)return 'nothing is open yet';
 if(concealed)return 'you have ••••';
 // Qualified on purpose: the total only counts the wallets that loaded and is a display-only price estimate.
 return totalText?`about ${totalText} across what loaded`:'your balance';
}

/**
 * One sentence per room. A room with a known balance says how much is in it (with its estimate in dollars when there is one);
 * a room without one says why, in the words the caller passes (its existing status sentence).
 * @param {{concealed:boolean,xmr:{amount:string|null,usd:string|null,state:string},sol:{amount:string|null,usd:string|null,state:string}}} input
 */
export function siloHomeSplit({concealed,xmr,sol}){
 if(concealed&&(xmr.amount!==null||sol.amount!==null))return 'Private and public amounts are hidden.';
 const room=(part,unit,word)=>part.amount===null?part.state:part.usd?`${part.usd} is ${word} (${part.amount} ${unit}).`:`${part.amount} ${unit} is ${word}.`;
 return `${room(xmr,'XMR','private')} ${room(sol,'SOL','public')}`;
}
