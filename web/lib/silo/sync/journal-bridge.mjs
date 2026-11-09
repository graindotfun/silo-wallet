/** Read-only bridge from the existing per-browser journals to the synced operation journal.
 *
 * The existing flows keep their own reviewed journals in localStorage ('grain-silo-solana-pending-v1' for Solana
 * transfers; 'grain-silo-jupiter-pending-v1' for every Jupiter variant, told apart by `kind`). This module only reads and
 * validates them with their own readers and describes the saved operation in the sync vocabulary:
 *   {kind, network, state, signature?, messageHash, owner, record}
 * so a flow can (1) reserve through sync before its wallet prompt with the same message hash, and (2) record the saved
 * record as signed evidence. It never writes either journal, builds, signs or sends anything.
 *
 * Wiring it into the signing components is a separate, explicitly scoped change (they are signing paths); see
 * docs/product/SILO_ACCOUNT_SYNC_DESIGN.md §15 for the exact call points. */
import {Buffer} from 'buffer';
import {sha256} from '@noble/hashes/sha256';
import {VersionedTransaction} from '@solana/web3.js';
import {readSiloTransferJournal} from '../solana-transfer-journal.mjs';
import {readSiloJupiterJournal} from '../jupiter-journal.mjs';
import {readSiloSharedJournal} from '../jupiter-shared-journal.mjs';
import {readSiloDirectJournal} from '../jupiter-direct-journal.mjs';
import {readSiloManagedJournal} from '../jupiter-managed-journal.mjs';
import {managedBindingHash} from './readers-variants.mjs';

export const SILO_TRANSFER_STORAGE_KEY = 'grain-silo-solana-pending-v1';
export const SILO_JUPITER_STORAGE_KEY = 'grain-silo-jupiter-pending-v1';
const messageHashOf = (base64) => Buffer.from(sha256(VersionedTransaction.deserialize(Buffer.from(base64, 'base64')).message.serialize())).toString('hex');
const promptState = (row, signed) => signed ? 'signed' : row.promptStarted === true ? 'prompt-started' : 'reserved';

const READERS = {
  readSiloTransferJournal, readSiloJupiterJournal, readSiloSharedJournal, readSiloDirectJournal, readSiloManagedJournal,
};

/** Describes the saved Solana transfer, if any. Throws if the saved record does not validate (the flow holds anyway). */
export function describeSavedTransfer(storage, impl = READERS) {
  const row = impl.readSiloTransferJournal(storage);
  if (!row) return null;
  const signed = row.state !== 'signing';
  return {kind: 'solana-transfer', network: row.network, state: promptState(row, signed), signature: signed ? row.signature : null, messageHash: messageHashOf(row.wire), owner: row.owner, record: row};
}

/** Describes the saved Jupiter operation of whichever variant is held, if any. */
export function describeSavedSwap(storage, impl = READERS) {
  const text = storage.getItem(SILO_JUPITER_STORAGE_KEY);
  if (text === null) return null;
  const kind = JSON.parse(text)?.kind ?? '';
  const variant = kind.startsWith('silo-jupiter-shared-') ? 'shared' : kind.startsWith('silo-jupiter-direct-') ? 'direct' : kind.startsWith('silo-jupiter-managed-') ? 'managed' : 'core';
  const row = variant === 'shared' ? impl.readSiloSharedJournal(storage) : variant === 'direct' ? impl.readSiloDirectJournal(storage) : variant === 'managed' ? impl.readSiloManagedJournal(storage) : impl.readSiloJupiterJournal(storage);
  if (!row) return null;
  const signed = /-signed-v1$/.test(row.kind);
  const messageHash = variant === 'managed' ? managedBindingHash(row.review?.capture?.captureHash) : variant === 'core' ? row.messageHash : row.context?.messageHash;
  const owner = variant === 'managed' ? row.review?.contract?.owner : variant === 'core' ? row.owner ?? row.terms?.owner : row.context?.derived?.owner;
  return {kind: 'jupiter-swap', variant, network: row.network, state: promptState(row, signed), signature: signed ? row.signature : null, messageHash, owner, record: row};
}

/** After a flow has saved a signed record: records it as evidence for the operation reserved through sync. */
export async function recordSavedAsSigned(client, opId, described) {
  if (!described || described.state !== 'signed' || !described.signature) throw Error('No signed record is saved yet.');
  const known = await client.operation(opId);
  if (!known || known.kind !== described.kind || known.binding?.messageHash !== described.messageHash) throw Error('The saved record is not the reserved operation.');
  if (known.state === 'reserved') await client.markPromptStarted(opId);
  return client.recordSigned(opId, {signature: described.signature, messageHash: described.messageHash, record: described.record});
}
