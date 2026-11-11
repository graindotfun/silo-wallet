// User side (Alice) of the XMR -> SOL beta, browser-safe. Silo drives this module:
// it holds the per-swap secrets, builds the only transaction the user's side ever signs
// (the claim, signed by a throwaway fee-payer key, never the user's wallet key), and
// derives the Monero recovery keys if the maker refunds. Decisions come from swap-core.
import { Keypair, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { randomScalar, pub, addPoints, addScalars, moneroAddress, fromLE, toLE, hex, unhex, proveShare, verifyShare } from './keys.mjs';
import { claimIx, swapPda, PROGRAM_ID, disc, decodeSwap, matchRevealed } from './sol.mjs';
import { aliceNext, MARGIN, timelocksAcceptable } from './swap-core.mjs';

export const RECORD_KIND = 'silo-atomic-xmr-sol-v1';
export { LOCK_MIN_LEAD } from './swap-core.mjs';
import { CLAIM_FEE as FEE } from './swap-core.mjs';

/** Step 1: fresh secrets for one swap. Persist the returned record BEFORE sending anything. */
export function newSwapRecord({ claimer, quote, network }) {
  const a = randomScalar(), v = randomScalar();
  const fee = Keypair.generate();
  const swapId = unhex(quote.swapId);
  return {
    kind: RECORD_KIND, network, createdAt: Date.now(), quote,
    claimer, swapId: quote.swapId,
    a: hex(toLE(a)), A: hex(pub(a)), v: hex(toLE(v)), V: hex(pub(v)),
    proofA: proveShare(a, swapId, 0),
    feePayerSecret: hex(fee.secretKey), feePayer: fee.publicKey.toBase58(),
    status: 'quoted',
  };
}
/** What Silo sends to the maker (never `a`). The private view key is shared by design. */
export const swapRequest = (r) => ({ quoteId: r.quote.quoteId, claimer: r.claimer, feePayer: r.feePayer, A: r.A, proofA: r.proofA, v: r.v });

/** Step 2: accept the maker's answer only if it is self-consistent; returns the record update.
 * `now` is the user's own clock (seconds): the maker's timelocks must fall inside fixed bounds (H3). */
export function acceptMakerLock(r, m, now = Math.floor(Date.now() / 1000)) {
  if (!timelocksAcceptable(m.t0, m.t1, now)) throw new Error('timelocks-outside-bounds');
  const B = unhex(m.B);
  if (!verifyShare(B, m.proofB, unhex(r.swapId), 1)) throw new Error('maker-share-proof-invalid');
  const joint = moneroAddress(addPoints(unhex(r.A), B), unhex(r.V), r.network === 'mainnet' ? 'mainnet' : 'stagenet');
  if (joint !== m.jointAddress) throw new Error('joint-address-mismatch');
  const pda = swapPda(new PublicKey(m.refunder), unhex(r.swapId)).toBase58();
  if (pda !== m.pda) throw new Error('pda-mismatch');
  if (m.xmrAtomic !== r.quote.xmrAtomic || m.lamports !== r.quote.lamports) throw new Error('terms-mismatch');
  return { ...r, B: m.B, proofB: m.proofB, refunder: m.refunder, pda, jointAddress: joint, t0: m.t0, t1: m.t1, acceptedAt: now, lockSig: m.lockSig, status: 'maker-locked' };
}

/** Observations -> next action. `chain` = { now, pda, outcome } read by Silo's server route. */
export function nextAction(r, chain) {
  return aliceNext({
    now: chain.now, pda: chain.pda, outcome: chain.outcome, quoteExpiresAt: r.quote.expiresAt, feePayerLamports: chain.feePayerLamports,
    // A payment that may have gone out (H6) counts as funded, so a refund always leads to recovery.
    xmrLockTxid: r.xmrLockTxid ?? (r.fundingAttempted ? 'unknown' : null), xmrRecovered: !!r.xmrRecoveredTxids,
    terms: { A: r.A, B: r.B, claimer: r.claimer, lamports: r.quote.lamports, refunder: r.refunder, t0: r.t0, t1: r.t1, acceptedAt: r.acceptedAt,
      bobProofOk: !!r.proofB && verifyShare(unhex(r.B), r.proofB, unhex(r.swapId), 1) },
  });
}

/**
 * The claim: signed by the throwaway fee payer, sends the SOL to the user's own address and
 * returns the leftover gas to her in the same transaction. Returns base64 wire bytes.
 */
export function buildClaimTx(r, { blockhash, feePayerLamports }) {
  if (!Number.isSafeInteger(feePayerLamports) || feePayerLamports < FEE) throw new Error('fee-payer-underfunded');  // H2
  const fee = Keypair.fromSecretKey(unhex(r.feePayerSecret));
  const claimer = new PublicKey(r.claimer);
  const tx = new Transaction({ feePayer: fee.publicKey, recentBlockhash: blockhash });
  tx.add(claimIx({ refunder: new PublicKey(r.refunder), swapId: unhex(r.swapId), claimer, secret: unhex(r.a) }));
  const rest = feePayerLamports - FEE;
  if (rest > 0) tx.add(SystemProgram.transfer({ fromPubkey: fee.publicKey, toPubkey: claimer, lamports: rest }));
  tx.sign(fee);
  return Buffer.from(tx.serialize()).toString('base64');
}

/** After a refund: the full Monero keys of the joint address, to sweep back to the user. */
export function recoveryKeys(r, revealedB) {
  const b = fromLE(unhex(revealedB));
  if (hex(pub(b)) !== r.B) throw new Error('revealed-scalar-does-not-open-B');
  const spend = addScalars(fromLE(unhex(r.a)), b);
  const address = moneroAddress(pub(spend), unhex(r.V), r.network === 'mainnet' ? 'mainnet' : 'stagenet');
  if (address !== r.jointAddress) throw new Error('joint-key-mismatch');
  return { primaryAddress: address, privateSpendKey: hex(toLE(spend)), privateViewKey: r.v, restoreHeight: Math.max(0, (r.xmrLockHeight ?? 0) - 20) };
}

/** Policy the Silo server route applies before broadcasting a claim (also unit-tested). */
export function isAllowedClaimTx(tx, { programId = PROGRAM_ID } = {}) {
  const ixs = tx.instructions;
  if (ixs.length < 1 || ixs.length > 2) return false;
  if (!ixs[0].programId.equals(programId) || ixs[0].data.length !== 40 || !Buffer.from(ixs[0].data.subarray(0, 8)).equals(disc('claim'))) return false;
  if (ixs.length === 2) {
    const t = ixs[1];
    if (!t.programId.equals(SystemProgram.programId)) return false;
    if (!t.keys[0].pubkey.equals(tx.feePayer) || !t.keys[1].pubkey.equals(ixs[0].keys[1].pubkey)) return false; // leftover only to claimer
  }
  return true;
}

/**
 * The ONLY chain view used for money-moving decisions (H1, H2, H7). It comes from an independent
 * public RPC, never from the Silo server (Grain runs both the server and the maker).
 * rpcCall(method, params) -> JSON-RPC result.
 * Returns { now, pda, outcome, blockhash, feePayerLamports }:
 * - pda is null once the escrow is closed or the address was recreated as a non-program account;
 * - outcome is read from the full paged history and bound to this swap account and the expected share.
 */
export async function readChainIndependent(r, rpcCall, { maxPages = 20 } = {}) {
  // History is scanned newest -> oldest, resuming from r.historyCursor across ticks (H7): signatures
  // added after closure only sit in front of the cursor, so progress toward the closing tx is never lost.
  let historyCursor = r.historyCursor ?? null;
  const slot = await rpcCall('getSlot', [{ commitment: 'confirmed' }]);
  const now = await rpcCall('getBlockTime', [slot]);
  if (!Number.isSafeInteger(now)) throw new Error('chain-time-unavailable');
  const acc = (await rpcCall('getAccountInfo', [r.pda, { encoding: 'base64', commitment: 'confirmed' }]))?.value ?? null;
  let pda = null, outcome = null;
  if (acc && acc.owner === PROGRAM_ID.toBase58()) { try { pda = decodeSwap(Buffer.from(acc.data[0], 'base64')); } catch { pda = null; } }
  if (!pda) {
    let before = historyCursor ?? undefined;
    outer: for (let page = 0; page < maxPages; page++) {
      const rows = (await rpcCall('getSignaturesForAddress', [r.pda, { limit: 1000, before, commitment: 'confirmed' }])) ?? [];
      for (const row of rows) {
        if (row.err) continue;
        const tx = await rpcCall('getTransaction', [row.signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
        if (!tx?.transaction?.message || tx.meta?.err) continue;
        const c = matchRevealed(tx.transaction.message, { pda: r.pda, which: 'claim', expectedPoint: r.A });
        if (c) { outcome = { kind: 'claimed', secret: hex(c), sig: row.signature }; break outer; }
        const f = matchRevealed(tx.transaction.message, { pda: r.pda, which: 'refund', expectedPoint: r.B });
        if (f) { outcome = { kind: 'refunded', secret: hex(f), sig: row.signature }; break outer; }
      }
      if (rows.length < 1000) { historyCursor = null; break; }   // reached the oldest row: next pass starts fresh
      before = rows[rows.length - 1].signature;
      historyCursor = before;
    }
    if (outcome) historyCursor = null;
  }
  const feePayerLamports = (await rpcCall('getBalance', [r.feePayer, { commitment: 'confirmed' }]))?.value;
  const blockhash = (await rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }]))?.value?.blockhash;
  if (!Number.isSafeInteger(feePayerLamports) || typeof blockhash !== 'string') throw new Error('chain-read-incomplete');
  return { now, pda, outcome, blockhash, feePayerLamports, historyCursor };
}

/** Last check right before secret-bearing bytes leave the device (after any await): own clock only. */
export const claimStillSafe = (r, localNow = Math.floor(Date.now() / 1000)) => localNow < r.t1 - MARGIN;
