// Standalone XMR -> SOL swap driver (reference client). The user brings a maker URL, a Solana RPC URL (optionally a second one) and a Monero wallet RPC with a
// funded wallet; nothing else is contacted. As in swap-lib.mjs the swap decisions come from the same modules Silo's wallet runs
// (lib/silo/atomic-swap/alice-flow.mjs, client/swap-core.mjs, rules H1-H7) and the step order from the same driver (lib/silo/atomic-driver.mjs), but this file
// is not free of logic: the funding reservation, its reconciliation with the wallet and the sweep through the wallet RPC are code of this client.
// What this file adds is what a program without the wallet UI needs:
//   - client-side checks of the maker's quote before anything is stored,
//   - a durable, encrypted swap file, written BEFORE the maker is asked to register, and before and after the one XMR payment,
//   - the user's XMR payment from the user's own monero-wallet-rpc: built without relaying, recorded durably, only then relayed, never repeated,
//   - the claim, signed by the throwaway fee payer in the record and broadcast through the user's own Solana RPC (and a second one when given), no relay.
// Secrets (swap secrets, wallet password, URLs, tokens) are never logged and never put in an error message.
import * as flow from '../../../lib/silo/atomic-swap/alice-flow.mjs';
import { createAtomicDriver } from '../../../lib/silo/atomic-driver.mjs';
import { MARGIN, LOCK_MIN_LEAD, LOCK_WAIT, MIN_GAS, T0_MAX_LEAD, T1_MAX_LEAD } from '../client/swap-core.mjs';
import { xmrTransferRequest } from '../maker/maker-reverse.mjs';
import { PublicKey } from '@solana/web3.js';
import { SwapRefusal, refuse, createSolanaRpc, createChainClock, createSwapFile, createWalletRpc, createMoneroBridge, checkDestination, preflightSolana, parseXmrAmount,
  formatXmr, formatSol, utc, sha, parseUserUrl, noRedirect, checkNewPassphrase, DEFAULT_MAX_SPREAD_BPS, QUOTE_MAX_TTL_S, POLL_MS, SCAN_TIMEOUT_MS } from './swap-lib.mjs';
import { createLogger, describeError, scrub } from './swap-log.mjs';

const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
const isPubkey = (s) => { try { return typeof s === 'string' && new PublicKey(s).toBase58() === s; } catch { return false; } };
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

// ---- client-side quote checks --------------------------------------------------------------------------------------------------------
/**
 * Everything that can be checked about a forward quote from the quote alone. Unknown fields (for example `tiers`) are ignored and never change what is charged.
 * The user PAYS `xmrAtomic` and RECEIVES `lamports` (the maker's gas top-up comes on top of that, to the fee payer). Throws SwapRefusal.
 */
export function checkForwardQuote(q, { xmrAtomic, now, minSolPerXmr = null, maxSpreadBps = DEFAULT_MAX_SPREAD_BPS, maxTtlS = QUOTE_MAX_TTL_S }) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) refuse('quote-malformed', 'The quote is not an object.');
  if (q.direction !== undefined && q.direction !== 'xmr-sol') refuse('quote-wrong-direction', 'The maker answered with a quote for another direction.');
  if (typeof q.quoteId !== 'string' || !HEX(32).test(q.quoteId) || typeof q.swapId !== 'string' || !HEX(64).test(q.swapId)) refuse('quote-malformed', 'The quote ids are malformed.');
  if (typeof q.xmrAtomic !== 'string' || !/^\d{1,18}$/.test(q.xmrAtomic) || BigInt(q.xmrAtomic) !== BigInt(xmrAtomic)) refuse('quote-amount-mismatch', 'The quote is for a different XMR amount than you asked for.');
  if (!(Number.isSafeInteger(q.lamports) && q.lamports > 0)) refuse('quote-malformed', 'The SOL amount in the quote is not valid.');
  if (!(Number.isSafeInteger(q.gasLamports) && q.gasLamports >= MIN_GAS)) refuse('quote-gas-too-low', 'The maker does not fund enough SOL for your claim fee. The swap could not finish without SOL of your own.');
  if (!Number.isSafeInteger(q.expiresAt)) refuse('quote-malformed', 'The quote has no valid expiry.');
  if (q.expiresAt <= now) refuse('quote-expired', 'The quote has already expired.');
  if (q.expiresAt > now + maxTtlS) refuse('quote-ttl-too-long', 'The quote stays open longer than this client accepts.');
  if (q.confirmations !== undefined && !(Number.isSafeInteger(q.confirmations) && q.confirmations >= 1 && q.confirmations <= 10)) refuse('quote-malformed', 'The confirmation depth in the quote is not valid.');
  const receivePerXmr = q.lamports / 1e9 / (Number(xmrAtomic) / 1e12);
  if (minSolPerXmr !== null && receivePerXmr < minSolPerXmr) refuse('quote-price-under-limit', `The quote pays ${receivePerXmr.toFixed(6)} SOL per XMR, below your limit of ${minSolPerXmr} SOL per XMR.`);
  let solPerXmr = null, spreadBps = null;
  if (q.solPerXmr !== undefined || q.spreadBps !== undefined) {
    solPerXmr = q.solPerXmr; spreadBps = q.spreadBps;
    if (!(typeof solPerXmr === 'number' && Number.isFinite(solPerXmr) && solPerXmr > 0)) refuse('quote-price-inconsistent', 'The price in the quote is not a positive number.');
    if (!(Number.isSafeInteger(spreadBps) && spreadBps >= 0)) refuse('quote-price-inconsistent', 'The spread in the quote is not a whole number of basis points.');
    if (spreadBps > maxSpreadBps) refuse('quote-spread-too-high', `The maker spread (${spreadBps} basis points) is above your limit (${maxSpreadBps}).`);
    const implied = Number(xmrAtomic) / 1e12 * solPerXmr * (1 - spreadBps / 10_000) * 1e9 - q.gasLamports;
    if (Math.abs(implied - q.lamports) > Math.max(2, Math.abs(implied) * 0.001)) refuse('quote-price-inconsistent', 'The SOL amount does not match the stated price and spread.');
  }
  return { swapId: q.swapId, xmr: formatXmr(xmrAtomic), xmrAtomic: String(xmrAtomic), lamports: q.lamports, sol: formatSol(q.lamports), gasLamports: q.gasLamports, receivePerXmr, solPerXmr, spreadBps,
    confirmations: q.confirmations ?? null, expiresAt: q.expiresAt, tiers: Array.isArray(q.tiers) ? q.tiers.length : null };
}

export function describeForwardTerms(t, { network, solAddress }) {
  return [
    `You pay ${t.xmr} XMR (Monero ${network === 'mainnet' ? 'mainnet' : 'stagenet'}) and receive ${t.sol} SOL at ${solAddress}.`,
    t.solPerXmr !== null ? `Stated price ${t.solPerXmr} SOL per XMR, maker spread ${t.spreadBps} basis points.` : 'The maker states no price or spread.',
    `Quote valid until ${utc(t.expiresAt)}.`,
    'Order of events: the maker locks the SOL in the swap program before you pay anything. You pay the XMR only after this tool has read that escrow from your own Solana RPC and every field matches. Nothing is paid before then.',
    `The maker's timelocks must fall inside fixed bounds: t0 between ${LOCK_MIN_LEAD / 3600} and ${T0_MAX_LEAD / 3600} hours after registration, t1 at most ${T1_MAX_LEAD / 3600} hours after it (exact times are printed once the maker has locked).`,
    'YOU MUST CLAIM THE SOL BEFORE t1. This tool claims for you while it runs: keep it running (or run resume) until the swap is done.',
    'If you miss t1: the maker can refund its SOL after t1, and that refund reveals what this tool needs to move your XMR back to your own address. If the maker stays silent after t1, you cannot move your XMR alone: it waits at the shared address until the maker acts.',
    'Your claim transaction reveals a secret. It is broadcast only through your own Solana RPC (and the second one if you gave it); there is no relay.',
  ];
}

// ---- Monero side: the user's own funding wallet ------------------------------------------------------------------------------------------
const destinationsOf = (e) => [e.address, ...(Array.isArray(e.destinations) ? e.destinations.map((d) => d.address) : [])].filter(Boolean);
/** The wallet's own outgoing or pending transfers to this address, from a get_transfers answer. */
export function findOutgoing(t, address, txid = null) {
  const all = [...(t?.out ?? []), ...(t?.pending ?? []), ...(t?.pool ?? [])];
  return all.filter((e) => destinationsOf(e).includes(address) && (txid === null || e.txid === txid));
}

/**
 * Did the payment with this txid leave the wallet? Decided by the txid ALONE, never by the destination: a wallet that lost its cache and rescanned can
 * report an outgoing transaction without its destination. Returns { state: 'seen' | 'absent' | 'unknown', entry }.
 * 'absent' only when BOTH lookups completed without error and neither knows the txid. Any error or odd answer is 'unknown', which is never "not sent".
 */
export async function txidState(w, txid) {
  if (typeof txid !== 'string' || !HEX(64).test(txid)) return { state: 'unknown', entry: null };
  let byTxid = 'unknown', entry = null;
  try {
    const r = await w('get_transfer_by_txid', { txid });
    const t = r?.transfer ?? (Array.isArray(r?.transfers) ? r.transfers[0] : null);
    if (t && (t.txid === undefined || t.txid === txid)) { entry = t; byTxid = 'seen'; } else byTxid = 'unknown';
  } catch (e) { byTxid = (e?.code === -8 || /not found/i.test(String(e?.message))) ? 'absent' : 'unknown'; }
  if (byTxid === 'seen') return { state: 'seen', entry };
  let lists = 'unknown';
  try {
    const t = await w('get_transfers', { out: true, pending: true, pool: true });
    if (t && typeof t === 'object') {
      const hit = [...(t.out ?? []), ...(t.pending ?? []), ...(t.pool ?? [])].find((e) => e.txid === txid);
      if (hit) return { state: 'seen', entry: hit };
      lists = 'absent';
    }
  } catch { lists = 'unknown'; }
  return { state: byTxid === 'absent' && lists === 'absent' ? 'absent' : 'unknown', entry: null };
}

// ---- the funding reservation --------------------------------------------------------------------------------------------------------------
/**
 * The payment intent is a small state machine on the record: nothing -> reserved (written BEFORE the wallet builds anything, bound to the funding wallet) ->
 * built (txid and the transaction, written BEFORE the relay). A different non-null intent is never accepted over an existing one: not another txid, not another
 * wallet, not another amount or address. Throws SwapRefusal('funding-conflict' | 'funding-wallet-mismatch').
 */
export function checkIntentTransition(cur, next) {
  if (!cur || !next) return;
  if (cur.walletId && next.walletId && cur.walletId !== next.walletId) refuse('funding-wallet-mismatch', 'This swap\'s payment was reserved or made from a different wallet. Resume with the original funding wallet.');
  if (String(cur.amountAtomic) !== String(next.amountAtomic) || cur.address !== next.address) refuse('funding-conflict', 'A different payment is already recorded for this swap. The record was not changed.');
  if (cur.txid && next.txid !== cur.txid) refuse('funding-conflict', 'A different payment is already recorded for this swap. The record was not changed.');
}
export const WALLET_ID_DOMAIN = 'silo-standalone-swap/funding-wallet/v1/';

// ---- the session -------------------------------------------------------------------------------------------------------------------------
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const CARRY = ['fundingAttempted', 'fundingIntent', 'fundingRelayed', 'xmrLockTxid', 'xmrLockHeight', 'xmrConfirmations'];
const isDone = (v) => ['final', 'received', 'refunded'].includes(v.phase) || (v.phase === 'stopped' && v.record?.status === 'done');
export function forwardPhaseLine(v) {
  const r = v.record ?? {};
  switch (v.phase) {
    case 'waiting-maker': return 'Registered with the maker; waiting for its SOL lock.';
    case 'checking-lock': return 'Reading the maker escrow from your Solana RPC.';
    case 'awaiting-xmr': return v.notice === 'dry run' ? 'Next step when run: pay the XMR from your wallet (after the escrow checks).' : (v.notice ?? 'Escrow checked. Paying the XMR from your wallet.');
    case 'confirming': return `XMR payment sent${v.confirmations != null ? `: ${v.confirmations} confirmations` : ''}. Waiting for the maker to confirm.`;
    case 'claiming': return 'Claiming the SOL (broadcast through your own Solana RPC, retried every minute inside the window).';
    case 'awaiting-refund': return 'The claim window closed with your XMR sent. Only the maker refund moves it now.';
    case 'recovering': return v.notice ?? 'The maker refunded. Moving your XMR back to your own address.';
    case 'received': return 'Done. The SOL arrived at your address.';
    case 'refunded': return 'Done. The maker refunded and your XMR was moved back to your address.';
    case 'stopped': return `Stopped: ${r.result ?? v.reason ?? 'no result'}.`;
    case 'final': return `Finished: ${r.result ?? r.status}.`;
    default: return v.phase;
  }
}
export function forwardOutcomeOf(v) {
  const result = v?.record?.result;
  if (result === 'sol-received') return { code: 0, text: 'sol-received' };
  if (result === 'xmr-recovered') return { code: 3, text: 'xmr-recovered' };
  if (v?.record?.status === 'done' || v?.record?.status === 'rejected') return { code: 3, text: result ?? 'stopped' };
  return { code: 4, text: 'in-progress' };
}

/**
 * o = { network, solanaRpcUrl, secondSolanaRpcUrl?, moneroWalletRpcUrl, moneroLogin?, fundingWallet, fundingWalletPassword, daemonHeight, solAddress, xmrAddress, expectedMaker,
 *       minSolPerXmr, maxSpreadBps?, recordPath, maker (createMakerClient), fetcher, now, sleep, log, confirmPayment(info) -> bool }
 * `fetcher` serves the maker and the Solana RPCs; `walletFetcher` serves the wallet RPC and the node.
 */
export function createForwardSession(o) {
  const { network, sleep = sleepReal, fetcher = fetch } = o;
  const logger = createLogger({ sink: o.log ?? (() => {}), secrets: () => [o.solanaRpcUrl, o.secondSolanaRpcUrl, o.moneroWalletRpcUrl, o.moneroLogin, o.fundingWalletPassword, o.recordPassphrase, ...(o.maker?.secrets ?? []), ...(o.secrets ?? [])] });
  const log = logger.show;
  if (network !== 'mainnet' && network !== 'devnet') refuse('bad-network', 'The network must be named explicitly: mainnet or devnet.');
  const localNow = o.now ?? (() => Date.now());
  const solanaUrl = parseUserUrl(o.solanaRpcUrl, 'Solana RPC');
  const solana = createSolanaRpc({ url: solanaUrl, fetcher });
  const second = o.secondSolanaRpcUrl ? createSolanaRpc({ url: o.secondSolanaRpcUrl, fetcher }) : null;
  const safeFetcher = noRedirect(fetcher);
  const clock = createChainClock({ rpc: solana, localNow, onSkew: (s) => log(`Warning: your computer clock differs from Solana chain time by ${s} seconds. Chain time is used for every deadline.`) });
  const now = () => clock.now();
  const syncClock = async () => { try { await clock.sync(); } catch { if (!clock.synced) throw new SwapRefusal('clock-unsynced', 'Could not read chain time from your Solana RPC.'); } };
  const rpcIsLocal = LOOPBACK.has(new URL(solanaUrl).hostname);
  const file = createSwapFile(o.recordPath, { passphrase: o.recordPassphrase ?? null, kdf: o.recordKdf, minKdfN: o.recordMinKdfN });
  const wallet = () => createWalletRpc({ url: o.moneroWalletRpcUrl, login: o.moneroLogin ?? null, fetchImpl: o.walletFetcher ?? fetcher });
  let latest = null;                                    // the newest record this process holds (merged with the file)

  const diskRecord = () => { try { return file.load().record; } catch (e) { if (e instanceof SwapRefusal && (e.code === 'record-decrypt-failed' || e.code === 'passphrase-missing' || e.code === 'record-file-unsafe')) throw e; return null; } };
  const walletIdOf = async (w) => {
    const a = await w('get_address', { account_index: 0 }).catch(() => null);
    if (typeof a?.address !== 'string' || !a.address) throw new SwapRefusal('funding-wallet-unreadable', 'Could not read the address of the funding wallet, so it cannot be matched to this swap. Nothing was paid.');
    return sha(`${WALLET_ID_DOMAIN}${a.address}`);
  };
  /** Chain re-read for a payment decision: the escrow is exactly what was accepted, the quote is still open and the funding cutoff has not passed, all by chain time. */
  async function payableNow(r, cutoffMs) {
    const chain = await flow.readChainIndependent(r, solana);
    const next = flow.nextAction({ ...r, fundingAttempted: undefined, xmrLockTxid: undefined }, chain);
    if (chain.now >= r.quote.expiresAt) refuse('quote-expired', 'The quote expired before the payment could be sent. Nothing was paid.');
    if (chain.now * 1000 >= cutoffMs) refuse('funding-deadline', 'The deadline to pay for this swap has passed. Nothing was paid.');
    if (next.action !== 'lock-xmr') refuse('escrow-changed', `The maker escrow does not match what you accepted any more (${next.reason ?? next.result ?? next.action}). Nothing was paid.`);
  }

  function makeDriver({ dry, meta }) {
    const w = wallet();
    const persist = (record, { release = false, ifRev = null } = {}) => {
      const cur = dry ? null : diskRecord();
      const out = { ...record };
      if (cur) {
        checkIntentTransition(cur.fundingIntent, out.fundingIntent);
        if (cur.xmrLockTxid && out.xmrLockTxid && cur.xmrLockTxid !== out.xmrLockTxid) refuse('funding-conflict', 'A different payment is already recorded for this swap. The record was not changed.');
        if (release) {
          if (cur.fundingIntent?.txid || cur.xmrLockTxid) refuse('funding-conflict', 'A payment is already recorded for this swap; the reservation cannot be released.');
          out.fundingIntent = undefined; out.fundingAttempted = undefined;
        } else for (const f of CARRY) if (cur[f] != null && out[f] == null) out[f] = cur[f];   // a later write from a stale copy never forgets a payment
      }
      if (!dry) file.saveRecord(out, ifRev === null ? {} : { ifRev });
      latest = out; return out;
    };
    const bridge = createMoneroBridge({ wallet: w, daemonHeight: o.daemonHeight ?? (async () => { throw new Error('no Monero node URL'); }), destination: meta?.xmrAddress,
      saveRecord: async (r) => { persist(r); }, records: () => (latest ? [latest] : []) });
    const fundJob = (fn) => bridge.job(`${o.fundingWallet}`, o.fundingWalletPassword ?? '', () => { throw new Error('the funding wallet could not be opened'); }, fn);
    const outgoing = async (address, txid = null) => findOutgoing(await w('get_transfers', { out: true, pending: true, pool: true }), address, txid);
    if (dry) bridge.sweepRecovery = async () => { throw Object.assign(new Error('dry run'), { dryRun: true }); };
    const patch = (fields, opts) => persist({ ...latest, ...fields }, opts);

    /** The one XMR payment. Called by the driver only after the core has accepted the escrow (proofs, every field, timelocks by chain time, fee payer funded). */
    bridge.lockStatus = ({ address }) => fundJob(async () => {
      const intentTxid = latest?.fundingIntent?.txid ?? null;
      if (intentTxid) {                                  // an intent exists: the txid alone decides; an unknown answer is an error, never "not found"
        const t = await txidState(w, intentTxid);
        if (t.state === 'unknown') throw new Error('payment state unknown');
        if (t.state === 'absent') return { found: false, txid: null, confirmations: null, height: null };
        return { found: true, txid: intentTxid, confirmations: t.entry?.confirmations ?? 0, height: t.entry?.height ?? null };
      }
      const mine = await outgoing(address, null);
      if (!mine.length) return { found: false, txid: null, confirmations: null, height: null };
      const e = mine[0];
      return { found: true, txid: e.txid, confirmations: e.confirmations ?? 0, height: e.height ?? null };
    });
    bridge.prepareLock = async ({ address, amountAtomic, swapId, expiresAt }) => {
      if (dry) throw Object.assign(new Error('dry run'), { dryRun: true });
      // The session holds the swap's lock; the record on disk is the truth, not this process's earlier copy.
      const onDisk = diskRecord(); if (onDisk) latest = onDisk;
      const r = latest;
      if (!r || r.swapId !== swapId || r.jointAddress !== address || String(r.quote.xmrAtomic) !== String(amountAtomic)) throw new Error('payment request does not match the swap record');
      const reservedOnly = r.fundingIntent && !r.fundingIntent.txid;     // an earlier run reserved but never built: nothing left the wallet, the same wallet may go on
      if (r.xmrLockTxid || (r.fundingAttempted && !reservedOnly)) throw new Error('a payment was already attempted for this swap');
      if (o.expectedMaker && r.refunder !== o.expectedMaker) throw new SwapRefusal('maker-address-mismatch', 'The escrow counterparty is not the maker address you expected. Nothing was paid.');
      await syncClock();
      if (now() >= expiresAt) throw new SwapRefusal('funding-deadline', 'The deadline to pay for this swap has passed. Nothing was paid.');
      await payableNow(r, expiresAt);
      const info = { amount: formatXmr(amountAtomic), address, claimBy: r.t1 - MARGIN, t0: r.t0, t1: r.t1, sol: formatSol(r.quote.lamports), solAddress: r.claimer, quoteExpiresAt: r.quote.expiresAt };
      if (typeof o.confirmPayment !== 'function' || !(await o.confirmPayment(info))) throw new SwapRefusal('declined', 'You declined to pay. Nothing was paid.');
      // The confirmation can take any time. Everything the decision rested on is read again NOW: the quote, the exact escrow terms, the funding cutoff.
      await syncClock();
      if (now() >= expiresAt) throw new SwapRefusal('funding-deadline', 'The deadline to pay for this swap has passed. Nothing was paid.');
      const fresh = diskRecord() ?? latest; latest = fresh;
      if (fresh.xmrLockTxid || (fresh.fundingAttempted && !(fresh.fundingIntent && !fresh.fundingIntent.txid))) throw new Error('a payment was already attempted for this swap');
      await payableNow(fresh, expiresAt);
      let elsewhere = false;
      await fundJob(async () => {
        const id = await walletIdOf(w);
        const held = latest.fundingIntent;
        if (held?.walletId && held.walletId !== id) throw new SwapRefusal('funding-wallet-mismatch', `This swap's payment was reserved from a different wallet. Resume with the original funding wallet (${meta?.fundingWallet ?? 'the one you started with'}).`);
        // 1. What this wallet already sent to this address wins: never pay twice.
        const already = await outgoing(address);
        if (already.length) { patch({ fundingAttempted: latest.fundingAttempted ?? localNow(), xmrLockTxid: already[0].txid, fundingRelayed: true }); return; }
        const bal = await w('get_balance');
        if (BigInt(bal.unlocked_balance ?? 0) < BigInt(amountAtomic)) throw new SwapRefusal('funds-low', 'The funding wallet has not enough unlocked XMR for this swap. Nothing was paid.');
        // 2. Reserve BEFORE anything is built: the reservation (this wallet, this amount, this address) is on disk before anything else, and no other intent can replace it.
        //    Only the run that CREATED the reservation (it holds its unique claim token) may build and transfer. 'same' = another execution already owns this funding step.
        const reserved = { state: 'reserved', walletId: id, amountAtomic: String(amountAtomic), address, txid: null, at: localNow() };
        const claim = file.claimIntent(reserved);
        if (claim.status !== 'created') { elsewhere = true; return; }
        patch({ fundingAttempted: latest.fundingAttempted ?? localNow(), fundingIntent: reserved });
        const revReserved = file.revision();
        // 3. Build without relaying: the txid and the transaction are known before anything leaves the wallet. A failure here leaves nothing built or sent, so the reservation is released.
        //    Immediately before the transfer: this run still holds the swap lock AND the reservation still carries this run's own token.
        if (!file.lockStillHeld() || !file.ownsIntent(claim.token)) throw new SwapRefusal('funding-conflict', 'The payment reservation is no longer held by this run, so nothing was built or paid. Run resume again.');
        let built;
        try {
          built = await w('transfer', xmrTransferRequest(address, amountAtomic));
          if (typeof built?.tx_hash !== 'string' || !HEX(64).test(built.tx_hash) || typeof built?.tx_metadata !== 'string' || !built.tx_metadata) throw new Error('wallet rpc returned no relayable transaction');
          if (BigInt(built.amount) !== BigInt(amountAtomic)) throw new SwapRefusal('amount-mismatch', 'The wallet built a payment of a different amount. Nothing was sent.');
        } catch (e) { persist({ ...latest }, { release: true }); file.releaseIntent(reserved, claim.token); throw e; }
        // 4. The txid and the transaction are on disk BEFORE the relay, written only if the swap file is still at the revision this run last wrote and this run still owns the
        //    reservation. From here the record counts as "payment may have gone out": the driver never pays again. A refusal here relays nothing.
        if (!file.ownsIntent(claim.token)) throw new SwapRefusal('funding-conflict', 'The payment reservation changed while the payment was built. The built transaction was not recorded and not relayed. Run resume again.');
        patch({ fundingIntent: { ...reserved, state: 'built', txid: built.tx_hash, hex: built.tx_metadata, at: localNow() } }, { ifRev: revReserved });
        // 5. Immediately before the relay: time, quote expiry, the escrow, once more. A failure keeps the built transaction on disk (abandoned, looked at again on every resume) and sends nothing.
        try { await syncClock(); await payableNow(latest, expiresAt); }
        catch (e) {
          if (e instanceof SwapRefusal) { patch({ fundingRelayed: false, fundingAbandoned: e.code === 'funding-deadline' ? 'deadline-before-relay' : `recheck-${e.code}` }); throw e; }
          throw e;                                         // the chain could not be read: unknown, nothing relayed, the intent stays for the next pass
        }
        await w('relay_tx', { hex: built.tx_metadata });
        patch({ xmrLockTxid: built.tx_hash, fundingRelayed: true });
      });
      if (elsewhere) await followOtherOwner(meta);
    };
    /**
     * Another execution owns the funding step of this swap. This run builds and transfers NOTHING. It looks at the record for a short while: if the other run persisted its built
     * transaction, that transaction (by txid) is the one thing that may still be relayed, and only through the usual checks of settleFunding; otherwise it stops with a clear message.
     */
    const followOtherOwner = async (m) => {
      for (let i = 0; i < 5; i++) {
        const rec = diskRecord() ?? latest;
        if (rec?.xmrLockTxid) { latest = rec; return; }
        if (rec?.fundingIntent?.txid) { latest = await settleFunding(rec, m); if (latest.xmrLockTxid) return; break; }
        await sleep(2000);
      }
      throw new SwapRefusal('funding-in-progress', 'Another run is already paying for this swap. This run built and sent nothing. Wait a minute, then run resume to continue.');
    };
    const second2 = second;
    const post = async (action, body) => {
      if (action === 'quote') return o.maker.quoteForward(body.xmr);
      if (action === 'swap') return o.maker.registerForward(body);
      if (action === 'claim') {                           // no relay: the claim goes to the user's own RPC(s) only; the driver already sent it to the first
        if (second2 && !dry) { try { await second2('sendTransaction', [body.tx, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }]); } catch { /* best effort */ } }
        return {};
      }
      throw new Error('unexpected action');
    };
    // A status pass reads everything but never lets a transaction leave.
    const dryFetcher = async (url, init) => {
      try { if (JSON.parse(init?.body ?? '{}').method === 'sendTransaction') return { ok: true, status: 200, json: async () => ({ result: 'dry-run' }) }; } catch { /* not JSON */ }
      return safeFetcher(url, init);
    };
    const driver = createAtomicDriver({ flow, post, bridge, network, now, fetcher: dry ? dryFetcher : safeFetcher, publicRpc: solanaUrl });
    return { driver, persist, seed: (r) => { latest = r; } };
  }

  /** A funding wallet other than the one the swap started with (or reserved a payment from) must not go on with it. Checked before a resume or a status pass acts. */
  async function assertFundingWallet(record, meta) {
    if (meta.fundingWallet && o.fundingWallet && meta.fundingWallet !== o.fundingWallet) refuse('funding-wallet-mismatch', `This swap started with the funding wallet "${meta.fundingWallet}". Resume with that wallet.`);
    const bound = record.fundingIntent?.walletId;
    if (!bound || !o.fundingWallet) return;                  // no funding wallet named (a status pass): nothing is paid or relayed, so there is nothing to match
    const w = wallet(); const bridge = createMoneroBridge({ wallet: w, destination: meta.xmrAddress, saveRecord: async () => {}, records: () => [] });
    let id;
    try { id = await bridge.job(o.fundingWallet, o.fundingWalletPassword ?? '', () => { throw new Error('the funding wallet could not be opened'); }, () => walletIdOf(w)); }
    catch (e) { if (e instanceof SwapRefusal) throw e; throw new SwapRefusal('funding-wallet-unreadable', 'The funding wallet could not be opened to match it to this swap. Nothing was changed. Check the wallet RPC and try again.'); }
    if (id !== bound) refuse('funding-wallet-mismatch', `This swap's payment was reserved or made from a different wallet than the one you gave. Resume with the original funding wallet (${meta.fundingWallet ?? 'the one you started with'}).`);
  }

  /**
   * The recorded payment from an earlier run (crash between the steps, or an earlier "abandoned"): decided from the recorded txid ALONE, on every resume and every
   * status pass. seen anywhere -> paid (continue to claim, or to recovery after a maker refund). unknown (wallet or RPC error) -> change nothing, relay nothing, abandon
   * nothing. absent -> relay the SAME recorded transaction only while the funding deadline allows AND the quote is still open AND the escrow still matches what was
   * accepted (read again just before the relay); otherwise mark abandoned. Abandoned is never terminal: the next pass looks again.
   * dry = read only (status): returns the record as it would be, writes and relays nothing.
   */
  async function settleFunding(record, meta, { dry = false } = {}) {
    const intent = record.fundingIntent;
    if (!intent?.txid || record.xmrLockTxid) return record;
    const w = wallet(); const { persist } = makeDriver({ dry, meta });
    const bridge = createMoneroBridge({ wallet: w, destination: meta.xmrAddress, saveRecord: async () => {}, records: () => [] });
    const paid = { ...record, xmrLockTxid: intent.txid, fundingRelayed: true, fundingAbandoned: undefined };
    try {
      return await bridge.job(o.fundingWallet, o.fundingWalletPassword ?? '', () => { throw new Error('the funding wallet could not be opened'); }, async () => {
        const t = await txidState(w, intent.txid);
        if (t.state === 'seen') return dry ? paid : persist(paid);
        if (t.state === 'unknown') return record;                       // never "not sent" on an error
        if (dry) return record;
        await syncClock();
        const deadline = (record.t0 - LOCK_MIN_LEAD) * 1000;
        if (now() >= deadline) return record.fundingAbandoned ? record : persist({ ...record, fundingAbandoned: 'deadline-before-relay' });   // never relay a stale transaction
        try { await payableNow(record, deadline); }
        catch (e) {
          if (e instanceof SwapRefusal) return persist({ ...record, fundingAbandoned: e.code === 'funding-deadline' ? 'deadline-before-relay' : `recheck-${e.code}` });
          return record;                                                // the chain could not be read: unknown, relay nothing
        }
        await w('relay_tx', { hex: intent.hex });                       // the SAME signed transaction: cannot pay twice
        return persist({ ...paid });
      });
    } catch (e) { if (e instanceof SwapRefusal && /^funding-/.test(e.code)) throw e; return record; }   // wallet unreachable: unknown, change nothing
  }

  /** The same checks start makes, again before a resume acts: network, cluster, pinned program, destination. */
  async function preflightResume(meta) {
    if (meta.network !== network) refuse('network-mismatch', `This swap file is for ${meta.network}, but you named ${network}.`);
    if (o.xmrAddress && meta.xmrAddress && o.xmrAddress !== meta.xmrAddress) refuse('destination-mismatch', 'The Monero address you gave is not the one in the swap file.');
    await preflightSolana(solana, { network, rpcIsLocal });
    if (meta.xmrAddress) await checkDestination(wallet(), meta.xmrAddress, network);
  }

  async function run(record, { dry = false, meta, until = 'done', pollMs = POLL_MS, maxTicks = Infinity, onPhase = () => {} } = {}) {
    const { driver, seed } = makeDriver({ dry, meta });
    seed(record);
    let failures = 0, last = null, warnedAt = 0;
    for (let i = 0; i < maxTicks; i++) {
      let v;
      try { await syncClock(); } catch (e) { if (++failures >= 5) throw new SwapRefusal('stopped-after-errors', `Stopped after repeated errors (${describeError(e)}). Run resume to continue.`); logger.line(`temporary error (${describeError(e)}); retrying`); await sleep(pollMs); continue; }
      if ((latest ?? record).fundingAbandoned && !(latest ?? record).xmrLockTxid) { const again = await settleFunding(latest ?? record, meta, { dry }); if (again !== (latest ?? record)) { latest = again; record = again; } }
      try { v = await driver.tick(latest ?? record); failures = 0; }
      catch (e) {
        if (e.dryRun) return { ...last, phase: last?.phase ?? 'dry', record: latest ?? record };
        if (e instanceof SwapRefusal && e.code !== 'clock-unsynced') throw e;
        if (++failures >= 5) throw new SwapRefusal('stopped-after-errors', `Stopped after repeated errors (${describeError(e)}). Run resume to continue.`);
        logger.line(`temporary error (${describeError(e)}); retrying`); await sleep(pollMs); continue;
      }
      record = latest = { ...v.record, ...Object.fromEntries(CARRY.filter((f) => latest?.[f] != null && v.record[f] == null).map((f) => [f, latest[f]])) };
      last = logger.view({ ...v, record }); onPhase(last);
      // The claim is the user's job: warn loudly as t1 approaches while a payment may be out and nothing has closed it.
      if (record.t1 && (record.fundingAttempted || record.xmrLockTxid) && !isDone(last)) {
        const left = record.t1 - MARGIN - Math.floor(now() / 1000);
        if (left <= 3600 && Date.now() - warnedAt > 300_000) { warnedAt = Date.now(); logger.show(`WARNING: the claim window closes at ${utc(record.t1 - MARGIN)} (${Math.max(0, Math.floor(left / 60))} minutes). Keep this tool running. After that the SOL cannot be claimed and your XMR depends on the maker.`); }
      }
      if (isDone(last)) return last;
      if (dry) return last;
      if (until === 'paid' && (record.xmrLockTxid || record.fundingAttempted)) return last;
      await sleep(pollMs);
    }
    return last;
  }

  return {
    file,
    async preflight() {
      const program = await preflightSolana(solana, { network, rpcIsLocal });
      if (o.xmrAddress) await checkDestination(wallet(), o.xmrAddress, network);
      return program;
    },
    async quote(xmrText) {
      const xmrAtomic = parseXmrAmount(xmrText);
      await syncClock();
      const q = await o.maker.quoteForward(xmrText);
      const terms = checkForwardQuote(q, { xmrAtomic, now: Math.floor(now() / 1000), minSolPerXmr: o.minSolPerXmr ?? null, maxSpreadBps: o.maxSpreadBps ?? DEFAULT_MAX_SPREAD_BPS });
      return { quote: q, terms, xmrAtomic };
    },
    async start({ xmr, confirm, until = 'done', pollMs, maxTicks, onPhase }) {
      if (!o.solAddress || !isPubkey(o.solAddress)) refuse('sol-address-missing', 'Name the Solana address that receives the SOL (--sol-address).');
      if (!o.xmrAddress) refuse('destination-missing', 'A Monero address of yours is needed (--xmr-address): it receives your XMR back if the swap fails.');
      if (!o.fundingWallet) refuse('funding-wallet-missing', 'Name the wallet in your wallet RPC folder that pays the XMR (--monero-wallet).');
      if (!o.daemonHeight) refuse('node-missing', 'A Monero node URL is needed to start a swap (it chooses where the recovery scan starts).');
      if (!o.expectedMaker) refuse('maker-address-missing', 'Name the Solana address you expect for this maker (--maker-address): it is the key that locks the SOL.');
      if (o.minSolPerXmr == null) refuse('price-limit-missing', 'Set a price limit: --min-sol-per-xmr. No client can know the market price, so the limit has to come from you.');
      checkNewPassphrase(o.recordPassphrase);
      log('Connections: this tool talks directly to the endpoints you gave it. It does not use Tor and does not check that you do; your endpoints see your network address.');
      log('Your wallet RPC opens the funding wallet with its password and receives the swap keys it needs to move your XMR back if the swap fails (view key, and the spend key after a maker refund).');
      if (file.exists()) refuse('swap-file-exists', 'That swap file already exists. Use resume, or choose a new file name.');
      const program = await this.preflight();
      await syncClock();
      log(`Swap program ${program.programId}: ${program.upgradeable ? `upgradeable, upgrade authority ${program.upgradeAuthority ?? 'unknown'}` : 'not upgradeable'} (read from the chain).`);
      const { quote, terms } = await this.quote(xmr);
      for (const l of describeForwardTerms(terms, { network, solAddress: o.solAddress })) log(l);
      if (!(await confirm(terms))) refuse('declined', 'You declined. Nothing was stored and nothing was paid.');
      if (Math.floor(now() / 1000) >= quote.expiresAt - 5) refuse('quote-expired', 'The quote expired while you were deciding. Nothing was stored and nothing was paid. Run start again.');
      const height = await o.daemonHeight();
      if (!Number.isSafeInteger(height) || height <= 0) refuse('node-unreadable', 'Could not read the Monero network height from your node.');
      file.lock();
      try {
        file.create({ direction: 'xmr-sol', network, makerUrl: o.maker.url, xmrAddress: o.xmrAddress, solAddress: o.solAddress, fundingWallet: o.fundingWallet, createdAt: Math.floor(now() / 1000) });
        const meta = file.load();
        const { driver, seed } = makeDriver({ dry: false, meta });
        let record;
        // The driver stores the record (the swap secrets, the throwaway fee payer key) BEFORE it contacts the maker, then checks the maker answer (core rules).
        try { record = await driver.start({ quote, claimer: o.solAddress }); }
        catch (e) { throw new SwapRefusal('registration-refused', e?.userFacing ? scrub(e.message, [], { strict: true }) : `The maker registration was refused (${describeError(e)}).`); }
        if (record.refunder !== o.expectedMaker) {
          file.saveRecord({ ...record, status: 'rejected', result: 'maker-answer-rejected', rejectedReason: 'maker-address-mismatch' });
          throw new SwapRefusal('maker-address-mismatch', 'The maker locked from a different Solana address than the one you expected. Nothing was paid.');
        }
        seed(record);
        log(`Registered. Exact times: t0 ${utc(record.t0)}; claim window ends t1 ${utc(record.t1)}. Claim by ${utc(record.t1 - MARGIN)}.`);
        return await run(record, { meta, until, pollMs, maxTicks, onPhase });
      } finally { file.unlock(); }
    },
    async resume({ until = 'done', pollMs, maxTicks, onPhase } = {}) {
      file.lock();                                        // take the lock, then read: the record is the one on disk now
      try {
        const meta = file.load();
        if (!meta.record) refuse('no-record', 'The swap file has no swap in it yet.');
        await preflightResume(meta);
        let record = meta.record;
        await assertFundingWallet(record, meta);
        record = await settleFunding(record, meta);
        return await run(record, { meta, until, pollMs, maxTicks, onPhase });
      } finally { file.unlock(); }
    },
    async status() {
      const meta = file.load();
      if (!meta.record) return { meta, record: null, phase: 'no-record' };
      await assertFundingWallet(meta.record, meta);
      const r = await settleFunding(meta.record, meta, { dry: true });
      const v = await run(r, { dry: true, meta, maxTicks: 1 });
      return { meta, record: r, phase: v?.phase ?? 'unknown', view: v, schedule: r.t1 ? { t0: r.t0, t1: r.t1, claimBy: r.t1 - MARGIN, fundBy: r.t0 - LOCK_MIN_LEAD, makerAbortsIfNoXmrAt: (r.acceptedAt ?? 0) + LOCK_WAIT } : null };
    },
  };
}
