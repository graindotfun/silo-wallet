'use client';
/** Silo's own error state (wallet at /app). Display only: the wallet and its backups live in the browser and are not touched by a view error. */
export default function SiloError({reset}:{error:Error&{digest?:string};reset:()=>void}){
 return <main className="silo-app exposure-shell" style={{minHeight:'100dvh',display:'grid',placeItems:'center',padding:'24px'}}>
  <div style={{maxWidth:420,display:'grid',gap:16}}>
   <h1 style={{margin:0,fontSize:40,lineHeight:'40px',letterSpacing:'-.05em'}}>something stopped<span style={{color:'var(--grain-orange)'}}>.</span></h1>
   <p style={{margin:0,fontSize:16,lineHeight:'24px'}}>Your wallet and backups are safe. They stay in this browser and this error did not touch them.</p>
   <button type="button" className="silo-primary" onClick={()=>reset()} style={{minHeight:48}}>Try again</button>
  </div>
 </main>;
}
