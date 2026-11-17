// Checks that the browser files served at https://silo.trading/app are the files a published build manifest lists.
// Node 22 or later, no packages. Read docs/silo-trust/VERIFY_SERVED_CODE.md for what this proves and what it does not.
//
//   node scripts/silo/verify-silo.mjs [--origin https://silo.trading] [--manifest file | --manifest-url url]
//                                     [--retained public/client-assets-compatibility.json] [--dist dist/client] [--json]
//
// Exit code: 0 every served file has a verdict of match or retained-prior-build, 1 at least one mismatch or file without
// a manifest entry (or the manifest is for another commit), 2 usage error or the manifest could not be loaded.
import {createHash} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const STATIC=/^\/(?:_next\/static\/|fonts\/|brand\/|silo-icons\/|silo-sdk\/|assets\/)|^\/(?:theme-init|kernel)\.js$/;
export const DEFAULT_MANIFEST_URL=commit=>`https://raw.githubusercontent.com/graindotfun/silo-wallet/main/docs/verify-app/build-manifest-${commit}.json`;

/** The build commit the document names (the footer shows "build · <12 hex>" with the full id in its title). */
export function commitFromDocument(html){
 const m=/build\s*(?:·|&#xB7;|&middot;)[^]{0,80}?|title(?:\\")?[=:]\\?"([a-f0-9]{40})/.exec(html);
 const t=/title(?:=|\\":)\\?"([a-f0-9]{40})\\?"[^]{0,120}build/.exec(html);
 return (t&&t[1])||(m&&m[1])||null;
}

export function staticRefs(text,basePath,origin){
 const out=new Set();
 const add=raw=>{
  if(!raw||raw.startsWith('data:')||raw.startsWith('blob:'))return;
  let u;try{u=new URL(raw,new URL(basePath,origin));}catch{return;}
  if(u.origin!==new URL(origin).origin)return;
  if(STATIC.test(u.pathname))out.add(u.pathname);
 };
 for(const m of text.matchAll(/["'`(\s,](\/(?:_next\/static|fonts|brand|silo-icons|silo-sdk|assets)\/[A-Za-z0-9_.\/-]+)/g))add(m[1]);
 for(const m of text.matchAll(/["'`](_next\/static\/[A-Za-z0-9_.\/-]+)["'`]/g))add('/'+m[1]);
 for(const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'`](\.{1,2}\/[^"'`\s]+)["'`]/g))add(m[1]);
 for(const m of text.matchAll(/new URL\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url\s*\)/g))add(m[1]);
 for(const m of text.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/g))add(m[1]);
 for(const m of text.matchAll(/(?:src|href)="(\/(?:theme-init|kernel)\.js)"/g))add(m[1]);
 return out;
}

/** Fetch the document and every static file it reaches. `get(path)` returns {status, body:Buffer}. */
export async function crawl(origin,pages,get){
 const served=new Map(),queue=[],documents=[];let commit=null;
 for(const page of pages){
  const doc=await get(page);documents.push({page,status:doc.status});
  if(doc.status!==200)continue;
  const text=doc.body.toString('utf8');commit=commit??commitFromDocument(text);
  for(const p of staticRefs(text,page,origin))queue.push(p);
 }
 while(queue.length){
  const path=queue.shift();if(served.has(path))continue;
  const r=await get(path);
  served.set(path,{status:r.status,sha256:r.status===200?sha256(r.body):null,bytes:r.body.length});
  if(r.status===200&&/\.(m?js|css)$/.test(path))for(const p of staticRefs(r.body.toString('utf8'),path,origin))if(!served.has(p))queue.push(p);
 }
 return {commit,documents,served};
}

/** One verdict per served file. manifest: silo-build-manifest/1. retained: {path: sha256} from the committed inventory. */
export function judge({served,manifest,retained={},dist=null}){
 const rows=[];
 for(const [path,s] of [...served].sort(([a],[b])=>a<b?-1:1)){
  const row={path,status:s.status,served:s.sha256};
  if(s.status!==200){row.verdict='referenced-not-served';rows.push(row);continue;}
  const entry=manifest.files[path];
  if(entry)row.verdict=entry.sha256===s.sha256?'match':'mismatch';
  else if(retained[path]!==undefined)row.verdict=retained[path]===s.sha256?'retained-prior-build':'mismatch';
  else row.verdict='not-in-manifest';
  if(dist){
   const f=join(dist,path);
   row.rebuilt=existsSync(f)?sha256(readFileSync(f)):null;
   if(row.verdict==='match'&&row.rebuilt!==s.sha256)row.verdict='mismatch';
  }
  rows.push(row);
 }
 return rows;
}
export const FAILING=new Set(['mismatch','not-in-manifest']);

async function main(){
 const args=process.argv.slice(2),opt={origin:'https://silo.trading',pages:[]};
 const usage=m=>{console.error(m);process.exit(2);};
 for(let i=0;i<args.length;i++){
  const a=args[i],next=()=>args[++i]??usage('missing value for '+a);
  if(a==='--origin')opt.origin=next().replace(/\/+$/,'');else if(a==='--page')opt.pages.push(next());
  else if(a==='--manifest')opt.manifest=next();else if(a==='--manifest-url')opt.manifestUrl=next();
  else if(a==='--retained')opt.retained=next();else if(a==='--dist')opt.dist=next();else if(a==='--json')opt.json=true;
  else usage('unknown argument '+a);
 }
 if(!opt.pages.length)opt.pages=['/app'];
 const get=async path=>{const res=await fetch(new URL(path,opt.origin),{redirect:'manual'});return {status:res.status,body:Buffer.from(await res.arrayBuffer())};};
 const {commit,documents,served}=await crawl(opt.origin,opt.pages,get);
 if(documents.some(d=>d.status!==200))usage('The document did not answer 200: '+JSON.stringify(documents));
 if(!commit)usage('The document does not name a build commit; nothing to compare against.');
 let manifest;
 try{
  manifest=opt.manifest?JSON.parse(readFileSync(opt.manifest,'utf8')):await (async()=>{const r=await fetch(opt.manifestUrl??DEFAULT_MANIFEST_URL(commit));if(r.status!==200)throw Error('HTTP '+r.status);return r.json();})();
 }catch(e){console.error(`No manifest for commit ${commit}: ${e.message}. Result: NOT VERIFIED (nothing published to compare with).`);process.exit(2);}
 if(manifest.schema!=='silo-build-manifest/1')usage('Unknown manifest schema.');
 const retained={};
 if(opt.retained)for(const f of JSON.parse(readFileSync(opt.retained,'utf8')).files)retained[f.path]=f.sha256;
 const rows=judge({served,manifest,retained,dist:opt.dist});
 const counts={};for(const r of rows)counts[r.verdict]=(counts[r.verdict]||0)+1;
 const commitMatches=manifest.commit===commit;
 const failed=!commitMatches||rows.some(r=>FAILING.has(r.verdict));
 if(opt.json)console.log(JSON.stringify({origin:opt.origin,documentCommit:commit,manifestCommit:manifest.commit,commitMatches,counts,rows},null,1));
 else{
  for(const r of rows)if(r.verdict!=='match')console.log(r.verdict.padEnd(24),r.path);
  console.log(JSON.stringify({origin:opt.origin,documentCommit:commit,manifestCommit:manifest.commit,commitMatches,counts}));
  console.log(failed?'RESULT: DIFFERENT. Do not rely on the manifest for this site as it is now.':'RESULT: the served files equal the manifest. This is not proof that the manifest equals the public source; see docs/silo-trust/VERIFY_SERVED_CODE.md.');
 }
 process.exit(failed?1:0);
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href)await main();
