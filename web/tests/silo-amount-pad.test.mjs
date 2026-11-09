// The number pad's editing rules (lib/silo/amount-pad.mjs): UI input only, so these pin exactly what the pad may write into a field.
import test from 'node:test';import assert from 'node:assert/strict';
import {PAD_KEYS,padEdit,padPaste,padRefusal,padModeFor} from '../lib/silo/amount-pad.mjs';

const type=(keys,decimals=9)=>{let s={value:'',caret:0};for(const k of keys)s=padEdit(s.value,s.caret,s.caret,k,decimals).refused?s:padEdit(s.value,s.caret,s.caret,k,decimals);return s;};

test('the pad has 0 to 9, one point and delete, nothing else',()=>{
 assert.deepEqual([...PAD_KEYS].sort(),['.','0','1','2','3','4','5','6','7','8','9','del'].sort());
 assert.equal(padEdit('1',1,1,'e',9).refused,'key');assert.equal(padEdit('1',1,1,'-',9).refused,'key');assert.equal(padEdit('1',1,1,'+',9).refused,'key');
});

test('caret insert: a key lands at the caret, or replaces the selection, and the caret moves past it',()=>{
 assert.deepEqual(padEdit('125',1,1,'7',9),{value:'1725',caret:2});
 assert.deepEqual(padEdit('125',0,0,'9',9),{value:'9125',caret:1});
 assert.deepEqual(padEdit('125',3,3,'0',9),{value:'1250',caret:4});
 assert.deepEqual(padEdit('1.25',2,4,'5',9),{value:'1.5',caret:3});
 assert.deepEqual(type(['1','2','.','5']),{value:'12.5',caret:4});
});

test('leading zeros collapse and a bare point gets its zero',()=>{
 assert.deepEqual(type(['0','0','7']),{value:'7',caret:1});
 assert.deepEqual(type(['.','5']),{value:'0.5',caret:3});
 assert.deepEqual(type(['0','.','0','5']),{value:'0.05',caret:4});
 assert.deepEqual(type(['0']),{value:'0',caret:1});
});

test('delete: one character before the caret, or the selection; clear empties the field',()=>{
 assert.deepEqual(padEdit('12.5',4,4,'del',9),{value:'12.',caret:3});
 assert.deepEqual(padEdit('12.5',2,2,'del',9),{value:'1.5',caret:1});
 assert.deepEqual(padEdit('12.5',0,0,'del',9),{value:'12.5',caret:0});
 assert.deepEqual(padEdit('12.5',1,3,'del',9),{value:'15',caret:1});
 assert.deepEqual(padEdit('1',1,1,'del',9),{value:'',caret:0});
 assert.deepEqual(padEdit('10.5',1,1,'del',9),{value:'0.5',caret:0});
 assert.deepEqual(padEdit('12.5',2,2,'clear',9),{value:'',caret:0});
});

test('one point only, and never more decimals than the coin allows',()=>{
 assert.equal(padEdit('1.5',3,3,'.',9).refused,'point');
 assert.equal(padEdit('15',1,1,'.',9).refused,undefined);
 assert.equal(padEdit('1.5',0,3,'.',9).refused,undefined,'replacing the selection that holds the point is allowed');
 assert.deepEqual(type(['0','.','1','2','3','4','5','6','7'],6),{value:'0.123456',caret:8});
 assert.equal(padEdit('0.123456',8,8,'7',6).refused,'decimals');
 assert.equal(padEdit('0.123456789012',14,14,'1',12).refused,'decimals');
 assert.equal(padEdit('5',1,1,'.',0).refused,undefined);assert.equal(padEdit('5.',2,2,'1',0).refused,'decimals');
 assert.equal(padEdit('9'.repeat(20),20,20,'9',9).refused,'long');
 const kept=padEdit('1.5',3,3,'.',9);assert.equal(kept.value,'1.5');assert.equal(kept.caret,3);
});

test('text a phone keyboard left behind that is not an amount is never extended, only deleted',()=>{
 assert.equal(padEdit('1e5',3,3,'1',9).refused,'shape');
 assert.equal(padEdit('-1',2,2,'1',9).refused,'shape');
 assert.deepEqual(padEdit('1e5',3,3,'del',9),{value:'1e',caret:2});
});

test('paste: only a plain amount gets in; junk, negatives, two points and too many decimals are refused',()=>{
 assert.deepEqual(padPaste(' 12.5 ',9),{value:'12.5'});
 assert.deepEqual(padPaste('1,234.5',9),{value:'1234.5'});
 assert.deepEqual(padPaste('.25',9),{value:'0.25'});
 assert.deepEqual(padPaste('0007',9),{value:'7'});
 for(const junk of ['','.','abc','12abc','1.2.3','-5','1e9','$5','5 SOL','1,2,3','12,5','0x10','Infinity','NaN','<b>1</b>'])assert.ok(padPaste(junk,9).refused,`refused: ${JSON.stringify(junk)}`);
 assert.equal(padPaste('0.1234567',6).refused,'decimals');
 assert.equal(padPaste('1'.repeat(21),9).refused,'long');
});

test('refusals read plainly, with no dashes',()=>{
 for(const reason of ['point','decimals','long','shape']){const text=padRefusal(reason,6,'USDC');assert.ok(text.length>5);assert.doesNotMatch(text,/[–—]/);}
 assert.equal(padRefusal('decimals',6,'USDC'),'USDC has up to 6 decimal places.');
});

test('toggle: touch screens default to the pad, a saved choice wins on touch, a mouse or trackpad always types directly',()=>{
 assert.equal(padModeFor({coarse:true,saved:null}),'pad');
 assert.equal(padModeFor({coarse:true,saved:'keyboard'}),'keyboard');
 assert.equal(padModeFor({coarse:true,saved:'pad'}),'pad');
 assert.equal(padModeFor({coarse:true,saved:'junk'}),'pad');
 assert.equal(padModeFor({coarse:false,saved:null}),'keyboard');
 assert.equal(padModeFor({coarse:false,saved:'pad'}),'keyboard');
});
