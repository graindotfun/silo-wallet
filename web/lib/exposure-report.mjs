import bs58 from 'bs58';

export const EXPOSURE_LIMITS = Object.freeze({transactions: 12, tokenAccounts: 64, responseBytes: 524288, scanMs: 20000, rpcMs: 5000, scanCu: 560, cacheMs: 30000, cacheEntries: 32, instructionLimit: 128});
export const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const SYSTEM = '11111111111111111111111111111111';
export function exposureAddress(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  try { return bs58.decode(value).length === 32; } catch { return false; }
}
export function exposureSignature(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value)) return false;
  try { return bs58.decode(value).length === 64; } catch { return false; }
}
const integer = value => Number.isSafeInteger(value) && value >= 0;
const key = row => typeof row === 'string' ? row : row?.pubkey;

/** Decode successful parsed System transfers only. Never infer ownership from a transfer. */
export function exposureTransaction(address, signature, tx) {
  const message = tx?.transaction?.message;
  if (!message || !Array.isArray(message.accountKeys) || !Array.isArray(message.instructions) || !tx.meta || !Object.hasOwn(tx.meta, 'err') || !integer(tx.slot) || tx.transaction.signatures?.[0] !== signature) return null;
  if (!message.accountKeys.some(row => key(row) === address)) return null;
  if (message.accountKeys.length > 256 || message.instructions.length > EXPOSURE_LIMITS.instructionLimit) return null;
  if (tx.meta.innerInstructions != null && (!Array.isArray(tx.meta.innerInstructions) || tx.meta.innerInstructions.some(row => !Array.isArray(row?.instructions)))) return null;
  const signed = message.accountKeys.some(row => key(row) === address && row?.signer === true);
  const feePayer = key(message.accountKeys[0]);
  const successful = tx.meta.err === null;
  const instructions = [...message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap(row => row.instructions)];
  if (instructions.length > EXPOSURE_LIMITS.instructionLimit) return null;
  const transfers = [];
  if (successful) for (const instruction of instructions) {
    if (instruction?.programId !== SYSTEM || instruction.parsed?.type !== 'transfer') continue;
    const info = instruction.parsed.info;
    if (!exposureAddress(info?.source) || !exposureAddress(info?.destination) || !integer(info?.lamports) || info.lamports === 0 || info.source === info.destination) continue;
    if (info.source !== address && info.destination !== address) continue;
    transfers.push({direction: info.destination === address ? 'incoming' : 'outgoing', counterparty: info.destination === address ? info.source : info.destination, lamports: String(info.lamports)});
  }
  return {signature, slot: tx.slot, blockTime: integer(tx.blockTime) ? tx.blockTime : null, successful, signed,
    feePayer: exposureAddress(feePayer) ? feePayer : null,
    programs: [...new Set(instructions.map(row => row?.programId).filter(exposureAddress))], transfers};
}

/** An intentionally bounded address sample, not complete wallet attribution or a trade decoder. */
export async function scanExposure(address, read, now = Date.now) {
  if (!exposureAddress(address)) throw Error('Invalid address.');
  const capture = async (method, params) => { try { return {ok: true, value: await read(method, params)}; } catch { return {ok: false}; } };
  const balance = await capture('getBalance', [address, {commitment: 'finalized'}]);
  const tokenReads = [];
  for (const programId of TOKEN_PROGRAMS) tokenReads.push(await capture('getTokenAccountsByOwner', [address, {programId}, {encoding: 'jsonParsed', commitment: 'finalized'}]));
  const holdings = [];
  const tokenCoverage = tokenReads.map((result, index) => {
    if (!result.ok || !Array.isArray(result.value?.value)) return {program: TOKEN_PROGRAMS[index], status: 'not checked', accountsReturned: null};
    const accounts = result.value.value;
    let malformed = false;
    for (const row of accounts.slice(0, EXPOSURE_LIMITS.tokenAccounts)) {
      const info = row?.account?.data?.parsed?.info;
      const amount = info?.tokenAmount;
      if (row?.account?.owner !== TOKEN_PROGRAMS[index] || !exposureAddress(row.pubkey) || info?.owner !== address || !exposureAddress(info?.mint) || !/^\d{1,20}$/.test(amount?.amount) || !integer(amount?.decimals) || amount.decimals > 255) { malformed = true; continue; }
      if (BigInt(amount.amount) > 18446744073709551615n) { malformed = true; continue; }
      // Include only a public amount. An encrypted balance cannot be derived here.
      holdings.push({account: row.pubkey, mint: info.mint, amount: amount.amount, decimals: amount.decimals, program: TOKEN_PROGRAMS[index]});
    }
    return {program: TOKEN_PROGRAMS[index], status: malformed || accounts.length > EXPOSURE_LIMITS.tokenAccounts ? 'partial coverage' : 'checked', accountsReturned: accounts.length};
  });
  const signatures = await capture('getSignaturesForAddress', [address, {limit: EXPOSURE_LIMITS.transactions + 1, commitment: 'finalized'}]);
  const validHistory = signatures.ok && Array.isArray(signatures.value) && signatures.value.every(row => exposureSignature(row?.signature) && integer(row.slot));
  const rows = validHistory ? [...new Map(signatures.value.map(row => [row.signature, row])).values()].slice(0, EXPOSURE_LIMITS.transactions) : [];
  const transactions = [];
  let missing = 0;
  // Two transaction reads in flight at most; no recursive counterparty traversal.
  for (let index = 0; index < rows.length; index += 2) {
    const batch = await Promise.all(rows.slice(index, index + 2).map(async row => {
      const receipt = await capture('getTransaction', [row.signature, {encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0}]);
      const decoded = receipt.ok ? exposureTransaction(address, row.signature, receipt.value) : null;
      return decoded?.slot === row.slot ? decoded : null;
    }));
    for (const row of batch) { if (row) transactions.push(row); else missing++; }
  }
  const relationships = new Map();
  for (const transaction of transactions) for (const transfer of transaction.transfers) {
    const id = transfer.direction + ':' + transfer.counterparty;
    const item = relationships.get(id) ?? {counterparty: transfer.counterparty, direction: transfer.direction, signatures: [], hypothesis: transfer.direction === 'incoming' ? 'Possible funding relationship; not proof of original funding, shared ownership or identity.' : 'Possible payment relationship; purpose and ownership are not checked.'};
    if (!item.signatures.includes(transaction.signature)) item.signatures.push(transaction.signature);
    relationships.set(id, item);
  }
  const publicBalance = balance.ok && integer(balance.value?.value) ? String(balance.value.value) : null;
  return {version: 1, network: 'mainnet-beta', address, checkedAt: new Date(now()).toISOString(),
    balance: {status: publicBalance === null ? 'not checked' : 'checked', lamports: publicBalance}, holdings, tokenCoverage, transactions,
    relationships: [...relationships.values()].map(row => ({...row, status: 'hypothesis'})),
    history: {status: validHistory ? 'partial coverage' : 'not checked', signaturesReturned: validHistory ? signatures.value.length : null, receiptsChecked: transactions.length, receiptsUnavailable: validHistory ? missing : null, limit: EXPOSURE_LIMITS.transactions},
    limitations: ['Only the latest address-referencing signatures were sampled; full history and original funding are not checked.', 'Token-account history, closed accounts, DeFi positions, NFTs, prices, PnL and swap attribution are not checked.', 'Incoming transfers can be unsolicited. A connection does not establish identity, ownership or intent.', 'Public token amounts are shown; confidential balances are not read or decrypted.']};
}
