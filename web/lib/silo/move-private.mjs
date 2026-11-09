/** Get XMR is an external link, not integrated swap execution. Silo prepares a fresh Monero mainnet address,
 * then the browser can open Trocador AnonPay. The URL carries the address plus XMR/mainnet selectors;
 * it includes no amount or affiliate code. Opening it shares the destination with the external service.
 * The selected exchange receives funds and controls its custody, identification and refund process. */
const MONERO_MAINNET=/^[48][1-9A-HJ-NP-Za-km-z]{94}$/;
export const SILO_PRIVATE_IN_PROVIDER=Object.freeze({name:'Trocador',origin:'https://trocador.app'});
export function siloMoneroMainnetAddress(value){return typeof value==='string'&&MONERO_MAINNET.test(value);}
/** AnonPay link that delivers XMR to `address`. Throws unless it is a standard or subaddress Monero mainnet address. */
export function siloPrivateInLink(address){
 if(!siloMoneroMainnetAddress(address))throw Error('A Monero mainnet receive address is required.');
 const url=new URL('/anonpay/',SILO_PRIVATE_IN_PROVIDER.origin);
 url.searchParams.set('ticker_to','xmr');url.searchParams.set('network_to','Mainnet');url.searchParams.set('address',address);
 return url.href;
}
