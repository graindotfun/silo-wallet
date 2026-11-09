// Owner report (4 Nov, second browser): the right file and passphrase in "Verify the exported file" and nothing happened. The handler used to
// return silently while the wallet was busy (a first sync in a new browser can run for a long time) and the inputs were disabled meanwhile.
// Source-level guard for the fix: every early exit says why, a busy wallet keeps the file and verifies it when free, nothing is marked verified
// early, and the gate inputs stay usable while syncing. (The state machine itself is exercised by the restore-proof browser test.)
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const text=readFileSync(new URL('../components/silo-native-zone.tsx',import.meta.url),'utf8');
const body=text.slice(text.indexOf(' async function verifyBackup('),text.indexOf(' async function verifyBackup(')+2200);
test('verifyBackup never returns silently: no wallet and busy wallet each set a visible message',()=>{
 assert.match(body,/if\(!active\)\{setVerifyResult\(\{ok:false,text:'Open this wallet first/);
 assert.match(body,/if\(busy\|\|working\.current\)\{pendingVerify\.current=\{imported,secret:secretOverride\?\?verifyPassphrase\};setVerifyResult\(\{ok:false,text:'This wallet is busy[^']*verified automatically/);
 assert.doesNotMatch(body.slice(0,400),/if\(!active\|\|busy\|\|working\.current\)return;/);
});
test('the queued file is verified as soon as the wallet is free, and only then can anything be marked verified',()=>{
 assert.match(text,/useEffect\(\(\)=>\{if\(busy\|\|working\.current\|\|!pendingVerify\.current\|\|!wallet\.current\)return;const queued=pendingVerify\.current;pendingVerify\.current=null;void verifyBackup\(queued\.imported,queued\.secret\);\}\);/);
 const marks=[...text.matchAll(/markBackup\(true\)/g)].length;assert.ok(marks>=2);
});
test('the gate inputs are not disabled while the wallet syncs',()=>{
 const gate=text.slice(text.indexOf('<strong>Verify the exported file</strong>'),text.indexOf('<strong>Verify the exported file</strong>')+1200);
 assert.doesNotMatch(gate,/disabled=\{busy/);assert.match(gate,/disabled=\{verifyPassphrase\.length<12\}/);
});
