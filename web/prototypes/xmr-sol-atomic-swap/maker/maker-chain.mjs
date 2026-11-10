// Maker-only Solana helpers for the admission gate (VBU-M1): a lock transaction signed locally BEFORE it is stored, so its signature and
// last valid block height are on disk before any broadcast, and finalized-commitment evidence for a lock whose outcome is not known.
// Kept out of client/sol.mjs, which the browser client shares. The evidence collectors are shared by the maker loop and the quiesce check.
import { Transaction, VersionedTransaction, ComputeBudgetProgram, SystemProgram, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import * as sol from '../client/sol.mjs';
import { strictPda, decodeStrict } from './strict-sol.mjs';
import { ATTEMPT_LISTS, OPEN_ATTEMPT_STATES } from './maker-core.mjs';

/**
 * Builds, simulates and signs the lock. Nothing valid leaves the process here (Astra AG-H1).
 * The message (fee payer, instructions, blockhash) is compiled ONCE. The simulation sends that message with all-zero signatures
 * (VersionedTransaction without signers, sigVerify false, replaceRecentBlockhash false): those bytes can never pass signature
 * verification, so no RPC can broadcast them, and web3.js neither signs nor swaps the blockhash on this path (the legacy
 * simulateTransaction(tx, signers) overload signs a copy with a blockhash of its own choosing and sends it with sigVerify true: never used).
 * Only after a clean simulation is the SAME message signed locally, in memory. The caller stores the signature with the secret (fsync)
 * before broadcastSigned sends these exact bytes, so there is one signed variant only and it is on disk before any RPC sees it.
 */
export async function prepareSigned(ixs, payer) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }), ...ixs);
  tx.feePayer = payer.publicKey;
  const { blockhash, lastValidBlockHeight } = await sol.conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  const message = tx.compileMessage();
  const sim = await sol.conn.simulateTransaction(new VersionedTransaction(message), { sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' });
  if (sim.value.err) throw new Error(`simulation refused: ${JSON.stringify(sim.value.err)} ${sim.value.logs?.slice(-3).join(' | ')}`);
  const signed = new VersionedTransaction(message);
  signed.sign([payer]);
  return { raw: Buffer.from(signed.serialize()), sig: bs58.encode(signed.signatures[0]), blockhash, lastValidBlockHeight };
}

/** Sends the already signed lock and waits for confirmation. A thrown error says nothing about whether it landed. */
export async function broadcastSigned(p) {
  await sol.conn.sendRawTransaction(p.raw, { skipPreflight: true });
  const c = await sol.conn.confirmTransaction({ signature: p.sig, blockhash: p.blockhash, lastValidBlockHeight: p.lastValidBlockHeight }, 'confirmed');
  if (c.value.err) throw new Error(`lock-failed ${JSON.stringify(c.value.err)}`);
  return { sig: p.sig };
}

// ---- Finalized evidence (Astra AG-H2): an expiry observation first, then absence reads in a context at least as new ----

/** Minimal read-only JSON-RPC client (only get* methods are ever called). */
export function rpcClient(url) {
  return async (method, params) => {
    if (!/^get[A-Z]/.test(method)) throw new Error(`refusing non-read method ${method}`);
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
    const j = await r.json(); if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code }); return j.result;
  };
}

const FIN = 'finalized';
export const HISTORY_PAGES = 50;          // at most 50 pages of 1000 signatures per PDA; a longer history is "unreadable", never evidence

/**
 * Expiry observation: the finalized tip slot and the height of the block AT that slot (one block answers both, so the height is bound
 * to a slot). Also returns the block's signatures for the history index probe. Throws when it cannot be established.
 */
export async function expiryObservation(rpc) {
  const slot = await rpc('getSlot', [{ commitment: FIN }]);
  const b = await rpc('getBlock', [slot, { commitment: FIN, transactionDetails: 'signatures', rewards: false, maxSupportedTransactionVersion: 0 }]);
  if (!Number.isInteger(slot) || !b || !Number.isInteger(b.blockHeight)) throw new Error('expiry-unobservable');
  return { slot, height: b.blockHeight, signatures: Array.isArray(b.signatures) ? b.signatures : [] };
}

/**
 * History completeness, measured separately from the node's own context: a transaction finalized IN the expiry block must already be
 * found by (a) the address-signature index (getSignaturesForAddress of its fee payer, newest entry at or after the expiry slot) and
 * (b) the status history (getSignatureStatuses with searchTransactionHistory). A history service that lags behind the node fails this.
 */
export async function historyIndexProbe(rpc, exp) {
  for (const sig of exp.signatures.slice(0, 3)) {
    const tx = await rpc('getTransaction', [sig, { commitment: FIN, encoding: 'json', maxSupportedTransactionVersion: 0 }]);
    const payer = tx?.transaction?.message?.accountKeys?.[0];
    if (typeof payer !== 'string') continue;
    const top = (await rpc('getSignaturesForAddress', [payer, { limit: 1, commitment: FIN, minContextSlot: exp.slot }]))?.[0];
    const st = (await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]))?.value?.[0];
    const addressIndex = Number.isInteger(top?.slot) && top.slot >= exp.slot;
    const statusIndex = Number.isInteger(st?.slot) && st.slot === exp.slot;
    return { ok: addressIndex && statusIndex, addressIndexSlot: top?.slot ?? null, statusIndex };
  }
  return { ok: false, why: 'no transaction to probe in the expiry block' };
}

/** One chain snapshot per pass: the expiry observation and the history index probe. Null when either cannot be established. */
export async function chainSnapshot(rpc) {
  try { const expiry = await expiryObservation(rpc); return { expiry: { slot: expiry.slot, height: expiry.height }, historyIndex: await historyIndexProbe(rpc, expiry) }; } catch { return null; }
}

/** Account at the PDA: none, a live identified escrow (program owner AND swap layout), a plain lamport balance (system owned, no data), or unknown.
 * strict = true for a SOL -> XMR record: the escrow layout expected at its PDA is the v2 StrictSwap (any other program-owned data is unknown). */
export function accountKind(value, program, { strict = false } = {}) {
  if (value === null) return { kind: 'none' };
  const owner = value.owner, data = Buffer.from(value.data?.[0] ?? '', 'base64');
  if (owner === program) { try { (strict ? decodeStrict : sol.decodeSwap)(data); return { kind: 'escrow', owner }; } catch { return { kind: 'unknown-type', owner }; } }
  if (owner === SystemProgram.programId.toBase58() && data.length === 0) return { kind: 'non-escrow', owner, lamports: value.lamports };
  return { kind: 'unknown-type', owner };
}

/** Which program instruction a finalized transaction ran on this PDA: lock (PDA second account), claim or refund (PDA first); 'unrelated' when
 * the program is not among the transaction's accounts at all (it cannot have run, not even by CPI), else 'other'. */
const DISC = { lock: sol.disc('lock'), claim: sol.disc('claim'), refund: sol.disc('refund') };
export function txKind(tx, pda, program) {
  const msg = tx?.transaction?.message; const keys = msg?.accountKeys ?? [];
  const loaded = [...(tx?.meta?.loadedAddresses?.writable ?? []), ...(tx?.meta?.loadedAddresses?.readonly ?? [])];
  if (!keys.includes(program) && !loaded.includes(program)) return 'unrelated';
  for (const ix of msg?.instructions ?? []) {
    if (keys[ix.programIdIndex] !== program) continue;
    let data; try { data = Buffer.from(bs58.decode(ix.data)); } catch { continue; }
    for (const [kind, d] of Object.entries(DISC)) if (data.subarray(0, 8).equals(Buffer.from(d)) && keys[ix.accounts?.[kind === 'lock' ? 1 : 0]] === pda) return kind;
  }
  return 'other';
}

/** Full finalized PDA history (each page with minContextSlot) with each transaction's kind. Null when any page or transaction cannot be read
 * or the history is longer than HISTORY_PAGES pages: a truncated history is never evidence of anything. */
export async function pdaHistory(rpc, pda, program, minContextSlot) {
  const out = []; let before;
  for (let page = 0; page < HISTORY_PAGES; page++) {
    const sigs = await rpc('getSignaturesForAddress', [pda, { limit: 1000, before, commitment: FIN, minContextSlot }]);
    if (!Array.isArray(sigs)) return null;
    for (const s of sigs) {
      const tx = s.err ? null : await rpc('getTransaction', [s.signature, { commitment: FIN, encoding: 'json', maxSupportedTransactionVersion: 0 }]);
      if (!s.err && !tx) return null;
      out.push({ signature: s.signature, err: s.err, slot: s.slot ?? null, kind: s.err ? 'failed' : txKind(tx, pda, program) });
    }
    if (sigs.length < 1000) return out;
    before = sigs[sigs.length - 1].signature;
  }
  return null;
}

/**
 * Absence reads for one record, all at finalized commitment with minContextSlot = the expiry slot, each answer keeping its context slot so the
 * classifier can reject an older one. Every failed read becomes null/undefined (unknown, never "nothing there").
 */
export async function recordAbsence(rpc, { pda, lockSig, program, minSlot, strict = false }) {
  const safe = async (f) => { try { return await f(); } catch { return null; } };
  const acc = await safe(() => rpc('getAccountInfo', [pda, { commitment: FIN, encoding: 'base64', minContextSlot: minSlot }]));
  const account = acc && typeof acc === 'object' && 'value' in acc ? { slot: acc.context?.slot ?? null, ...accountKind(acc.value, program, { strict }) } : null;
  // The strict PDA's history is read too: an open send attempt counts as "never executed" only when the finalized history does not name it.
  const history = await safe(() => pdaHistory(rpc, pda, program, minSlot));
  let sigStatus, sigStatusSlot = null;
  if (typeof lockSig === 'string' && lockSig) {
    const st = await safe(() => rpc('getSignatureStatuses', [[lockSig], { searchTransactionHistory: true }]));
    sigStatus = st && Array.isArray(st.value) ? st.value[0] ?? null : undefined;
    sigStatusSlot = st?.context?.slot ?? null;
  }
  return { pda, account, history, sigStatus, sigStatusSlot };
}

/**
 * Status of every send attempt (maker-send.mjs, both directions) the record still holds as open: { [sig]: { status, slot } } where status is
 * the finalized status object, null (unknown to the cluster) or undefined (unread), and slot the answer's context slot. Read-only.
 */
export async function attemptStatuses(rpc, record) {
  const sigs = ATTEMPT_LISTS.flatMap((l) => record?.[l] ?? []).filter((a) => a && OPEN_ATTEMPT_STATES.has(a.state) && typeof a.sig === 'string').map((a) => a.sig);
  const out = {};
  for (const sig of sigs) {
    let st = null; try { st = await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]); } catch { st = null; }
    out[sig] = { status: st && Array.isArray(st.value) ? st.value[0] ?? null : undefined, slot: st?.context?.slot ?? null };
  }
  return out;
}

/** Evidence for one record: the pass's snapshot plus the record's own absence reads. Null when the snapshot is missing.
 * A SOL -> XMR record (direction 'sol-xmr') is read at its strict PDA (refunder = the user, the maker is the claimer). */
export async function collectEvidence(rpc, { snapshot, record, makerKey, program, boundary }) {
  if (!snapshot?.expiry) return null;
  const strict = record?.direction === 'sol-xmr';
  let pda;
  try { pda = (strict ? strictPda(new PublicKey(record.refunder), Buffer.from(String(record.swapId), 'hex')) : sol.swapPda(makerKey, Buffer.from(String(record.swapId), 'hex'))).toBase58(); } catch { return null; }
  return { ...snapshot, boundary, ...(await recordAbsence(rpc, { pda, lockSig: strict ? undefined : record.lockSig, program, minSlot: snapshot.expiry.slot, strict })), attempts: await attemptStatuses(rpc, record) };
}
