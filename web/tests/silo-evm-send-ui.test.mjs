import test from 'node:test';
import assert from 'node:assert/strict';
import {siloEvmAmountToWei,siloEvmWeiLabel,siloEvmExplorer,siloRecipientOrThrow} from '../lib/silo/evm-send-ui.mjs';
test('amounts convert exactly and refuse everything ambiguous',()=>{
 assert.equal(siloEvmAmountToWei('0.01'),'10000000000000000');assert.equal(siloEvmAmountToWei('1'),'1000000000000000000');assert.equal(siloEvmAmountToWei('0.000000000000000001'),'1');
 for(const bad of ['','0','0.0','-1','1e3','.5','1.','0.0000000000000000001',' 1','1,5','abc',null]) assert.throws(()=>siloEvmAmountToWei(bad),/Enter an amount/,String(bad));
});
test('labels never round an amount up',()=>{
 assert.equal(siloEvmWeiLabel('10000000000000000'),'0.01');assert.equal(siloEvmWeiLabel('1999999999999999999'),'1.99999999');assert.equal(siloEvmWeiLabel('0'),'0');assert.equal(siloEvmWeiLabel('1000000000000000000'),'1');
});
test('explorer links exist only for the three chains and a real hash',()=>{
 const hash='0x'+'ab'.repeat(32);
 assert.equal(siloEvmExplorer(8453,hash),'https://basescan.org/tx/'+hash);assert.equal(siloEvmExplorer(1,hash),'https://etherscan.io/tx/'+hash);assert.equal(siloEvmExplorer(4663,hash),'https://robinhoodchain.blockscout.com/tx/'+hash);assert.equal(siloEvmExplorer(46630,hash),null);assert.equal(siloEvmExplorer(56,hash),'https://bscscan.com/tx/'+hash);
 assert.equal(siloEvmExplorer(137,hash),null);assert.equal(siloEvmExplorer(1,'0x12'),null);
});
test('the recipient check is the shared one',()=>{
 assert.throws(()=>siloRecipientOrThrow('0x0000000000000000000000000000000000000000'),/cannot receive/);
 assert.equal(siloRecipientOrThrow('0x70997970c51812dc3a010c7d01b50e0d17dc79c8'),'0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
});
