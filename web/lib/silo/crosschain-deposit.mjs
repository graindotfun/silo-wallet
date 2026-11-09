import '../browser-buffer.mjs';
import { Buffer } from 'buffer';
import { VersionedTransaction } from '@solana/web3.js';
import { inspectSiloTransfer, SILO_SOLANA_GENESIS } from './solana-transfer.mjs';
import { crosschainAsset } from './crosschain-order.mjs';

/** Concrete signed SOL/classic-USDC deposit verification. Reuses the product's
 * strict instruction-layout + Ed25519 verification, never a provider-built opaque transaction.
 * No signing/sending here. XMR prepared transaction verification remains separate. */
export async function verifyCrosschainSolanaDeposit(signed, binding, connection) {
  if (!connection || await connection.getGenesisHash() !== SILO_SOLANA_GENESIS['mainnet-beta']) throw Error('crosschain-mainnet-required');
  const expected = crosschainAsset(binding.asset.asset);
  if (!['sol', 'usdc'].includes(expected.asset) || Object.keys(expected).some((key) => binding.asset[key] !== expected[key])) throw Error('crosschain-deposit-asset');
  if (binding.depositMemo !== '' || typeof signed?.bytes !== 'string' || signed.bytes.length > 2000
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(signed.bytes)) throw Error('crosschain-deposit-layout');
  const wire = Buffer.from(signed.bytes, 'base64');
  if (wire.toString('base64') !== signed.bytes) throw Error('crosschain-deposit-encoding');
  const transaction = VersionedTransaction.deserialize(wire);
  const { terms, signature } = inspectSiloTransfer(transaction, { network: 'mainnet-beta', signed: true });
  if (terms.owner !== binding.sourceAddress || terms.recipient !== binding.depositAddress
    || terms.amount !== binding.amountAtomic || terms.mint !== expected.mint || terms.decimals !== expected.decimals
    || (terms.mint && (terms.program !== 'spl' || terms.tokenFee !== null))) throw Error('crosschain-deposit-binding');
  return { bytes: signed.bytes, txid: signature };
}

/** Finalized chain receipt, not a provider 'finished' claim. Checks exact owner/mint
 * net increase; no floating point conversion of token amounts. RPC integrity remains
 * the same explicit trust boundary as ordinary Solana balance verification. */
export async function verifyCrosschainSolanaArrival(asset, recipient, minimumAtomic, signature, connection) {
  if (!connection || await connection.getGenesisHash() !== SILO_SOLANA_GENESIS['mainnet-beta']) throw Error('crosschain-mainnet-required');
  const expected = crosschainAsset(asset.asset);
  if (!['sol', 'usdc'].includes(expected.asset) || Object.keys(expected).some((key) => asset[key] !== expected[key])
    || typeof signature !== 'string' || !signature || !/^[1-9]\d{0,19}$/.test(minimumAtomic)) return false;
  const transaction = await connection.getParsedTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
  if (!transaction?.meta || transaction.meta.err || transaction.transaction.signatures[0] !== signature) return false;
  const meta = transaction.meta;
  if (expected.asset === 'sol') {
    const index = transaction.transaction.message.accountKeys.findIndex((key) => key.pubkey.toBase58() === recipient);
    if (index < 0 || !Number.isSafeInteger(meta.preBalances[index]) || !Number.isSafeInteger(meta.postBalances[index])) return false;
    return BigInt(meta.postBalances[index]) - BigInt(meta.preBalances[index]) >= BigInt(minimumAtomic);
  }
  const sum = (rows) => rows.filter((row) => row.owner === recipient && row.mint === expected.mint && row.uiTokenAmount.decimals === expected.decimals)
    .reduce((total, row) => {
      if (!/^\d+$/.test(row.uiTokenAmount.amount)) throw Error('crosschain-arrival-amount');
      return total + BigInt(row.uiTokenAmount.amount);
    }, 0n);
  return sum(meta.postTokenBalances ?? []) - sum(meta.preTokenBalances ?? []) >= BigInt(minimumAtomic);
}
