import manifest from './zec-sdk-manifest.json' with {type:'json'};
import {pinnedSiloAsset,pinnedSiloWasm,siloLoadFailure} from './integrity.mjs';
let loading;
/** The ZEC core (vendor/silo/zec-core: upstream zcash_client_backend / zcash_client_sqlite) runs in a dedicated module worker,
 * because upstream scanning blocks on channels, which the page's main thread may not do. The executed code is the verified
 * bundle itself: its bytes are fetched once, checked against the pin, and the worker (and its scanning/proving workers) start
 * from a blob URL made from those bytes. The WASM is instantiated from verified bytes. No wallet code is fetched again by URL.
 * Origin compromise remains a release threat: an origin that serves this page can also serve a different manifest.
 * Returns {engine, open()}: each open() starts one engine worker for one wallet; terminate() ends it. */
export function loadZecBrowserSdk(releaseReady=false,{fetcher=fetch,objectUrl=bytes=>URL.createObjectURL(new Blob([bytes],{type:'text/javascript'})),spawn=url=>new Worker(url,{type:'module',name:'silo-zec-engine'}),threads=1}={}){
 if(!['localhost','127.0.0.1','[::1]'].includes(location.hostname)&&!releaseReady)throw Error('Wallet release review is required for this origin.');
 if(!crossOriginIsolated)throw siloLoadFailure('Wallet WASM requires a reviewed cross-origin-isolated origin.','isolation');
 return loading??=(async()=>{
  if(manifest.assets.some(row=>row.url.endsWith('.js')&&row.url!==manifest.module.url))throw Error('Wallet SDK manifest lists unverified modules.');
  const [code,wasm]=await Promise.all([pinnedSiloAsset(manifest.module,fetcher),pinnedSiloWasm(manifest.wasm,fetcher)]);
  // The blob URL stays alive for the page lifetime: every engine and its workers start from it.
  const url=objectUrl(code);
  return Object.freeze({engine:manifest.engine,open:async()=>{const engine=zecEngine(spawn(url));try{await engine.call('boot',{wasm:wasm.slice(),threads});}catch(error){engine.terminate();throw error;}return engine;}});
 })().catch(error=>{loading=null;throw error;});
}
/** Request/response over one engine worker. A worker failure rejects every outstanding and later request. */
export function zecEngine(worker){
 let next=0,ended=false;const pending=new Map();
 const fail=error=>{for(const {reject} of pending.values())reject(error);pending.clear();};
 worker.addEventListener('message',({data})=>{if(data?.silo!=='zec-core')return;const request=pending.get(data.id);if(!request)return;pending.delete(data.id);if(data.ok)request.resolve(data.value);else request.reject(Error(data.error));});
 worker.addEventListener('error',event=>{event.preventDefault?.();ended=true;fail(Error('Wallet engine stopped.'));});
 return Object.freeze({
  call:(op,args)=>new Promise((resolve,reject)=>{if(ended){reject(Error('Wallet engine stopped.'));return;}const id=++next;pending.set(id,{resolve,reject});worker.postMessage({silo:'zec-core',id,op,args});}),
  terminate(){ended=true;fail(Error('Wallet engine stopped.'));worker.terminate();},
 });
}
