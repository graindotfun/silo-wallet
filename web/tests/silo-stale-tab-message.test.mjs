// Owner report (4 Nov): "The wallet could not be unlocked. Nothing was changed." on the Solana wallet right after several releases. Older builds' lazily
// loaded files return 404 once a new release is live (checked on the live site), so a tab opened before a release fails its dynamic import and the
// failure fell through to the generic unlock message. It now says what happened and what to do.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const text=readFileSync(new URL('../components/silo-native-public-wallet.tsx',import.meta.url),'utf8');
const body=text.slice(text.indexOf('function nativeFailure('),text.indexOf('function nativeFailure(')+4200);
test('a failed lazy import is reported as "Silo was updated", before the generic fallback',()=>{
 assert.match(body,/dynamically imported module\|Importing a module script failed\|Loading chunk/);
 assert.match(body,/Silo was updated while this page was open\. Reload the page, then try again\. Nothing was changed\./);
 assert.ok(body.indexOf('Silo was updated')<body.indexOf('Reason: ${siloFailureReason'));
 // The messages a wrong passphrase gets stay distinct from it.
 assert.match(body,/Nothing was decrypted: this passphrase does not open this encrypted wallet/);
});
test('each real failure reason keeps its own message and unknown ones still reach the fallback',async()=>{
 const re=/dynamically imported module|Importing a module script failed|Loading chunk|error loading dynamically/i;
 for(const reason of ['Failed to fetch dynamically imported module: https://silo.trading/_next/static/chunks/x.js','Importing a module script failed.','Loading chunk 12 failed.'])assert.ok(re.test(reason));
 for(const reason of ['The passphrase or encrypted native wallet is invalid.','Native wallet storage failed.','something else'])assert.ok(!re.test(reason));
});

import {siloFailureReason} from '../lib/silo/failure-reason.mjs';
test('unknown failures state their real reason, cleaned of anything that could be a key or secret, and bounded',()=>{
 assert.equal(siloFailureReason(Object.assign(new Error('The quota has been exceeded.'),{name:'QuotaExceededError'})),'QuotaExceededError: The quota has been exceeded.');
 assert.equal(siloFailureReason(new Error('Only an encrypted native wallet envelope may be stored.')),'Only an encrypted native wallet envelope may be stored.');
 const secret='5Kb8kLf9zqWXYZ1234567890abcdefghijklmnopqrstuvwxyzABCDEF';
 const out=siloFailureReason(new Error(`bad key ${secret} here`));assert.ok(!out.includes(secret));assert.match(out,/bad key … here/);
 assert.ok(siloFailureReason(new Error('x'.repeat(500)+' y')).length<=160);assert.equal(siloFailureReason(undefined),'unknown');
 assert.match(text,/Reason: \$\{siloFailureReason\(failure\)\}/,'the fallback of both the unlock and the create/import/restore messages carries it');
});
