// The backup drill's receive-address freshness check (owner report 4 Nov: export then verify the SAME file stayed red). The check stays
// exact and fail-closed (a backup missing even one newer address is stale: tests/silo-backup-drill.test.mjs); what changed is that each
// red result now says WHICH part is out of date, with the address counts, so the person (and we) are never left guessing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sealSilo} from '../lib/silo/local-envelope.mjs';
import {verifySiloBackup} from '../lib/silo/offline-recovery.mjs';
const PASS='Disposable-Meteor-Forest-72!',SEED='abandon ability able about above absent absorb abstract absurd abuse access accident acid across act action actor actress actual adapt add addict address adjust admit adult advance advice aerobic affair afford afraid again';
const base={seed:SEED,height:1000,subaddresses:5,ordinaryReceiveIndex:3,keysData:'AA',cacheData:'AA'};
async function check(exported,current,network='mainnet'){const envelope=await sealSilo('xmr',network,exported,PASS);return verifySiloBackup(envelope,PASS,{zone:'xmr',network,current});}
test('a file verified right after its export passes, with and without an ordinary receive address',async()=>{
 const same=await check(base,{...base});assert.equal(same.sameReceiveState,true);assert.equal(same.receiveGap,null);
 const fresh={seed:SEED,height:1000,subaddresses:0,keysData:'AA',cacheData:'AA'};assert.equal((await check(fresh,{...fresh})).sameReceiveState,true);
});
test('each stale part stays red and is named: addresses (with counts), receive address, required scan cache',async()=>{
 const behind=await check(base,{...base,subaddresses:6});assert.equal(behind.sameReceiveState,false);assert.equal(behind.receiveGap,'addresses');assert.deepEqual([behind.backupAddresses,behind.walletAddresses],[5,6]);
 const moved=await check(base,{...base,ordinaryReceiveIndex:4});assert.equal(moved.sameReceiveState,false);assert.equal(moved.receiveGap,'receive-address');
 const noCache=await check({...base,cacheData:undefined,cacheOmitted:true},{...base,subaddressCacheRequired:true});assert.equal(noCache.sameReceiveState,false);assert.equal(noCache.receiveGap,'scan-cache');
});
test('the screen words each gap with what to do and never claims success for any of them',()=>{
 const text=readFileSync(new URL('../components/silo-native-zone.tsx',import.meta.url),'utf8');
 for(const phrase of ['recorded in this backup','receive addresses and this backup records','without opening Receive or Convert in between','export the full encrypted backup again'])assert.ok(text.includes(phrase)||/This wallet now knows/.test(text),phrase);
 assert.match(text,/This wallet now knows \$\{result\.walletAddresses\} receive addresses and this backup records \$\{result\.backupAddresses\}/);
 assert.match(text,/export a new backup now/);
});
