/** The unresolved-attempt record for an EVM transfer, kept durably (browser storage) from just BEFORE the signed bytes are
 * sent until the outcome is known. While one exists for a wallet address, nothing may be reviewed or signed for that address:
 * a lost or unclear broadcast can otherwise be retried as a NEW payment (next nonce) while the first one lands too.
 * Keyed by wallet address only, so a chain change, a lock, a remount or a reload cannot hide it. Pure module: storage is injected. */
const KEY=address=>`silo-evm-attempt:${String(address).toLowerCase()}`;
const fail=(message,reason)=>Object.assign(Error(message),{siloEvmAttempt:reason});
const HEX=/^0x[0-9a-f]+$/;
function valid(value,address){
 return Boolean(value&&typeof value==='object'&&['signed','uncertain','accepted'].includes(value.state)&&Number.isSafeInteger(value.chainId)&&Number.isSafeInteger(value.nonce)
  &&typeof value.hash==='string'&&/^0x[0-9a-f]{64}$/.test(value.hash)&&typeof value.raw==='string'&&HEX.test(value.raw)&&value.raw.length<2000&&value.from?.toLowerCase()===String(address).toLowerCase());
}
/** The stored attempt for this wallet, or null. A record that cannot be parsed is treated as UNRESOLVED (fail closed), not as absent. */
export function readSiloEvmAttempt(storage,address){
 let text;try{text=storage.getItem(KEY(address));}catch{throw fail('Saved transfer state is unavailable. Sending is paused.','storage');}
 if(text===null||text===undefined)return null;
 let value;try{value=JSON.parse(text);}catch{throw fail('A saved transfer could not be read. Sending is paused for this wallet.','corrupt');}
 if(!valid(value,address))throw fail('A saved transfer could not be read. Sending is paused for this wallet.','corrupt');
 return value;
}
/** Throws while an attempt is unresolved or storage cannot be trusted. Called before review and again before signing. */
export function assertSiloEvmCanSend(storage,address){
 const attempt=readSiloEvmAttempt(storage,address);
 if(attempt)throw fail('A previous transfer is not resolved yet. Check it first; a second payment is not allowed until then.','unresolved');
}
/** Persists the signed transfer BEFORE it is sent. If the write fails, the caller must not send. */
export function beginSiloEvmAttempt(storage,{from,chainId,nonce,hash,raw,now=Date.now}){
 const record={state:'signed',from,chainId,nonce,hash,raw,at:now()};
 if(!valid(record,from))throw fail('Invalid transfer record.','shape');
 try{storage.setItem(KEY(from),JSON.stringify(record));if(storage.getItem(KEY(from))!==JSON.stringify(record))throw Error();}
 catch{throw fail('This browser cannot save the transfer state, so sending is paused. Nothing was sent.','storage');}
 return record;
}
/** The node accepted the transaction. The record is KEPT (sending stays paused) until a receipt reaches the chain's confirmation
 * depth, so a transaction that was accepted but later dropped or replaced cannot be forgotten and paid for a second time. */
export function markSiloEvmAccepted(storage,address){
 const attempt=readSiloEvmAttempt(storage,address);if(!attempt)return null;
 const next={...attempt,state:'accepted'};try{storage.setItem(KEY(address),JSON.stringify(next));}catch{/* the earlier record still blocks sending */}
 return next;
}
export function markSiloEvmUncertain(storage,address){
 const attempt=readSiloEvmAttempt(storage,address);if(!attempt)return null;
 if(attempt.state==='accepted')return attempt;
 const next={...attempt,state:'uncertain'};try{storage.setItem(KEY(address),JSON.stringify(next));}catch{/* the signed record already exists and still blocks sending */}
 return next;
}
/** Clears the record. Only for a definite outcome: accepted, provably rejected, or resolved by a lookup. */
export function clearSiloEvmAttempt(storage,address){try{storage.removeItem(KEY(address));}catch{/* a failed removal keeps the block, which is the safe direction */}}
/** What a status lookup means for an unresolved attempt. Only POSITIVE evidence resolves it:
 * - `mined`: the transaction has a receipt; the payment happened (success or revert): clear;
 * - `confirming`: mined with a checked receipt but fewer confirmations than the chain's policy asks (a shallow reorg could still
 *   remove it): keep, and check again;
 * - `pending`: the node has the transaction and it is waiting: keep;
 * - `unknown`: neither a transaction nor a receipt was found: keep (the same signed bytes may be rebroadcast, idempotent);
 * - `unknown-nonce-advanced`: nothing found, but the sender's confirmed nonce moved past this nonce: keep. Independent reads can
 *   straddle the block that mines it, and a used nonce does not prove this payment did not happen, so this is never a reason to clear.
 * A refusal on a retry is not evidence either (see siloEvmSettleDecision). */
export function siloEvmAttemptResolution(attempt,lookup){
 if(lookup?.mined)return lookup.final===false?'confirming':'mined';
 if(lookup?.known)return 'pending';
 if(Number.isSafeInteger(lookup?.nonceLatest)&&lookup.nonceLatest>attempt.nonce)return 'unknown-nonce-advanced';
 return 'unknown';
}
/** How the send route's answer is read. Only the exact accepted shape is `accepted`; a 4xx is `refused`; everything else
 * (202 uncertain, 5xx, a hash that differs, an unreadable body, a thrown request) is `uncertain`. */
export function siloEvmClassifyResponse(status,body,expectedHash){
 if(status===200&&body&&typeof body==='object'&&body.hash===expectedHash)return 'accepted';
 if(status>=400&&status<500)return 'refused';
 return 'uncertain';
}
/** What an outcome does to the saved attempt. `accepted` KEEPS it, marked accepted, until the receipt is final (MC-N1). A refusal clears it ONLY
 * for the FIRST send of a freshly signed transfer, when nothing earlier could have been accepted. A refusal of a resend, whatever
 * its cause (nonce too low, 403, 429, 422), can mean the original already went through, so it never clears. `uncertain` never does. */
export function siloEvmSettleDecision({first,outcome}){
 if(outcome==='accepted')return 'accepted';
 if(outcome==='refused'&&first===true)return 'clear';
 return 'keep';
}

const ARCHIVE=address=>`silo-evm-attempt-archive:${String(address).toLowerCase()}`;
export const SILO_EVM_ARCHIVE_MAX=20;
/** What the person must type to clear by hand: the first 8 hex characters of the transaction id ("unreadable" for a record that
 * cannot be parsed). */
export function siloEvmClearToken(attempt){return attempt?.hash?String(attempt.hash).slice(2,10):'unreadable';}
export function readSiloEvmArchive(storage,address){
 let text;try{text=storage.getItem(ARCHIVE(address));}catch{throw fail('The list of cleared transfers cannot be read, so nothing was cleared.','archive');}
 if(text===null||text===undefined)return [];
 let list;try{list=JSON.parse(text);}catch{throw fail('The list of cleared transfers cannot be read, so nothing was cleared.','archive');}
 if(!Array.isArray(list))throw fail('The list of cleared transfers cannot be read, so nothing was cleared.','archive');
 return list;
}
/** Manual clear of an unresolved record, for a person who checked elsewhere. Sending again can pay twice, so: the exact token must
 * be typed, the signed bytes are SAVED to a list in this browser BEFORE the record is removed (an unreadable record is saved WHOLE
 * as text, never truncated; if that does not fit, nothing is cleared), and if the list cannot be read, written back or is full, nothing is cleared. */
export function archiveAndClearSiloEvmAttempt(storage,address,{token,now=Date.now}){
 let text;try{text=storage.getItem(KEY(address));}catch{throw fail('Saved transfer state is unavailable, so nothing was cleared.','storage');}
 if(text===null||text===undefined)return null;
 let attempt=null;try{const parsed=JSON.parse(text);if(valid(parsed,address))attempt=parsed;}catch{/* kept as text below */}
 if(token!==siloEvmClearToken(attempt))throw fail('Type the first 8 characters of the transaction id to confirm.','confirm');
 const list=readSiloEvmArchive(storage,address);
 if(list.length>=SILO_EVM_ARCHIVE_MAX)throw fail('The list of cleared transfers is full, so nothing was cleared.','archive');
 const entry={clearedAt:now(),...(attempt?{attempt}:{unreadable:String(text)})};
 const next=JSON.stringify([...list,entry]);
 try{storage.setItem(ARCHIVE(address),next);if(storage.getItem(ARCHIVE(address))!==next)throw Error();}
 catch{throw fail('The cleared transfer could not be saved, so nothing was cleared.','archive');}
 try{storage.removeItem(KEY(address));}catch{throw fail('The record could not be removed.','storage');}
 return entry;
}
