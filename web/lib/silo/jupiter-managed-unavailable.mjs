/** Fixed display reasons for validated preparation refusals only.
 * Neither a reason nor an Error grants execution or retires a pending record. */
const messages=Object.freeze({
 'unsupported-contract':'Silo cannot swap this token or transaction contract. Choose a supported token. Nothing was signed or submitted.',
 'route-unavailable':'Jupiter did not provide an executable route for this request. You can request a fresh review. Nothing was signed or submitted.',
 'insufficient-input':'Jupiter could quote a price but could not build this swap because the input balance is insufficient. Nothing was signed or submitted.',
 'trade-too-large':'This swap is above the beta limit per trade. Choose a smaller amount. Nothing was signed or submitted.',
 'price-impact-too-high':'The price impact of this swap is too high (10% or more). Choose a smaller amount or a more liquid token. Nothing was signed or submitted.',
 'value-unavailable':'Silo could not confirm the dollar value and price impact of this swap, which the beta limits require. Nothing was signed or submitted.',
 'insufficient-gas':'Jupiter could quote a price but could not build this swap because SOL for network costs is insufficient. Nothing was signed or submitted.',
});
export class SiloManagedPreparationUnavailable extends Error{constructor(code){if(!Object.hasOwn(messages,code))throw Error('Unknown preparation refusal.');super(messages[code]);this.name='SiloManagedPreparationUnavailable';this.code=code;}}
export function siloManagedPreparationMessage(code){return Object.hasOwn(messages,code)?messages[code]:null;}
export function assertSiloManagedOrderExecutable(capture){
 if(capture.originalTransaction){if(capture.heldReason!=='common-transaction-review-required'||capture.router!=='metis'||capture.gasless)throw new SiloManagedPreparationUnavailable('unsupported-contract');return;}
 // Match router plus code as required by the official provider contract.
 if(capture.originalTransaction===''&&capture.router==='metis'&&capture.errorCode===1)throw new SiloManagedPreparationUnavailable('insufficient-input');
 if(capture.originalTransaction===''&&capture.router==='metis'&&capture.errorCode===2)throw new SiloManagedPreparationUnavailable('insufficient-gas');
 throw new SiloManagedPreparationUnavailable('route-unavailable');
}
