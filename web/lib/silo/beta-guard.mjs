// Mainnet beta guards (owner decisions, 21 and 23 October 2026): admission by invitation or, with SILO_BETA_ACCESS=open, by a
// code-less entry proof for everyone; a cap per wallet action; a kill switch that stops new payments without touching access
// to funds or backups; and the standing notice that the beta is not externally audited. Everything here is configuration-driven and secret-free: the invite allowlist holds SHA-256 hashes of codes, the
// invite cookie is an HMAC under the existing RPC session secret, and no code, hash or secret ever reaches the client.
import {SILO_BETA_TERMS} from './beta-terms.mjs';
const encoder=new TextEncoder();
const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
export const SILO_BETA_COOKIE='silo-invite';
// Entry-proof lifetime (owner decision, 28 October 2026: shortened from 30 days to 8 hours to bound how long the
// server, or anything that sees the cookie on repeat requests, can link this browser's requests to one entry proof —
// disclosed in ownerRiskAcceptance). Re-entering after expiry issues a fresh proof with a new nonce; nothing about the
// now-expired proof is retained once it is replaced.
export const SILO_BETA_INVITE_MAX_AGE_SECONDS=8*3600;
export const SILO_BETA_DEFAULT_CAPS=Object.freeze({sol:'1',xmr:'0.5'});
export const SILO_BETA_NOTICE='Beta, not externally audited. Use small amounts.';
// Open beta (owner decision, 23 October 2026): everyone may enter. Entry still issues the same per-browser HMAC proof (cookie,
// expiry, fresh nonce), so every guard built on it (session admission, transfer binding, budgets) keeps working; the proof's
// prefix is this fixed public marker instead of an invite-code hash. Open access is explicit (SILO_BETA_ACCESS=open): a mainnet
// deployment without it stays invite-only, and with no allowlist admits nobody, as before.
export const SILO_BETA_OPEN_ENTRY='silo-open-entry-v1';
// SHA-256 of SILO_BETA_OPEN_ENTRY (pinned by tests/silo-beta-open-access.test.mjs).
const SILO_BETA_OPEN_ENTRY_HASH='a9e2cc096e89ff5040e8c971814487880bab7818bffb9827746c075945d70006';

/** Decimal text in whole units to integer base units (lamports: 9 decimals; piconero: 12). Refuses anything else. */
export function siloBetaUnits(value,decimals){
 if(typeof value!=='string'||!/^\d+(\.\d+)?$/.test(value))throw Error('Invalid beta cap.');
 const [whole,frac='']=value.split('.');if(frac.length>decimals)throw Error('Beta cap has too many decimals.');
 return BigInt(whole+frac.padEnd(decimals,'0'));
}
/** The beta configuration as the server reads it. Only `closed`, `open`, `paused`, `caps` and `auditDeferred` are meant for the client. */
export function siloBetaConfiguration(env={},{auditDeferred=false}={}){
 const invites=typeof env.SILO_BETA_INVITES==='string'?env.SILO_BETA_INVITES.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean):[];
 if(invites.some(h=>!/^[a-f0-9]{64}$/.test(h)))throw Error('SILO_BETA_INVITES must hold SHA-256 hashes of invite codes.');
 const sol=env.SILO_BETA_CAP_SOL??SILO_BETA_DEFAULT_CAPS.sol,xmr=env.SILO_BETA_CAP_XMR??SILO_BETA_DEFAULT_CAPS.xmr;
 // Fail closed (review N3): a mainnet deployment is a closed beta whether or not an allowlist is configured; with no
 // allowlist nobody is admitted. Only a test deployment with no allowlist is unrestricted. Mainnet opens to everyone only through
 // the explicit SILO_BETA_ACCESS=open mode below, which still requires the entry proof, and only on release evidence reviewed
 // for open admission (lib/silo/release-gate.mjs).
 // SILO_BETA_ACCESS is absent, 'invite' or 'open'; anything else is a configuration error (fail closed).
 const access=env.SILO_BETA_ACCESS??'invite';if(access!=='invite'&&access!=='open')throw Error('SILO_BETA_ACCESS must be invite or open.');
 const mainnet=env.SILO_NETWORK==='mainnet',allowlisted=invites.length>0,open=access==='open';
 return Object.freeze({closed:allowlisted||mainnet||open,allowlisted,open,paused:env.SILO_BETA_PAUSED==='true',caps:Object.freeze({sol,xmr,solLamports:siloBetaUnits(sol,9).toString(),xmrAtomic:siloBetaUnits(xmr,12).toString()}),auditDeferred:auditDeferred===true,notice:SILO_BETA_NOTICE});
}
/** What the browser may know: no hashes, no secret. */
export function siloBetaPublic(beta){return {closed:beta.closed,open:beta.open===true,paused:beta.paused,caps:{sol:beta.caps.sol,xmr:beta.caps.xmr,solLamports:beta.caps.solLamports,xmrAtomic:beta.caps.xmrAtomic},auditDeferred:beta.auditDeferred,notice:beta.notice};}

export async function siloInviteHash(code){if(typeof code!=='string'||code.length<8||code.length>128)throw Error('Invalid invite code.');return hex(await crypto.subtle.digest('SHA-256',encoder.encode(code.trim())));}
async function hmacKey(secret){if(typeof secret!=='string'||secret.length<32)throw Error('Beta invite protection is not configured.');return crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
/** A code is accepted when its hash is in the allowlist; the proof is an HMAC over the hash prefix, an expiry and a fresh
 * random nonce, never the code. The nonce makes every redemption its own proof (candidate review, round 7: two browsers that
 * redeem the same code within the same second must not share a proof or a transfer binding). */
// The accepted terms version is part of the signed proof (Sol, review of 15a0afbf, R6-M2): 'silo-beta-terms-v1' is carried as
// 'v1'. A proof made under any other version (or before terms existed) no longer admits, so its holder sees the entry page and
// accepts the current terms again. Nothing else about the acceptance is recorded: the proof shows that this browser's entry
// request carried the current terms version at the proof's issue time (its expiry minus 30 days); it does not verify an age.
const SILO_BETA_TERMS_TAG=SILO_BETA_TERMS.replace(/^silo-beta-terms-/,'');
const SILO_BETA_PROOF=/^(\d{1,12})\.([a-f0-9]{16})\.([a-f0-9]{32})\.(v\d{1,4})\.([a-f0-9]{64})$/;
export async function siloInviteProof(secret,env,code,now=Date.now(),nonce=hex(crypto.getRandomValues(new Uint8Array(16)))){
 const beta=siloBetaConfiguration(env);
 // Open entry: no code; the proof carries the open-entry marker. A code is still accepted in open mode if it is allowlisted.
 const hash=code===null&&beta.open?SILO_BETA_OPEN_ENTRY_HASH:await siloInviteHash(code);
 if(!beta.closed||!siloBetaAdmitted(env,beta).includes(hash))throw Error('Invite code not accepted.');
 if(!/^[a-f0-9]{32}$/.test(nonce))throw Error('Invalid invite nonce.');
 const expires=Math.floor(now/1000)+SILO_BETA_INVITE_MAX_AGE_SECONDS,payload=`${expires}.${hash.slice(0,16)}.${nonce}.${SILO_BETA_TERMS_TAG}`;
 return `${payload}.${hex(await crypto.subtle.sign('HMAC',await hmacKey(secret),encoder.encode(payload)))}`;
}
/** The proof prefixes admitted right now: the invite allowlist, plus the open-entry marker while the beta is open. Closing the
 * open beta therefore invalidates every open-entry cookie at once. */
function siloBetaAdmitted(env,beta){const allowed=(env.SILO_BETA_INVITES??'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);return beta.open?[...allowed,SILO_BETA_OPEN_ENTRY_HASH]:allowed;}
export async function siloInviteValid(secret,env,cookieHeader,now=Date.now()){
 const beta=siloBetaConfiguration(env);if(!beta.closed)return true;if(!beta.allowlisted&&!beta.open)return false;
 const token=String(cookieHeader??'').split(';').map(x=>x.trim()).find(x=>x.startsWith(SILO_BETA_COOKIE+'='))?.slice(SILO_BETA_COOKIE.length+1);
 const match=SILO_BETA_PROOF.exec(token??'');if(!match)return false;
 const [,expires,prefix,nonce,terms,signature]=match;if(Number(expires)*1000<now||terms!==SILO_BETA_TERMS_TAG)return false;
 if(!siloBetaAdmitted(env,beta).some(h=>h.startsWith(prefix)))return false;
 const bytes=Uint8Array.from(signature.match(/../g).map(h=>parseInt(h,16)));
 return crypto.subtle.verify('HMAC',await hmacKey(secret),bytes,encoder.encode(`${expires}.${prefix}.${nonce}.${terms}`));
}
/** The proof token this browser carries, or null. Never the code or the full hash. */
export function siloInviteToken(cookieHeader){const token=String(cookieHeader??'').split(';').map(x=>x.trim()).find(x=>x.startsWith(SILO_BETA_COOKIE+'='))?.slice(SILO_BETA_COOKIE.length+1);return SILO_BETA_PROOF.test(token??'')?token:null;}
export function siloInviteCookie(token,url){const secure=new URL(url).protocol==='https:'?'; Secure':'';return `${SILO_BETA_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SILO_BETA_INVITE_MAX_AGE_SECONDS}${secure}`;}

export const SILO_BETA_PAUSED_MESSAGE='The beta is paused: new payments and trades are stopped. Your funds and backups stay available.';
/** A refusal by the beta rules is typed (round 9): every layer between the rule and the person can tell it from a transport failure,
 * because a refusal happens before any bytes leave. `preDispatchRefusal` is the protocol-neutral mark the transports rethrow. */
const refusal=(message,code)=>Object.assign(Error(message),{code,siloBetaRefusal:true,preDispatchRefusal:true});
export const isSiloBetaRefusal=error=>Boolean(error&&typeof error==='object'&&error.siloBetaRefusal===true);
/** Action guards: the pause, the SOL cap (lamports) and the XMR cap (piconero). Used by the server routes for Solana and, for
 * Monero, by the page before it prepares, submits and relays (the Monero side has no server; see SILO_BETA_MONERO_LIMITS). */
/** @param {{paused:boolean,caps:{sol:string,xmr:string,solLamports:string,xmrAtomic:string}}} beta @param {{kind:string,lamports?:string|number|bigint|null,xmrAtomic?:string|null}} action */
export function assertSiloBetaAction(beta,{kind,lamports=null,xmrAtomic=null}){
 if(beta.paused)throw refusal(SILO_BETA_PAUSED_MESSAGE,'beta-paused');
 if(lamports!==null&&BigInt(lamports)>BigInt(beta.caps.solLamports))throw refusal(`Beta limit: up to ${beta.caps.sol} SOL per ${kind}.`,'beta-cap');
 if(xmrAtomic!==null&&BigInt(xmrAtomic)>BigInt(beta.caps.xmrAtomic))throw refusal(`Beta limit: up to ${beta.caps.xmr} XMR per ${kind}.`,'beta-cap');
}
/** Live admission for an authoritative mainnet route (review N2): the invitation (when the beta is closed), the pause, and the
 * cap, all read from the environment at the moment of the call so a flipped switch counts at once. `lamports` is the amount
 * the route itself derived from the authenticated review or transaction, never from free request fields. Throws to refuse. */
/** @param {Record<string,any>} env @param {{headers:{get?:(name:string)=>string|null}|null|undefined,kind:string,lamports?:string|number|bigint|null,paused?:boolean}} options */
export async function siloBetaAdmission(env,{headers,kind,lamports=null,paused=true}){
 const cookie=headers?.get?.('Cookie')??null;
 // The proof check is the only wait here. The policy (pause, caps) is read AFTER it, so a switch flipped during the wait counts
 // (round 9, Sol's stale-snapshot finding); and if the allowlist changed during the wait, the proof is checked again against
 // the allowlist of the moment, so the invitation that passes is the one the current configuration admits.
 // The re-verification is bounded (SILO_BETA_ADMISSION_PASSES). When the configuration is still changing on the last pass, the
 // membership could not be verified against a stable configuration, and that ends in a typed refusal, never in an admission
 // on a stale check (round 10, Sol's B1).
 for(let attempt=1;attempt<=SILO_BETA_ADMISSION_PASSES;attempt++){
  const allowlist=env.SILO_BETA_INVITES,access=env.SILO_BETA_ACCESS,before=siloBetaConfiguration(env);
  const invited=before.closed?await siloInviteValid(env.RPC_SESSION_SECRET,env,cookie):true;
  const current=siloBetaConfiguration(env);
  // The allowlist or the access mode changed, or the beta closed, since this pass started: verify again under the configuration of the moment.
  if(env.SILO_BETA_INVITES!==allowlist||env.SILO_BETA_ACCESS!==access||(current.closed&&!before.closed))continue;
  if(!invited)throw refusal('Invitation required.','beta-invite');
  if(paused||lamports!==null)assertSiloBetaAction(current,{kind,lamports});
  return current;
 }
 throw refusal('Invitation could not be verified against a stable beta configuration. Nothing was sent; try again.','beta-unverified');
}
/** Passes `siloBetaAdmission` makes before it refuses a configuration that keeps changing under it. */
export const SILO_BETA_ADMISSION_PASSES=3;

/** Wrapped SOL: the one input mint the swap cap applies to (lib/silo/swap-admission.mjs reads each protocol's authenticated terms). */
export const SILO_WRAPPED_SOL_MINT='So11111111111111111111111111111111111111112';
