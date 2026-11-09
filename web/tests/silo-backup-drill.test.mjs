import test from 'node:test';
import assert from 'node:assert/strict';
import {sealSilo} from '../lib/silo/local-envelope.mjs';
import {verifySiloBackup} from '../lib/silo/offline-recovery.mjs';
const passphrase='backup drill test passphrase',phrase='alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';
const target={zone:'xmr',network:'stagenet'};
test('a backup of the open wallet verifies without returning its phrase',async()=>{
 const envelope=await sealSilo('xmr','stagenet',{seed:phrase,height:1200,cacheData:'AA=='},passphrase);
 const result=await verifySiloBackup(envelope,passphrase,{...target,current:{seed:` ${phrase.replaceAll(' ','  ')} `,height:1200}});
 assert.deepEqual({...result},{samePhrase:true,sameAccount:true,samePendingPayment:false,sameReceiveState:true,receiveGap:null,backupAddresses:0,walletAddresses:0,sameConversionRecovery:true,safeBirthday:true,sameBirthday:true,birthday:1200,pendingPayment:false,openWalletPending:false,scanCacheIncluded:true});
 assert.ok(!JSON.stringify(result).includes('alpha'),'the phrase never leaves the check');
});
test('a backup of another wallet, a wrong passphrase or another network fails without changing anything',async()=>{
 const other=await sealSilo('xmr','stagenet',{seed:'other words here',height:5},passphrase);
 const result=await verifySiloBackup(other,passphrase,{...target,current:{seed:phrase,height:5}});
 assert.equal(result.samePhrase,false);assert.equal(result.sameBirthday,false);
 await assert.rejects(verifySiloBackup(other,'a wrong passphrase!!',{...target,current:{seed:phrase}}),error=>error.siloDecrypt==='auth');
 await assert.rejects(verifySiloBackup(other,passphrase,{zone:'zec',network:'testnet',current:{seed:phrase}}),/network mismatch/);
 await assert.rejects(verifySiloBackup(other,passphrase,{...target,current:{}}),/no recovery phrase/);
});
test('a pending payment in the backup or the open wallet is reported',async()=>{
 const envelope=await sealSilo('xmr','stagenet',{seed:phrase,height:7,pending:{status:'unconfirmed'}},passphrase);
 const result=await verifySiloBackup(envelope,passphrase,{...target,current:{seed:phrase,height:7,pending:{status:'unconfirmed'}}});
 assert.equal(result.pendingPayment,true);assert.equal(result.openWalletPending,true);
});

test('a different pending payment or ZEC account cannot verify the active wallet recovery state',async()=>{
 const envelope=await sealSilo('zec','testnet',{seed:phrase,account:1,height:7,pending:{id:'old'}},passphrase);
 const result=await verifySiloBackup(envelope,passphrase,{zone:'zec',network:'testnet',current:{seed:phrase,account:2,height:7,pending:{id:'new'}}});
 assert.equal(result.samePhrase,true);assert.equal(result.sameAccount,false);assert.equal(result.samePendingPayment,false);
 const matching=await verifySiloBackup(envelope,passphrase,{zone:'zec',network:'testnet',current:{seed:phrase,account:1,height:7,pending:{id:'old'}}});
 assert.equal(matching.sameAccount,true);assert.equal(matching.samePendingPayment,true);
});

// An old export can share the phrase yet omit newer subaddresses or the distinct ordinary/exchange receive state.
test('XMR backup drill refuses stale receive metadata and required cache loss',async()=>{
 const current={seed:phrase,height:7,subaddresses:51,scannedSubaddresses:51,ordinaryReceiveIndex:49};
 const old=await sealSilo('xmr','stagenet',{...current,subaddresses:50,scannedSubaddresses:50},passphrase);
 assert.equal((await verifySiloBackup(old,passphrase,{zone:'xmr',network:'stagenet',current})).sameReceiveState,false);
 const wrongOrdinary=await sealSilo('xmr','stagenet',{...current,ordinaryReceiveIndex:50},passphrase);
 assert.equal((await verifySiloBackup(wrongOrdinary,passphrase,{zone:'xmr',network:'stagenet',current})).sameReceiveState,false);
 const full=await sealSilo('xmr','stagenet',{...current,cacheData:'fixture',cacheOmitted:false},passphrase);
 assert.equal((await verifySiloBackup(full,passphrase,{zone:'xmr',network:'stagenet',current:{...current,subaddressCacheRequired:true}})).sameReceiveState,true);
 const reduced=await sealSilo('xmr','stagenet',{...current,cacheOmitted:true},passphrase);
 assert.equal((await verifySiloBackup(reduced,passphrase,{zone:'xmr',network:'stagenet',current:{...current,subaddressCacheRequired:true}})).sameReceiveState,false);
});

// Recovery may start earlier, but missing/later scan coverage cannot clear receiving.
test('backup drill refuses missing, negative or later birthdays and accepts earlier coverage',async()=>{
 const current={seed:phrase,height:1000};
 for(const [height,safe] of [[2000,false],[undefined,false],[-1,false],[1000,true],[999,true],[0,true]]){
  const payload={seed:phrase,...(height===undefined?{}:{height})},envelope=await sealSilo('xmr','mainnet',payload,passphrase);
  const result=await verifySiloBackup(envelope,passphrase,{zone:'xmr',network:'mainnet',current});
  assert.equal(result.samePhrase,true);assert.equal(result.sameAccount,true);assert.equal(result.safeBirthday,safe,String(height));
 }
 const envelope=await sealSilo('xmr','mainnet',{seed:phrase,height:1},passphrase);
 assert.equal((await verifySiloBackup(envelope,passphrase,{zone:'xmr',network:'mainnet',current:{seed:phrase}})).safeBirthday,false);
});
