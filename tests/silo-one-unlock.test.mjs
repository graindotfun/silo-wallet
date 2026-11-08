// SPDX-License-Identifier: AGPL-3.0-only
/** One unlock for every wallet: the state contract, driven against REAL sealed wallets (native keyring for Solana/EVM, sealSilo for Monero). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createNativeKeyring,unlockNativeKeyring} from '../lib/silo/native-keyring.mjs';
import {sealSilo,openSilo} from '../lib/silo/local-envelope.mjs';
import {createOneUnlock,ONE_UNLOCK_MESSAGES} from '../lib/silo/one-unlock.mjs';

const ONE='marble orchid tundra compass 905',OTHER='copper meadow fjord umbrella 87';
const store=envelope=>({closed:false,async read(){return structuredClone(envelope);},async create(){return false;},async remove(){return true;},close(){},onClose(){}});
const memory=()=>{let e=null;return {closed:false,async read(){return e;},async create(x){if(e)return false;e=x;return true;},async remove(){return true;},close(){},onClose(){}};};
async function wallets({solana=ONE,evm=ONE,xmr=ONE}={}){
 const sol=(await createNativeKeyring({chain:'solana',passphrase:solana,store:memory()})).exportBackup(),evmEnv=(await createNativeKeyring({chain:'evm',passphrase:evm,store:memory()})).exportBackup(),xmrEnv=await sealSilo('xmr','mainnet',{seed:'abandon '.repeat(24).trim()},xmr);
 const log=[],failure={};
 const open={
  solana:async pass=>{log.push('solana');if(failure.solana)throw failure.solana;(await unlockNativeKeyring({chain:'solana',passphrase:pass,store:store(sol)})).lock();},
  evm:async pass=>{log.push('evm');if(failure.evm)throw failure.evm;(await unlockNativeKeyring({chain:'evm',passphrase:pass,store:store(evmEnv)})).lock();},
  xmr:async pass=>{log.push('xmr');if(failure.xmr)throw failure.xmr;await openSilo(xmrEnv,pass);},
 };
 return {open,log,failure};
}
const classify=error=>/another tab/.test(error.message)?'in-use':(/passphrase or encrypted/i.test(error.message)||error.siloDecrypt)?'wrong':'error';
/** What the wallets do after `submit`: each starts only if allowed, tries once, and reports. Light wallets together, Monero after them. */
async function drive(controller,w,version,{only=['solana','evm','xmr'],beforeReport=async()=>{}}={}){
 const run=async zone=>{
  if(!only.includes(zone)||!controller.started(zone,version))return null;
  let outcome='open';try{await w.open[zone](controller.passphraseFor(version));}catch(error){outcome=classify(error);}
  await beforeReport(zone);return controller.report(zone,outcome,version);
 };
 await Promise.all(['solana','evm'].map(run));await run('xmr');
}
const make=(extra={})=>{const c=createOneUnlock(extra);for(const zone of ['solana','evm','xmr'])c.setPresent(zone,true);return c;};

test('one passphrase opens all three: light wallets first, Monero gated until they settle, no message',async()=>{
 const w=await wallets(),c=make(),{version}=c.submit(ONE);
 assert.deepEqual(c.statuses(),{solana:'opening',evm:'opening',xmr:'locked'},'Monero waits');assert.equal(c.canOpen('xmr',version),false);
 assert.equal(c.canOpen('solana',version),true);
 await drive(c,w,version);
 assert.deepEqual(c.statuses(),{solana:'open',evm:'open',xmr:'open'});assert.equal(c.message(),ONE_UNLOCK_MESSAGES.none);
 assert.deepEqual(w.log.slice(0,2).sort(),['evm','solana']);assert.equal(w.log[2],'xmr');
});

test('a wallet with a different old passphrase stays locked as "needs-own"; the others open; no message names a part',async()=>{
 const w=await wallets({evm:OTHER}),c=make(),{version}=c.submit(ONE);await drive(c,w,version);
 assert.deepEqual(c.statuses(),{solana:'open',evm:'needs-own',xmr:'open'});assert.equal(c.message(),'');
 const mono=await wallets({xmr:OTHER}),c2=make(),v2=c2.submit(ONE).version;await drive(c2,mono,v2);assert.deepEqual(c2.statuses(),{solana:'open',evm:'open',xmr:'needs-own'});
});

test('a wrong passphrase opens nothing and shows ONE message that does not name a wallet',async()=>{
 const w=await wallets(),c=make(),{version}=c.submit('nothing like the real one 12345');await drive(c,w,version);
 assert.deepEqual(c.statuses(),{solana:'needs-own',evm:'needs-own',xmr:'needs-own'});assert.equal(c.message(),ONE_UNLOCK_MESSAGES.wrong);
 assert.doesNotMatch(c.message(),/solana|ethereum|evm|monero|base|bnb/i);
});

test('each wallet is tried once per typed passphrase, never retried; a new passphrase is a new version',async()=>{
 const w=await wallets(),c=make(),{version}=c.submit('nothing like the real one 12345');await drive(c,w,version);const calls=w.log.length;
 await drive(c,w,version);assert.equal(w.log.length,calls,'no retry for the same version');assert.equal(c.canOpen('solana',version),false);
 const next=c.submit(ONE).version;assert.notEqual(next,version);assert.equal(c.report('solana','open',version).accept,false,'an old version cannot report');
 await drive(c,w,next);assert.deepEqual(c.statuses(),{solana:'open',evm:'open',xmr:'open'});
 assert.equal(c.submit('short').accepted,false);
});

test('a lock in the middle of an open makes the late result stale: nothing stays open, the passphrase is forgotten',async()=>{
 const w=await wallets(),c=make(),{version}=c.submit(ONE);let stale=null;
 await drive(c,w,version,{only:['solana'],beforeReport:async zone=>{c.lockAll();}});
 assert.deepEqual(c.statuses(),{solana:'locked',evm:'locked',xmr:'locked'});assert.equal(c.passphraseFor(version),'');
 assert.equal(c.report('solana','open',version).accept,false,'the caller must lock the wallet it opened');
 assert.equal(c.canOpen('evm',version),false);assert.equal(c.canOpen('xmr',version),false);
});

test('blocked or failing storage leaves that wallet locked with one generic message; Monero still gets its turn',async()=>{
 const w=await wallets();w.failure.solana=Error('Native wallet storage is unavailable.');w.failure.evm=Error('Native wallet storage failed.');
 const c=make(),{version}=c.submit(ONE);await drive(c,w,version);
 assert.deepEqual(c.statuses(),{solana:'locked',evm:'locked',xmr:'open'});assert.equal(c.message(),'','something opened, so no failure banner');
 const all=await wallets();for(const z of ['solana','evm','xmr'])all.failure[z]=Error('Native wallet storage is unavailable.');
 const c2=make(),v2=c2.submit(ONE).version;await drive(c2,all,v2);assert.equal(c2.message(),ONE_UNLOCK_MESSAGES.trouble);
});

test('a wallet open in another tab is said so, and does not block the others',async()=>{
 const w=await wallets();w.failure.evm=Error('Native wallet is open in another tab.');
 const c=make(),{version}=c.submit(ONE);await drive(c,w,version);
 assert.deepEqual(c.statuses(),{solana:'open',evm:'other-tab',xmr:'open'});
});

test('a light wallet that never answers cannot hold Monero forever: after the timeout it is locked and Monero proceeds',async()=>{
 let fire=null;const c=make({timeoutMs:50,setTimer:fn=>{fire=fn;return 1;},clearTimer:()=>{fire=null;}}),{version}=c.submit(ONE);
 c.started('solana',version);c.started('evm',version);c.report('evm','open',version);
 assert.equal(c.canOpen('xmr',version),false);fire();
 assert.equal(c.statuses().solana,'locked');assert.equal(c.canOpen('xmr',version),true);
});

test('presence, wallets opened another way, and what the module never touches',async()=>{
 const c=make();c.setPresent('evm',false);assert.deepEqual(Object.keys(c.statuses()),['solana','xmr']);
 c.setOpen('solana');assert.equal(c.statuses().solana,'open');const {version}=c.submit(ONE);assert.equal(c.statuses().solana,'open','an open wallet is left alone');assert.equal(c.canOpen('solana',version),false);
 assert.throws(()=>c.setPresent('zec',true),/Unknown wallet/);
 const source=readFileSync(new URL('../lib/silo/one-unlock.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/localStorage|sessionStorage|indexedDB|fetch\(|console\.|document\.cookie/);
});

test('Monero has its own bound: an open that never answers is released as locked after the heavy timeout, and a settled error frees the field',async()=>{
 const timers=[];const c=make({timeoutMs:50,heavyTimeoutMs:200,setTimer:(fn,ms)=>{const entry={fn,ms,live:true};timers.push(entry);return entry;},clearTimer:entry=>{if(entry)entry.live=false;}});
 const {version}=c.submit(ONE);c.started('solana',version);c.started('evm',version);c.report('solana','open',version);c.report('evm','open',version);
 assert.equal(c.started('xmr',version),true);assert.equal(c.statuses().xmr,'opening');
 const heavy=timers.filter(t=>t.live&&t.ms===200);assert.equal(heavy.length,1);heavy[0].fn();
 assert.equal(c.statuses().xmr,'locked');assert.equal(c.message(),'','something opened, so no banner');
 const next=c.submit(ONE).version;c.started('solana',next);c.started('evm',next);c.report('solana','open',next);c.report('evm','open',next);c.started('xmr',next);
 assert.equal(c.report('xmr','error',next).accept,true);assert.equal(c.statuses().xmr,'locked');
});
