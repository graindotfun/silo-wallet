/** Expired-unknown attempts are preserved separately, never terminal receipts,
 * never auto-pruned and never transport authority. Capacity exhaustion fails closed. */
import {sha256} from '@noble/hashes/sha256';
import {Buffer} from 'buffer';
import {VersionedTransaction} from '@solana/web3.js';
import {validateSiloManagedJournal,validateSiloManagedTerminalReceipt} from './jupiter-managed-journal.mjs';
import {validateSiloManagedExpiryProof} from './managed-expiry-proof.mjs';
export const SILO_MANAGED_UNRESOLVED_KEY='grain-silo-jupiter-pending-v1-managed-unresolved';
const MAX_ROWS=4,MAX_BYTES=262144;
export const siloManagedJournalHash=row=>Buffer.from(sha256(new TextEncoder().encode(JSON.stringify(row)))).toString('hex');
const fail=()=>{throw Error('Unresolved swap archive cannot be verified; preserve the hold.');};
export function assertSiloManagedExpiryIdentity(row,p){validateSiloManagedJournal(row);validateSiloManagedExpiryProof(p,{complete:true});const r=row.review,tx=VersionedTransaction.deserialize(Buffer.from(r.capture.originalTransaction,'base64'));if(p.journalHash!==siloManagedJournalHash(row)||p.owner!==r.contract.owner||p.blockhash!==tx.message.recentBlockhash||p.messageHash!==r.capture.messageHash||p.reviewHash!==r.capture.captureHash||p.primarySlot!==r.primarySlot||p.signature!==(row.signature??null)||row.kind==='silo-jupiter-managed-signing-v1'&&row.promptStarted!==true)fail();return true;}
export function readSiloManagedUnresolved(storage,validateReceipt=validateSiloManagedTerminalReceipt){
 const text=storage.getItem(SILO_MANAGED_UNRESOLVED_KEY);if(text===null)return {kind:'silo-managed-unresolved-v1',rows:[]};if(new TextEncoder().encode(text).length>MAX_BYTES)fail();const a=JSON.parse(text);if(!a||Object.keys(a).sort().join('|')!=='kind|rows'||a.kind!=='silo-managed-unresolved-v1'||!Array.isArray(a.rows)||a.rows.length>MAX_ROWS)fail();const seen=new Set();
 for(const entry of a.rows){if(!entry||Object.keys(entry).sort().join('|')!=='archivedAt|journalText|proof|resolution'||typeof entry.journalText!=='string'||!Number.isSafeInteger(entry.archivedAt)||entry.archivedAt<0)fail();const row=JSON.parse(entry.journalText);assertSiloManagedExpiryIdentity(row,entry.proof);if(seen.has(entry.proof.journalHash))fail();seen.add(entry.proof.journalHash);if(entry.resolution!==null){validateReceipt(entry.resolution);if(JSON.stringify(entry.resolution.journal.review)!==JSON.stringify(row.review)||entry.resolution.journal.createdAt!==row.createdAt)fail();}}
 return a;
}
export function unresolvedSiloManagedRows(storage,validateReceipt=validateSiloManagedTerminalReceipt){return readSiloManagedUnresolved(storage,validateReceipt).rows.filter(r=>r.resolution===null);}
function persist(storage,archive){const text=JSON.stringify(archive);if(new TextEncoder().encode(text).length>MAX_BYTES)fail();storage.setItem(SILO_MANAGED_UNRESOLVED_KEY,text);if(storage.getItem(SILO_MANAGED_UNRESOLVED_KEY)!==text)fail();}
export function saveSiloManagedUnresolved(storage,journalText,proof,archivedAt,validateReceipt){const a=readSiloManagedUnresolved(storage,validateReceipt),row=JSON.parse(journalText);assertSiloManagedExpiryIdentity(row,proof);const existing=a.rows.find(r=>r.proof.journalHash===proof.journalHash);if(existing){if(existing.journalText!==journalText||existing.resolution!==null)fail();return;}if(a.rows.length>=MAX_ROWS)fail();persist(storage,{...a,rows:[...a.rows,{journalText,proof,archivedAt,resolution:null}]});}
export function resolveSiloManagedUnresolved(storage,journalHash,receipt,validateReceipt){const a=readSiloManagedUnresolved(storage,validateReceipt),entry=a.rows.find(r=>r.proof.journalHash===journalHash);if(!entry||entry.resolution!==null)fail();validateReceipt(receipt);const row=JSON.parse(entry.journalText);if(JSON.stringify(receipt.journal.review)!==JSON.stringify(row.review)||receipt.journal.createdAt!==row.createdAt)fail();persist(storage,{...a,rows:a.rows.map(r=>r===entry?{...r,resolution:receipt}:r)});return receipt.outcome;}
