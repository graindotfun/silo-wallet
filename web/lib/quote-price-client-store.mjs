/** One visibility-aware client subscription. Ref-counted cancellation never interrupts another consumer. */
export const EMPTY_QUOTE_PRICES=Object.freeze({prices:null,now:0,loading:false,error:false});
export function createQuotePriceStore({fetchImpl=(...args)=>fetch(...args),clock=()=>Date.now(),getDocument=()=>typeof document==='undefined'?null:document,timers=globalThis}={}){
 let snapshot=EMPTY_QUOTE_PRICES,interval=null,ageInterval=null,requestTimer=null,controller=null,inflight=null,generation=0;const listeners=new Set();
 const publish=next=>{snapshot=Object.freeze(next);for(const listener of listeners)listener();};
 const visible=()=>!getDocument()?.hidden;
 const armTimeout=fn=>(timers.setTimeout??globalThis.setTimeout)(fn,15000),disarmTimeout=id=>(timers.clearTimeout??globalThis.clearTimeout)(id);
 function cancel(){generation++;controller?.abort();if(requestTimer!==null)disarmTimeout(requestTimer);requestTimer=null;controller=null;inflight=null;}
 function stopInterval(){if(interval!==null)timers.clearInterval(interval);if(ageInterval!==null)timers.clearInterval(ageInterval);interval=null;ageInterval=null;}
 function startInterval(){stopInterval();if(listeners.size&&visible()){interval=timers.setInterval(()=>void refresh(),60000);ageInterval=timers.setInterval(()=>{if(listeners.size&&visible())publish({...snapshot,now:clock()});},1000);}}
 function refresh(){
  if(!listeners.size||!visible())return Promise.resolve();if(inflight)return inflight;
  const id=++generation,abort=new AbortController();controller=abort;publish({...snapshot,now:clock(),loading:true});
  const timeout=armTimeout(()=>{if(id!==generation)return;generation++;abort.abort();requestTimer=null;inflight=null;controller=null;publish({...snapshot,now:clock(),loading:false,error:true});});requestTimer=timeout;
  const task=Promise.resolve().then(async()=>{try{const response=await fetchImpl('/api/quote-prices',{cache:'no-store',signal:abort.signal});if(!response.ok)throw Error('Price unavailable');const prices=await response.json();if(!prices||typeof prices!=='object'||!Object.hasOwn(prices,'SOL')||!Object.hasOwn(prices,'wXMR'))throw Error('Price unavailable');if(id===generation&&!abort.signal.aborted&&listeners.size)publish({prices,now:clock(),loading:false,error:false});}catch{if(id===generation&&!abort.signal.aborted&&listeners.size)publish({...snapshot,now:clock(),loading:false,error:true});}finally{disarmTimeout(timeout);if(id===generation){requestTimer=null;inflight=null;controller=null;}}});inflight=task;return task;
 }
 const visibility=()=>{if(visible()){publish({...snapshot,now:clock(),loading:false});void refresh();startInterval();}else{stopInterval();cancel();publish({...snapshot,now:clock(),loading:false});}};
 return {getSnapshot:()=>snapshot,getServerSnapshot:()=>EMPTY_QUOTE_PRICES,refresh,subscribe(listener){listeners.add(listener);if(listeners.size===1){getDocument()?.addEventListener('visibilitychange',visibility);void refresh();startInterval();}return()=>{listeners.delete(listener);if(!listeners.size){stopInterval();cancel();getDocument()?.removeEventListener('visibilitychange',visibility);snapshot=Object.freeze({...snapshot,loading:false});}};}};
}
export const quotePriceClientStore=createQuotePriceStore();
