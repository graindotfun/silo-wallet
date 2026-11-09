/**
 * Public status and wording for the Grainpad Monero record layer (GRN1 v1/v2).
 * Every public surface reads its Monero claims from here, so the first confirmed
 * live record needs one edit to LIVE_RECORD, not a copy rewrite.
 *
 * Plain data only: this file is imported by client components and must not pull in
 * lib/monero-record.mjs (node:crypto). tests/monero-narrative.test.mjs checks that
 * the numbers below equal the encoder's constants.
 */

/** Canonical product description. Architecture, not a claim that a record exists. */
export const MONERO_NARRATIVE = 'grainpad records launch provenance on Monero mainnet. Trading and token state remain on Solana.';

export const GRN1 = {
  magic: 'GRN1',
  version: 1,
  recordBytes: 185,
  extraFieldBytes: 189,
  confirmationsRequired: 10,
  feeCapXmr: '0.02',
  spec: '/docs#monero-records',
};

/** Public Monero block explorer used for transaction proof links. */
export const MONERO_EXPLORER_TX = 'https://xmrchain.net/tx/';
export const SOLANA_EXPLORER_TOKEN = 'https://solscan.io/token/';

/**
 * The first live record. null until the real GRAINU GRN1 transaction is broadcast,
 * has 10 Monero confirmations, and the public receipt shows it verified with a
 * matching mint and metadata hash. Do not type it by hand: run
 *   node scripts/monero-live-record.mjs <GRAINU mint>
 * which reads the verified public receipt and prints this object.
 * Shape: {symbol, mint, metadataHash, txHash, height, confirmations}.
 */
/** @type {{symbol:string,mint:string,metadataHash:string,txHash:string,height:number,confirmations:number}|null} */
export const LIVE_RECORD = {
  "symbol": "GRAIN",
  "mint": "FCN2KLyUGT9EddKf8MZYjPce8CWxUid7nWpAx9ograin",
  "metadataHash": "9734421a0d11cd50e6d4aa40e88fa6e177f15d09322703492eab7c713b42b86e",
  "txHash": "aabbe3be4bb9fa601c95c59e32922e112971dc64c988e33c952478ed10a67d8e",
  "height": 3777783,
  "confirmations": 20900
};

/** Throws unless live is a complete verified record. Tests run it on LIVE_RECORD. */
export function assertLiveRecord(live) {
  if (!live || typeof live !== 'object') throw Error('Live record is missing.');
  if (typeof live.symbol !== 'string' || !/^[A-Z0-9]{1,10}$/.test(live.symbol)) throw Error('Live record symbol is invalid.');
  if (typeof live.mint !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(live.mint)) throw Error('Live record mint is not a Solana address.');
  if (!/^[0-9a-f]{64}$/.test(live.metadataHash ?? '')) throw Error('Live record metadata hash must be 64 hex characters.');
  if (!/^[0-9a-f]{64}$/.test(live.txHash ?? '')) throw Error('Live record Monero transaction hash must be 64 hex characters.');
  if (!Number.isInteger(live.height) || live.height <= 0) throw Error('Live record block height is invalid.');
  if (!Number.isInteger(live.confirmations) || live.confirmations < GRN1.confirmationsRequired) throw Error(`Live record needs ${GRN1.confirmationsRequired} Monero confirmations.`);
  return live;
}

/** Proof links for a live record. */
export function liveRecordLinks(live = LIVE_RECORD) {
  if (!live) return null;
  return {monero: MONERO_EXPLORER_TX + live.txHash, solana: SOLANA_EXPLORER_TOKEN + live.mint, receipt: `/token/${live.mint}/receipt`};
}

/** Status labels. The live labels appear only when LIVE_RECORD is set. */
export function moneroRecordStatus(live = LIVE_RECORD) {
  if (live) return [
    {label: 'RECORDED ON MONERO', state: 'done'},
    {label: 'MONERO MAINNET PROVEN', state: 'done'},
    {label: `${live.symbol} · ${live.confirmations} CONFIRMATIONS`, state: 'done'},
  ];
  return [
    {label: 'RECORD FORMAT IMPLEMENTED', state: 'done'},
    {label: 'PRODUCTION OPERATOR: NOT VERIFIED', state: 'pending'},
    {label: 'SIGNED CONSTRUCTION PROOF COMPLETE', state: 'done'},
    {label: 'LIVE RECORD: NOT YET PUBLISHED', state: 'pending'},
  ];
}

/** One-sentence status for surfaces too small for the chips. Flips with LIVE_RECORD. */
export function moneroRecordSummary(live = LIVE_RECORD) {
  return live
    ? `Recorded on Monero: the ${live.symbol} launch record is verified after ${GRN1.confirmationsRequired} Monero confirmations and matches its Solana mint and metadata hash.`
    : 'The record format and local construction proof are implemented. The production operator is not verified, and no live record has been published.';
}

/** What the record layer is. Each line is backed by code in lib/monero-*.mjs. */
export const MONERO_RECORD_FACTS = [
  `Each grainpad launch record is one packed binary ${GRN1.magic} record of ${GRN1.recordBytes} bytes (version 1 or 2; GRAINU uses version 2), carried in a single ${GRN1.extraFieldBytes}-byte grainpad field in a Monero transaction's tx_extra.`,
  'The record commits to the Solana mint and the SHA-256 metadata hash, and names the creator’s Solana public key.',
  'The creator authorizes the record with a Solana (Ed25519) signature. grainpad rejects a record whose signature does not verify.',
  'A repeated record nonce, a repeated Monero transaction, or a second record for the same Solana mint is treated as a duplicate.',
  `grainpad marks a record verified only after ${GRN1.confirmationsRequired} Monero confirmations and a match with the Solana mint, metadata hash and creator on the grainpad receipt. Fewer confirmations stay pending.`,
  'Indexing is independent and read-only. The format is described on the documentation page; decoder source access currently requires repository permission; grainpad’s own daemon client allows read methods only and cannot sign or send.',
  'The public receipt shows the Solana launch and its Monero record side by side.',
];

/** What the record layer is not. Kept next to the facts on every surface that explains GRN1. */
export const MONERO_RECORD_LIMITS = [
  'Trading, balances and token state remain on Solana. Monero carries no token balances and no token transfers.',
  'Users do not send or hold XMR for a record. A dedicated grainpad fee wallet pays the Monero network fee. The approved automatic policy caps it at 0.0001 XMR per record and 0.01 XMR per UTC day, within the format’s absolute 0.02 XMR limit.',
  'It is not a bridge and grainpad takes no custody of user funds.',
  'It does not make Solana trades or balances private.',
  'GRN1 is grainpad’s own format. It is not an XMR20 inscription and is not XMR20-compatible.',
];

/** Where the proof stands. Each entry names the evidence it rests on. Flips with LIVE_RECORD. */
const BUILT = [
  'GRN1 v1/v2 encoder and decoder, with the same 185-byte layout and 189-byte extra field; version 2 changes only the creator authorization message',
  'Creator Solana signature verification',
  'Duplicate and replay protection (nonce, transaction and mint)',
  '10-confirmation pending/verified index logic',
  'Receipt integration: the receipt reports not published, pending or verified, and whether the mint and metadata hash match',
  'Local pre-relay checks on a constructed transaction: one grainpad field, fee-wallet-only outputs, fee cap',
  'A mainnet-compatible Monero transaction carrying a GRN1 record, built and signed locally with wallet2::create_transactions_2; the recorded semantic, non-input consensus and RingCT non-semantic checks passed',
];
export function moneroProofStatus(live = LIVE_RECORD) {
  if (live) return {
    built: BUILT,
    provenHeading: 'Proven on Monero mainnet',
    proven: [
      `The ${live.symbol} launch record was published to Monero mainnet in transaction ${live.txHash}`,
      `It was indexed at block ${live.height} and verified after ${live.confirmations} confirmations`,
      `The ${live.symbol} receipt shows the same Solana mint and metadata hash as the Monero record`,
    ],
    notYet: ['A verified Monero record for every public token: each new record must independently finish publication and reach 10 confirmations'],
    caveat: `${live.symbol} proves one record. That proof does not activate automatic publication for future tokens. Creator authorization and the bounded automatic publication service are implemented; each launch receipt is the evidence of its own publication. Public token creation remains a separate gate. The earlier fixture construction was never broadcast.`,
  };
  return {
    built: BUILT,
    provenHeading: null,
    proven: [],
    notYet: [
      'An installed and independently verified production Monero operator',
      'A grainpad launch record published to Monero mainnet',
      '10-confirmation public indexing of that live record',
      'A receipt showing the same real Solana mint and metadata hash as the Monero record',
    ],
    caveat: 'The signed construction proof used fixture mint and metadata-hash data, not a live Solana launch, and was not broadcast; the source refuses to relay it. The first broadcast must bind to a real grainpad launch, GRAINU, and needs the owner\u2019s approval of that exact transaction.',
  };
}

/** Receipt wording for one launch, from the same index row the receipt API returns. */
export function moneroReceiptView(monero,now=Date.now()) {
  if(monero?.status?.startsWith('publication-'))return {label:'Monero publication '+monero.status.slice(12)+' · not verified',verified:false,txHash:monero.txHash,explorer:/^[0-9a-f]{64}$/.test(monero.txHash||'')?MONERO_EXPLORER_TX+monero.txHash:null};
  if(monero&&['stale','unavailable','rejected'].includes(monero.status))return {label:monero.status==='rejected'?'Monero record rejected':'Current Monero verification unavailable',verified:false,txHash:monero.txHash,explorer:/^[0-9a-f]{64}$/.test(monero.txHash||'')?MONERO_EXPLORER_TX+monero.txHash:null};
  if (!monero || monero.status === 'not-published' || !monero.txHash) return {label: 'Not published on Monero', verified: false, txHash: null, explorer: null};
  const explorer = /^[0-9a-f]{64}$/.test(monero.txHash) ? MONERO_EXPLORER_TX + monero.txHash : null;
  const verified = Number.isSafeInteger(monero.expiresAt)&&monero.expiresAt>now&&monero.matchesCreator===true&&monero.status === 'verified' && monero.matchesMint === true && monero.matchesMetadataHash === true && Number(monero.confirmations) >= GRN1.confirmationsRequired;
  if (verified) return {label: `Recorded on Monero · verified · ${monero.confirmations} confirmations`, verified, txHash: monero.txHash, explorer};
  if (monero.status === 'verified') return {label: 'Monero verification expired or does not match this receipt', verified: false, txHash: monero.txHash, explorer};
  return {label: `Published on Monero · ${Math.min(Number(monero.confirmations) || 0, GRN1.confirmationsRequired)}/${GRN1.confirmationsRequired} confirmations`, verified: false, txHash: monero.txHash, explorer};
}
