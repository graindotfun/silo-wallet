import {readFile,writeFile,mkdir,rm,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
/** Pins the bundled ZEC core for serving: silo-zec-core-bundle.js (bundle-zec-core.mjs) and the WASM in 8 MiB chunks under
 * public/silo-sdk/zec-core-<hash>/, with lib/silo/zec-sdk-manifest.json, and a third-party notice listing every crate compiled
 * into the WASM with its license. The page executes exactly these verified bytes. Previous ZEC engine assets are removed: the
 * WebZjs engine is not valid on the network after NU6.2. Usage: node package-zec-core.mjs <.silo-sdk-build/zec-core> */
const build=resolve(process.argv[2]??'');if(!process.argv[2])throw Error('Provide the ZEC core build directory.');
const generated=join(build,'generated'),hash=createHash('sha256'),files=[];
const bundle=await readFile(join(generated,'silo-zec-core-bundle.js')),wasm=await readFile(join(generated,'silo_zec_core_bg.wasm'));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
files.push({path:'silo-zec-core-bundle.js',bytes:bundle});hash.update(digest(bundle));
const wasmPin={sha256:digest(wasm),bytes:wasm.length,chunks:[]};
for(let offset=0,index=0;offset<wasm.length;offset+=8*1024*1024,index++){const part=wasm.subarray(offset,offset+8*1024*1024),path=`wasm-part-${index}.bin`;files.push({path,bytes:part});wasmPin.chunks.push(path);hash.update(digest(part));}
const name='zec-core-'+hash.digest('hex').slice(0,16),directory=join('public/silo-sdk',name);
for(const entry of await readdir('public/silo-sdk'))if(/^(webzjs|zec-core)-[0-9a-f]{16}$/.test(entry)||/^WEBZJS_LICENSE/.test(entry))await rm(join('public/silo-sdk',entry),{recursive:true,force:true});
await mkdir(directory,{recursive:true});for(const file of files)await writeFile(join(directory,file.path),file.bytes);
const entries=files.map(file=>({url:`/silo-sdk/${name}/${file.path}`,sha256:digest(file.bytes),bytes:file.bytes.length}));const pick=path=>entries.find(row=>row.url.endsWith('/'+path));
const lock=await readFile(join(build,'Cargo.lock'),'utf8'),version=crate=>new RegExp(`name = "${crate}"\\nversion = "([^"]+)"`).exec(lock)?.[1];
await writeFile('lib/silo/zec-sdk-manifest.json',JSON.stringify({project:'Grain Silo ZEC core (vendor/silo/zec-core)',version:'0.1.0',engine:'lrz-sqlite',upstream:{zcash_client_backend:version('zcash_client_backend'),zcash_client_sqlite:version('zcash_client_sqlite'),zcash_protocol:version('zcash_protocol'),orchard:version('orchard')},module:pick('silo-zec-core-bundle.js'),wasm:{...wasmPin,chunks:wasmPin.chunks.map(pick)},assets:entries},null,2)+'\n');
// Third-party notice: every normal dependency compiled for the browser target, with its declared license (SQLite: public domain).
const tree=execFileSync('cargo',['+nightly-2026-09-15','tree','--locked','--target','wasm32-unknown-unknown','-e','normal','--prefix','none','--format','{p}\t{l}'],{cwd:build,encoding:'utf8'});
const crates=[...new Set(tree.split('\n').filter(Boolean).map(line=>line.replace(/ \(\/.*?\)/,'').replace(/ \(\*\)$/,'')))].sort();
await writeFile('public/silo-sdk/ZEC_CORE_THIRD_PARTY.txt',`Grain Silo ZEC core: crates compiled into ${name}/ (crate version, declared license).\nUpstream Zcash crates are MIT OR Apache-2.0 (https://github.com/zcash/librustzcash). The bundled SQLite is public domain.\n\n${crates.join('\n')}\n`);
console.log(`Pinned ${entries.length} ZEC core assets in ${directory}; ${crates.length} crates listed.`);
