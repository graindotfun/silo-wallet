// r8 asset colours (owner, 6 Nov 2026): one registry for Home, the What to send sheet, Convert and Swap. Every label on a colour field
// reads at 4.5:1 or better on every stop of its fill; unverified tokens never borrow a brand colour.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SILO_ASSET_LOOKS,SILO_FALLBACK_LOOK,siloAssetLook,siloChainLook} from '../lib/silo/asset-look.mjs';
const lum=hex=>{const [r,g,b]=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.03928?v/12.92:((v+.055)/1.055)**2.4);return .2126*r+.7152*g+.0722*b;};
const ratio=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
test('every look carries its label at 4.5:1 or better on every stop',()=>{
 for(const look of [...Object.values(SILO_ASSET_LOOKS),SILO_FALLBACK_LOOK])for(const stop of look.stops)assert.ok(ratio(stop,look.ink)>=4.5,`${look.key} ${stop} on ${look.ink}: ${ratio(stop,look.ink).toFixed(2)}`);
});
test('brand colours only for verified assets; a fake "USDC" stays cream; wXMR is not native XMR',()=>{
 assert.equal(siloAssetLook('USDC',true).fill,'#2775ca');
 assert.equal(siloAssetLook('USDC',false),SILO_FALLBACK_LOOK);
 assert.equal(siloAssetLook('wXMR',true),SILO_FALLBACK_LOOK);
 assert.equal(siloAssetLook('SomethingNew',true),SILO_FALLBACK_LOOK);
 assert.equal(siloChainLook(8453).key,'base');assert.equal(siloChainLook(999),SILO_FALLBACK_LOOK);
 assert.equal(SILO_ASSET_LOOKS.xmr.fill,'#ff6600');assert.notEqual(SILO_ASSET_LOOKS.grain.fill,'#ff6600','GRAIN never reads as Monero');
});
test('Home builds every card from the registry, Monero first, and marks unverified tokens in the card name',()=>{
 const overview=readFileSync(new URL('../components/silo-overview.tsx',import.meta.url),'utf8');
 assert.match(overview,/look=\{xmrOff\?SILO_FALLBACK_LOOK:SILO_ASSET_LOOKS\.xmr\}/);
 assert.match(overview,/look=\{SILO_ASSET_LOOKS\.sol\}/);
 assert.match(overview,/look=siloAssetLook\(symbol,verified\)/);
 assert.match(overview,/look=\{siloChainLook\(evm\.chainId\)\}/);
 assert.match(overview,/Unverified · not official \$\{label\.imitates\}/);
 assert.ok(overview.indexOf('<SiloAssetCard id="xmr"')<overview.indexOf('<SiloAssetCard id="sol"'));
});
