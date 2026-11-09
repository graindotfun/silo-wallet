/** Prevent two tabs from editing or spending from the same encrypted wallet concurrently. */
export async function acquireSiloSession(zone,network,locks=globalThis.navigator?.locks){
 if(!locks?.request)throw Error('This browser cannot establish exclusive wallet ownership.');
 let release;
 const untilReleased=new Promise(resolve=>{release=resolve;});
 return new Promise((resolve,reject)=>{
  locks.request(`grain-silo:${zone}:${network}`,{mode:'exclusive',ifAvailable:true},async lock=>{
   if(!lock){reject(Error('This wallet is already open in another tab.'));return;}
   resolve(()=>release());await untilReleased;
  }).catch(()=>reject(Error('Exclusive wallet session unavailable.')));
 });
}
