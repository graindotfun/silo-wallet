/** Closing an operation requires this device's own outcome check — never another device's word.
 *
 * A verifier is protocol-specific and reads the chain through this device's own reviewed reader:
 *   verifiers[kind].checkOutcome({network, signature, messageHash, owner}) →
 *     {status: 'finalized' | 'failed' | 'unknown', network, signature, messageHash, evidence}
 * 'failed' means the operation can provably never be included (for example a Solana blockhash expired past the
 * last valid block height with no landed signature; a Monero input spent by a different transaction). 'unknown'
 * covers "not found yet", "pending", "RPC unavailable" and anything unproven. The verifier, not this module, is
 * responsible for protocol details such as minimum-received checks on swaps.
 *
 * Rules enforced here, for every terminal claim:
 *  - a verifier for the operation's kind must exist, else the hold stays ('no-verifier');
 *  - the operation must carry signed evidence whose message hash equals the one bound at reservation;
 *  - the verifier's answer must name the same network, signature and message hash ('proof-mismatch' otherwise);
 *  - 'unknown' keeps the hold ('outcome-unknown');
 *  - an answer that differs from the claimed status is a contradiction ('outcome-contradiction') and is surfaced
 *    as a conflict; the hold stays.
 * `cancelled-before-prompt` needs no chain check: merge.mjs/assertJournalGrowth only accept it from the reserving
 * device while the operation was still `reserved`. */
import {canonical, randomId, sha256Hex} from './codec.mjs';
import {isTerminalState} from './merge.mjs';

const CLAIM = {'finalized': 'finalized', 'failed-proven': 'failed'};
/** Identity of an outcome. Evidence detail (slot, confirmations) may legitimately differ between readers. */
const core = (claim) => sha256Hex(canonical({status: claim.status, network: claim.network, signature: claim.signature, messageHash: claim.messageHash}));
const CACHE_VERSION = 'silo-local-outcome-cache-v2';
const readerEpochs = new WeakMap();
const boundOperation = entry => canonical({opId: entry.opId, kind: entry.kind, network: entry.network, state: entry.state,
  createdBy: entry.createdBy, claim: entry.claim ?? null, binding: entry.binding, signed: entry.signed ?? null, cancellation: entry.cancellation ?? null,
  legacy: entry.legacy ?? null, conflict: entry.conflict ?? null});
async function cacheBinding(entry, verifiers, claimHash) {
  const reader = verifiers?.[entry.kind];
  // Only locally constructed, identified readers can cache. Missing build or
  // policy identity means a fresh check, never a grandfathered cache entry.
  if (typeof reader?.checkOutcome !== 'function' || typeof reader.cachePolicyVersion !== 'string' || !reader.cachePolicyVersion ||
      reader.cachePolicyVersion.length > 128 || !/^[a-f0-9]{40}$/.test(reader.cacheSource ?? '')) return null;
  let epoch = readerEpochs.get(reader);
  if (!epoch || epoch.check !== reader.checkOutcome) { epoch = {check: reader.checkOutcome, id: randomId(16)}; readerEpochs.set(reader, epoch); }
  const identity = boundOperation(entry), check = reader.checkOutcome,
    policy = reader.cachePolicyVersion, source = reader.cacheSource;
  const operationHash = await sha256Hex(identity);
  if (verifiers?.[entry.kind] !== reader || reader.checkOutcome !== check || reader.cachePolicyVersion !== policy ||
      reader.cacheSource !== source || boundOperation(entry) !== identity) return {contextChanged:true};
  return {schema: CACHE_VERSION, policy, source, readerEpoch: epoch.id, operationHash, claimHash};
}

export async function checkOperationOutcome(entry, verifiers) {
  if (entry.legacyRecovery) return {status:'unknown',reason:'legacy-protocol-reconciliation-required'};
  const verifier = verifiers?.[entry.kind];
  if (!verifier?.checkOutcome) return {status: 'unknown', reason: 'no-verifier'};
  if (!entry.signed || entry.signed.messageHash !== entry.binding?.messageHash) return {status: 'unknown', reason: 'no-signed-evidence'};
  // `record` is the protocol's own saved record (Solana transfer journal row, Jupiter journal row, XMR pending payment), carried
  // encrypted in the vault so another device's reader can check it. The verifier must bind it to signature and message.
  const request = {network: entry.network, signature: entry.signed.signature, messageHash: entry.binding.messageHash, owner: entry.binding.owner ?? null, record: entry.signed.record ?? entry.legacy ?? null, cancellation: entry.cancellation ?? null};
  const checkedIdentity = boundOperation(entry), checkedFunction = verifier.checkOutcome,
    checkedPolicy = verifier.cachePolicyVersion, checkedSource = verifier.cacheSource;
  let result;
  try { result = await verifier.checkOutcome(structuredClone(request)); } catch { return {status: 'unknown', reason: 'verifier-error'}; }
  if (verifiers?.[entry.kind] !== verifier || verifier.checkOutcome !== checkedFunction || verifier.cachePolicyVersion !== checkedPolicy ||
      verifier.cacheSource !== checkedSource || boundOperation(entry) !== checkedIdentity)
    return {status: 'unknown', reason: 'verification-context-changed'};
  if (!result || result.network !== request.network || result.signature !== request.signature || result.messageHash !== request.messageHash) return {status: 'unknown', reason: 'proof-mismatch'};
  if (!['finalized', 'failed', 'unknown'].includes(result.status)) return {status: 'unknown', reason: 'proof-mismatch'};
  if (result.status === 'unknown') return {status: 'unknown', reason: 'outcome-unknown'};
  const claim = {status: result.status, network: result.network, signature: result.signature, messageHash: result.messageHash, evidence: result.evidence ?? null};
  const proofHash = await core(claim);
  if (verifiers?.[entry.kind] !== verifier || verifier.checkOutcome !== checkedFunction || verifier.cachePolicyVersion !== checkedPolicy ||
      verifier.cacheSource !== checkedSource || boundOperation(entry) !== checkedIdentity)
    return {status:'unknown',reason:'verification-context-changed'};
  return {status: result.status, claim, proofHash};
}

/** Returns [{entry, reason, contradiction}] for every operation that still blocks a new one on this device.
 * `verified` is this device's versioned cache. Historical proof-hash strings invalidate.
 * A reader/build/policy incarnation and complete operation/record identity must match. */
export async function blockingOperations(journal, {verifiers, verified}) {
  const blocking = [];
  for (const entry of Object.values(journal?.entries ?? {})) {
    if (entry.legacyRecovery) { blocking.push({entry,reason:'legacy-protocol-reconciliation-required'}); continue; }
    if (entry.conflict) { blocking.push({entry, reason: 'conflict', contradiction: true}); continue; }
    if (entry.state === 'cancelled-before-prompt') continue;
    if (!isTerminalState(entry.state)) { blocking.push({entry, reason: entry.state}); continue; }
    const claimIdentity = boundOperation(entry);
    const claimHash = entry.claim ? await core(entry.claim) : null;
    if (boundOperation(entry) !== claimIdentity) { delete verified[entry.opId]; blocking.push({entry,reason:'verification-context-changed'}); continue; }
    if (!entry.claim || entry.claim.status !== CLAIM[entry.state]) { blocking.push({entry, reason: 'claim-malformed'}); continue; }
    const binding = await cacheBinding(entry, verifiers, claimHash);
    if (binding?.contextChanged) { delete verified[entry.opId]; blocking.push({entry,reason:'verification-context-changed'}); continue; }
    if (binding && canonical(verified[entry.opId] ?? null) === canonical(binding)) continue;
    delete verified[entry.opId];
    const result = await checkOperationOutcome(entry, verifiers);
    if (result.status === 'unknown') { blocking.push({entry, reason: result.reason}); continue; }
    if (result.proofHash !== claimHash) { blocking.push({entry, reason: 'outcome-contradiction', contradiction: true}); continue; }
    const after = await cacheBinding(entry, verifiers, claimHash);
    if (after?.contextChanged || boundOperation(entry) !== claimIdentity) { blocking.push({entry,reason:'verification-context-changed'}); continue; }
    if (canonical(after) !== canonical(binding)) { blocking.push({entry,reason:'verification-context-changed'}); continue; }
    if (binding) verified[entry.opId] = binding;
  }
  return blocking;
}
