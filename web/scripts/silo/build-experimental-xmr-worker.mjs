// Candidate-only packaging. Does not publish or change release authorization.
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
const root=process.cwd(),helpers=path.join(root,'docs/security/proposals/silo-sdk-worker-removal-20261014'),out=path.join(root,'.silo-worker-experiment');
const manifestPath=path.join(root,'lib/silo/xmr-sdk-manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestPath));
if(manifest.module.sha256!=='7b5da83603c012d3061a14ea9c091db9796bf4b243b431fb9ce2ab843f4a7c01')throw Error('Original reviewed SDK module differs');
const moduleBytes=fs.readFileSync(path.join(root,'public',manifest.module.url));if(createHash('sha256').update(moduleBytes).digest('hex')!==manifest.module.sha256)throw Error('Original module bytes differ');
fs.mkdirSync(out,{recursive:true});for(const name of ['build-worker.mjs','entry.cjs','deny-node-crypto.cjs','deny-node-fs.cjs','process-inject.mjs'])fs.copyFileSync(path.join(helpers,name),path.join(out,name));
execFileSync(process.execPath,[path.join(out,'build-worker.mjs'),root,out],{stdio:'inherit'});
const bytes=fs.readFileSync(path.join(out,'candidate-worker.js')),sha256=createHash('sha256').update(bytes).digest('hex'),name='monero-worker-'+sha256.slice(0,16)+'.js';
fs.writeFileSync(path.join(root,'public/silo-sdk',name),bytes);manifest.worker={url:'/silo-sdk/'+name,sha256,bytes:bytes.length};fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({candidateOnly:true,worker:manifest.worker,moduleUnchanged:true,published:false}));
