import test from 'node:test';
import assert from 'node:assert/strict';
import {siloPrivateInLink,siloMoneroMainnetAddress} from '../lib/silo/move-private.mjs';
const primary='4'+'A'.repeat(94),sub='8'+'B'.repeat(94);
test('Move to private links to Trocador AnonPay with the Monero address as the only data',()=>{
 for(const address of [primary,sub]){const url=new URL(siloPrivateInLink(address));
  assert.equal(url.origin,'https://trocador.app');assert.equal(url.pathname,'/anonpay/');
  assert.deepEqual([...url.searchParams.keys()].sort(),['address','network_to','ticker_to']);
  assert.equal(url.searchParams.get('address'),address);assert.equal(url.searchParams.get('ticker_to'),'xmr');assert.equal(url.searchParams.get('network_to'),'Mainnet');
  assert.equal(url.searchParams.has('ref'),false,'no affiliate code');}
});
test('only Monero mainnet addresses are accepted: stagenet, Solana, malformed and injected values are refused',()=>{
 for(const bad of ['5'+'A'.repeat(94),'7'+'A'.repeat(94),'4'+'A'.repeat(93),'4'+'0'.repeat(94),'7xKpQe2m9RtVbN4sLw8cHd3fZy6u4mQeAbCdEfGhJkLm',primary+'&ref=x','',null,undefined]){
  assert.equal(siloMoneroMainnetAddress(bad),false,String(bad));assert.throws(()=>siloPrivateInLink(bad),/mainnet receive address/);}
});
