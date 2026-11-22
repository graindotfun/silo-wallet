// Contacts inside the unified backup file. The address book is sealed as ONE extra envelope (zone 'contacts', same AES-256-GCM and
// PBKDF2 seal as the wallet parts) and stored under the file's top-level `contacts` key. The file format stays v1, v2 or v3: a client
// that predates the address book ignores the extra key and restores its wallets exactly as before (it just does not see the contacts),
// and a client with the address book opens a file with no `contacts` key as before. The wallet parts, their names and the file
// identifier are untouched. Contacts are never written in plain text into a backup.
import {sealSilo,openSilo} from './local-envelope.mjs';
import {siloContactsData,siloContactsFromData} from './contacts.mjs';
import {isSiloUnifiedBackup,siloBackupHasContacts} from './unified-backup.mjs';
export {siloBackupHasContacts};

/** Returns a copy of a unified backup `file` that also carries the sealed contacts. A file that is not unified, or an empty list,
 * is returned unchanged. `passphrase` is the one that sealed the wallet part being exported. */
export async function attachSiloContacts(file,contacts,passphrase){
 if(!isSiloUnifiedBackup(file)||!contacts.length)return file;
 const envelope=await sealSilo('contacts','local',siloContactsData(contacts),passphrase);
 return {...file,contacts:envelope};
}
/** Opens the contacts of a backup file. Returns `{contacts,dropped}`; throws when the passphrase is wrong or the file has none. */
export async function openSiloBackupContacts(file,passphrase){
 if(!siloBackupHasContacts(file))throw Object.assign(Error('This backup file has no saved contacts.'),{siloContact:'none'});
 return siloContactsFromData(await openSilo(file.contacts,passphrase));
}
