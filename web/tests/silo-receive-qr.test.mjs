import test from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import {siloReceiveQr} from '../lib/silo/receive-qr.mjs';
test('independent decoder recovers exact public receive address from emitted SVG modules',()=>{
 for(const address of ['So11111111111111111111111111111111111111112','5'+ '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.repeat(2).slice(0,94),'utest1'+ 'abcdefghijklmnopqrstuvwxyz234567'.repeat(5)]){
  const qr=siloReceiveQr(address),scale=5,width=qr.size*scale,pixels=new Uint8ClampedArray(width*width*4).fill(255);
  for(const match of qr.path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)){
   const x=Number(match[1])*scale,y=Number(match[2])*scale;
   for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++){const at=((y+dy)*width+x+dx)*4;pixels[at]=pixels[at+1]=pixels[at+2]=0;}
  }
  assert.equal(jsQR(pixels,width,width)?.data,address);
 }
});
test('receive QR rejects URLs, scripts, whitespace and oversized payloads',()=>{
 for(const address of ['', 'https://example.com/address', '<script>alert(1)</script>', 'abc def'.repeat(9), 'x'.repeat(513),null])assert.throws(()=>siloReceiveQr(address));
});
