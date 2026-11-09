'use client';
import {useMemo,useState} from 'react';
import {SiloAddressText} from './silo-address-text';
import {Check,Copy} from 'lucide-react';
import {siloReceiveQr} from '@/lib/silo/receive-qr.mjs';
export function SiloReceiveAddress({address,asset,network,note}:{address:string;asset:string;network:string;note?:string}){
 const qr=useMemo(()=>{try{return siloReceiveQr(address);}catch{return null;}},[address]);
 const [copied,setCopied]=useState(false),[copyError,setCopyError]=useState(false);
 async function copy(){try{await navigator.clipboard.writeText(address);setCopied(true);setCopyError(false);}catch{setCopied(false);setCopyError(true);}}
 return <section className="silo-receive" aria-label={`${asset} receive address`}>
  <p>Receive {asset} · {network}</p>
  {qr&&<div className="silo-qr-tile"><svg role="img" aria-label={`${asset} receive address QR code`} width="176" height="176" viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges"><rect width={qr.size} height={qr.size} fill="white"/><path d={qr.path} fill="black"/></svg></div>}
  <SiloAddressText address={address}/>
  <button type="button" onClick={()=>void copy()}>{copied?<Check size={17} aria-hidden="true"/>:<Copy size={17} aria-hidden="true"/>}{copied?'Address copied':'Copy receive address'}</button><span className="sr-only" role="status">{copied?'Receive address copied to the clipboard.':''}</span>
  {copyError&&<p role="status">Copy is unavailable. Select and copy the address above.</p>}
  {note&&<p className="exposure-note" role="note">{note}</p>}
  <p className="exposure-note">Use only the displayed network. This QR contains the receive address; scanning it does not send a payment.</p>
 </section>;
}
