import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {openXmrResearch} from '../lib/silo/xmr-adapter.mjs';
import {sealSilo,openSilo} from '../lib/silo/local-envelope.mjs';
import {boundedSiloBackup} from '../lib/silo/backup-budget.mjs';
// The packaged monero-ts SDK, offline. Disposable stagenet wallets only: the node URL refuses connections,
// so nothing is scanned, signed or relayed and no funds exist. The network check is answered by a fixture.
const sdk=createRequire(import.meta.url)('monero-ts');
const node='https://127.0.0.1:9',fetcher=async()=>new Response(JSON.stringify({stagenet:true,mainnet:false,testnet:false}));
test('real monero-ts: new wallet, encrypted backup, cache unlock and seed restore keep one address',{timeout:240000},async()=>{
 const created=await openXmrResearch({sdk,node,fetcher});
 const address=await created.receive(),backup=boundedSiloBackup('xmr',await created.backup());await created.close();
 assert.equal(backup.cacheOmitted,undefined);assert.equal(backup.seed.split(' ').length,25);assert.ok(Number.isSafeInteger(backup.height));
 assert.ok(await sdk.MoneroUtils.isValidAddress(address,sdk.MoneroNetworkType.STAGENET));assert.equal(await sdk.MoneroUtils.isValidAddress(address,sdk.MoneroNetworkType.MAINNET),false);
 const envelope=await sealSilo('xmr','stagenet',backup,'disposable passphrase');
 assert.equal(JSON.stringify(envelope).includes(backup.seed.split(' ')[0]+' '),false,'the recovery phrase is not stored in clear');
 await assert.rejects(openSilo(envelope,'wrong passphrase!'),/invalid/);
 await assert.rejects(openSilo({...envelope,network:'mainnet'},'disposable passphrase'),/invalid/,'network is bound into the envelope');
 const cache=await openSilo(envelope,'disposable passphrase');
 const unlocked=await openXmrResearch({sdk,node,cache,fetcher});assert.equal(await unlocked.receive(),address);assert.equal((await unlocked.backup()).height,backup.height);await unlocked.close();
 const restored=await openXmrResearch({sdk,node,seed:backup.seed,height:backup.height,fetcher});assert.equal(await restored.receive(),address);await restored.close();
 const reduced=await openXmrResearch({sdk,node,cache:{seed:backup.seed,height:backup.height,cacheOmitted:true},fetcher});assert.equal(await reduced.receive(),address);await reduced.close();
});
test('real monero-ts: receive addresses are account-0 subaddresses that every restore path reproduces',{timeout:240000},async()=>{
 const created=await openXmrResearch({sdk,node,fetcher});
 const first=await created.receive(),second=await created.newReceive(),third=await created.newReceive(),backup=boundedSiloBackup('xmr',await created.backup());await created.close();
 assert.equal(backup.subaddresses,3);assert.equal(new Set([first,second,third]).size,3);
 // Stagenet subaddresses start with 7; the primary address (5) is never shown for receiving.
 for(const address of [first,second,third]){assert.match(address,/^7/);assert.ok(await sdk.MoneroUtils.isValidAddress(address,sdk.MoneroNetworkType.STAGENET));}
 const unlocked=await openXmrResearch({sdk,node,cache:await openSilo(await sealSilo('xmr','stagenet',backup,'disposable passphrase'),'disposable passphrase'),fetcher});
 assert.equal(await unlocked.receive(),third);await unlocked.close();
 const reduced=await openXmrResearch({sdk,node,cache:{seed:backup.seed,height:backup.height,subaddresses:3,cacheOmitted:true},fetcher});
 assert.equal(await reduced.receive(),third);assert.equal((await reduced.backup()).subaddresses,3);await reduced.close();
 // A phrase alone has no count: it shows subaddress 1 again, and the wallet's restore lookahead still scans the others.
 const restored=await openXmrResearch({sdk,node,seed:backup.seed,height:backup.height,fetcher});assert.equal(await restored.receive(),first);
 // New receive addresses are refused after a phrase-only restore: an earlier unpaid request could sit at the next index (PR 564 review).
 await assert.rejects(restored.newReceive(),/requests-gated/);await restored.close();
});
test('real monero-ts: a restored wallet recognises outputs to every subaddress Silo can hand out',{timeout:600000},async()=>{
 const {SILO_XMR_SUBADDRESS_GAP}=await import('../lib/silo/xmr-adapter.mjs');
 // getAddressIndex answers from the same subaddress table the scanner uses to detect incoming outputs.
 const captured=[],spy={...sdk,createWalletFull:async config=>{const wallet=await sdk.createWalletFull(config);captured.push(wallet);return wallet;}};
 const original=await openXmrResearch({sdk:spy,node,fetcher}),{seed,height}=await original.backup(),source=captured[0];
 const address=index=>source.getAddress(0,index);
 const knows=async(wallet,index)=>{try{return (await wallet.getAddressIndex(await address(index))).getIndex()===index;}catch{return false;}};
 // Phrase only: the restore lookahead covers indexes 0-199, more than the 50 unused addresses Silo allows after the last used one.
 await openXmrResearch({sdk:spy,node,seed,height,fetcher});const phraseOnly=captured[1];
 for(const index of [1,SILO_XMR_SUBADDRESS_GAP,4*SILO_XMR_SUBADDRESS_GAP-1])assert.equal(await knows(phraseOnly,index),true,`index ${index}`);
 // Recovery material with a recorded count: the wallet recreates the handed-out addresses and looks ahead of the last one.
 await openXmrResearch({sdk:spy,node,cache:{seed,height,subaddresses:250,cacheOmitted:true},fetcher});const counted=captured[2];
 for(const index of [250,449])assert.equal(await knows(counted,index),true,`index ${index}`);
 assert.equal(await knows(phraseOnly,250),false,'without the count, an address beyond the lookahead is not recognised');
 for(const wallet of captured)await wallet.close(false);await sdk.shutdown();
});

test('real monero-ts: ceiling recovery lookahead has a finite boundary',{timeout:600000},async()=>{
 const {SILO_XMR_SUBADDRESS_MAX,SILO_XMR_SUBADDRESS_LOOKAHEAD}=await import('../lib/silo/xmr-adapter.mjs');
 const captured=[],spy={...sdk,createWalletFull:async config=>{const wallet=await sdk.createWalletFull(config);captured.push(wallet);return wallet;}};
 try{
  const original=await openXmrResearch({sdk:spy,node,fetcher}),{seed,height}=await original.backup();
  await openXmrResearch({sdk:spy,node,cache:{seed,height,subaddresses:SILO_XMR_SUBADDRESS_MAX,cacheOmitted:true},fetcher});
  const source=captured[0],restored=captured[1];
  const known=async index=>{try{return (await restored.getAddressIndex(await source.getAddress(0,index))).getIndex()===index;}catch{return false;}};
  assert.equal(await known(SILO_XMR_SUBADDRESS_MAX+50),true);
  assert.equal(await known(SILO_XMR_SUBADDRESS_MAX+SILO_XMR_SUBADDRESS_LOOKAHEAD-1),true);
  assert.equal(await known(SILO_XMR_SUBADDRESS_MAX+SILO_XMR_SUBADDRESS_LOOKAHEAD),false);
 }finally{for(const wallet of captured)await wallet.close(false);await sdk.shutdown();}
});
