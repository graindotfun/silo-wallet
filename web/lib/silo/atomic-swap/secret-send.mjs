// Sending a transaction that CARRIES A SECRET (the maker's claim reveals `a`, a refund reveals `b`) is only allowed while the window that makes
// the reveal harmless is still open. Astra r6 (High): a check made before the send is not enough, because the send itself takes time
// (blockhash, broadcast). This module re-authorizes against a trusted clock immediately before signing and again immediately before the BROADCAST
// (a secret-carrying transaction sent through THIS module is never simulated; see the scope note in the threat model), prepares everything that does not depend on
// the secret first, and refuses (fails closed) whenever a safe margin cannot be established.
//
// Trusted clock: `now()` is the chain time (seconds). It can lag, and a failing or non-numeric answer is a refusal. Between two chain-time reads
// the local monotonic clock keeps the estimate moving, so a stalled or lagging RPC clock cannot make a late send look early.
import { Transaction, ComputeBudgetProgram } from '@solana/web3.js';

export const CLOCK_LAG_S = 30;            // chain time read from a confirmed slot trails real time; this much is always added
export const MAX_BLOCKHASH_AGE_MS = 45_000; // a blockhash older than this is not used for a secret-carrying broadcast

/** notAfter: chain-time second after which the reveal is no longer safe (null = no deadline, e.g. a refund after the claim window closed).
 * Timing baseline (Astra r7): the monotonic clock is read BEFORE the request for the chain time goes out. The chain time `t` was sampled by the node somewhere between
 * the request and its reply, so the real time at the reply is at most t + (reply - request); that upper bound is what is used from the very first reading. A slow or delayed
 * clock reply can therefore only make the estimate later, never earlier. Between readings the monotonic clock keeps the estimate moving. */
export function createAuthorizer({ now, mono = () => performance.now(), notAfter = null }) {
  let lastEst = null, lastM = null;
  return async function authorize(stage) {
    if (notAfter === null || notAfter === undefined) return Infinity;
    const requestedAt = mono();                                   // BEFORE the first await
    let t;
    try { t = await now(); } catch { throw new Error(`clock-unavailable:${stage}`); }
    if (!Number.isFinite(t)) throw new Error(`clock-unavailable:${stage}`);
    const repliedAt = mono();
    let est = t + Math.max(0, repliedAt - requestedAt) / 1000;    // upper bound of the real chain time at the moment of the reply
    if (lastEst !== null) est = Math.max(est, lastEst + Math.max(0, repliedAt - lastM) / 1000);
    if (est + CLOCK_LAG_S >= notAfter) throw new Error(`deadline-unsafe:${stage}`);
    lastEst = est; lastM = repliedAt;
    return notAfter - est - CLOCK_LAG_S;
  };
}

/**
 * Builds, signs and broadcasts one secret-carrying transaction under the rules above. It is NEVER simulated (Astra r7, design note): a simulation hands the instruction data,
 * secret included, to the RPC in a transmission that no blockhash bounds, and it adds nothing the program will not check again; the window is decided locally, from the finalized
 * account state and the trusted clock, by the caller. The inclusion bound is what remains: a blockhash at most MAX_BLOCKHASH_AGE_MS old plus its own validity (about 60 to 90 s).
 * deps: conn (getLatestBlockhash, sendRawTransaction, confirmTransaction, getTransaction), now(), mono().
 * Order: blockhash (no secret yet) -> authorize -> sign -> authorize -> blockhash age check -> broadcast -> confirm.
 */
export async function sendSecretVia({ conn, now, mono = () => performance.now(), notAfter = null, ix, payer, signers = [], units = 60_000 }) {
  const authorize = createAuthorizer({ now, mono, notAfter });
  const bhAt = mono();
  const bh = await conn.getLatestBlockhash();                       // prepared ahead: nothing here depends on the secret
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units }), ...(Array.isArray(ix) ? ix : [ix]));
  tx.feePayer = payer.publicKey; tx.recentBlockhash = bh.blockhash;
  await authorize('before-signing');
  tx.sign(payer, ...signers);                                        // local, instant
  await authorize('before-broadcast');                               // the exit boundary: the bytes leave right after this
  if (mono() - bhAt > MAX_BLOCKHASH_AGE_MS) throw new Error('blockhash-too-old');
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 });
  const done = await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, 'confirmed');
  if (done?.value?.err) throw new Error(`transaction failed: ${JSON.stringify(done.value.err)}`);
  const info = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  return { sig, cu: info?.meta?.computeUnitsConsumed, fee: info?.meta?.fee };
}
