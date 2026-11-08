// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { createNativeKeyring, importNativeKeyring, unlockNativeKeyring, restoreNativeKeyring, previewNativePrivateKey } from '../lib/silo/native-keyring.mjs';
import { openNativeKeyringStore } from '../lib/silo/native-keyring-store.mjs';
import { Keypair } from '@solana/web3.js';
const password = 'copper meadow violet lantern';
function memory(saved = null) {
 let closed = false, value = saved; const callbacks = [];
 return { get closed() { return closed; }, async read() { if (closed) throw Error('closed'); return structuredClone(value); },
  async create(next) { if (closed) throw Error('closed'); if (value) return false; value = structuredClone(next); return true; },
  close() { if (!closed) { closed = true; callbacks.forEach(fn => fn()); } }, onClose(fn) { callbacks.push(fn); }, snapshot() { return structuredClone(value); } };
}
for (const chain of ['solana','evm']) {
 test(`${chain} create, ciphertext-only portability, lock, wrong password and reopen identity`, async () => {
  const store = memory(), session = await createNativeKeyring({ chain, passphrase:password, store });
  const address = session.metadata().address, backup = session.exportBackup();
  assert.equal(backup.address,address); assert.equal(backup.chain,chain); assert.equal(backup.iterations,600000);
  assert.equal(backup.ciphertext.length,96); assert(!JSON.stringify(backup).includes(password));
  assert.equal(await session.verifyBackup(backup,password),true);
  await assert.rejects(session.signTransaction({}),/held/);
  const restored = await restoreNativeKeyring({ backup, passphrase:password, store:memory() });
  assert.equal(restored.metadata().address,address); restored.lock();
  await assert.rejects(unlockNativeKeyring({ chain, passphrase:'different unrelated mountain flower', store:memory(backup) }),/invalid/);
  session.lock(); assert.throws(()=>session.metadata(),/locked/); assert.throws(()=>session.exportBackup(),/locked/);
  const opened = await unlockNativeKeyring({ chain, passphrase:password, store:memory(backup) });
  assert.equal(opened.metadata().address,address); opened.lock();
 });
}
test('canonical Solana64byte private key validates its public half; no seed truncation accepted', async () => {
 const pair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19)), key = bs58.encode(pair.secretKey);
 const session = await importNativeKeyring({ chain:'solana', privateKey:key, passphrase:password, store:memory() });
 assert.equal(session.metadata().address,bs58.encode(pair.publicKey)); session.lock();
 const bad = new Uint8Array(pair.secretKey); bad[63] ^= 1;
 for (const privateKey of [bs58.encode(bad),bs58.encode(pair.secretKey.subarray(0,32)),key+'1',' '+key]) {
  await assert.rejects(importNativeKeyring({ chain:'solana',privateKey,passphrase:password,store:memory() }),/canonical/);
 }
 pair.secretKey.fill(0); bad.fill(0);
});
test('EVM scalar validation and independently known secp256k1 address vector', async () => {
 const privateKey = '0'.repeat(63)+'1';
 const session = await importNativeKeyring({chain:'evm',privateKey,passphrase:password,store:memory()});
 assert.equal(session.metadata().address,'0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'); session.lock();
 for(const bad of ['0'.repeat(64),'f'.repeat(64),'12','0x'+'1'.repeat(63)]) await assert.rejects(importNativeKeyring({chain:'evm',privateKey:bad,passphrase:password,store:memory()}));
});
test('create, import and restore never overwrite an existing vault', async () => {
 const store = memory(); const first = await createNativeKeyring({chain:'evm',passphrase:password,store});
 const before = store.snapshot();
 await assert.rejects(createNativeKeyring({chain:'evm',passphrase:password,store}),/already exists/);
 await assert.rejects(importNativeKeyring({chain:'evm',privateKey:'0'.repeat(63)+'1',passphrase:password,store}),/already exists/);
 await assert.rejects(restoreNativeKeyring({backup:before,passphrase:password,store}),/already exists/);
 assert.deepEqual(store.snapshot(),before); first.lock();
});
test('authenticated metadata, ciphertext, parameter and encoding tampering all refuse', async () => {
 const session = await createNativeKeyring({chain:'solana',passphrase:password,store:memory()}), backup = session.exportBackup(); session.lock();
 const mutations = [ {address:bs58.encode(new Uint8Array(32))},{chain:'evm'},{network:'devnet'},{scope:'grain-silo'},{iterations:1},{cipher:'AES-CBC'},{iv:backup.iv.slice(2)},{ciphertext:'0'+backup.ciphertext.slice(1)},{salt:'g'.repeat(32)},{extra:'ignored?'} ];
 for(const change of mutations) {
  if(change.ciphertext === backup.ciphertext) change.ciphertext = '1'+backup.ciphertext.slice(1);
  await assert.rejects(unlockNativeKeyring({chain:'solana',passphrase:password,store:memory({...backup,...change})}),/invalid|Invalid/);
 }
});
test('lock invalidates in-flight verify and closed-store creation; callback closes session', async () => {
 const store = memory(), session = await createNativeKeyring({chain:'evm',passphrase:password,store});
 const pending = session.verifyBackup(session.exportBackup(),password); session.lock(); await assert.rejects(pending,/locked/);
 const closed = memory(); const creating = createNativeKeyring({chain:'evm',passphrase:password,store:closed}); closed.close(); await assert.rejects(creating);
 const callbackStore = memory(), callbackSession = await createNativeKeyring({chain:'evm',passphrase:password,store:callbackStore});
 callbackStore.close(); assert.throws(()=>callbackSession.metadata(),/locked/);
});
test('new wallets refuse weak passphrases and missing exclusive tab capability', async () => {
 await assert.rejects(createNativeKeyring({chain:'solana',passphrase:'passwordpassword',store:memory()}));
 await assert.rejects(openNativeKeyringStore('solana',{factory:{},locks:{}}),/exclusive/);
 await assert.rejects(openNativeKeyringStore('solana',{factory:{},locks:{request:async(_name,_options,fn)=>fn(null)}}),/another tab/);
});
test('restore snapshot resists caller mutation while decrypting and backup belongs to current wallet', async () => {
 const first = await createNativeKeyring({chain:'evm',passphrase:password,store:memory()}), backup = first.exportBackup();
 const second = await createNativeKeyring({chain:'evm',passphrase:password,store:memory()});
 await assert.rejects(first.verifyBackup(second.exportBackup(),password),/different wallet/);
 const restore = restoreNativeKeyring({backup,passphrase:password,store:memory()}); backup.ciphertext = 'f'.repeat(96); backup.address = '0x'+'f'.repeat(40);
 const recovered = await restore; assert.equal(recovered.metadata().address,first.metadata().address);
 first.lock(); second.lock(); recovered.lock();
});
test('simultaneous creations preserve one durable envelope and never return a second wallet', async () => {
 const store = memory(); const results = await Promise.allSettled([createNativeKeyring({chain:'solana',passphrase:password,store}),createNativeKeyring({chain:'solana',passphrase:password,store})]);
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
 const winner = results.find(result=>result.status==='fulfilled').value;
 assert.equal(store.snapshot().address,winner.metadata().address); winner.lock();
});

test('canonical leading-zero seed keypairs are admitted by decoded length, not inaccurate string length', async () => {
 const pair = nacl.sign.keyPair.fromSeed(new Uint8Array(32)), privateKey = bs58.encode(pair.secretKey);
 assert(privateKey.length < 80);
 assert.equal(previewNativePrivateKey({chain:'solana',privateKey}).address,bs58.encode(pair.publicKey));
 const session = await importNativeKeyring({chain:'solana',privateKey,passphrase:password,store:memory()});
 assert.equal(session.metadata().address,bs58.encode(pair.publicKey)); session.lock(); pair.secretKey.fill(0);
});
test('unlock snapshots envelope before decryption and returns its verified backup after caller mutation', async () => {
 const original = await createNativeKeyring({chain:'evm',passphrase:password,store:memory()}), backup = original.exportBackup();
 const exposed = structuredClone(backup); let readDone;
 const readSignal = new Promise(resolve=>{readDone=resolve;});
 const store = {read:async()=>{queueMicrotask(()=>readDone());return exposed;},close(){},closed:false};
 const opening = unlockNativeKeyring({chain:'evm',passphrase:password,store});
 await readSignal; await Promise.resolve(); exposed.address = '0x'+'f'.repeat(40); exposed.ciphertext = 'f'.repeat(96);
 const opened = await opening; assert.deepEqual(opened.exportBackup(),backup); assert.equal(opened.metadata().address,original.metadata().address);
 original.lock(); opened.lock();
});
function mockedPagehide(run) {
 const previousAdd = globalThis.addEventListener, previousRemove = globalThis.removeEventListener; let handler;
 globalThis.addEventListener = (type,fn)=>{if(type==='pagehide')handler=fn;};
 globalThis.removeEventListener = (type,fn)=>{if(type==='pagehide'&&handler===fn)handler=undefined;};
 return run(()=>{assert(handler);handler();}).finally(()=>{if(previousAdd)globalThis.addEventListener=previousAdd;else delete globalThis.addEventListener;if(previousRemove)globalThis.removeEventListener=previousRemove;else delete globalThis.removeEventListener;});
}
test('pagehide during pending lock rejects immediately and late lock never opens database',()=>mockedPagehide(async hide=>{
 let callback, dbOpens = 0;
 const pending = openNativeKeyringStore('solana',{locks:{request:(_name,_options,fn)=>{callback=fn;return Promise.resolve();}},factory:{open(){dbOpens++;throw Error('must not open');}}});
 hide(); await assert.rejects(pending,/closed/); await callback({}); assert.equal(dbOpens,0);
}));
test('pagehide during pending database open releases lock and closes late database result',()=>mockedPagehide(async hide=>{
 let request, released = false, closed = 0; const fakeDatabase={close(){closed++;}};
 const pending = openNativeKeyringStore('solana',{locks:{request:async(_name,_options,fn)=>{await fn({});released=true;}},factory:{open(){request={result:fakeDatabase};return request;}}});
 await Promise.resolve(); await Promise.resolve(); assert(request); hide(); await assert.rejects(pending,/closed/); await Promise.resolve(); assert.equal(released,true);
 request.onsuccess(); assert.equal(closed,1);
}));

test('network label: mainnet by default; devnet only for Solana and only when asked; an envelope opens only as its own network; test-network signing is held',async()=>{
 const pass='Synthetic network label phrase 17!';
 const main=await createNativeKeyring({chain:'solana',passphrase:pass,store:memory()}),mainEnvelope=main.exportBackup();assert.equal(mainEnvelope.network,'mainnet');assert.equal(main.metadata().network,'mainnet');main.lock();
 const dev=await createNativeKeyring({chain:'solana',passphrase:pass,store:memory(),network:'devnet'}),devEnvelope=dev.exportBackup();
 assert.equal(devEnvelope.network,'devnet');assert.equal(dev.metadata().network,'devnet');assert.equal(devEnvelope.address,dev.metadata().address);
 assert.throws(()=>dev.signReviewedTransfer('AA==',{}),/held for test-network wallets/);assert.throws(()=>dev.signReviewedManaged('AA==',{}),/held for test-network wallets/);dev.lock();
 // Authenticated label: neither envelope opens as the other network, and the default is mainnet.
 await assert.rejects(restoreNativeKeyring({backup:devEnvelope,passphrase:pass,store:memory()}),/invalid/i);
 await assert.rejects(restoreNativeKeyring({backup:mainEnvelope,passphrase:pass,store:memory(),network:'devnet'}),/invalid/i);
 await assert.rejects(restoreNativeKeyring({backup:{...devEnvelope,network:'mainnet'},passphrase:pass,store:memory()}),/invalid/i,'a relabelled envelope fails authentication');
 assert.equal((await restoreNativeKeyring({backup:devEnvelope,passphrase:pass,store:memory(),network:'devnet'})).metadata().network,'devnet');
 assert.equal((await unlockNativeKeyring({chain:'solana',passphrase:pass,store:memory(devEnvelope),network:'devnet'})).metadata().network,'devnet');
 await assert.rejects(unlockNativeKeyring({chain:'solana',passphrase:pass,store:memory(devEnvelope)}),/invalid/i);
 // EVM and unknown labels are refused before anything is generated or stored.
 for(const [chain,network] of [['evm','devnet'],['solana','testnet'],['solana','mainnet-beta']])await assert.rejects(createNativeKeyring({chain,passphrase:pass,store:memory(),network}),/Unsupported native wallet network/);
 await assert.rejects(openNativeKeyringStore('evm',{network:'devnet',factory:{},locks:{}}),/Unsupported native wallet network/);
});

test('Solana secret-key export round-trips through import into a fresh Silo wallet with the same address; requires its own re-entered passphrase; Solana-only; locked refuses',async()=>{
 const solana=await createNativeKeyring({chain:'solana',passphrase:password,store:memory()}),address=solana.metadata().address;
 await assert.rejects(solana.revealSecretKey('wrong unrelated nonsense phrase'),/invalid/);
 const revealed=await solana.revealSecretKey(password);
 assert.equal(bs58.decode(revealed).length,64,'canonical 64-byte keypair form, the format Phantom/Solflare/Backpack import');
 assert.equal(previewNativePrivateKey({chain:'solana',privateKey:revealed}).address,address);
 // Decoded with @solana/web3.js's own Keypair, exactly as an independent external Solana wallet would -- not through any
 // Silo code path -- to prove the exported format is genuinely portable, not just round-trippable through Silo itself.
 assert.equal(Keypair.fromSecretKey(bs58.decode(revealed)).publicKey.toBase58(),address,'an independent Solana wallet decoding this exact string reconstructs the same address');
 const reimported=await importNativeKeyring({chain:'solana',privateKey:revealed,passphrase:password,store:memory()});
 assert.equal(reimported.metadata().address,address,'importing the revealed key recreates the identical wallet address');
 reimported.lock();
 const evm=await createNativeKeyring({chain:'evm',passphrase:password,store:memory()});
 await assert.rejects(evm.revealSecretKey(password),/Solana wallets only/);
 evm.lock(); solana.lock();
 await assert.rejects(solana.revealSecretKey(password),/locked/);
});

test('a key generated by an independent Solana wallet (web3.js Keypair, not Silo) imports into Silo with the same address',async()=>{
 const external=Keypair.generate(),key=bs58.encode(external.secretKey);
 assert.equal(previewNativePrivateKey({chain:'solana',privateKey:key}).address,external.publicKey.toBase58());
 const session=await importNativeKeyring({chain:'solana',privateKey:key,passphrase:password,store:memory()});
 assert.equal(session.metadata().address,external.publicKey.toBase58());
 assert.equal(await session.revealSecretKey(password),key,'Silo\'s own export of the imported key is byte-for-byte what the external wallet generated');
 session.lock();
});
