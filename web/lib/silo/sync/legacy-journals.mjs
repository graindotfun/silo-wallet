/** Exact legacy recovery bytes, not protocol approval. Even a receipt claiming a
 * terminal outcome is held until its specific verifier is integrated. Never signs,
 * reads providers, rewrites legacy slots, or treats a missing local slot as closure. */
import { sha256 } from '@noble/hashes/sha256';
import { canonical, hex, utf8 } from './codec.mjs';
export const LEGACY_JOURNAL_KEYS = Object.freeze([
 'grain-silo-solana-pending-v1', 'grain-silo-jupiter-pending-v1',
 'grain-silo-jupiter-pending-v1-receipt', 'grain-silo-jupiter-pending-v1-direct-receipt',
 'grain-silo-jupiter-pending-v1-shared-receipt', 'grain-silo-jupiter-pending-v1-managed-receipt',
 'grain-silo-jupiter-pending-v1-managed-receipt-history',
]);
const MAX_TOTAL = 2 * 1024 * 1024, MAX_RECORDS = 64;
const limit = key => key.endsWith('-history') ? 1024 * 1024 : key === LEGACY_JOURNAL_KEYS[0] ? 4096 : 65536;
const digest = record => hex(sha256(utf8(canonical({storageKey:record.storageKey,text:record.text}))));
function assertRecord(record) {
 if (!record || Object.keys(record).sort().join(',') !== 'sha256,storageKey,text' || !LEGACY_JOURNAL_KEYS.includes(record.storageKey)
   || typeof record.text !== 'string' || utf8(record.text).length > limit(record.storageKey)
   || typeof record.sha256 !== 'string' || record.sha256 !== digest(record)) throw Error('sync-legacy-recovery-record-invalid');
 return record;
}
export function assertLegacyJournalSnapshot(value) {
 const copy = structuredClone(value);
 if (!copy || Object.keys(copy).sort().join(',') !== 'records,schema' || copy.schema !== 'silo-sync-legacy-journals-v1'
  || !Array.isArray(copy.records) || copy.records.length > MAX_RECORDS) throw Error('sync-legacy-recovery-snapshot-invalid');
 let bytes = 0; const seen = new Set();
 for (const record of copy.records) {
  assertRecord(record); bytes += utf8(record.text).length;
  if (bytes > MAX_TOTAL || seen.has(record.sha256)) throw Error('sync-legacy-recovery-budget-or-duplicate');
  seen.add(record.sha256);
 }
 copy.records.sort((a,b)=>a.storageKey.localeCompare(b.storageKey)||a.sha256.localeCompare(b.sha256));
 return copy;
}
export function captureLegacyJournals(storage) {
 const records = [];
 for (const storageKey of LEGACY_JOURNAL_KEYS) {
  const text = storage.getItem(storageKey);
  if (text !== null) { if (typeof text!=='string' || utf8(text).length>limit(storageKey)) throw Error('sync-legacy-recovery-record-invalid'); records.push({storageKey,text,sha256:digest({storageKey,text})}); }
 }
 // Detect in-flight changes rather than accepting a mixed snapshot. This cannot
 // prevent a change after return; every later capture appends another held version.
 for (const record of records) if (storage.getItem(record.storageKey) !== record.text) throw Error('sync-legacy-recovery-local-change');
 for (const storageKey of LEGACY_JOURNAL_KEYS) if (!records.some(r=>r.storageKey===storageKey) && storage.getItem(storageKey)!==null) throw Error('sync-legacy-recovery-local-change');
 return assertLegacyJournalSnapshot({schema:'silo-sync-legacy-journals-v1',records});
}
export function legacyJournalEntries(snapshot, {createdBy, now}) {
 snapshot = assertLegacyJournalSnapshot(snapshot);
 if (typeof createdBy !== 'string' || !createdBy || !Number.isSafeInteger(now) || now < 0) throw Error('sync-legacy-recovery-origin');
 return Object.fromEntries(snapshot.records.map(record => {
  const opId=record.sha256.slice(0,32);
  // The enclosing network is the target sync profile, not verification of the raw protocol's network.
  return [opId,{opId,kind:record.storageKey===LEGACY_JOURNAL_KEYS[0]?'solana-transfer':'jupiter-swap',network:'mainnet-beta',reviewHash:record.sha256,
    binding:{messageHash:record.sha256},createdBy,state:'prompt-started',createdAt:now,updatedAt:now,
    legacyRecovery:{schema:'silo-sync-legacy-recovery-entry-v1',...record}}];
 }));
}
export function assertLegacyJournalEntry(entry) {
 const legacy=entry?.legacyRecovery;
 if (!legacy || Object.keys(legacy).sort().join(',')!=='schema,sha256,storageKey,text' || legacy.schema!=='silo-sync-legacy-recovery-entry-v1') throw Error('sync-legacy-recovery-entry-invalid');
 const record={storageKey:legacy.storageKey,text:legacy.text,sha256:legacy.sha256}; assertRecord(record);
 if (entry.opId!==record.sha256.slice(0,32) || entry.reviewHash!==record.sha256 || entry.binding?.messageHash!==record.sha256
   || entry.network!=='mainnet-beta' || entry.state!=='prompt-started' || entry.signed || entry.claim || entry.receipt
   || entry.kind!==(record.storageKey===LEGACY_JOURNAL_KEYS[0]?'solana-transfer':'jupiter-swap')) throw Error('sync-legacy-recovery-entry-binding');
 return entry;
}
export function legacyJournalSnapshot(journal) {
 const records=Object.values(journal?.entries??{}).filter(entry=>entry.legacyRecovery).map(entry=>{
  assertLegacyJournalEntry(entry);const legacy=entry.legacyRecovery;return {storageKey:legacy.storageKey,text:legacy.text,sha256:legacy.sha256};
 });
 return assertLegacyJournalSnapshot({schema:'silo-sync-legacy-journals-v1',records});
}
/** Public API returns a held exact-byte recovery plan; it never installs a record,
 * selects one conflicting version, trusts claimed terminality, or discards a hold. */
export function planLegacyJournalRecovery(snapshot, storage) {
 snapshot=assertLegacyJournalSnapshot(snapshot);const grouped=new Map(),conflicts=[],missing=[];
 for(const record of snapshot.records){const variants=grouped.get(record.storageKey)??[];variants.push(record);grouped.set(record.storageKey,variants);}
 for(const [storageKey,variants] of grouped){const text=storage.getItem(storageKey);if(variants.length!==1||text!==null&&text!==variants[0].text)conflicts.push(storageKey);else if(text===null)missing.push(storageKey);}
 return {held:snapshot.records.length>0,records:snapshot.records,conflicts,missing,protocolVerified:false};
}
