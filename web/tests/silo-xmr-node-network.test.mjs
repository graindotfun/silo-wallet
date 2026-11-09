// The Monero node must be on the wallet's network, whether configured or typed by hand: get_info flags and nettype agree.
import test from 'node:test';
import assert from 'node:assert/strict';
import {assertSiloXmrNodeNetwork} from '../lib/silo/xmr-node-network.mjs';

const refused=/did not verify the selected Monero network/;
test('stagenet: flags alone, flags with nettype, and every disagreement', () => {
 assert.equal(assertSiloXmrNodeNetwork({stagenet:true,mainnet:false,testnet:false},'stagenet'),'stagenet');
 assert.equal(assertSiloXmrNodeNetwork({stagenet:true,mainnet:false,testnet:false,nettype:'stagenet'},'stagenet'),'stagenet');
 assert.throws(()=>assertSiloXmrNodeNetwork({stagenet:true,mainnet:false,testnet:false,nettype:'mainnet'},'stagenet'),refused,'nettype says mainnet');
 assert.throws(()=>assertSiloXmrNodeNetwork({stagenet:true,mainnet:true,testnet:false},'stagenet'),refused,'two flags');
 assert.throws(()=>assertSiloXmrNodeNetwork({mainnet:true,nettype:'mainnet'},'stagenet'),refused,'a mainnet node for a stagenet wallet');
 assert.throws(()=>assertSiloXmrNodeNetwork({stagenet:'true'},'stagenet'),refused,'a string is not the flag');
 assert.throws(()=>assertSiloXmrNodeNetwork({testnet:true},'stagenet'),refused,'testnet');
 assert.throws(()=>assertSiloXmrNodeNetwork({},'stagenet'),refused);assert.throws(()=>assertSiloXmrNodeNetwork(null,'stagenet'),refused);assert.throws(()=>assertSiloXmrNodeNetwork([],'stagenet'),refused);
});
test('mainnet: the mirror image, and unsupported networks are refused before any node answer is read', () => {
 assert.equal(assertSiloXmrNodeNetwork({mainnet:true,stagenet:false,testnet:false,nettype:'mainnet'},'mainnet'),'mainnet');
 assert.throws(()=>assertSiloXmrNodeNetwork({mainnet:true,nettype:'stagenet'},'mainnet'),refused);
 assert.throws(()=>assertSiloXmrNodeNetwork({stagenet:true},'mainnet'),refused);
 assert.throws(()=>assertSiloXmrNodeNetwork({mainnet:true},'testnet'),/Unsupported Monero network/);
 assert.throws(()=>assertSiloXmrNodeNetwork({mainnet:true},undefined),/Unsupported Monero network/);
});
