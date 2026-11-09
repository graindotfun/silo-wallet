import type {Eip1193Provider} from "./evm-wallet.ts";

/** A source-owned adapter supplies these pins. A user form must never supply them. */
export type EvmExecutionPolicy = Readonly<{
  chainId: number;
  sourceCommit: string;
  factory: string;
  wrappedNative: string;
  /** Deployment-owned targets and spenders, including any verified launch token. */
  allowedTargets: readonly string[];
  approvedSpenders: readonly string[];
  executable: boolean;
  moneroRegistration: "required";
}>;
export type EvmSafeSession = Readonly<{chainId: number; account: string; provider: Eip1193Provider}>;
export type EvmUnsignedTransaction = Readonly<{chainId: number; from: string; to: string; data: string; value: string}>;
export type EvmTransactionReview = Readonly<{
  sourceCommit: string;
  factory: string;
  quoteAsset: string;
  transaction: EvmUnsignedTransaction;
  expiresAt: number;
}>;

export function evmAddress(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/i.test(value) || /^0x0{40}$/i.test(value)) throw new Error("Invalid nonzero EVM address.");
  return value.toLowerCase();
}
export function evmChainHex(chainId: number): string {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("Invalid EVM chain identity.");
  return `0x${chainId.toString(16)}`;
}
function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new Error("Invalid canonical EVM quantity.");
  const parsed = BigInt(value);
  if (parsed >= 1n << 256n) throw new Error("EVM quantity exceeds uint256.");
  return parsed;
}
function assertPolicy(policy: EvmExecutionPolicy): void {
  evmChainHex(policy.chainId);
  evmAddress(policy.factory);
  evmAddress(policy.wrappedNative);
  if (!Array.isArray(policy.allowedTargets) || !policy.allowedTargets.length || !Array.isArray(policy.approvedSpenders)) throw new Error("Missing source-owned transaction destinations.");
  policy.allowedTargets.forEach(evmAddress);
  policy.approvedSpenders.forEach(evmAddress);
  if (!/^[0-9a-f]{40}$/i.test(policy.sourceCommit) || policy.moneroRegistration !== "required" || policy.executable !== true) {
    throw new Error("This chain has no source-approved executable adapter.");
  }
}
/** Nonprompting session checks, repeated around each asynchronous wallet boundary. */
export async function assertEvmSession(session: EvmSafeSession): Promise<void> {
  const expected = evmChainHex(session.chainId);
  const account = evmAddress(session.account);
  const chain = await session.provider.request({method: "eth_chainId"});
  if (typeof chain !== "string" || !/^0x[0-9a-f]+$/i.test(chain) || BigInt(chain) !== BigInt(expected)) throw new Error("Wallet chain changed; reconnect and review again.");
  const accounts = await session.provider.request({method: "eth_accounts"});
  if (!Array.isArray(accounts) || evmAddress(accounts[0]) !== account) throw new Error("Wallet account changed; reconnect and review again.");
  const after = await session.provider.request({method: "eth_chainId"});
  if (typeof after !== "string" || !/^0x[0-9a-f]+$/i.test(after) || BigInt(after) !== BigInt(expected)) throw new Error("Wallet chain changed; reconnect and review again.");
}
function canonicalTransaction(tx: EvmUnsignedTransaction): EvmUnsignedTransaction {
  evmChainHex(tx.chainId);
  if (typeof tx.data !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(tx.data)) throw new Error("Malformed EVM calldata.");
  quantity(tx.value);
  return Object.freeze({chainId: tx.chainId, from: evmAddress(tx.from), to: evmAddress(tx.to), data: tx.data.toLowerCase(), value: tx.value.toLowerCase()});
}
/** Bind a reviewed unsigned payload to chain, account, deployed factory and quote asset. */
export function assertEvmReviewedTransaction(policy: EvmExecutionPolicy, session: EvmSafeSession, review: EvmTransactionReview, tx: EvmUnsignedTransaction, now = Date.now()): EvmUnsignedTransaction {
  assertPolicy(policy);
  if (!Number.isSafeInteger(review.expiresAt) || !Number.isSafeInteger(now) || review.expiresAt <= now || review.expiresAt > now + 120_000) throw new Error("Quote expired or exceeds the review lifetime.");
  if (review.sourceCommit !== policy.sourceCommit || evmAddress(review.factory) !== evmAddress(policy.factory) || evmAddress(review.quoteAsset) !== evmAddress(policy.wrappedNative)) throw new Error("Review deployment pins changed.");
  const expected = canonicalTransaction(review.transaction);
  const actual = canonicalTransaction(tx);
  if (actual.chainId !== policy.chainId || session.chainId !== policy.chainId || actual.from !== evmAddress(session.account) || JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Transaction differs from the reviewed chain, account or unsigned payload.");
  if (!policy.allowedTargets.map(evmAddress).includes(actual.to)) throw new Error("Transaction destination is not in the source-owned adapter.");
  if (actual.data.startsWith("0x095ea7b3")) {
    if (!/^0x095ea7b30{24}[0-9a-f]{40}[0-9a-f]{64}$/.test(actual.data) || actual.value !== "0x0") throw new Error("Malformed token approval.");
    const spender = `0x${actual.data.slice(34, 74)}`;
    const amount = BigInt(`0x${actual.data.slice(74)}`);
    if (!policy.approvedSpenders.map(evmAddress).includes(spender) || amount === 0n || amount === (1n << 256n) - 1n) throw new Error("Approval spender or amount is not source-approved.");
  }
  return actual;
}
/** Exact approvals only; caller supplies the spender from the reviewed source adapter. */
export function buildEvmExactApproval(chainId: number, account: string, token: string, spender: string, amount: bigint): EvmUnsignedTransaction {
  evmChainHex(chainId);
  if (amount <= 0n || amount >= (1n << 256n) - 1n) throw new Error("Approval requires a positive exact amount; unlimited approval is forbidden.");
  return Object.freeze({chainId, from: evmAddress(account), to: evmAddress(token), value: "0x0", data: `0x095ea7b3${evmAddress(spender).slice(2).padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`});
}
/**
 * Simulation only. No wallet signing, account requests, chain switch or broadcast.
 * This primitive does not grant execution authority or satisfy Monero publication.
 */
export async function simulateEvmReviewedTransaction(policy: EvmExecutionPolicy, session: EvmSafeSession, review: EvmTransactionReview, tx: EvmUnsignedTransaction, now: () => number = Date.now): Promise<Readonly<{transaction: EvmUnsignedTransaction; result: string}>> {
  const pinned = assertEvmReviewedTransaction(policy, session, review, tx, now());
  await assertEvmSession(session);
  assertEvmReviewedTransaction(policy, session, review, pinned, now());
  const result = await session.provider.request({method: "eth_call", params: [{from: pinned.from, to: pinned.to, data: pinned.data, value: pinned.value}, "pending"]});
  await assertEvmSession(session);
  assertEvmReviewedTransaction(policy, session, review, pinned, now());
  if (typeof result !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(result)) throw new Error("Malformed simulation response.");
  return Object.freeze({transaction: pinned, result});
}

/** Events always invalidate a reviewed payload, even when an account stays selected. */
export function watchEvmReviewInvalidation(provider: Eip1193Provider, invalidated: () => void): () => void {
  if (!provider.on || !provider.removeListener) return () => {};
  let active = true;
  const changed = () => { if (active) invalidated(); };
  for (const event of ["accountsChanged", "chainChanged", "disconnect"]) provider.on(event, changed);
  return () => { active = false; for (const event of ["accountsChanged", "chainChanged", "disconnect"]) provider.removeListener?.(event, changed); };
}

/** Recovery hashes cannot cross a chain/account namespace. No receipt success inferred. */
export function evmRecoveryStorageKey(chainId: number, account: string): string {
  evmChainHex(chainId);
  return `grainpad:evm:eip155:${chainId}:${evmAddress(account)}:transaction`;
}

export type EvmSubmission = Readonly<Omit<EvmTransactionReview, "expiresAt"> & {hash: string}>;
/** No submission or retry here: recovery must verify the original unsigned payload and canonical finality. */
export async function inspectEvmFinalizedReceipt(policy: EvmExecutionPolicy, session: EvmSafeSession, submission: EvmSubmission): Promise<Readonly<{hash: string; status: "pending" | "success" | "reverted"}>> {
  if (!/^0x[0-9a-f]{64}$/i.test(submission.hash)) throw new Error("Invalid recovery transaction hash.");
  const hash = submission.hash.toLowerCase();
  // Recovery is allowed after the quote's lifetime; it cannot submit that quote again.
  const review = {...submission, expiresAt: 1};
  const pinned = assertEvmReviewedTransaction(policy, session, review, submission.transaction, 0);
  await assertEvmSession(session);
  const receipt = await session.provider.request({method: "eth_getTransactionReceipt", params: [hash]});
  if (receipt === null) { await assertEvmSession(session); return {hash, status: "pending"}; }
  if (!receipt || typeof receipt !== "object") throw new Error("Malformed transaction receipt.");
  const r = receipt as Record<string, unknown>;
  if (typeof r.transactionHash !== "string" || r.transactionHash.toLowerCase() !== hash || !["0x0", "0x1"].includes(String(r.status)) || typeof r.blockHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(r.blockHash)) throw new Error("Receipt identity or status is invalid.");
  const receiptNumber = quantity(r.blockNumber);
  const actual = await session.provider.request({method: "eth_getTransactionByHash", params: [hash]});
  if (!actual || typeof actual !== "object") throw new Error("Recovery transaction is unavailable.");
  const t = actual as Record<string, unknown>;
  if (typeof t.hash !== "string" || t.hash.toLowerCase() !== hash || t.blockHash !== r.blockHash || quantity(t.blockNumber) !== receiptNumber || quantity(t.chainId) !== BigInt(policy.chainId)) throw new Error("Recovery transaction belongs to another block or chain.");
  const observed = {chainId: policy.chainId, from: t.from, to: t.to, data: t.input, value: t.value} as EvmUnsignedTransaction;
  assertEvmReviewedTransaction(policy, session, {...review, transaction: pinned}, observed, 0);
  const finalized = await session.provider.request({method: "eth_getBlockByNumber", params: ["finalized", false]});
  if (!finalized || typeof finalized !== "object" || !("number" in finalized)) throw new Error("Provider cannot verify finality.");
  if (quantity(finalized.number) < receiptNumber) { await assertEvmSession(session); return {hash, status: "pending"}; }
  const canonical = await session.provider.request({method: "eth_getBlockByNumber", params: [r.blockNumber, false]});
  if (!canonical || typeof canonical !== "object" || !("hash" in canonical) || typeof canonical.hash !== "string" || canonical.hash.toLowerCase() !== r.blockHash.toLowerCase()) throw new Error("Recovery receipt is no longer canonical.");
  await assertEvmSession(session);
  assertEvmReviewedTransaction(policy, session, {...review, transaction: pinned}, submission.transaction, 0);
  return {hash, status: r.status === "0x1" ? "success" : "reverted"};
}
