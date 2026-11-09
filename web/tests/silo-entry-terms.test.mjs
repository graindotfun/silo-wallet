// Sol, review of 15a0afbf (R6-M2): the accepted terms version is signed into the entry proof. A proof issued before terms
// existed, or under another terms version, is properly signed but no longer admits, so its holder accepts the current terms.
// This file imports only the beta guard and the terms constant, so it also runs against the previous candidate (15a0afbf),
// where it fails on behaviour: that guard still admits a proof that carries no terms version.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {siloInviteProof,siloInviteValid,siloInviteToken,SILO_BETA_COOKIE} from '../lib/silo/beta-guard.mjs';
import {SILO_BETA_TERMS} from '../lib/silo/beta-terms.mjs';
const secret='x'.repeat(40),code='silo-test-invite-code-1',sha=value=>createHash('sha256').update(value).digest('hex');
const open={SILO_NETWORK:'mainnet',SILO_BETA_ACCESS:'open',RPC_SESSION_SECRET:secret},cookie=token=>`${SILO_BETA_COOKIE}=${token}`;
test('the entry proof carries the accepted terms version; other or missing versions no longer admit',async()=>{
 const token=await siloInviteProof(secret,open,null),[expires,label,nonce,terms]=token.split('.');
 assert.equal(terms,SILO_BETA_TERMS.replace('silo-beta-terms-',''));assert.equal(await siloInviteValid(secret,open,cookie(token)),true);
 const sign=payload=>`${payload}.${createHmac('sha256',secret).update(payload).digest('hex')}`;
 const legacy=sign(`${expires}.${label}.${nonce}`),other=sign(`${expires}.${label}.${nonce}.v0`),future=sign(`${expires}.${label}.${nonce}.v2`);
 assert.equal(await siloInviteValid(secret,open,cookie(legacy)),false,'a proof from before the terms (no version) no longer admits');
 assert.equal(await siloInviteValid(secret,open,cookie(other)),false,'a proof under another terms version no longer admits');
 assert.equal(await siloInviteValid(secret,open,cookie(future)),false);
 assert.equal(await siloInviteValid(secret,open,cookie(sign(`${expires}.${label}.${nonce}.${terms}`))),true,'control: the same fields under the current version admit');
 assert.equal(siloInviteToken(cookie(legacy)),null,'the transfer binding ignores a legacy proof');
 const invite={SILO_NETWORK:'mainnet',SILO_BETA_INVITES:sha(code),RPC_SESSION_SECRET:secret},inviteToken=await siloInviteProof(secret,invite,code);
 assert.equal(inviteToken.split('.')[3],terms,'invite redemption records the terms version too');
});
