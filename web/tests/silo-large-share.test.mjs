// Sol, review of baf30097 (M4): a Monero debit of at least 25% of the freshly checked unlocked balance, or an unknown one,
// needs the amount typed again. The exact boundary and the unknown cases.
import test from 'node:test';import assert from 'node:assert/strict';import {siloLargeShare} from '../lib/silo/large-share.mjs';
test('a quarter or more of the unlocked balance is large; just below is not',()=>{
 assert.equal(siloLargeShare(250n,'1000'),true,'exactly 25%');
 assert.equal(siloLargeShare(249n,'1000'),false,'just below 25%');
 assert.equal(siloLargeShare(1000n,'1000'),true);assert.equal(siloLargeShare(830440000n,'2200000000'),true,'the 37.7% stagenet case');
 assert.equal(siloLargeShare(130000000n,'940000000'),false,'about 14%');
});
test('unknown debit or balance never waives the check',()=>{
 for(const spendable of [null,undefined,'','not checked','-1','1.5','0x10'])assert.equal(siloLargeShare(1n,spendable),true,String(spendable));
 for(const debit of [null,undefined,-1n,1])assert.equal(siloLargeShare(debit,'1000'),true,String(debit));
 assert.equal(siloLargeShare(0n,'0'),true,'an empty balance');
});
