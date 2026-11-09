/** Read one request body under a total byte/deadline/abort bound.
 * Cleanup is best-effort and never part of the response's completion condition. */
export async function readBoundedRequestText(request,{maxBytes,timeoutMs=10000,allowEmpty=false,onIncompleteCleanup}={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>32*1024*1024||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('Invalid request read bounds.');
 if(request.signal?.aborted)throw Error('Request body cancelled.');
 const declared=request.headers.get('content-length');
 if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maxBytes))throw Error('Request is too large.');
 if(!request.body){if(allowEmpty)return '';throw Error('Request body is required.');}
 const reader=request.body.getReader(),started=performance.now();let bytes=new Uint8Array(Math.min(maxBytes,65536)),size=0,fragments=0,timer,abort,complete=false;
 const current=()=>{if(request.signal?.aborted)throw Error('Request body cancelled.');if(performance.now()-started>=timeoutMs)throw Error('Request body deadline exceeded.');};
 const stopped=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Request body deadline exceeded.')),timeoutMs);abort=()=>reject(Error('Request body cancelled.'));request.signal?.addEventListener('abort',abort,{once:true});if(request.signal?.aborted)abort();});
 try{
  for(;;){current();const {done,value}=await Promise.race([reader.read(),stopped]);current();if(done)break;
   if(++fragments>Math.min(65536,Math.max(64,maxBytes)))throw Error('Request body has too many fragments.');
   if(!(value instanceof Uint8Array))throw Error('Invalid request body chunk.');if(value.byteLength>maxBytes-size)throw Error('Request is too large.');
   if(size+value.byteLength>bytes.byteLength){const grown=new Uint8Array(Math.min(maxBytes,Math.max(size+value.byteLength,bytes.byteLength*2)));grown.set(bytes.subarray(0,size));bytes=grown;}
   bytes.set(value,size);size+=value.byteLength;
  }
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size));current();complete=true;return text;
 }finally{
  clearTimeout(timer);request.signal?.removeEventListener('abort',abort);
  if(!complete){let cleanup;try{cleanup=Promise.resolve(reader.cancel());}catch(error){cleanup=Promise.reject(error);}void cleanup.catch(()=>{});try{onIncompleteCleanup?.(cleanup);}catch{/* Observers cannot prolong refusal. */}}
  try{reader.releaseLock();}catch{/* A pending read is being cancelled. */}
 }
}
