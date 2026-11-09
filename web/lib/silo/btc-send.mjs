// Silo Bitcoin send: fee tiers, coin selection, PSBT build, review summary (decoded from the PSBT bytes themselves) and local signing.
// PSBT building, serialisation, sighash and signatures are @scure/btc-signer 1.8.1 (MIT). This file only chooses coins and checks them.
// Signing refuses anything the person did not review: the signer recomputes the summary from the bytes it is about to sign and
// requires its digest to equal the digest that was shown, that every input is one of this wallet's own p2wpkh coins, and that the
// fee is inside the limits below, and on mainnet that the amount is inside the first-release per-send cap.
import * as btc from '@scure/btc-signer';
import {sha256} from '@noble/hashes/sha256';
import {siloBtcNetworkParams, siloBtcOwnedScripts, siloBtcPrivateKey, siloBtcValidAddress} from './btc.mjs';

export const SILO_BTC_MAX_INPUTS = 150; // well inside the 200-input review limit; a larger spend is refused, never truncated silently
export const SILO_BTC_MAX_PREVTX_BYTES = 100_000;
const RELAXED = Object.freeze({allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true});
const fromHex = text => { if (typeof text !== 'string' || text.length < 20 || text.length % 2 || text.length > SILO_BTC_MAX_PREVTX_BYTES * 2 || !/^[0-9a-f]+$/.test(text)) throw fail('Invalid previous transaction.'); return Uint8Array.from(text.match(/../g), b => parseInt(b, 16)); };

/** H1: the amount and script of a coin come from the previous transaction itself, never from a provider's summary. The raw bytes are
 * hashed locally (txid = double SHA-256 of the non-witness serialisation, done by the library) and must equal the outpoint's txid, so a
 * provider cannot give one outpoint two different amounts. Returns the verified output and the raw bytes to embed as nonWitnessUtxo. */
export function siloBtcVerifyPrevTx(hex, txid, vout) {
  const raw = fromHex(hex); let prev;
  try { prev = btc.Transaction.fromRaw(raw, RELAXED); } catch { throw fail('Invalid previous transaction.'); }
  if (prev.id !== txid) throw fail('A previous transaction does not match its id. Nothing was prepared.');
  if (!Number.isSafeInteger(vout) || vout < 0 || vout >= prev.outputsLength) throw fail('A previous transaction has no such output.');
  const out = prev.getOutput(vout);
  if (!out.script || typeof out.amount !== 'bigint' || out.amount <= 0n) throw fail('A previous transaction output is invalid.');
  return {raw, amountSats: Number(out.amount), scriptHex: hex_(out.script)};
}
const hex_ = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
/** The same check for a coin inside a PSBT: re-encode the embedded previous transaction, hash it, compare with the input's txid. */
function verifiedPrevout(input) {
  if (!input.nonWitnessUtxo || !input.txid || input.index === undefined) throw fail('Unsupported transaction input.');
  let prev; try { prev = btc.Transaction.fromRaw(btc.RawTx.encode(input.nonWitnessUtxo), RELAXED); } catch { throw fail('Unsupported transaction input.'); }
  if (prev.id !== hex_(input.txid)) throw fail('A transaction input does not match its previous transaction.');
  if (input.index >= prev.outputsLength) throw fail('A transaction input does not match its previous transaction.');
  const out = prev.getOutput(input.index);
  if (typeof out.amount !== 'bigint' || out.amount <= 0n || !out.script) throw fail('Unsupported transaction input.');
  // A witnessUtxo, if present at all, must say exactly what the previous transaction says.
  if (input.witnessUtxo && (input.witnessUtxo.amount !== out.amount || hex_(input.witnessUtxo.script) !== hex_(out.script))) throw fail('A transaction input disagrees with its previous transaction.');
  return {amount: out.amount, script: out.script};
}

export const SILO_BTC_FEE_TIERS = Object.freeze({fast: 1, normal: 3, economy: 12}); // confirmation targets in blocks
export const SILO_BTC_MIN_FEE_RATE = 1; // sat/vB, relay minimum
export const SILO_BTC_MAX_FEE_RATE = 500; // sat/vB on test networks, refuse anything above (a broken or hostile estimate)
/** Mainnet is stricter: 200 sat/vB. */
export const SILO_BTC_MAINNET_MAX_FEE_RATE = 200;
/** Absolute fee ceiling on mainnet, whatever the amount: 20,000 sats (about 0.0002 BTC). */
export const SILO_BTC_MAINNET_MAX_FEE_SATS = 20_000;
export const siloBtcMaxFeeRate = network => network === 'mainnet' ? SILO_BTC_MAINNET_MAX_FEE_RATE : SILO_BTC_MAX_FEE_RATE;
/** First mainnet release: at most 100,000 sats (0.001 BTC) leave the wallet in one send. Config can lower it, never raise it (config.mjs). */
export const SILO_BTC_FIRST_RELEASE_CAP_SATS = 100_000;
export const SILO_BTC_RBF_SEQUENCE = 0xfffffffd;
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const fail = message => Object.assign(Error(message), {siloBtc: true});
const isTxid = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/** Esplora /fee-estimates ({"1":x,"3":y,...}) to three tiers in sat/vB, rounded up, clamped to [1, 500]. A missing target uses the nearest slower one. */
export function siloBtcFeeTiers(estimates, network = 'signet') {
  const ceiling = siloBtcMaxFeeRate(network);
  if (!estimates || typeof estimates !== 'object' || Array.isArray(estimates)) throw fail('Fee estimates are unavailable.');
  const targets = Object.keys(estimates).map(Number).filter(n => Number.isInteger(n) && n > 0 && Number.isFinite(estimates[n]) && estimates[n] > 0).sort((a, b) => a - b);
  if (!targets.length) throw fail('Fee estimates are unavailable.');
  const tiers = {};
  for (const [name, want] of Object.entries(SILO_BTC_FEE_TIERS)) {
    const target = targets.find(t => t >= want) ?? targets[targets.length - 1];
    tiers[name] = Math.min(ceiling, Math.max(SILO_BTC_MIN_FEE_RATE, Math.ceil(estimates[target])));
  }
  // A faster tier is never cheaper than a slower one.
  tiers.fast = Math.max(tiers.fast, tiers.normal); tiers.normal = Math.max(tiers.normal, tiers.economy);
  return tiers;
}

/** "0.00012345" to sats (integer). At most 8 decimals; refuses anything else. */
export function siloBtcParseAmount(text) {
  if (typeof text !== 'string' || !/^\d{1,8}(\.\d{1,8})?$/.test(text.trim())) throw fail('Enter an amount in BTC, with at most 8 decimals.');
  const [whole, frac = ''] = text.trim().split('.'), sats = BigInt(whole) * 100_000_000n + BigInt(frac.padEnd(8, '0'));
  if (sats <= 0n || sats > 2_100_000_000_000_000n) throw fail('Enter an amount in BTC, with at most 8 decimals.');
  return Number(sats);
}
export const siloBtcFormat = sats => `${Math.floor(sats / 1e8)}.${String(sats % 1e8).padStart(8, '0')}`;
const OVERHEAD_VB = 11; // version, locktime, counts, segwit marker (rounded up)
const P2WPKH_INPUT_VB = 68;
function outputVbytes(scriptLength) { return 8 + 1 + scriptLength; }
export function siloBtcDustLimit(scriptLength) { return scriptLength === 22 ? 294 : scriptLength === 34 ? 330 : 546; }
export const siloBtcVsize = (inputs, outputScriptLengths) => OVERHEAD_VB + P2WPKH_INPUT_VB * inputs + outputScriptLengths.reduce((sum, n) => sum + outputVbytes(n), 0);

/** Coin selection. Largest-first over confirmed coins; if the leftover would be dust it is added to the fee (never silently below dust).
 * `sendAll` spends every eligible coin to the destination with no change. Returns {inputs, changeSats, feeSats, vsize}. Throws a plain reason. */
export function siloBtcSelectCoins({utxos, amountSats, feeRate, destinationScriptLength, changeScriptLength = 22, sendAll = false, allowUnconfirmed = false}) {
  if (!Array.isArray(utxos)) throw fail('No coins to spend.');
  if (!Number.isInteger(feeRate) || feeRate < SILO_BTC_MIN_FEE_RATE || feeRate > SILO_BTC_MAX_FEE_RATE) throw fail('Fee rate is outside the allowed range.');
  const coins = utxos.filter(u => u && isTxid(u.txid) && Number.isSafeInteger(u.vout) && u.vout >= 0 && Number.isSafeInteger(u.value) && u.value > 0 && typeof u.address === 'string' && (allowUnconfirmed || u.confirmed === true)).sort((a, b) => b.value - a.value || (a.txid < b.txid ? -1 : 1));
  if (!coins.length) throw fail(utxos.length ? 'Only unconfirmed coins are available. Wait for a confirmation.' : 'There is nothing to send yet.');
  const dust = siloBtcDustLimit(destinationScriptLength);
  if (sendAll) {
    if (coins.length > SILO_BTC_MAX_INPUTS) throw fail('This wallet holds too many small coins to send at once. Send a smaller amount first.');
    const total = coins.reduce((sum, c) => sum + c.value, 0), vsize = siloBtcVsize(coins.length, [destinationScriptLength]), feeSats = Math.ceil(vsize * feeRate);
    if (total - feeSats < dust) throw fail('The balance does not cover the network fee.');
    return {inputs: coins, changeSats: 0, feeSats, vsize, sendSats: total - feeSats};
  }
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) throw fail('Enter an amount.');
  if (amountSats < dust) throw fail('That amount is below the network minimum for this address.');
  const chosen = []; let total = 0;
  for (const coin of coins) {
    if (chosen.length >= SILO_BTC_MAX_INPUTS) break;
    chosen.push(coin); total += coin.value;
    const withChange = siloBtcVsize(chosen.length, [destinationScriptLength, changeScriptLength]), feeWithChange = Math.ceil(withChange * feeRate);
    const noChange = siloBtcVsize(chosen.length, [destinationScriptLength]), feeNoChange = Math.ceil(noChange * feeRate);
    if (total >= amountSats + feeWithChange && total - amountSats - feeWithChange >= siloBtcDustLimit(changeScriptLength)) return {inputs: [...chosen], changeSats: total - amountSats - feeWithChange, feeSats: feeWithChange, vsize: withChange, sendSats: amountSats};
    if (total >= amountSats + feeNoChange) return {inputs: [...chosen], changeSats: 0, feeSats: total - amountSats, vsize: noChange, sendSats: amountSats};
  }
  throw fail('The balance does not cover the amount and the network fee.');
}

/** Builds the unsigned PSBT. `utxos` are the provider's coins for addresses this wallet derived ({txid,vout,value,confirmed,address}).
 * `fetchPrevTxs(txids)` returns {txid: rawHex} for the previous transactions of the SELECTED coins; each one is hashed locally and its
 * amount and script must equal what the provider said, else nothing is prepared (H1). The PSBT carries the previous transactions
 * (nonWitnessUtxo), so the signer and the review use only locally verified amounts. `lockTime` is the current tip height
 * (anti fee sniping); sequences signal RBF. Public data only: no key is touched. */
export async function siloBtcBuildSend({network, utxos, destination, amountSats, feeRate, changeAddress, sendAll = false, allowUnconfirmed = false, fetchPrevTxs, lockTime = 0, capSats}) {
  const params = siloBtcNetworkParams(network);
  if (!Number.isInteger(feeRate) || feeRate > siloBtcMaxFeeRate(network)) throw fail('Fee rate is outside the allowed range.');
  if (!siloBtcValidAddress(destination, network)) throw fail('That is not a valid address for this network.');
  if (typeof fetchPrevTxs !== 'function') throw fail('Previous transactions are required.');
  if (!Number.isSafeInteger(lockTime) || lockTime < 0 || lockTime >= 500_000_000) throw fail('Invalid lock time.');
  const destScript = btc.OutScript.encode(btc.Address(params).decode(destination));
  const changeScript = btc.OutScript.encode(btc.Address(params).decode(changeAddress));
  const selection = siloBtcSelectCoins({utxos, amountSats, feeRate, destinationScriptLength: destScript.length, changeScriptLength: changeScript.length, sendAll, allowUnconfirmed});
  if (network === 'mainnet') { siloBtcAssertCap(selection.sendSats + selection.feeSats, capSats); if (selection.feeSats > SILO_BTC_MAINNET_MAX_FEE_SATS) throw fail('The fee is above the limit for this version.'); }
  const wanted = [...new Set(selection.inputs.map(coin => coin.txid))], got = await fetchPrevTxs(wanted);
  const tx = new btc.Transaction({allowUnknownOutputs: false, lockTime});
  let verifiedTotal = 0;
  for (const coin of selection.inputs) {
    const verified = siloBtcVerifyPrevTx(got?.[coin.txid], coin.txid, coin.vout);
    const expectedScript = hex(btc.OutScript.encode(btc.Address(params).decode(coin.address)));
    if (verified.scriptHex !== expectedScript) throw fail('A coin does not belong to the address the provider named. Nothing was prepared.');
    if (verified.amountSats !== coin.value) throw fail('The data provider reported a different amount than the transaction itself. Nothing was prepared.');
    verifiedTotal += verified.amountSats;
    tx.addInput({txid: coin.txid, index: coin.vout, sequence: SILO_BTC_RBF_SEQUENCE, nonWitnessUtxo: verified.raw});
  }
  if (verifiedTotal !== selection.inputs.reduce((sum, coin) => sum + coin.value, 0)) throw fail('Amounts do not add up. Nothing was prepared.');
  tx.addOutputAddress(destination, BigInt(selection.sendSats), params);
  if (selection.changeSats > 0) tx.addOutputAddress(changeAddress, BigInt(selection.changeSats), params);
  return {psbt: tx.toPSBT(0), selection};
}

/** Decodes a PSBT into what the person must review. Everything here comes from the bytes, not from the builder. `owned` is the Map from
 * siloBtcOwnedScripts. Throws if the PSBT is not a plain spend of this wallet's own native segwit coins. */
export function siloBtcSummarizePsbt(psbtBytes, network, owned) {
  const params = siloBtcNetworkParams(network);
  if (!(psbtBytes instanceof Uint8Array) || psbtBytes.length > 100_000) throw fail('Invalid transaction.');
  let tx; try { tx = btc.Transaction.fromPSBT(psbtBytes); } catch { throw fail('Invalid transaction.'); }
  if (tx.version !== 2 || !Number.isSafeInteger(tx.lockTime) || tx.lockTime < 0 || tx.lockTime >= 500_000_000) throw fail('Unsupported transaction.');
  if (tx.inputsLength < 1 || tx.inputsLength > 200 || tx.outputsLength < 1 || tx.outputsLength > 3) throw fail('Unsupported transaction shape.');
  let totalIn = 0n, totalOut = 0n, ownOut = 0n;
  const inputs = [], outputs = [], outLens = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i), prevout = verifiedPrevout(input);
    if (input.sequence !== SILO_BTC_RBF_SEQUENCE) throw fail('Unsupported transaction input.');
    const scriptHex = hex(prevout.script), slot = owned.get(scriptHex);
    if (!slot || scriptHex.length !== 44) throw fail('A transaction input does not belong to this wallet.');
    totalIn += prevout.amount;
    inputs.push({txid: hex(input.txid), index: input.index, amountSats: Number(prevout.amount), sequence: input.sequence, chain: slot.chain, slot: slot.index});
  }
  for (let i = 0; i < tx.outputsLength; i++) {
    const output = tx.getOutput(i);
    if (!output.script || output.amount === undefined || output.amount <= 0n) throw fail('Unsupported transaction output.');
    let address; try { address = btc.Address(params).encode(btc.OutScript.decode(output.script)); } catch { throw fail('Unsupported transaction output.'); }
    const slot = owned.get(hex(output.script)), own = Boolean(slot);
    if (output.amount < BigInt(siloBtcDustLimit(output.script.length))) throw fail('A transaction output is below the network minimum.');
    totalOut += output.amount; if (own) ownOut += output.amount;
    outLens.push(output.script.length);
    outputs.push({address, amountSats: Number(output.amount), own, change: own && slot.chain === 1});
  }
  const feeSats = Number(totalIn - totalOut);
  if (feeSats < 0) throw fail('Outputs exceed inputs.');
  const vsize = siloBtcVsize(inputs.length, outLens), feeRate = feeSats / vsize;
  const sendSats = Number(totalOut - ownOut);
  // The digest binds everything the signature will cover: version, lock time, every outpoint with its verified amount and sequence, every output.
  const canonical = JSON.stringify({n: network, v: tx.version, l: tx.lockTime, i: inputs.map(x => [x.txid, x.index, x.amountSats, x.sequence]), o: outputs.map(x => [x.address, x.amountSats])});
  return {network, lockTime: tx.lockTime, inputs, outputs, totalInSats: Number(totalIn), feeSats, vsize, feeRate: Math.round(feeRate * 10) / 10, sendSats, leavesWalletSats: Number(totalIn - ownOut), digest: hex(sha256(new TextEncoder().encode(canonical)))};
}

/** Limits applied to every signature: a fee rate above 500 sat/vB, or any fee above a quarter of the amount sent, is refused outright. */
export function siloBtcAssertFeeSane(summary) {
  // Exact: the largest fee the builder can produce at the ceiling rate is ceil(vsize * ceiling); one satoshi more is refused.
  if (summary.feeSats > Math.ceil(summary.vsize * siloBtcMaxFeeRate(summary.network))) throw fail('The fee rate is too high. Nothing was signed.');
  if (summary.network === 'mainnet' && summary.feeSats > SILO_BTC_MAINNET_MAX_FEE_SATS) throw fail('The fee is above the limit for this version. Nothing was signed.');
  if (summary.sendSats > 0 && summary.feeSats > summary.sendSats / 4) throw fail('The fee is more than a quarter of the amount. Nothing was signed.');
}

/** After signing: the fee must also fit the ceiling rate at the real size. The transaction was signed here but is never returned or sent. */
export function siloBtcAssertFinalFee(summary, finalVsize) {
  if (!Number.isSafeInteger(finalVsize) || finalVsize <= 0 || summary.feeSats > Math.ceil(finalVsize * siloBtcMaxFeeRate(summary.network))) throw fail('The fee rate is too high for the final transaction. It was signed here but not sent, and the signature was discarded.');
}

/** Per-send cap. On mainnet a cap MUST be given (no cap means no signature) and can never exceed the first-release constant. */
export function siloBtcAssertCap(leavingSats, capSats) {
  if (!Number.isSafeInteger(capSats) || capSats <= 0 || capSats > SILO_BTC_FIRST_RELEASE_CAP_SATS) throw fail('A per-send limit is required for real bitcoin.');
  if (leavingSats > capSats) throw fail(`This is above the limit of ${siloBtcFormat(capSats)} BTC per send for this version, network fee included. Send a smaller amount.`);
}
/** Signs a reviewed PSBT with keys derived from `entropy` (zeroed here after use) and returns the final transaction. The caller passes the
 * digest the person approved; any mismatch, foreign input or unsafe fee throws before a key is derived. */
export function siloBtcSignReviewed({entropy, network, psbtBytes, approvedDigest, capSats}) {
  const owned = siloBtcOwnedScripts(entropy, network), summary = siloBtcSummarizePsbt(psbtBytes, network, owned);
  if (typeof approvedDigest !== 'string' || approvedDigest !== summary.digest) throw fail('The transaction changed after review. Nothing was signed.');
  siloBtcAssertFeeSane(summary);
  if (network === 'mainnet') siloBtcAssertCap(summary.leavesWalletSats, capSats);
  const tx = btc.Transaction.fromPSBT(psbtBytes);
  summary.inputs.forEach((input, i) => {
    const key = siloBtcPrivateKey(entropy, network, input.chain, input.slot);
    try { if (tx.signIdx(key, i) !== true) throw fail('Signing failed.'); } finally { key.fill(0); }
  });
  tx.finalize();
  const raw = tx.extract();
  // Final-size bound: the fee checks above use the fixed estimate; the finalized transaction must also stay within the ceiling rate at its real size.
  siloBtcAssertFinalFee(summary, tx.vsize);
  return {hex: hex(raw), txid: tx.id, vsize: tx.vsize, summary};
}
