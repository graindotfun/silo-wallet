import manifest from './xmr-sdk-manifest.json' with {type:'json'};
import {pinnedSiloAsset} from './integrity.mjs';
let xmrLoading;
/** SRI checks the executed module; worker bytes are hashed before becoming an isolated blob. */
export function loadXmrBrowserSdk(releaseReady=false){
 if(!['localhost','127.0.0.1','[::1]'].includes(location.hostname)&&!releaseReady)throw Error('Wallet research is restricted to a local test origin.');
 return xmrLoading??=(async()=>{
  const workerBytes=await pinnedSiloAsset(manifest.worker);
  const sdk=await new Promise((resolve,reject)=>{
   const script=document.createElement('script');script.type='module';script.src=manifest.module.url;
   script.integrity='sha256-'+btoa(String.fromCharCode(...Uint8Array.from(manifest.module.sha256.match(/../g),value=>parseInt(value,16))));script.crossOrigin='anonymous';script.referrerPolicy='no-referrer';
   script.onload=()=>globalThis.GrainSiloXmrSdk?resolve(globalThis.GrainSiloXmrSdk):reject(Error('Wallet SDK initialization failed.'));
   script.onerror=()=>reject(Error('Wallet SDK integrity or loading failed.'));document.head.append(script);
  });
  sdk.LibraryUtils.setWorkerLoader(()=>{const url=URL.createObjectURL(new Blob([workerBytes],{type:'text/javascript'}));const worker=new Worker(url);URL.revokeObjectURL(url);return worker;});
  return sdk;
 })().catch(error=>{xmrLoading=null;throw error;});
}
