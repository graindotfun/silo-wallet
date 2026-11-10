// SOL -> XMR: the only Solana transactions a Silo wallet signs for a no-bridge swap, as the refunder (the user locks SOL).
// Three exact layouts of the program's STRICT mode (owner decision P): lock_strict, set_ready_strict, refund_strict, on the
// `swap-strict` escrow, where the maker's claim always needs this wallet's ready. Each is rebuilt from its decoded fields and compared byte for byte, so no
// other instruction, account or program can ride along. The program id is pinned here, never taken from configuration.
// The lock's timelocks must have the agreed shape, so the user can always refund before t0 (threat model U1, U5).
import { PublicKey, SystemProgram, ComputeBudgetProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha256';
import { REV_T0_LEAD, REV_CLAIM_WINDOW, REV_LEAD_SLACK } from './reverse-core.mjs';

export const SILO_ATOMIC_PROGRAM_ID = '7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS';
/** Hard ceiling for one lock, far above the approved per-swap cap (0.05 XMR); a layout above it is never signed. */
export const SILO_ATOMIC_MAX_LOCK_LAMPORTS = 2_000_000_000;
const PROGRAM = new PublicKey(SILO_ATOMIC_PROGRAM_ID);
const CU = 60_000;
const disc = (name) => Buffer.from(sha256(new TextEncoder().encode(`global:${name}`))).subarray(0, 8);
const D = { lock: disc('lock_strict'), ready: disc('set_ready_strict'), refund: disc('refund_strict') };
export const SILO_ATOMIC_STRICT_SEED = 'swap-strict';
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const bytes32 = (x, what) => { const b = Buffer.from(x); if (b.length !== 32) throw Error(`Invalid ${what}.`); return b; };
export const atomicSwapPda = (owner, swapId) => PublicKey.findProgramAddressSync([Buffer.from(SILO_ATOMIC_STRICT_SEED), new PublicKey(owner).toBuffer(), bytes32(swapId, 'swap id')], PROGRAM)[0];
const STRICT_ACCOUNT = Buffer.from(sha256(new TextEncoder().encode('account:StrictSwap'))).subarray(0, 8);
/** Decodes a strict escrow account (the normal fields plus the v2 claim_committed_at; its own discriminator). Throws on anything else, a pre-v2 186-byte account included. */
export function decodeStrictSwap(data) {
  const all = Buffer.from(data);
  if (all.length !== 8 + 194 || !all.subarray(0, 8).equals(STRICT_ACCOUNT)) throw Error('not-a-strict-swap-account');
  const d = all.subarray(8), h = (b) => Buffer.from(b).toString('hex');
  return { refunder: new PublicKey(d.subarray(0, 32)).toBase58(), claimer: new PublicKey(d.subarray(32, 64)).toBase58(), claimPoint: h(d.subarray(64, 96)), refundPoint: h(d.subarray(96, 128)),
    lamports: Number(d.readBigUInt64LE(128)), t0: Number(d.readBigInt64LE(136)), t1: Number(d.readBigInt64LE(144)), ready: d[152] === 1, swapId: h(d.subarray(153, 185)), claimCommittedAt: Number(d.readBigInt64LE(186)) };
}

function programIx(kind, f) {
  const owner = new PublicKey(f.owner), pda = atomicSwapPda(owner, f.swapId);
  if (kind === 'lock') return new TransactionInstruction({ programId: PROGRAM, keys: [{ pubkey: owner, isSigner: true, isWritable: true }, { pubkey: pda, isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }],
    data: Buffer.concat([D.lock, bytes32(f.swapId, 'swap id'), new PublicKey(f.claimer).toBuffer(), bytes32(f.claimPoint, 'claim point'), bytes32(f.refundPoint, 'refund point'), u64(f.lamports), i64(f.t0), i64(f.t1)]) });
  if (kind === 'ready') return new TransactionInstruction({ programId: PROGRAM, keys: [{ pubkey: owner, isSigner: true, isWritable: false }, { pubkey: pda, isSigner: false, isWritable: true }], data: Buffer.from(D.ready) });
  if (kind === 'refund') return new TransactionInstruction({ programId: PROGRAM, keys: [{ pubkey: pda, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: false, isWritable: true }], data: Buffer.concat([D.refund, bytes32(f.secret, 'secret')]) });
  throw Error('Unknown swap transaction.');
}
/** Builds one unsigned refunder transaction (the owner pays the fee and is the only signer). */
export function buildSiloAtomicRefunderTx(kind, fields, blockhash) {
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: CU }), programIx(kind, fields)];
  return new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(fields.owner), recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
}

/**
 * Decodes and verifies a refunder transaction. Returns { kind, terms }. Throws unless the transaction is exactly one of the
 * three layouts above, for the pinned program, with the owner as fee payer and only signer, and (lock) an amount within
 * the ceiling and the agreed timelock shape relative to `now` (unix seconds).
 */
export function inspectSiloAtomicRefunderTx(tx, { now }) {
  if (!(tx instanceof VersionedTransaction)) throw Error('A versioned transaction is required.');
  const m = tx.message;
  if (m.addressTableLookups?.length) throw Error('Lookup tables are not allowed.');
  if (m.header.numRequiredSignatures !== 1 || tx.signatures.length !== 1) throw Error('Exactly one signer is allowed.');
  if (m.compiledInstructions.length !== 2) throw Error('Unexpected instructions.');
  const keys = m.staticAccountKeys, owner = keys[0].toBase58(), ix = m.compiledInstructions[1];
  if (!keys[ix.programIdIndex]?.equals(PROGRAM)) throw Error('Not the swap program.');
  const data = Buffer.from(ix.data), tag = data.subarray(0, 8);
  let kind, terms;
  if (tag.equals(D.lock) && data.length === 8 + 32 + 32 + 32 + 32 + 8 + 8 + 8) {
    kind = 'lock';
    terms = { owner, swapId: data.subarray(8, 40), claimer: new PublicKey(data.subarray(40, 72)).toBase58(), claimPoint: data.subarray(72, 104), refundPoint: data.subarray(104, 136),
      lamports: Number(data.readBigUInt64LE(136)), t0: Number(data.readBigInt64LE(144)), t1: Number(data.readBigInt64LE(152)) };
    if (!(Number.isSafeInteger(terms.lamports) && terms.lamports > 0 && terms.lamports <= SILO_ATOMIC_MAX_LOCK_LAMPORTS)) throw Error('Swap amount outside the allowed range.');
    if (!Number.isSafeInteger(now) || Math.abs(terms.t0 - (now + REV_T0_LEAD)) > REV_LEAD_SLACK || terms.t1 - terms.t0 !== REV_CLAIM_WINDOW) throw Error('Swap deadlines do not have the agreed shape.');
    if (terms.claimer === owner) throw Error('The maker cannot be this wallet.');
  } else if (tag.equals(D.ready) && data.length === 8) { kind = 'ready'; terms = { owner }; }
  else if (tag.equals(D.refund) && data.length === 40) { kind = 'refund'; terms = { owner, secret: data.subarray(8, 40) }; }
  else throw Error('Not a reviewed swap instruction.');
  // ready and refund name the escrow by address only; the swap id comes from the caller's record and is proven by the rebuild.
  return { kind, terms, rebuild: (swapId) => {
    const f = { ...terms, swapId: kind === 'lock' ? terms.swapId : swapId };
    const again = buildSiloAtomicRefunderTx(kind, f, m.recentBlockhash);
    if (!Buffer.from(again.message.serialize()).equals(Buffer.from(m.serialize()))) throw Error('The swap transaction does not match its reviewed layout.');
    return f;
  } };
}

const hexOf = (b) => Buffer.from(b).toString('hex');
/**
 * The keyring's check before it signs: the transaction is exactly the reviewed layout, belongs to this wallet, and
 * matches what the swap record expects. expected = { kind, swapId (hex) } plus, for a lock, { claimer, claimPoint,
 * refundPoint (hex), lamports, t0, t1 } and, for a refund, { secret (hex) }. Returns the transaction to sign.
 */
export function verifySiloAtomicRefunderTx(encoded, expected, { address, now }) {
  if (typeof encoded !== 'string' || !expected || typeof expected !== 'object') throw Error('A swap transaction and its record are required.');
  if (!/^[0-9a-f]{64}$/.test(expected.swapId ?? '')) throw Error('Invalid swap id.');
  const tx = VersionedTransaction.deserialize(Buffer.from(encoded, 'base64'));
  const seen = inspectSiloAtomicRefunderTx(tx, { now });
  if (seen.kind !== expected.kind) throw Error('Unexpected swap step.');
  const f = seen.rebuild(Buffer.from(expected.swapId, 'hex'));
  if (f.owner !== address) throw Error('The transaction belongs to another wallet.');
  if (hexOf(f.swapId) !== expected.swapId) throw Error('The transaction belongs to another swap.');
  if (seen.kind === 'lock' && !(f.claimer === expected.claimer && hexOf(f.claimPoint) === expected.claimPoint && hexOf(f.refundPoint) === expected.refundPoint
    && f.lamports === expected.lamports && f.t0 === expected.t0 && f.t1 === expected.t1)) throw Error('The lock does not match the accepted offer.');
  if (seen.kind === 'refund' && hexOf(f.secret) !== expected.secret) throw Error('The refund does not match this swap.');
  return tx;
}
