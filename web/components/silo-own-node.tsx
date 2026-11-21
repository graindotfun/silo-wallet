'use client';
import {useEffect,useState} from 'react';
import {SiloWaitBar,SiloWaitStatus} from './silo-wait';
import {SILO_OWN_NODE_COPY as COPY,chooseXmrNode,loadOwnNode,nodeInUseLine,saveOwnNode,clearOwnNode,testOwnNode,siloOwnNodeEnabled,normalizeOwnNode} from '@/lib/silo/own-node.mjs';

type Line={ok:boolean;text:string};
/** The saved choice for this device, read in an effect after mount (never during render, so server and client first paint match). Nothing here leaves the device. */
export function useSiloOwnNode(configured:string,zone:string){
 const enabled=siloOwnNodeEnabled()&&zone==='xmr';
 const [own,setOwn]=useState<string|null>(null);
 useEffect(()=>{if(enabled)setOwn(loadOwnNode());},[enabled]);
 const [useSiloNow,setUseSiloNow]=useState(false),[failed,setFailed]=useState(false);
 const choice=chooseXmrNode({configured,own,enabled,useSiloForNow:useSiloNow});
 return {enabled,own,choice,failed,setFailed,
  save:(address:string)=>{const uri=saveOwnNode(address);setOwn(uri);setUseSiloNow(false);setFailed(false);return uri;},
  remove:()=>{clearOwnNode();setOwn(null);setUseSiloNow(false);setFailed(false);},
  useSiloForNow:()=>{setUseSiloNow(true);setFailed(false);}};
}

/** Monero node settings: which node is in use is always shown; an own node needs a passing test before Save; a failing own node
 * stops the wallet and offers one explicit button, never an automatic switch to Silo's node. */
export function SiloOwnNodePanel({state,network,silo,busy}:{state:ReturnType<typeof useSiloOwnNode>;network:string;silo:string;busy:boolean}){
 const [mode,setMode]=useState<'silo'|'own'>(state.own?'own':'silo'),[draft,setDraft]=useState(state.own??''),[lines,setLines]=useState<Line[]|null>(null),[passed,setPassed]=useState<string|null>(null),[testing,setTesting]=useState(false),[how,setHow]=useState(false),[copied,setCopied]=useState(false);
 const choosing=mode==='own';
 async function run(){setTesting(true);setLines(null);setPassed(null);try{const result=await testOwnNode({address:draft,network,silo});setLines(result.lines);setPassed(result.ok?result.uri:null);}finally{setTesting(false);}}
 return <section className="silo-review silo-node" aria-labelledby="silo-node-title" data-silo-own-node="">
  <h4 id="silo-node-title">{COPY.heading}</h4>
  <p className="silo-hint" role="status" data-silo-node-in-use="">{nodeInUseLine(state.choice)}</p>
  {state.failed&&<div role="alert" className="silo-review"><p>{COPY.failure}</p><button type="button" className="silo-primary" disabled={busy} onClick={()=>{state.useSiloForNow();setMode('silo');}}>{COPY.useSilo}</button></div>}
  <div className="silo-fields" role="radiogroup" aria-label={COPY.heading}>
   <label><input type="radio" name="silo-node-choice" checked={mode==='silo'} disabled={busy} onChange={()=>{setMode('silo');if(state.own)state.remove();}}/> Silo&apos;s node (default)<span className="exposure-note">{COPY.silo}</span></label>
   <label><input type="radio" name="silo-node-choice" checked={choosing} disabled={busy} onChange={()=>setMode('own')}/> My own node<span className="exposure-note">{COPY.own}</span></label>
  </div>
  {choosing&&<div className="silo-fields">
   <label>Node address<input value={draft} inputMode="url" onChange={event=>{setDraft(event.target.value);setLines(null);setPassed(null);}} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="https://node.example.com:18081" disabled={busy||testing}/></label>
   <div className="exposure-actions">
    <button type="button" disabled={busy||testing||!draft.trim()} onClick={()=>void run()}>Test</button>
    <button type="button" className="silo-primary" disabled={busy||testing||!passed||passed!==normalizeOwnNode(draft)} onClick={()=>{try{state.save(draft);}catch{setLines([{ok:false,text:'Could not save the address.'}]);}}}>Save</button>
   </div>
   {testing&&<p className="silo-hint" role="status"><SiloWaitBar/><SiloWaitStatus>Testing your node</SiloWaitStatus>Testing your node...</p>}
   {lines&&<ul className="silo-node-checks" aria-label="Node test">{lines.map((line,index)=><li key={index}><span aria-hidden="true">{line.ok?'✓':'✗'}</span> <span className="silo-wait-vh">{line.ok?'Passed: ':'Failed: '}</span>{line.text}</li>)}</ul>}
  </div>}
  <button type="button" className="silo-textlink" aria-expanded={how} onClick={()=>setHow(!how)}>{COPY.howTitle}</button>
  {how&&<div className="silo-review"><ol>{COPY.how.map(step=><li key={step}>{step}</li>)}</ol>
   <button type="button" onClick={()=>{void navigator.clipboard?.writeText('--rpc-access-control-origins https://silo.trading').then(()=>setCopied(true)).catch(()=>{});}}>{copied?'Copied':'Copy the origin flag'}</button></div>}
 </section>;
}
