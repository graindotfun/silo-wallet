'use client';
import {useState} from 'react';
import {SiloReceiveAddress} from './silo-receive-address';
import {ArrowUpRight,ShieldCheck} from 'lucide-react';
import {siloPrivateInLink,siloMoneroMainnetAddress,SILO_PRIVATE_IN_PROVIDER} from '@/lib/silo/move-private.mjs';
/** Prepare an XMR receive address for an external exchange. A fresh address does not guarantee unlinkability;
 * the selected provider can associate the public payment with this destination. */
export function SiloMovePrivate({network,busy,fresh,enabled=false}:{network:string;busy:boolean;enabled?:boolean;fresh:()=>Promise<string|null>}){
 const [prepared,setPrepared]=useState<string|null>(null);
 const mainnet=network==='mainnet',available=mainnet&&enabled;
 const [error,setError]=useState(''),[accepted,setAccepted]=useState(false);
 async function prepare(){if(!available||busy||!accepted)return;setError('');try{const address=await fresh();setPrepared(address&&siloMoneroMainnetAddress(address)?address:null);if(!address)setError('The address was not prepared. No external link is available.');}catch{setPrepared(null);setError('The address could not be saved. No external link is available.');}}
 return <section className="silo-inset silo-move-private" aria-label="Get XMR through an external exchange">
  <h3><ShieldCheck size={18} aria-hidden="true"/>Get XMR</h3>
  <p>Through an external exchange. Trocador helps you choose a provider that converts a supported asset into native XMR sent to this wallet. Your payment on a public network remains public, and the provider may link it to your XMR receiving address.</p>
  <p className="exposure-note">Opening the link shares this XMR address with Trocador. Trocador and the selected exchange may retain transaction and connection data. A refund is not guaranteed.</p>
  {!available?<p className="silo-empty">Planned. Requires an approved Monero mainnet wallet and checked backup; no exchange can pay stagenet XMR.</p>:prepared&&accepted?<a className="silo-button" data-variant="primary" href={siloPrivateInLink(prepared)} target="_blank" rel="noopener noreferrer" onClick={()=>setPrepared(null)}>Open {SILO_PRIVATE_IN_PROVIDER.name} with the new address<ArrowUpRight size={16} aria-hidden="true"/></a>:<button type="button" className="silo-primary" disabled={busy||!accepted} onClick={()=>void prepare()}>Create a new address for this exchange</button>}
  {available&&<label><input type="checkbox" checked={accepted} onChange={event=>{setAccepted(event.target.checked);setPrepared(null);}}/>I understand this opens an external exchange using real mainnet funds. The selected provider may hold funds, request identification, keep data, and does not guarantee a refund.</label>}
  {available&&accepted&&prepared&&<SiloReceiveAddress address={prepared} asset="XMR" network="mainnet" note="This destination was saved separately from your ordinary Receive address. Check it on the provider’s page before paying."/>}
  {error&&<p role="alert">{error}</p>}
  <p>Opening an external link does not create a Silo order. Save the provider’s order ID and use its support for order or refund questions.</p>
  <details><summary>Before you open the external exchange</summary><ul>
   <li>{SILO_PRIVATE_IN_PROVIDER.name} is an aggregator, not Grainpad. The selected exchange receives your payment and may hold funds, delay the exchange or request identification. Silo does not control the exchange or refunds.</li>
   <li>The link includes your XMR destination address. Opening it shares that address with Trocador; Trocador and the selected provider may retain transaction details and connection data, including your IP address.</li>
   <li>Review the supported coin and network, rate, fees, limits and refund terms on the provider&apos;s page before paying. Save your order ID. A fresh address does not guarantee that the exchange cannot associate your payments.</li>
   <li>Check that the destination shown on their page matches the new address shown in this wallet before you pay.</li>
   <li>To go back to Solana, start an exchange to your Solana address on their page and send XMR from Silo to the deposit address they give you.</li>
  </ul></details>
 </section>;
}
