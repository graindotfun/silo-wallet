import {isPreviousOfficialMint} from './previous-official-mints.mjs';
/** Pending pages observe publication; this never publishes or requests a wallet. */
export function watchOfficialContract({onResult=(result)=>{void result;},fetchImpl=fetch,visibility=globalThis.document,focus=globalThis.window,interval=setInterval,cancelInterval=clearInterval}={}){
 const abort=new AbortController();let busy=false,stopped=false;
 let timer;
 const refresh=async()=>{
  if(stopped||busy||visibility?.visibilityState==='hidden')return;
  busy=true;
  try{
   const response=await fetchImpl('/api/token',{cache:'no-store',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(12000)])});
   if(!response.ok)throw Error('Official record unavailable.');
   const data=await response.json();
   if(data.network!=='mainnet-beta'||data.generation!==2||(data.token!==null&&(!data.token||data.token.generation!==2||!(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).test(data.token.mint??'')||isPreviousOfficialMint(data.token.mint))))throw Error('Official identity mismatch.');
   if(stopped)return;
   const verified=Boolean(data.token);
   onResult({mint:data.token?.mint??null,state:verified?'verified':'pending'});
  }catch{if(!stopped)onResult({mint:null,state:'unavailable'});}
  finally{busy=false;}
 };
 timer=interval(refresh,15000);visibility?.addEventListener('visibilitychange',refresh);focus?.addEventListener('focus',refresh);void refresh();
 return ()=>{stopped=true;abort.abort();cancelInterval(timer);visibility?.removeEventListener('visibilitychange',refresh);focus?.removeEventListener('focus',refresh);};
}
