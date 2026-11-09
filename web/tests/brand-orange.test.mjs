import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
/** Brand-orange guard. Grainpad has one brand orange, --grain-orange (#ff6600); see design/brand-system.md.
 * This fails when a UI change reintroduces an orange literal, a second opaque orange token, a colour-shifting filter,
 * or the light-theme ink token outside text. Exact theme palette definitions and picker swatches are pinned below. */
const root=new URL('..',import.meta.url).pathname;
function files(dir,exts){const out=[];for(const name of readdirSync(join(root,dir))){const path=join(dir,name),full=join(root,path);if(statSync(full).isDirectory())out.push(...files(path,exts));else if(exts.some(e=>name.endsWith(e)))out.push(path);}return out;}
const sources=[...files('app',['.css','.tsx','.ts']),...files('components',['.tsx','.ts']),...files('lib',['.ts','.tsx','.mjs'])];
function hsl(r,g,b){r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),l=(max+min)/2,d=max-min;if(!d)return {h:0,s:0,l};const s=d/(1-Math.abs(2*l-1));const h=(max===r?((g-b)/d)%6:max===g?(b-r)/d+2:(r-g)/d+4)*60;return {h:(h+360)%360,s,l};}
// Solid oranges, plus opaque orange tints (a second orange backgrounds sometimes hide behind). Cream and paper tokens
// sit near 40-45deg with lower saturation and are not matched.
const orangeHsl=({h,s,l})=>(h>=15&&h<=40&&s>=0.6&&l>=0.25&&l<=0.75)||(h>=18&&h<=35&&s>=0.8&&l>0.75&&l<=0.98);
function literals(text){
 const found=[];
 for(const m of text.matchAll(/#([0-9a-fA-F]{3,8})\b/g)){let v=m[1];if(v.length===3||v.length===4)v=[...v.slice(0,3)].map(c=>c+c).join('');else if(v.length===6||v.length===8)v=v.slice(0,6);else continue;
  const c=hsl(parseInt(v.slice(0,2),16),parseInt(v.slice(2,4),16),parseInt(v.slice(4,6),16));if(orangeHsl(c))found.push({literal:m[0],index:m.index});}
 for(const m of text.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/g)){if(orangeHsl(hsl(+m[1],+m[2],+m[3])))found.push({literal:m[0],index:m.index});}
 for(const m of text.matchAll(/hsla?\(\s*(\d{1,3}(?:\.\d+)?)(?:deg)?[\s,]+(\d{1,3}(?:\.\d+)?)%[\s,]+(\d{1,3}(?:\.\d+)?)%/g)){if(orangeHsl({h:+m[1],s:+m[2]/100,l:+m[3]/100}))found.push({literal:m[0],index:m.index});}
 // Canvas palettes written as [r,g,b] arrays.
 for(const m of text.matchAll(/\[\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\]/g)){if(orangeHsl(hsl(+m[1],+m[2],+m[3])))found.push({literal:m[0],index:m.index});}
 return found;
}
/** Literals that may stay, each with a reason. A literal is judged by the declaration it sits in. The canonical orange
 * itself is a literal only in the token and in lib/brand-colors.mjs (GRAIN_ORANGE, GRAIN_ORANGE_RGB for canvas code). */
const TOKEN_DEFINITIONS=/--(grain-orange|grain-orange-ink|grain-warning)\s*:\s*$/;
const ALLOWED=[
 {why:'token definitions (canonical orange, light-theme text ink, warning amber)',test:({before})=>TOKEN_DEFINITIONS.test(before)},
 {why:'GRAIN_ORANGE constant for renderers without CSS variables',test:({file})=>file==='lib/brand-colors.mjs'},
 {why:'Solflare wallet icon: third-party brand colour',test:({line})=>/solflare/i.test(line)},
 {why:'User-requested MetaMask provider button uses its exact third-party brand orange',test:({file,literal,before,line})=>file==='app/claim-wallet.css'&&literal.toLowerCase()==='#ff5c16'&&before.trim()==='--wallet-bg:'&&line.startsWith('html body button[data-wallet-provider*="metamask"]{')},
];
// The theme layer landed after this guard. These are palette definitions, contrast inks, warning
// colours and data ramps, not ad-hoc component paints. Pin file + selector +
// declaration value so neither a new shade nor another use inherits an exception.
const THEME_PALETTES = [
 ...['b','a','c'].map(skin=>['app/themes.css',`html[data-skin=${skin}]`,'--tk-accent','#ff6600']),
 ...['a','c'].map(skin=>['app/themes.css',`html[data-skin=${skin}]`,'--tk-heat4','#ff6600']),
 ['app/themes.css','html[data-skin=a]','--tk-band3','#c4551a'],
 ['app/themes.css','html[data-skin=a]','--tk-heat2','#8a4a20'],
 ['app/themes.css','html[data-skin=a]','--tk-heat3','#d65c10'],
 ...['a','c'].flatMap(skin=>[
  ['app/app/silo-themes.css',`html[data-skin=${skin}] .silo-app`,'--silo-accent','#ff6600'],
  ['app/app/silo-themes.css',`html[data-skin=${skin}] .silo-app`,'--silo-accent-soft','color-mix(in srgb,#ff6600 8%,transparent)'],
 ]),
 ['app/app/silo-themes.css','html[data-skin=a] .silo-app','--silo-accent-text','#ff7a26'],
 ['app/app/silo-themes.css','html[data-skin=c] .silo-app','--silo-accent-text','#8a3400'],
 ['app/app/silo-themes.css','html[data-skin=a] .silo-app','--silo-warn','#e0aa4a'],
 ['app/app/silo-themes.css','.silo-app','--silo-a-xmr','#ff6600'],
];
const THEME_SWATCHES = new Map([
 ['components/appearance-control.tsx',[
  '["#101010","#171717","#ff6600","#ffffff"]',
  '["#3a2b20","#e9dac6","#ff6600","#1a1714"]',
 ]],
 ['lib/theme/theme-core.mjs',[
  "['#101010','#161616','#ff6600','#ffffff']",
  "['#14110e','#3a2b20','#ff6600','#f3ebde']",
  "['#3a2b20','#e9dac6','#ff6600','#1a1714']",
 ]],
]);
function themeLiteralAllowed({file,literal,index,text}){
 if(file==='lib/silo/asset-look.mjs' && lineAt(text,index).trim()==="xmr:look('xmr','#ff6600',['#ff6600'],'#14110e'),")return true;
 if(file.endsWith('.css')){
  const start=text.lastIndexOf('{',index),end=text.indexOf('}',index);
  if(start<0||end<0)return false;
  const commentEnd=text.lastIndexOf('*/',start);
  const selector=text.slice(Math.max(text.lastIndexOf('}',start)+1,commentEnd<0?0:commentEnd+2),start).trim();
  const declaration=text.slice(Math.max(start,text.lastIndexOf(';',index))+1,Math.min(...[text.indexOf(';',index),end].filter(i=>i>=0))).trim();
  return THEME_PALETTES.some(([path,sel,prop,value])=>file===path&&selector===sel&&declaration===`${prop}:${value}`);
 }
 // Only the canonical orange inside an exact picker strip. Another paint on
 // the same line, even in these files, must still fail.
 return literal.toLowerCase()==='#ff6600'&&(THEME_SWATCHES.get(file)??[]).some(strip=>{
  const start=text.lastIndexOf(strip,index);
  return start>=0&&index<start+strip.length&&/strip:\s*$/.test(text.slice(Math.max(0,start-20),start));
 });
}
function lineAt(text,index){const start=text.lastIndexOf('\n',index)+1,end=text.indexOf('\n',index);return text.slice(start,end<0?undefined:end);}
function declarationBefore(text,index){const start=Math.max(text.lastIndexOf(';',index),text.lastIndexOf('{',index),text.lastIndexOf('\n',index))+1;return text.slice(start,index);}

function orangeOffenders(file,text){
 const offenders=[];
 for(const {literal,index} of literals(text)){
  const ctx={file,literal,index,text,before:declarationBefore(text,index),line:lineAt(text,index)};
  if(!ALLOWED.some(rule=>rule.test(ctx))&&!themeLiteralAllowed(ctx))offenders.push(`${file}: ${literal} in "${ctx.line.trim().slice(0,120)}"`);
 }
 return offenders;
}
test('brand orange comes from --grain-orange: no stray orange literals',()=>{
 const offenders=sources.flatMap(file=>orangeOffenders(file,readFileSync(join(root,file),'utf8')));
 assert.deepEqual(offenders,[],`Use var(--grain-orange), a transparent tint of it (var(--grain-orange-tint)), or --grain-orange-ink for light-theme text:\n${offenders.join('\n')}`);
});

test('theme palette exceptions reject new shades, selectors, properties and files',()=>{
 for(const [file,selector,prop,value] of THEME_PALETTES){
  const css=`${selector}{${prop}:${value};}`;
  assert.deepEqual(orangeOffenders(file,css),[],css);
  for(const [path,text] of [
   [file,css.replaceAll(/#[0-9a-f]{6}/g,'#ff6700')],
   [file,`.unrelated ${css}`],
   [file,css.replace(prop,'background')],
   ['app/unrelated.css',css],
  ])assert.ok(orangeOffenders(path,text).length,`${path}: ${text}`);
 }
 for(const [file,strips] of THEME_SWATCHES)for(const strip of strips){
  const text=`{strip:${strip},background:"#ff6600"}`;
  assert.equal(orangeOffenders(file,text).length,1,'same-line paint stays guarded');
  assert.ok(orangeOffenders(file,`{strip:${strip.replace('#ff6600','#ff6700')}}`).length);
  assert.ok(orangeOffenders('components/unrelated.tsx',`{strip:${strip}}`).length);
 }
});

test('there is one opaque brand orange: no hover orange token',()=>{
 const offenders=sources.filter(file=>/--grain-orange-hover\b/.test(readFileSync(join(root,file),'utf8')));
 assert.deepEqual(offenders,[],'Hover states keep var(--grain-orange); use motion or var(--grain-orange-ring) for affordance.');
});

test('no filter shifts an orange to a new shade',()=>{
 const offenders=[];
 for(const file of sources.filter(f=>f.endsWith('.css'))){const text=readFileSync(join(root,file),'utf8');
  for(const m of text.matchAll(/filter\s*:\s*([^;}]+)/g)){const value=m[1];
   if(/hue-rotate|saturate|sepia/.test(value)||[...value.matchAll(/brightness\(\s*([\d.]+)/g)].some(b=>Number(b[1])>1))offenders.push(`${file}: filter:${value.trim()}`);}}
 assert.deepEqual(offenders,[],'Lightening, saturating or hue-rotating filters create a second orange.');
});

test('the light-theme ink orange is only used for text',()=>{
 const offenders=[];
 for(const file of sources.filter(f=>f.endsWith('.css'))){const text=readFileSync(join(root,file),'utf8');
  for(const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)){const selector=rule[1].trim(),body=rule[2];
   for(const decl of body.split(';')){const i=decl.indexOf(':');if(i<0)continue;const prop=decl.slice(0,i).trim(),value=decl.slice(i+1);
    if(!/var\(--(grain-orange-ink|light-accent)\)/.test(value))continue;
    const nonText=/^(border|outline|background|fill|stroke|box-shadow|text-decoration-color|caret-color|accent-color|column-rule)/.test(prop);
    const icon=prop==='color'&&/\bsvg\b|icon|glyph|chevron/.test(selector.split(',').pop());
    if(nonText||icon)offenders.push(`${file}: ${selector.slice(-80)} { ${prop}: ${value.trim()} }`);}}}
 assert.deepEqual(offenders,[],'Icons, borders, rails, rings and backgrounds use var(--grain-orange); ink is for text on light surfaces.');
});

/** Stylesheets in the order app/layout.tsx loads them; route stylesheets follow. */
function cssInLoadOrder(){
 const layout=readFileSync(join(root,'app/layout.tsx'),'utf8');
 const ordered=[...layout.matchAll(/import\s+["']\.\/([\w./-]+\.css)["']/g)].map(m=>`app/${m[1]}`);
 return [...ordered,...sources.filter(f=>f.endsWith('.css')&&!ordered.includes(f))];
}
test('a solid brand-orange paint is never faded into a second orange by opacity',()=>{
 // Cascades each selector across the stylesheets: #ff6600 at opacity .75 renders as rgb(251,134,55), a new solid orange.
 const solid=/^var\(--(grain-orange|xmr-orange)\)(\s*!important)?$/,state=new Map();
 for(const file of cssInLoadOrder()){const text=readFileSync(join(root,file),'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
  for(const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
   for(const selector of rule[1].split(',').map(x=>x.trim().replace(/\s+/g,' ')).filter(Boolean)){
    const st=state.get(selector)??{};
    for(const decl of rule[2].split(';')){const i=decl.indexOf(':');if(i<0)continue;const prop=decl.slice(0,i).trim(),value=decl.slice(i+1).trim();
     if(prop==='background'||prop==='background-color')st.bg=solid.test(value)?file:undefined;
     else if(prop==='color')st.color=solid.test(value)?file:undefined;
     else if(prop==='opacity')st.opacity={value:Number(value.replace('!important','')),file};}
    state.set(selector,st);}}}
 const offenders=[...state].filter(([,st])=>(st.bg||st.color)&&st.opacity&&st.opacity.value<1).map(([sel,st])=>`${sel}: --grain-orange from ${st.bg||st.color}, opacity ${st.opacity.value} from ${st.opacity.file}`);
 assert.deepEqual(offenders,[],`Keep solid brand orange at opacity 1, or paint a transparent tint (color-mix with transparent) instead:\n${offenders.join('\n')}`);
});
