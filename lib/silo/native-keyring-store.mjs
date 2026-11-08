// SPDX-License-Identifier: AGPL-3.0-only
/** Ciphertext-only, distinct from the Monero vault and account prototype. Same-origin
 * Web Locks excludes cooperating tabs; it is not a hardware/key revocation boundary. */
export async function openNativeKeyringStore(chain, { factory = globalThis.indexedDB, locks = globalThis.navigator?.locks, network = 'mainnet' } = {}) {
  if (network !== 'mainnet' && !(network === 'devnet' && chain === 'solana')) throw Error('Unsupported native wallet network.');
  if (!['solana', 'evm'].includes(chain) || !factory || !locks?.request) throw Error('Native wallet storage and exclusive tab locking are required.');
  let release, database, cancelOpen, closed = false; const listeners = new Set();
  const pagehide = () => close();
  const close = () => { if (!closed) { closed = true; globalThis.removeEventListener?.('pagehide', pagehide); database?.close(); release?.(); cancelOpen?.(Error('Native wallet store was closed while opening.')); for (const listener of listeners) listener(); listeners.clear(); } };
  globalThis.addEventListener?.('pagehide', pagehide);
  const acquired = new Promise((resolve, reject) => {
    cancelOpen = reject;
    locks.request(`silo-native-keyring-v1:${chain}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (closed) { reject(Error('Native wallet store was closed while opening.')); return; }
      if (!lock) { reject(Error('Native wallet is open in another tab.')); return; }
      const held = new Promise(done => { release = done; }); resolve(); await held;
    }).catch(reject);
  });
  try {
    await acquired;
    if (closed) throw Error('Native wallet store was closed while opening.');
    database = await new Promise((resolve, reject) => {
      let refused = false;
      cancelOpen = reject;
      const request = factory.open(`silo-native-keyring-v1-${chain}`, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('vault');
      request.onsuccess = () => { if (refused || closed) { request.result.close(); reject(Error('Native wallet store was closed while opening.')); return; } resolve(request.result); };
      request.onerror = request.onblocked = () => { refused = true; reject(Error('Native wallet storage is unavailable.')); };
    });
    cancelOpen = undefined;
    if (closed) { database.close(); throw Error('Native wallet store was closed while opening.'); }
    database.onversionchange = close;
  } catch (error) { close(); throw error; }
  const transact = (mode, create) => new Promise((resolve, reject) => {
    if (closed) { reject(Error('Native wallet store is closed.')); return; }
    let result; const tx = database.transaction('vault', mode), vault = tx.objectStore('vault'), request = vault.get('wallet');
    request.onsuccess = () => {
      if (mode === 'readonly') result = request.result ?? null;
      else if (!request.result) { vault.add(create, 'wallet'); result = true; } else result = false;
    };
    tx.oncomplete = () => resolve(result); tx.onabort = tx.onerror = () => reject(Error('Native wallet storage failed.'));
  });
  const names = ['scope','version','chain','network','address','kdf','iterations','cipher','salt','iv','ciphertext'];
  const invalid = envelope => (!envelope || Object.keys(envelope).length !== names.length || names.some(name => !Object.hasOwn(envelope, name))
        || envelope.scope !== 'silo-native-keyring-v1' || envelope.version !== 1 || envelope.chain !== chain || envelope.network !== network
        || envelope.kdf !== 'PBKDF2-SHA256' || envelope.iterations !== 600000 || envelope.cipher !== 'AES-256-GCM'
        || typeof envelope.address !== 'string' || envelope.address.length > 64
        || !/^[0-9a-f]{32}$/.test(envelope.salt) || !/^[0-9a-f]{24}$/.test(envelope.iv) || !/^[0-9a-f]{96}$/.test(envelope.ciphertext));
  return {
    get closed() { return closed; }, read: () => transact('readonly'),
    create: envelope => {
      if (invalid(envelope)) return Promise.reject(Error('Only an encrypted native wallet envelope may be stored.'));
      return transact('readwrite', structuredClone(envelope));
    },
    /** Replaces the stored wallet with another sealed envelope of the SAME address in ONE transaction (the old copy is never absent): used only by the
     * one-passphrase switch, after the new file was verified. Refuses when nothing is stored, when the address differs, or when the envelope is malformed. */
    replace: envelope => new Promise((resolve, reject) => {
      if (closed) { reject(Error('Native wallet store is closed.')); return; }
      if (invalid(envelope)) { reject(Error('Only an encrypted native wallet envelope may be stored.')); return; }
      let ok = false; const tx = database.transaction('vault', 'readwrite'), vault = tx.objectStore('vault'), request = vault.get('wallet');
      request.onsuccess = () => { const current = request.result; if (current && current.address === envelope.address) { vault.put(structuredClone(envelope), 'wallet'); ok = true; } else tx.abort(); };
      tx.oncomplete = () => resolve(ok); tx.onabort = tx.onerror = () => reject(Error('Native wallet storage failed.'));
    }),
    /** Deletes this browser's encrypted copy of the wallet. The caller has already shown the person what that means and asked for a typed confirmation; no passphrase is needed (someone who cannot unlock must still be able to clear the slot). */
    remove: () => new Promise((resolve, reject) => {
      if (closed) { reject(Error('Native wallet store is closed.')); return; }
      const tx = database.transaction('vault', 'readwrite'); tx.objectStore('vault').delete('wallet');
      tx.oncomplete = () => resolve(true); tx.onabort = tx.onerror = () => reject(Error('Native wallet storage failed.'));
    }),
    close,
    onClose(listener) { if (closed) listener(); else listeners.add(listener); },
  };
}
