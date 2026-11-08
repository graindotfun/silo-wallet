// SPDX-License-Identifier: AGPL-3.0-only
/** Streaming bound is enforced even when a peer omits or lies about Content-Length. */
export async function siloJson(response,maxBytes=512*1024){
 if(!response.body)throw Error('Node response unavailable.');const reader=response.body.getReader(),chunks=[];let length=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>maxBytes)throw Error('Node response exceeds wallet limit.');chunks.push(value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 const bytes=new Uint8Array(length);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}return JSON.parse(new TextDecoder().decode(bytes));
}
