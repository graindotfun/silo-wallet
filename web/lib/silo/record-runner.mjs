// Polling pass over swap records. Ticks are non-reentrant PER RECORD (a record whose tick is still running is skipped), never global: a stuck record
// only holds its own next tick, every other record and every later timer pass keeps running.
export function createRecordRunner(){
 const running=new Set();
 /** @param {{swapId:string}[]} records  @param {(record:any)=>Promise<any>} tick  @param {(record:any,view:any)=>void} onView  @param {(record:any,error:unknown)=>void} onError */
 const runAll=(records,tick,onView,onError)=>Promise.all(records.filter(r=>!running.has(r.swapId)).map(async record=>{
  running.add(record.swapId);
  try{onView(record,await tick(record));}catch(error){onError(record,error);}
  finally{running.delete(record.swapId);}
 }));
 return Object.freeze({runAll,busy:id=>running.has(id)});
}
