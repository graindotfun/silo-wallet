// Devnet client for the xmr_sol_swap Anchor program (hand-encoded, no IDL needed).
import { Connection, PublicKey, Keypair, Transaction, VersionedTransaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { sendSecretVia } from './secret-send.mjs';

const env = globalThis.process?.env ?? {};
export let PROGRAM_ID = new PublicKey(env.SWAP_PROGRAM_ID ?? '7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS');
/** Browser callers set the program id from server configuration (ES live binding updates every user). */
export const setProgramId = (id) => { PROGRAM_ID = new PublicKey(id); };
export let conn = new Connection(env.SOL_RPC ?? 'https://api.devnet.solana.com', 'confirmed');
export const setConnection = (c) => { conn = c; };

export const disc = (name) => Buffer.from(sha256(new TextEncoder().encode(`global:${name}`))).subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };

export const swapPda = (refunder, swapId) => PublicKey.findProgramAddressSync([Buffer.from('swap'), refunder.toBuffer(), Buffer.from(swapId)], PROGRAM_ID)[0];

export function lockIx({ refunder, swapId, claimer, claimPoint, refundPoint, lamports, t0, t1 }) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: refunder, isSigner: true, isWritable: true },
      { pubkey: swapPda(refunder, swapId), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc('lock'), Buffer.from(swapId), claimer.toBuffer(), Buffer.from(claimPoint), Buffer.from(refundPoint), u64(lamports), i64(t0), i64(t1)]),
  });
}
export const readyIx = ({ refunder, swapId }) => new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [{ pubkey: refunder, isSigner: true, isWritable: false }, { pubkey: swapPda(refunder, swapId), isSigner: false, isWritable: true }],
  data: disc('set_ready'),
});
export const claimIx = ({ refunder, swapId, claimer, secret }) => new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: swapPda(refunder, swapId), isSigner: false, isWritable: true },
    { pubkey: claimer, isSigner: false, isWritable: true },
    { pubkey: refunder, isSigner: false, isWritable: true },
  ],
  data: Buffer.concat([disc('claim'), Buffer.from(secret)]),
});
export const refundIx = ({ refunder, swapId, secret }) => new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [{ pubkey: swapPda(refunder, swapId), isSigner: false, isWritable: true }, { pubkey: refunder, isSigner: false, isWritable: true }],
  data: Buffer.concat([disc('refund'), Buffer.from(secret)]),
});

/**
 * Simulates a compiled message UNSIGNED: a VersionedTransaction with all-zero signatures, sigVerify false, replaceRecentBlockhash false.
 * Those bytes can never pass signature verification, so no RPC can broadcast them, and web3.js neither signs nor swaps the blockhash on
 * this path. Never use the legacy simulateTransaction(tx, signers) overload: it fetches a blockhash of its own, SIGNS a copy and sends
 * the valid signed bytes (sigVerify true), so a valid transaction leaves the process during a mere simulation.
 * Returns the RPC answer as is; the caller decides what an error means.
 */
export const simulateUnsigned = (message) => conn.simulateTransaction(new VersionedTransaction(message), { sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' });

/**
 * Builds one message, simulates it UNSIGNED (simulateUnsigned), and only after a clean simulation signs that SAME message in memory and
 * sends exactly those bytes (sendRawTransaction, which never swaps the blockhash): one blockhash, one signed variant, and no signed byte
 * leaves the process unless the simulation passed. A refused simulation throws and nothing signed is ever produced.
 *
 * Never for a secret-carrying transaction that matters (refund carries b, claim carries a): the simulation, even unsigned, shows the
 * scalar to the RPC operator in the instruction data. Only the devnet scripts use it that way. The maker's set-ready and refund go
 * through maker/maker-send.mjs (refund never simulated, attempt stored durably before broadcast, exposure rule of swap-core.mjs).
 */
export async function send(ix, payer, signers = []) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }), ...(Array.isArray(ix) ? ix : [ix]));
  tx.feePayer = payer.publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  const message = tx.compileMessage();
  // Every required signer must be supplied and every supplied key must be required, checked before anything goes out.
  const required = message.accountKeys.slice(0, message.header.numRequiredSignatures).map((k) => k.toBase58());
  const keys = [payer, ...signers], given = new Set(keys.map((k) => k.publicKey.toBase58()));
  for (const k of given) if (!required.includes(k)) throw new Error(`unknown signer: ${k}`);
  for (const k of required) if (!given.has(k)) throw new Error(`missing signer: ${k}`);
  const sim = await simulateUnsigned(message);
  if (sim.value.err) throw new Error(`simulation refused: ${JSON.stringify(sim.value.err)} ${sim.value.logs?.slice(-3).join(' | ')}`);
  const signed = new VersionedTransaction(message);
  signed.sign(keys);
  const sig = bs58.encode(signed.signatures[0]);
  await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  const status = (await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')).value;
  if (status.err) throw new Error(`Transaction ${sig} failed (${JSON.stringify(status)})`);
  const info = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  return { sig, cu: info?.meta?.computeUnitsConsumed, fee: info?.meta?.fee };
}

/** A transaction that carries a secret (claim reveals a, refund reveals b): authorized again right before every simulation and broadcast, see secret-send.mjs.
 * notAfter = chain-time second after which revealing is unsafe (null: no deadline). Throws deadline-unsafe / clock-unavailable instead of sending. */
export const sendSecret = (ix, payer, { notAfter = null, signers = [] } = {}) => sendSecretVia({ conn, now: chainNow, notAfter, ix, payer, signers });

/** Decodes swap account data (8-byte Anchor tag first). Throws on anything that is not a swap account. */
export const SWAP_ACCOUNT_LEN = 8 + 186;
export function decodeSwap(data) {
  const all = Buffer.from(data);
  if (all.length !== SWAP_ACCOUNT_LEN || !all.subarray(0, 8).equals(Buffer.from(sha256(new TextEncoder().encode('account:Swap'))).subarray(0, 8))) throw new Error('not-a-swap-account');
  const d = all.subarray(8);
  const h = (b) => Buffer.from(b).toString('hex');
  return { refunder: new PublicKey(d.subarray(0, 32)).toBase58(), claimer: new PublicKey(d.subarray(32, 64)).toBase58(), claimPoint: h(d.subarray(64, 96)), refundPoint: h(d.subarray(96, 128)), lamports: Number(d.readBigUInt64LE(128)), t0: Number(d.readBigInt64LE(136)), t1: Number(d.readBigInt64LE(144)), ready: d[152] === 1, swapId: h(d.subarray(153, 185)) };
}
/**
 * Reads the swap PDA. Returns null when the escrow is gone: closed, OR recreated by a third party as an
 * ordinary system account (anyone can send lamports to the address). Only an account owned by the
 * program with a valid swap layout counts as an open escrow.
 */
export async function readSwap(refunder, swapId) {
  const acc = await conn.getAccountInfo(swapPda(refunder, swapId), 'confirmed');
  if (!acc || !acc.owner.equals(PROGRAM_ID)) return null;
  try { return decodeSwap(acc.data); } catch { return null; }
}
export async function chainNow() { return conn.getBlockTime(await conn.getSlot('confirmed')); }

import { pub, hex as toHex, fromLE } from './keys.mjs';
import bs58 from 'bs58';

/**
 * Finds the scalar revealed by a successful claim/refund in one transaction message. Accepted only
 * if the instruction targets this program, carries the right tag, names THIS swap account first,
 * and the scalar opens the expected point. Anything else (another swap's claim that merely lists
 * this account, garbage data) is skipped, so a third party cannot feed a wrong secret.
 */
export function matchRevealed(message, { pda, which, expectedPoint }) {
  const want = disc(which);
  const keys = (message.staticAccountKeys ?? message.accountKeys ?? []).map((k) => (typeof k === 'string' ? k : k.toBase58()));
  const program = PROGRAM_ID.toBase58();
  for (const ix of message.compiledInstructions ?? message.instructions ?? []) {
    if (keys[ix.programIdIndex] !== program) continue;
    const accounts = ix.accountKeyIndexes ?? ix.accounts ?? [];
    if (keys[accounts[0]] !== pda) continue;
    const data = Buffer.from(typeof ix.data === 'string' ? bs58.decode(ix.data) : ix.data);
    if (data.length !== 40 || !data.subarray(0, 8).equals(want)) continue;
    const secret = new Uint8Array(data.subarray(8, 40));
    try { if (toHex(pub(fromLE(secret))) !== expectedPoint) continue; } catch { continue; } // pub() rejects 0 and non-canonical (>= l)
    return secret;
  }
  return null;
}

/** Walks the swap account's whole history (paged, so spam cannot push the real tx out of view). */
export async function readRevealedSecret(refunder, swapId, which, expectedPoint, { maxPages = 20, cursor = null, onCursor = () => {} } = {}) {
  const pda = swapPda(refunder, swapId);
  let before = cursor ?? undefined;   // resume where the last pass stopped (H7)
  for (let page = 0; page < maxPages; page++) {
    const sigs = await conn.getSignaturesForAddress(pda, { limit: 1000, before }, 'confirmed');
    for (const s of sigs) {
      if (s.err) continue;
      const tx = await conn.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (!tx) continue;
      const secret = matchRevealed(tx.transaction.message, { pda: pda.toBase58(), which, expectedPoint });
      if (secret) return { secret, sig: s.signature };
    }
    if (sigs.length < 1000) { onCursor(null); return null; }
    before = sigs[sigs.length - 1].signature;
    onCursor(before);
  }
  return null;
}
