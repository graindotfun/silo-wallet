import { openSilo, sealSilo } from './local-envelope.mjs';

async function hashedId(id) {
  if (typeof id !== 'string' || !id.length || id.length > 512) throw Error('crosschain-store-id');
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id))), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
/** Encrypt before persistence; bind identity/revision inside authenticated payload.
 * The backend CAS must be atomic. close() clears the passphrase and closes backend. */
export function encryptedCrosschainStore(backend, passphrase) {
  let password = passphrase, closed = false;
  function unlocked() { if (password === null) throw Error('crosschain-store-locked'); }
  async function validateSaved(key, saved) {
    unlocked();
    if (saved?.envelope?.zone !== 'xmr' || saved.envelope.network !== 'mainnet') throw Error('crosschain-store-binding');
    const value = await openSilo(saved.envelope, password); unlocked();
    if (value?.schema !== 'silo-crosschain-order-v1' || !Number.isSafeInteger(saved.revision) || saved.revision < 0
      || value.record?.revision !== saved.revision || await hashedId(value.record.id) !== key) throw Error('crosschain-store-binding');
    unlocked(); return value.record;
  }
  async function entries() {
    unlocked(); const saved = await backend.entries(); unlocked();
    if (!Array.isArray(saved) || saved.length > 1000) throw Error('crosschain-store-count');
    return structuredClone(saved);
  }
  return {
    async read(id) {
      unlocked(); const key = await hashedId(id); unlocked();
      const saved = await backend.read(key); unlocked();
      if (!saved) return null;
      return validateSaved(key, structuredClone(saved));
    },
    async compareAndSwap(id, revision, record) {
      unlocked();
      // Pin the requested contents before the first await; callers cannot change the sealed operation mid-save.
      const next = structuredClone(record);
      if (next?.id !== id || (revision !== null && (!Number.isSafeInteger(revision) || revision < 0))
        || !Number.isSafeInteger(next.revision) || next.revision !== (revision === null ? 0 : revision + 1)) throw Error('crosschain-store-revision');
      const key = await hashedId(id); unlocked();
      const envelope = await sealSilo('xmr', 'mainnet', { schema: 'silo-crosschain-order-v1', record: next }, password); unlocked();
      const changed = await backend.compareAndSwap(key, revision, { revision: next.revision, envelope }); unlocked();
      return changed;
    },
    async list() {
      const saved = await entries(); unlocked();
      const records = await Promise.all(saved.map(([key, value]) => validateSaved(key, value))); unlocked();
      return records;
    },
    async exportEncrypted() {
      const saved = await entries(); unlocked();
      await Promise.all(saved.map(([key, value]) => validateSaved(key, value))); unlocked();
      return { schema: 'silo-crosschain-recovery-v1', entries: saved };
    },
    async importEncrypted(snapshot) {
      unlocked();
      if (snapshot?.schema !== 'silo-crosschain-recovery-v1' || !Array.isArray(snapshot.entries) || snapshot.entries.length > 1000) throw Error('crosschain-store-backup');
      // Validation and persistence must use the same immutable snapshot, including across asynchronous reads.
      const savedEntries = structuredClone(snapshot.entries), keys = new Set();
      for (const [key, saved] of savedEntries) {
        if (keys.has(key)) throw Error('crosschain-store-backup'); keys.add(key);
        await validateSaved(key, saved); unlocked();
      }
      const missing = [];
      // Refuse already-visible conflicts before adding anything. A later cross-tab CAS race can still partially commit;
      // never roll back/delete existing recovery data. An exact retry checks the preserved entries again.
      for (const [key, saved] of savedEntries) {
        unlocked(); const existing = await backend.read(key); unlocked();
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(saved)) throw Error('crosschain-store-existing-order');
        } else missing.push([key, saved]);
      }
      for (const [key, saved] of missing) {
        unlocked(); const changed = await backend.compareAndSwap(key, null, structuredClone(saved)); unlocked();
        if (!changed) throw Error('crosschain-concurrent-change');
      }
      // close() cannot retract a backend transaction already admitted; late completion is never reported as success.
    },
    close() { if (closed) return; closed = true; password = null; backend.close?.(); },
  };
}

/** Separate IndexedDB database, never the wallet database. IDB readwrite transactions
 * serialize CAS across tabs; completion is the durable save boundary. */
export async function openCrosschainStore(passphrase, factory = globalThis.indexedDB) {
  const database = await new Promise((resolve, reject) => {
    const request = factory.open('grain-silo-crosschain-orders-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('orders');
    request.onsuccess = () => resolve(request.result);
    request.onerror = request.onblocked = () => reject(Error('crosschain-store-unavailable'));
  });
  database.onversionchange = () => database.close();
  const backend = {
    read: (id) => new Promise((resolve, reject) => {
      let result; const transaction = database.transaction('orders', 'readonly');
      const request = transaction.objectStore('orders').get(id); request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result ?? null);
      transaction.onerror = transaction.onabort = () => reject(Error('crosschain-store-unavailable'));
    }),
    compareAndSwap: (id, revision, next) => new Promise((resolve, reject) => {
      let changed = false; const transaction = database.transaction('orders', 'readwrite'); const store = transaction.objectStore('orders');
      const request = store.get(id);
      request.onsuccess = () => {
        if ((request.result?.revision ?? null) === revision) { store.put(next, id); changed = true; }
      };
      transaction.oncomplete = () => resolve(changed);
      transaction.onerror = transaction.onabort = () => reject(Error('crosschain-store-save-failed'));
    }),
    entries: () => new Promise((resolve, reject) => {
      let keys, values; const transaction = database.transaction('orders', 'readonly'); const store = transaction.objectStore('orders');
      const keyRequest = store.getAllKeys(), valueRequest = store.getAll();
      keyRequest.onsuccess = () => { keys = keyRequest.result; }; valueRequest.onsuccess = () => { values = valueRequest.result; };
      transaction.oncomplete = () => resolve(keys.map((key, index) => [key, values[index]]));
      transaction.onerror = transaction.onabort = () => reject(Error('crosschain-store-unavailable'));
    }),
    close: () => database.close(),
  };
  return encryptedCrosschainStore(backend, passphrase);
}
