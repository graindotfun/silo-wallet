/** Load failures carry a coarse category for the UI: 'session' (the private origin refused this browser session), 'unreachable'
 * (network failure or a refused redirect; browsers do not tell them apart), 'unavailable' (any other HTTP failure), 'integrity'
 * (bytes differ from the pin), 'isolation' (the page is not cross-origin isolated). Every category still fails closed. */
export const siloLoadFailure=(message,category)=>Object.assign(Error(message),{siloLoad:category});
export const siloLoadCategory=error=>['session','unreachable','unavailable','integrity','isolation'].includes(error?.siloLoad)?error.siloLoad:null;

/** Same-origin pins detect unexpected bytes; they are not independent protection from a malicious origin. */
export async function pinnedSiloAsset(pin,fetcher=fetch){
 if(!pin||!/^\/silo-sdk\/[a-z0-9._/-]+$/.test(pin.url)||!/^[a-f0-9]{64}$/.test(pin.sha256)||!Number.isSafeInteger(pin.bytes)||pin.bytes<1||pin.bytes>64*1024*1024)throw Error('Invalid Silo SDK pin.');
 let response;try{response=await fetcher(pin.url,{cache:'no-store',credentials:'same-origin',redirect:'error',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(30000)});}catch{throw siloLoadFailure('Silo SDK unreachable.','unreachable');}
 if(!response.ok)throw siloLoadFailure('Silo SDK unavailable.',[401,403].includes(response.status)?'session':'unavailable');
 if(!response.body)throw siloLoadFailure('Silo SDK body unavailable.','unavailable');
 const reader=response.body.getReader(),bytes=new Uint8Array(pin.bytes);let offset=0;
 try{for(;;){let chunk;try{chunk=await reader.read();}catch{throw siloLoadFailure('Silo SDK unreachable.','unreachable');}const {done,value}=chunk;if(done)break;if(value.length>pin.bytes-offset)throw siloLoadFailure('Silo SDK length mismatch.','integrity');bytes.set(value,offset);offset+=value.length;}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 if(offset!==pin.bytes)throw siloLoadFailure('Silo SDK length mismatch.','integrity');
 const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));const actual=Array.from(digest,value=>value.toString(16).padStart(2,'0')).join('');if(actual!==pin.sha256)throw siloLoadFailure('Silo SDK integrity mismatch.','integrity');
 return bytes;
}

/** Reassembles individually pinned chunks to meet static hosting asset limits. */
export async function pinnedSiloWasm(pin,fetcher=fetch){
 if(!Number.isSafeInteger(pin?.bytes)||pin.bytes<1||pin.bytes>64*1024*1024||!Array.isArray(pin.chunks)||pin.chunks.length<1||pin.chunks.length>8)throw Error('Invalid WASM pin.');
 const bytes=new Uint8Array(pin.bytes);let offset=0;
 for(const chunk of pin.chunks){const part=await pinnedSiloAsset(chunk,fetcher);if(part.length>bytes.length-offset)throw siloLoadFailure('WASM length mismatch.','integrity');bytes.set(part,offset);offset+=part.length;}
 if(offset!==bytes.length)throw siloLoadFailure('WASM length mismatch.','integrity');
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');if(digest!==pin.sha256)throw siloLoadFailure('WASM integrity mismatch.','integrity');return bytes;
}
