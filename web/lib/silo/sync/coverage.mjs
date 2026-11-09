/** History coverage a recovered device must prove before it may act (SYNC-PROTO-03).
 *
 * A device recovered after every trusted device was lost has no freshness anchor: the server may show it an old
 * vault and hide operations. The only independent source is the chains. So before the first action the device must
 * read the complete history of every (network, protocol, wallet) the vault can act on, from that wallet's start in
 * this vault up to the current tip, with its own reviewed readers — and every item must be explained by the
 * journal or, when fully covered and final, reviewed by the person.
 *
 * Fail closed. Each of these keeps recovery held, and a person's acknowledgement does not override any of them:
 *  - no reader for a required key ('no-history-reader');
 *  - the vault does not record the wallet identity or start needed to define the key ('coverage-undefined');
 *  - the reader throws or returns nothing usable ('history-error');
 *  - the answer names another network, protocol or wallet ('history-mismatch');
 *  - the answer is not complete, does not reach the tip, or starts after the required start ('history-partial');
 *  - any item is not final ('history-pending').
 * Only fully covered, final, unexplained activity may be acknowledged by the person.
 *
 * Reader contract — verifiers[protocol].history({network, protocol, wallet, from}) resolves to
 *   {network, protocol, wallet, complete: true, throughTip: true, coveredFrom, items: [{signature, final: true}]}
 * where `coveredFrom <= from` in the protocol's own unit (XMR: block height; Solana: unix milliseconds). */

const SOLANA_PROTOCOLS = ['solana-transfer', 'jupiter-swap'];

/** Every (network, protocol, wallet, from) the vault can act on, derived from authenticated vault state. */
export function requiredCoverage(state) {
  const keys = [], problems = [];
  const profile = state.profile ?? {}, xmr = state['xmr-state'] ?? {};
  // An XMR-format vault always holds a Monero wallet. A native-public vault (Solana/EVM keyrings) holds no Monero keys but
  // records the Monero wallet identity and restore height the account acts with (vault-identity.mjs), if any; the
  // recovered device reads that wallet's history from its own restored session. Monero operations in the journal of a
  // vault that names no Monero wallet leave coverage undefined.
  // Monero keys live in an XMR-format vault, or in the `xmr` segment of a combined vault (first-wallet line).
  const native = state.keys?.zone === 'native-public' || (state.keys?.zone === 'combined' && !state.keys.xmr);
  const xmrActed = Object.values(state.journal?.entries ?? {}).some((entry) => entry.kind === 'xmr-payment');
  if (!native || profile.xmrWallet || xmrActed) {
    const birthday = native ? profile.xmrBirthday : xmr.birthday;
    if (typeof profile.xmrWallet !== 'string' || !profile.xmrWallet) problems.push({protocol: 'xmr-payment', reason: 'coverage-undefined', detail: 'xmr-wallet-identity'});
    else if (!Number.isSafeInteger(birthday) || birthday < 0) problems.push({protocol: 'xmr-payment', reason: 'coverage-undefined', detail: 'xmr-birthday'});
    else keys.push({network: profile.xmrNetwork, protocol: 'xmr-payment', wallet: profile.xmrWallet, from: birthday});
  }
  const owners = new Set(profile.expectedSolanaOwner ? [profile.expectedSolanaOwner] : []);
  // SOL→XMR orders start with a Solana deposit signed by the owner, so the owner's Solana history covers them; their XMR
  // payouts are incoming, not actions this vault takes.
  const solanaActing = (entry) => SOLANA_PROTOCOLS.includes(entry.kind) || entry.kind === 'crosschain-order';
  for (const entry of Object.values(state.journal?.entries ?? {})) if (solanaActing(entry) && entry.binding?.owner) owners.add(entry.binding.owner);
  const solanaUsed = owners.size > 0 || Object.values(state.journal?.entries ?? {}).some(solanaActing);
  if (solanaUsed) {
    if (!owners.size) problems.push({protocol: 'solana', reason: 'coverage-undefined', detail: 'solana-owner'});
    else if (!Number.isSafeInteger(profile.createdAt)) problems.push({protocol: 'solana', reason: 'coverage-undefined', detail: 'vault-start'});
    // `marker`: {owner, slot, signature|null} recorded at vault creation (vault-identity.mjs); the reader ignores it for any other owner.
    else for (const owner of [...owners].sort()) for (const protocol of SOLANA_PROTOCOLS) keys.push({network: profile.solanaNetwork, protocol, wallet: owner, from: profile.createdAt, marker: owner === profile.expectedSolanaOwner ? profile.solanaStartMarker ?? null : null});
  }
  return {keys, problems};
}

/** Reads every required history. Returns {held: [...], items: [...]} — `held` empty only when coverage is complete. */
export async function readCoverage(state, verifiers) {
  const {keys, problems} = requiredCoverage(state);
  const held = problems.map((problem) => ({...problem}));
  const items = [];
  for (const key of keys) {
    const reader = verifiers?.[key.protocol]?.history;
    if (typeof reader !== 'function') { held.push({...key, reason: 'no-history-reader'}); continue; }
    let answer;
    try { answer = await reader(structuredClone(key)); } catch { held.push({...key, reason: 'history-error'}); continue; }
    if (!answer || typeof answer !== 'object' || !Array.isArray(answer.items)) { held.push({...key, reason: 'history-error'}); continue; }
    if (answer.network !== key.network || answer.protocol !== key.protocol || answer.wallet !== key.wallet) { held.push({...key, reason: 'history-mismatch'}); continue; }
    if (answer.complete !== true || answer.throughTip !== true || !Number.isSafeInteger(answer.coveredFrom) || answer.coveredFrom > key.from) { held.push({...key, reason: 'history-partial'}); continue; }
    if (answer.items.some((item) => typeof item?.signature !== 'string' || !item.signature || item.final !== true)) { held.push({...key, reason: 'history-pending'}); continue; }
    for (const item of answer.items) items.push({protocol: key.protocol, network: key.network, wallet: key.wallet, signature: item.signature});
  }
  return {held, items, keys};
}
