// Maker-side Solana helpers for SOL -> XMR strict escrows (owner decision P): the `swap-strict` PDA, claim_strict, the
// StrictSwap account decode, and the revealed-secret history walk. The normal-mode helpers in client/sol.mjs are unchanged.
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { conn, PROGRAM_ID, disc, matchRevealed } from '../client/sol.mjs';

export const STRICT_SEED = 'swap-strict';
const STRICT_ACCOUNT = Buffer.from(sha256(new TextEncoder().encode('account:StrictSwap'))).subarray(0, 8);
export const strictPda = (refunder, swapId) => PublicKey.findProgramAddressSync([Buffer.from(STRICT_SEED), refunder.toBuffer(), Buffer.from(swapId)], PROGRAM_ID)[0];
export const claimStrictIx = ({ refunder, swapId, claimer, secret }) => new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [{ pubkey: strictPda(refunder, swapId), isSigner: false, isWritable: true }, { pubkey: claimer, isSigner: false, isWritable: true }, { pubkey: refunder, isSigner: false, isWritable: true }],
  data: Buffer.concat([disc('claim_strict'), Buffer.from(secret)]),
});
/** Step one of the v2 claim: signed by the claimer (the maker), carries no secret. Account order is the program's: claimer (signer), escrow (writable). */
export const commitClaimStrictIx = ({ refunder, swapId, claimer }) => new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [{ pubkey: claimer, isSigner: true, isWritable: false }, { pubkey: strictPda(refunder, swapId), isSigner: false, isWritable: true }],
  data: disc('claim_commit_strict'),
});
export function decodeStrict(data) {
  const all = Buffer.from(data);
  if (all.length !== 8 + 194 || !all.subarray(0, 8).equals(STRICT_ACCOUNT)) throw new Error('not-a-strict-swap-account');
  const d = all.subarray(8), h = (b) => Buffer.from(b).toString('hex');
  return { refunder: new PublicKey(d.subarray(0, 32)).toBase58(), claimer: new PublicKey(d.subarray(32, 64)).toBase58(), claimPoint: h(d.subarray(64, 96)), refundPoint: h(d.subarray(96, 128)),
    lamports: Number(d.readBigUInt64LE(128)), t0: Number(d.readBigInt64LE(136)), t1: Number(d.readBigInt64LE(144)), ready: d[152] === 1, swapId: h(d.subarray(153, 185)), claimCommittedAt: Number(d.readBigInt64LE(186)) };
}
/** The strict escrow at FINALIZED commitment (M1), or null when absent / not a strict escrow of this program. */
export async function readStrictFinalized(refunder, swapId) {
  const acc = await conn.getAccountInfo(strictPda(refunder, swapId), 'finalized');
  if (!acc || !acc.owner.equals(PROGRAM_ID)) return null;
  try { return decodeStrict(acc.data); } catch { return null; }
}
/** which = 'claim' | 'refund' (mapped to the strict instruction names). Resumable like client/sol.mjs readRevealedSecret. */
export async function readRevealedStrict(refunder, swapId, which, expectedPoint, { maxPages = 20, cursor = null, onCursor = () => {} } = {}) {
  const pda = strictPda(refunder, swapId);
  let before = cursor ?? undefined;
  for (let page = 0; page < maxPages; page++) {
    const sigs = await conn.getSignaturesForAddress(pda, { limit: 1000, before }, 'confirmed');
    for (const s of sigs) {
      if (s.err) continue;
      const tx = await conn.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (!tx) continue;
      const secret = matchRevealed(tx.transaction.message, { pda: pda.toBase58(), which: `${which}_strict`, expectedPoint });
      if (secret) return { secret, sig: s.signature };
    }
    if (sigs.length < 1000) { onCursor(null); return null; }
    before = sigs[sigs.length - 1].signature;
    onCursor(before);
  }
  return null;
}
