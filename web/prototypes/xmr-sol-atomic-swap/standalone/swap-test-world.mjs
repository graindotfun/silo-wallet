// Shared fake maker, fake Solana chain and fake Monero wallet RPC for the standalone XMR -> SOL tests (also used by the multi-process race test).
import assert from 'node:assert/strict';
import { Keypair, Transaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { sha256 } from '@noble/hashes/sha256';
import { join } from 'node:path';
import { randomScalar, pub, hex, unhex, proveShare, addPoints, moneroAddress } from '../client/keys.mjs';
import { swapPda, PROGRAM_ID } from '../../../lib/silo/atomic-swap/sol.mjs';
import * as lib from './swap-lib.mjs';
import * as fwd from './swap-lib-xmr-sol.mjs';

export const MAKER = 'https://maker.example', SOL = 'http://127.0.0.1:8899', SOL2 = 'http://127.0.0.1:8900', XMR = 'http://127.0.0.1:38293', NODE = 'http://127.0.0.1:38081';
export const ORIGINS = new Set([MAKER, SOL, SOL2, XMR, NODE].map((u) => new URL(u).origin));
export const BASE = 1_900_000_000, DEST = '5' + 'A'.repeat(94);
const disc = (n) => Buffer.from(sha256(new TextEncoder().encode(n))).subarray(0, 8);
export const ok = (json, status = 200) => ({ ok: status < 400, status, type: 'basic', text: async () => JSON.stringify(json), json: async () => json });

/** { tmp, nextId, REC } -> world(opts). opts.preset = { swapId, escrow, feePayer, feeBalance, clock } rebuilds the chain state of a swap registered in another process. */
export function makeWorldFactory({ tmp, nextId, REC }) {
  return function world(opts = {}) {
  const maker = opts.preset?.maker ?? Keypair.generate().publicKey.toBase58(), user = opts.preset?.user ?? Keypair.generate().publicKey.toBase58();
  let clock = BASE;
  const swapId = opts.preset?.swapId ?? hex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  if (opts.preset?.clock) clock = opts.preset.clock;
  const W = { urls: [], posts: {}, escrow: null, history: [], sent: [], sent2: [], out: [], transfers: 0, relays: 0, sweeps: [], feePayer: null, feeBalance: 0, claimFailures: 0,
    quoteTweak: (q) => q, regTweak: (r) => r, escrowTweak: (e) => e, relayThrows: false, relayThrowsAfter: false, transferThrows: false, unlocked: '1000000000000', events: [], onRelay: null };
  const quote = () => W.quoteTweak({ quoteId: 'cd'.repeat(16), swapId, xmrAtomic: '50000000000', lamports: 344_000_000, gasLamports: 1_000_000, solPerXmr: 6.9, spreadBps: 0, priceSource: 'x', confirmations: 10, expiresAt: clock + 600 });
  if (opts.preset) { W.escrow = opts.preset.escrow; W.feePayer = opts.preset.feePayer; W.feeBalance = opts.preset.feeBalance; }
  let reg = null;
  const height = () => Math.floor((clock - BASE) * 2);
  const account = () => {
    const e = W.escrow, d = Buffer.alloc(8 + 186); disc('account:Swap').copy(d, 0); let o = 8;
    for (const k of [e.refunder, e.claimer]) { bs58.decode(k).forEach((x, i) => (d[o + i] = x)); o += 32; }
    Buffer.from(e.A, 'hex').copy(d, o); o += 32; Buffer.from(e.B, 'hex').copy(d, o); o += 32;
    d.writeBigUInt64LE(BigInt(e.lamports), o); o += 8; d.writeBigInt64LE(BigInt(e.t0), o); o += 8; d.writeBigInt64LE(BigInt(e.t1), o); o += 8; d[o] = e.ready ? 1 : 0; o += 1; Buffer.from(swapId, 'hex').copy(d, o);
    return { owner: e.owner ?? PROGRAM_ID.toBase58(), data: [d.toString('base64'), 'base64'] };
  };
  const chainRpc = (method, params, which) => {
    switch (method) {
      case 'getGenesisHash': return 'local-genesis';
      case 'getSlot': return params?.[0]?.commitment === 'finalized' ? height() : 1;
      case 'getBlockTime': return params[0] === 1 ? clock : clock - Math.floor((height() - params[0]) / 2);
      case 'getLatestBlockhash': return { value: { blockhash: bs58.encode(globalThis.crypto.getRandomValues(new Uint8Array(32))), lastValidBlockHeight: height() + 150 } };
      case 'getBalance': return { value: params[0] === W.feePayer ? W.feeBalance : 0 };
      case 'getAccountInfo':
        if (params[0] === PROGRAM_ID.toBase58()) return { context: { slot: height() }, value: { executable: true, owner: 'BPFLoaderUpgradeab1e11111111111111111111111', data: [Buffer.alloc(36).toString('base64'), 'base64'] } };
        return { context: { slot: height() }, value: W.escrow ? account() : null };
      case 'getSignaturesForAddress': return W.history.map((h, i) => ({ signature: `s${i}`, err: null }));
      case 'getTransaction': return W.history[Number(params[0].slice(1))];
      case 'sendTransaction': {
        (which === 2 ? W.sent2 : W.sent).push(params[0]);
        if (which === 1 && W.claimFailures > 0) { W.claimFailures--; throw new Error('blockhash not found'); }
        if (which === 1 || !W.escrow) {
          const tx = Transaction.from(Buffer.from(params[0], 'base64')), m = tx.compileMessage();
          const ix = m.instructions[0];
          W.history.push({ transaction: { message: { accountKeys: m.accountKeys.map((k) => k.toBase58()), instructions: [{ programIdIndex: ix.programIdIndex, accounts: ix.accounts, data: ix.data }] } }, meta: { err: null } });
          W.escrow = null;
        }
        return 'sig';
      }
      default: throw new Error(`unexpected solana method ${method}`);
    }
  };
  const walletRpc = (method, params) => {
    if (W.walletDown) throw new Error('connection refused');
    switch (method) {
      case 'validate_address': return { valid: params.address.startsWith('5'), nettype: 'stagenet', integrated: false };
      case 'close_wallet': case 'refresh': return {};
      case 'open_wallet': if (params.filename === 'funder') { if (params.password !== 'wallet-pass-123') throw new Error('bad password'); return {}; } throw new Error('not found');
      case 'generate_from_keys': W.walletKeys = params; return {};
      case 'get_balance': return { balance: W.unlocked, unlocked_balance: W.unlocked };
      case 'get_transfers': if (W.listError) throw new Error('wallet busy'); return { out: W.noDestinations ? W.out.map(({ destinations, ...e }) => e) : W.out, pending: [], pool: [] };
      case 'get_transfer_by_txid': {
        if (W.byTxidError) throw new Error('internal error');
        const e = W.out.find((x) => x.txid === params.txid); if (!e) { const err = new Error('Transaction not found.'); err.code = -8; throw err; }
        return { transfer: W.noDestinations ? (({ destinations, ...r }) => r)(e) : e };
      }
      case 'transfer': {
        if (W.transferThrows) throw new Error('daemon busy');
        W.transfers++; const d = params.destinations[0];
        assert.equal(params.do_not_relay, true, 'built without relaying');
        W.onTransfer?.(); W.built = { tx_hash: sha256(Buffer.from(`${process.pid}:${W.transfers}`)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''), tx_metadata: 'aa'.repeat(40), amount: d.amount, address: d.address };
        return { tx_hash: W.built.tx_hash, tx_metadata: W.built.tx_metadata, amount: d.amount, fee: 1 };
      }
      case 'relay_tx': {
        W.onRelay?.();
        if (W.relayThrows) throw new Error('connection reset');
        W.relays++; if (!W.out.some((e) => e.txid === W.built.tx_hash)) W.out.push({ txid: W.built.tx_hash, confirmations: 0, destinations: [{ address: W.built.address, amount: W.built.amount }] });
        if (W.relayThrowsAfter) throw new Error('connection reset after send');
        return {};
      }
      case 'get_address': return { address: W.address ?? 'WALLET-A-ADDRESS' };
      case 'get_info': return { height: 1000 };
      case 'get_transfers_in': return {};
      case 'sweep_all': W.sweeps.push(params.address); return { tx_hash_list: ['sweep-tx'] };
      default: throw new Error(`unexpected wallet method ${method}`);
    }
  };
  const makerRoute = (path, body) => {
    W.posts[path] = body;
    if (path === '/v1/quote') return ok(quote());
    if (path === '/v1/swap') {
      const b = randomScalar(); const t0 = clock + 7200;
      let v = 0n; const vb = unhex(body.v); for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(vb[i]);
      const B = pub(b);
      reg = W.regTweak({ swapId, B: hex(B), proofB: proveShare(b, unhex(swapId), 1), jointAddress: moneroAddress(addPoints(unhex(body.A), B), pub(v), 'stagenet'),
        pda: swapPda(new PublicKey(maker), unhex(swapId)).toBase58(), refunder: maker, t0, t1: t0 + 7200, lamports: 344_000_000, lockSig: 'x', xmrAtomic: '50000000000' });
      W.escrow = W.escrowTweak({ refunder: maker, claimer: body.claimer, A: body.A, B: hex(B), lamports: 344_000_000, t0, t1: t0 + 7200, ready: false, b });
      W.feePayer = body.feePayer; W.feeBalance = W.feeBalanceAfter ?? 1_000_000;
      return ok(reg);
    }
    return ok({ error: 'not-found' }, 404);
  };
  const fetcher = async (url, init = {}) => {
    const u = new URL(url); W.urls.push(url);
    assert.ok(ORIGINS.has(u.origin), `request outside the user's endpoints: ${u.origin}`);
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.origin === new URL(MAKER).origin) return makerRoute(u.pathname, body);
    if (u.origin === new URL(SOL).origin || u.origin === new URL(SOL2).origin) { try { return ok({ result: chainRpc(body.method, body.params, u.origin === new URL(SOL2).origin ? 2 : 1) }); } catch (e) { return ok({ error: { message: e.message } }); } }
    try { return ok({ result: walletRpc(body.method, body.params) }); } catch (e) { return ok({ error: { message: e.message } }); }
  };
  const info = [];
  const session = (o = {}) => fwd.createForwardSession({ network: 'devnet', solanaRpcUrl: SOL, moneroWalletRpcUrl: XMR, daemonHeight: lib.createDaemonHeight({ url: NODE, fetchImpl: fetcher }),
    fundingWallet: 'funder', fundingWalletPassword: 'wallet-pass-123', solAddress: user, xmrAddress: DEST, expectedMaker: maker, minSolPerXmr: 6, recordPath: o.recordPath ?? join(tmp, `fswap${nextId()}.json`),
    maker: lib.createMakerClient({ url: MAKER, fetcher }), fetcher, now: () => clock * 1000, sleep: async (ms) => { clock += ms / 1000; }, log: o.log ?? (() => {}),
    confirmPayment: async (i) => { info.push(i); W.events.push('confirm'); return true; }, ...REC, ...o });
  return { W, maker, user, session, fetcher, info, advance: (s) => { clock += s; }, now: () => clock, get swapId() { return swapId; } };
}
}
