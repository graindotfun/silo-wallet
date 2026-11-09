import {PublicKey,VersionedTransaction} from '@solana/web3.js';
const CHAIN='solana:mainnet';
const sameBytes=(a,b)=>a?.length===b?.length&&a.every((v,i)=>v===b[i]);
const legacyCache=new WeakMap(),standardCache=new WeakMap();
function guardedWallet({connect,disconnect,account,subscribe,signMessage,signTransaction}){
 let key=null,identity=null,revision=0;
 const listeners=new Map();
 const emit=event=>{for(const handler of listeners.get(event)||[])handler();};
 const invalidate=event=>{key=null;identity=null;revision++;emit(event);};
 subscribe(event=>{if(identity)invalidate(event);});
 const check=(before,version)=>{if(!identity||identity!==before||revision!==version||account()?.address!==before)throw Error('Wallet account changed or disconnected. Reconnect and review again. Nothing was submitted.');};
 return {
  get publicKey(){return key;},
  async connect(options){if(identity)invalidate('accountChanged');key=null;identity=null;revision++;const version=revision;await connect(options);const next=account();if(!next?.address)throw Error('Wallet did not provide a compatible Solana account.');if(revision!==version)throw Error('Wallet changed during connection. Choose it again.');key=new PublicKey(next.address);identity=next.address;emit('connect');return {publicKey:key};},
  invalidateSession(){invalidate('disconnect');},
  async disconnect(){invalidate('disconnect');await disconnect?.();},
  async signMessage(message,encoding){const before=identity,version=revision;check(before,version);if(!signMessage)throw Error('Selected wallet does not support message signing.');const result=await signMessage(message,encoding);check(before,version);return result;},
  async signTransaction(transaction){const before=identity,version=revision;check(before,version);if(!signTransaction)throw Error('Selected wallet does not support versioned transaction signing.');const result=await signTransaction(transaction);check(before,version);return result;},
  on(event,handler){if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event).add(handler);},
  removeListener(event,handler){listeners.get(event)?.delete(handler);},
 };
}
export function legacyWallet(raw){
 if(legacyCache.has(raw))return legacyCache.get(raw);
 const wallet=guardedWallet({
  connect:options=>raw.connect(options?.silent?{onlyIfTrusted:true}:undefined),disconnect:()=>raw.disconnect?.(),
  account:()=>raw.publicKey?{address:raw.publicKey.toBase58()}:null,
  subscribe:callback=>{raw.on?.('accountChanged',()=>callback('accountChanged'));raw.on?.('disconnect',()=>callback('disconnect'));},
  signMessage:typeof raw.signMessage==='function'?(m,e)=>raw.signMessage(m,e):null,
  signTransaction:typeof raw.signTransaction==='function'?t=>raw.signTransaction(t):null,
 });legacyCache.set(raw,wallet);return wallet;
}
export function standardCapabilities(raw){
 const features=raw?.features||{};
 return {connect:typeof features['standard:connect']?.connect==='function',events:typeof features['standard:events']?.on==='function',signMessage:typeof features['solana:signMessage']?.signMessage==='function',signTransaction:typeof features['solana:signTransaction']?.signTransaction==='function'&&features['solana:signTransaction'].supportedTransactionVersions?.includes(0)};
}
export function standardWallet(raw){
 if(standardCache.has(raw))return standardCache.get(raw);
 const features=raw.features,caps=standardCapabilities(raw);
 let selected=null;
 const eligible=a=>a.chains?.includes(CHAIN)&&a.features?.includes('solana:signMessage')&&a.features?.includes('solana:signTransaction');
 const wallet=guardedWallet({
  connect:async options=>{const result=await features['standard:connect'].connect(options?.silent?{silent:true}:undefined);const accounts=result?.accounts||raw.accounts;selected=accounts?.find(eligible)||null;},
  disconnect:async()=>{selected=null;await features['standard:disconnect']?.disconnect();},
  account:()=>selected&&raw.accounts.some(a=>a.address===selected.address&&eligible(a))?selected:null,
  subscribe:callback=>features['standard:events'].on('change',change=>{if(!selected)return;const accounts=change.accounts||raw.accounts,next=accounts?.find(eligible),c=standardCapabilities(raw);if(next?.address!==selected.address||!c.signMessage||!c.signTransaction||!raw.chains.includes(CHAIN)){selected=null;callback(accounts?.length===0?'disconnect':'accountChanged');}}),
  signMessage:caps.signMessage?async message=>{const [result]=await features['solana:signMessage'].signMessage({account:selected,message});if(!result||!sameBytes(result.signedMessage,message)||result.signature?.length!==64)throw Error('Wallet returned a different message or invalid signature.');return new Uint8Array(result.signature);}:null,
  signTransaction:caps.signTransaction?async transaction=>{const [result]=await features['solana:signTransaction'].signTransaction({account:selected,chain:CHAIN,transaction:transaction.serialize()});if(!result?.signedTransaction)throw Error('Wallet returned no signed transaction.');return VersionedTransaction.deserialize(result.signedTransaction);}:null,
 });standardCache.set(raw,wallet);return wallet;
}
/** Display-only icon a Standard wallet reports about itself. Only inert image data URIs are kept. */
export function walletIcon(icon){
 return typeof icon==='string'&&icon.length<=200000&&/^data:image\/(svg\+xml|png|webp|jpeg|gif)[;,]/.test(icon)?icon:null;
}
/** Marks the provider object captured at discovery. Signing must use this object, not a later window.solana. */
export const WALLET_PROVIDER_IDENTITY=Symbol.for('grainpad.walletProvider');
function stampProvider(wallet,name,raw){wallet[WALLET_PROVIDER_IDENTITY]={name,raw};return wallet;}
/** Installed providers only. Never auto-select or fall back to a different wallet.
 * Phantom is window.phantom.solana. window.solana is a separate choice because other extensions replace it. */
export function discoverWalletProviders(surface={},registered=[]){
 const list=[],raws=new Set(),labels=new Map();
 // A Standard name is a self-reported display string, not a verified brand identity.
 // Keep known injection separate; deduplicate only the exact same provider object.
 for(const [name,raw] of [['Phantom',surface.phantom?.solana],['Solflare',surface.solflare],['Browser wallet',surface.solana]]){
  if(!raw||raws.has(raw)||typeof raw.connect!=='function'||typeof raw.signMessage!=='function'||typeof raw.signTransaction!=='function'||typeof raw.on!=='function')continue;
  raws.add(raw);list.push({name,brand:name,kind:'injected',icon:null,wallet:stampProvider(legacyWallet(raw),name,raw)});
 }
 for(const raw of registered){const c=standardCapabilities(raw);if(raws.has(raw)||!raw.chains?.includes(CHAIN)||!c.connect||!c.events||!c.signMessage||!c.signTransaction)continue;
  raws.add(raw);const claimed=String(raw.name||'Unnamed wallet').slice(0,80),label=`${claimed} · Wallet Standard`,count=(labels.get(label)||0)+1;labels.set(label,count);
  const name=count===1?label:`${label} (${count})`;
  list.push({name,brand:claimed,kind:'standard',icon:walletIcon(raw.icon),wallet:stampProvider(standardWallet(raw),name,raw)});
 }
 return list.sort((a,b)=>{const rank=n=>n==='Phantom'?0:n==='Solflare'?1:2;return rank(a.name)-rank(b.name)||a.name.localeCompare(b.name);});
}
