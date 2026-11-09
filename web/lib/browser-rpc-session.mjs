let expires=0,pending=null;
const genesis=new Map();
export async function sessionRpcFetch(input,init,retried=false,assertCurrent=()=>{}){
 if(typeof assertCurrent!=='function')throw Error('Current request capability is required.');
 const current=()=>{assertCurrent();init?.signal?.throwIfAborted();};
 current();
 const sessionPath=new URL(String(input),'https://session.local').pathname.startsWith('/api/silo/')?'/api/silo/session':'/api/rpc-session';
 if(Date.now()>=expires){
  if(!pending)pending=fetch(sessionPath,{method:'POST',credentials:'same-origin'}).then(async r=>{
   // A closed-beta refusal of the session itself (409 {status:'refused',error,refusal}) is rethrown typed, so the flows and
   // screens report "refused" and never an uncertain submission (round 10). Any other failure stays the generic error.
   if(r.status===409){let body=null;try{body=JSON.parse(await r.text());}catch{}
    if(body?.status==='refused')throw Object.assign(Error(typeof body.error==='string'?body.error:'Beta invitation required.'),{siloBetaRefusal:true,preDispatchRefusal:true,code:typeof body.refusal==='string'?body.refusal:'invite-required'});
    throw Error('Trading connection is unavailable. Please retry shortly.');}
   const ok=r.ok;await r.body?.cancel().catch(()=>{});if(!ok)throw Error('Trading connection is unavailable. Please retry shortly.');expires=Date.now()+480_000;}).finally(()=>{pending=null;});
  await pending;
  current();
 }
 const body=typeof init?.body==='string'?JSON.parse(init.body):null;
 const url=String(input),cached=genesis.get(url);
 if(body?.method==='getGenesisHash'&&cached&&cached.expires>Date.now())return Response.json({...cached.value,id:body.id});
 current();
 const response=await fetch(input,{...init,credentials:'same-origin'});
 try{current();}catch(error){void response.body?.cancel().catch(()=>{});throw error;}
 // 403 is emitted before any upstream request. Renew once; identical signed bytes are retained.
 if(response.status===403&&!retried){expires=0;await response.body?.cancel();current();return sessionRpcFetch(input,init,true,assertCurrent);}
 if(body?.method==='getGenesisHash'&&response.ok){const value=await response.clone().json();current();if(typeof value.result==='string'&&!value.error)genesis.set(url,{value,expires:Date.now()+60_000});}
 current();
 return response;
}
