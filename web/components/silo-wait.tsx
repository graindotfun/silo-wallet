/** One shared waiting treatment for every in-progress Silo state (owner, 11 Nov 2026). Presentation only: markup, aria and CSS
 * (app/app/silo.css, "wait animations"). Orange, flat, no outline; a static orange bar under prefers-reduced-motion. */
export function SiloWaitBar(){
 return <span className="silo-wait-bar" data-silo-wait-bar="" aria-hidden="true"/>;
}
/** Orange pulse dot that sits beside a title while something is in progress. */
export function SiloWaitDot(){return <span className="silo-wait-dot" data-silo-wait-dot="" aria-hidden="true"/>;}
/** Text for screen readers only. */
export function SiloWaitStatus({children}:{children:string}){return <span className="silo-wait-vh" role="status">{children}</span>;}
/** Determinate confirmations bar: `target` equal segments, filled ones solid orange, the next unfilled one animated while waiting. */
export function SiloConfirmMeter({value,target,label,waiting=true,className='silo-wait-meter'}:{value:number;target:number;label:string;waiting?:boolean;className?:string}){
 const n=Math.max(0,Math.min(target,Math.floor(Number.isFinite(value)?value:0)));
 return <span className={className} data-silo-wait-meter="" role="progressbar" aria-valuemin={0} aria-valuemax={target} aria-valuenow={n} aria-label={label} aria-busy={waiting&&n<target?true:undefined}>
  {Array.from({length:target},(_,i)=><i key={i} data-on={i<n?'':undefined} data-now={waiting&&i===n?'':undefined}/>)}
 </span>;
}
