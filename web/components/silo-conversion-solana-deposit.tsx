'use client';
import '@/lib/browser-buffer.mjs';
import {Buffer} from 'buffer';
import {useCallback,useEffect,useRef,useState} from 'react';
import {Connection} from '@solana/web3.js';
import type {WalletProvider} from '@/lib/wallet';
import {sessionRpcFetch} from '@/lib/browser-rpc-session.mjs';
import {siloSolanaAmount} from '@/lib/silo/solana-amount.mjs';
import {siloUnits} from '@/lib/silo/amounts.mjs';
import {siloJson} from '@/lib/silo/bounded-json.mjs';
import {crosschainAsset} from '@/lib/silo/crosschain-order.mjs';
import {createSiloTransferClientFlow} from '@/lib/silo/solana-transfer-client-flow.mjs';
import {readSiloTransferJournal,cancelUnpromptedSiloTransfer} from '@/lib/silo/solana-transfer-journal.mjs';
import {siloTransferCosts} from '@/lib/silo/solana-transfer-review.mjs';
import {useSiloAccountSigning} from './silo-account-signing';
import type {SiloConversionDeposit} from './silo-conversion-panel';
/** A separate, isolated recovery journal under its own storage key -- never the ordinary-transfer journal's key
 * (SILO_TRANSFER_JOURNAL_KEY), so a crosschain deposit in flight here can never collide with, be picked up by, or
 * be resubmitted through the unrelated ordinary Solana send UI, which reads that key directly from the real
 * localStorage. The requested key is always remapped to one fixed real key, so this module's own internal key
 * name never matters. */
function isolatedStorage(real: Storage, namespace: string) {
 const map = () => `${namespace}:journal`;
 return {getItem: () => real.getItem(map()), setItem: (_key: string, value: string) => real.setItem(map(), value), removeItem: () => real.removeItem(map())} as unknown as Storage;
}
const DECIMALS: Record<'sol' | 'usdc', number> = {sol: 9, usdc: 6};
/** Stages, reviews, signs and reports the exact bound SOL/USDC deposit for a cross-chain conversion order, through
 * the SAME reviewed native signing path (createSiloTransferClientFlow, server review+verify at
 * /api/silo/solana/review) that an ordinary Silo send uses -- nothing new is signed; this only binds the
 * recipient/amount to the order instead of to free-form input, and reports the already-signed bytes to
 * /api/silo/conversion/deposit instead of the ordinary /api/silo/solana/submit. recordSiloConversionDeposit
 * independently re-derives the signed transaction's destination/amount before ever relaying it (see
 * conversion-service.mjs), so this component's own binding check is a UX guard, not the security boundary. */
export function SiloConversionSolanaDeposit({provider, onBridge}: {provider: WalletProvider | null; onBridge: (prepare: ((request: SiloConversionDeposit & {quoteSeal: string}) => Promise<void>) | null) => void}) {
 const accountSigning = useSiloAccountSigning();
 const [storage] = useState<Storage | null>(() => typeof localStorage !== 'undefined' ? isolatedStorage(localStorage, 'grain-silo-conversion-solana-deposit-v1') : null);
 const [pending, setPending] = useState<ReturnType<typeof readSiloTransferJournal> | null>(null);
 const [orderId, setOrderId] = useState<string | null>(null);
 // The real sealed quote id, NOT orderId -- /api/silo/conversion/deposit needs the seal to re-open and verify the
 // bound intent (Sol's review, 29 Oct 2026: report() was sending orderId in the quoteSeal field, which could
 // never open; a plain ChangeNOW order id is not a sealed quote token). Persisted under its own key, separate
 // from the signing journal's own isolated storage, so it survives exactly the same reload the signed-but-
 // unreported journal survives -- otherwise a reload between signing and reporting would lose the one piece of
 // data needed to report the deposit at all (the same gap Sol/Opus flagged for the order metadata generally).
 const [quoteSeal, setQuoteSeal] = useState<string | null>(null);
 const orderMetaKey = 'grain-silo-conversion-solana-deposit-v1:order';
 function persistOrderMeta(meta: {orderId: string; quoteSeal: string} | null) {
  try { if (meta) localStorage.setItem(orderMetaKey, JSON.stringify(meta)); else localStorage.removeItem(orderMetaKey); } catch { /* best-effort; report() still fails closed below if this is missing */ }
 }
 // Staged review awaiting the user's own explicit sign step -- prepare() only reserves and shows the review
 // (including its real network fee and rent), exactly like the ordinary Solana send UI; nothing is signed until
 // the separate confirmAndSign() click below (owner, 29 Oct: show the wallet-side send cost before signing).
 const [review, setReview] = useState<Awaited<ReturnType<ReturnType<typeof createSiloTransferClientFlow>['prepare']>> | null>(null);
 const flowRef = useRef<ReturnType<typeof createSiloTransferClientFlow> | null>(null);
 const [error, setError] = useState(''), [busy, setBusy] = useState(false);
 const mounted = useRef(true);
 useEffect(() => { mounted.current = true; try {
  // Mount-time restore of the persisted journal; reading localStorage during render would break hydration.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  if (storage) setPending(readSiloTransferJournal(storage));
  const savedMeta = localStorage.getItem(orderMetaKey);
  if (savedMeta) { const meta = JSON.parse(savedMeta); if (typeof meta?.orderId === 'string' && typeof meta?.quoteSeal === 'string') { setOrderId(meta.orderId); setQuoteSeal(meta.quoteSeal); } }
 } catch { /* shown via error on next action */ } return () => { mounted.current = false; }; }, []);
 function connection() { return new Connection(new URL('/api/silo/solana/transfer?network=mainnet-beta', window.location.origin).href, {commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: sessionRpcFetch}); }
 async function prepare(request: SiloConversionDeposit & {quoteSeal: string}) {
  if (!storage || !provider || provider.kind !== 'native' || busy) throw Error('Silo native Solana wallet required.');
  if (request.asset !== 'sol' && request.asset !== 'usdc') throw Error('Unsupported deposit asset for this wallet.');
  if (request.network !== 'mainnet') throw Error('Unsupported deposit network.');
  if (!Number.isSafeInteger(request.expiresAt) || request.expiresAt <= Date.now()) throw Error('This deposit order has expired.');
  // SOL/USDC deposits never carry a payment memo (changenow-adapter.mjs's boundOrder only ever accepts a
  // non-empty payinExtraId for a Monero source) -- this should never actually trigger, but refuse explicitly
  // rather than silently sending if it somehow ever did (owner, 29 Oct 2026: never omit or guess).
  // Opus's review, 29 Oct 2026: typeof, not truthiness -- a malformed (non-string) memo must be refused
  // explicitly too, not silently treated as "confirmed no memo required".
  if (typeof request.memo !== 'string') throw Error('This deposit\'s payment-identifier field could not be read. Nothing was prepared; check the conversion order before retrying.');
  if (request.memo.length > 0) throw Error(`This deposit requires a payment identifier ("${request.memo}") that a Solana transfer cannot carry. Contact support with order ${request.orderId} before sending anything.`);
  if (readSiloTransferJournal(storage)) throw Error('A deposit review is already open. Finish or cancel it before starting another.');
  setBusy(true); setError('');
  try {
   const owner = provider.wallet.publicKey?.toBase58();
   if (!owner || owner !== request.sourceAddress) throw Error('The connected wallet differs from the order’s source address.');
   const decimals = DECIMALS[request.asset], mint = request.asset === 'usdc' ? crosschainAsset('usdc').mint : null;
   const amount = siloUnits(request.amountAtomic, decimals);
   const input = {network: 'mainnet-beta' as const, owner, recipient: request.address, mint, amount: siloSolanaAmount(amount, decimals), decimals};
   const flow = createSiloTransferClientFlow({storage: storage, wallet: provider.wallet, connection: connection(), accountSigning});
   const staged = await flow.prepare({terms: input, max: false});
   if (provider.wallet.publicKey?.toBase58() !== owner) throw Error('Wallet changed during review.');
   if (!mounted.current) return;
   flowRef.current = flow; setReview(staged); setOrderId(request.orderId); setQuoteSeal(request.quoteSeal); persistOrderMeta({orderId: request.orderId, quoteSeal: request.quoteSeal});
  } catch (failure) {
   if (mounted.current) setError(failure instanceof Error ? failure.message : 'The deposit review could not be prepared.');
   throw failure;
  } finally { if (mounted.current) setBusy(false); }
 }
 async function confirmAndSign() {
  if (!review || !flowRef.current || busy) return;
  setBusy(true); setError('');
  try {
   await flowRef.current.approve(review, flowRef.current.consent(review));
   if (!mounted.current) return;
   setPending(readSiloTransferJournal(storage!)); setReview(null); flowRef.current = null;
  } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'The deposit could not be signed.'); }
  finally { if (mounted.current) setBusy(false); }
 }
 function cancelReview() { setReview(null); flowRef.current = null; setError(''); }
 // B2 (Astra round 2): register ONE stable wrapper per native/non-native state. A fresh `prepare` each render with a
 // dependency-less effect re-registered every render, and the parent stores it in state, so it looped forever.
 // The ref always holds the latest closure (current busy/provider/storage), so the stable wrapper never goes stale.
 const prepareRef = useRef(prepare); prepareRef.current = prepare; // eslint-disable-line react-hooks/refs
 const stablePrepare = useCallback((request: SiloConversionDeposit & {quoteSeal: string}) => prepareRef.current(request), []);
 const isNative = provider?.kind === 'native';
 useEffect(() => { onBridge(isNative ? stablePrepare : null); return () => onBridge(null); }, [isNative, onBridge, stablePrepare]);
 async function report() {
  if (!storage || !pending || pending.state !== 'signed' || busy) return;
  if (!quoteSeal) { setError('The order’s quote reference was lost (for example by a reload at the wrong moment). Keep the exact signed payment; do not sign a replacement. Contact support with the signed payload.'); return; }
  setBusy(true); setError('');
  try {
   const response = await sessionRpcFetch('/api/silo/conversion/deposit', {method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({quoteSeal, signedBytes: pending.wire})});
   const result = await siloJson(response, 8192);
   if (!response.ok) throw Error('Deposit reporting is held or unavailable. Keep the exact signed payment; do not sign a replacement.');
   if (result.state === 'deposit-submitted' || result.state === 'deposit-uncertain') { storage.removeItem('grain-silo-conversion-solana-deposit-v1:journal'); persistOrderMeta(null); setPending(null); setOrderId(null); setQuoteSeal(null); }
  } catch (failure) { setError(failure instanceof Error ? failure.message : 'Deposit reporting failed. Keep the exact signed payment; check the conversion order status before retrying.'); }
  finally { setBusy(false); }
 }
 function cancel() { if (!storage || !pending || pending.state !== 'signing' || pending.promptStarted !== false || busy) return; try { cancelUnpromptedSiloTransfer(storage, {network: 'mainnet-beta'}); persistOrderMeta(null); setPending(null); setOrderId(null); setQuoteSeal(null); setError(''); } catch { setError('The unsigned reservation could not be cancelled.'); } }
 if (review) {
  const costs = siloTransferCosts(review), label = review.terms.mint ? 'USDC' : 'SOL';
  return <section id="silo-conversion-deposit-review" tabIndex={-1} className="silo-review silo-conv-deposit" aria-label="Cross-chain deposit review"><h3>Review deposit · order {orderId}</h3>
   <p>Send <strong>{siloUnits(review.terms.amount, review.terms.decimals)} {label}</strong> to the provider&apos;s deposit address.</p>
   <dl className="silo-rows"><div><dt>Deposit address</dt><dd><code>{review.terms.recipient}</code></dd></div></dl>
   <dl className="silo-rows"><div><dt>Network fee (paid in SOL, separate from the provider&apos;s own quote)</dt><dd>{costs.rows.find(r => r.label === 'Network fee')?.value ?? 'not checked'}</dd></div><div><dt>Account creation (if a new token account is needed)</dt><dd>{costs.rows.find(r => r.label === 'Account creation')?.value ?? 'not checked'}</dd></div><div><dt>Total SOL leaving this wallet</dt><dd>{costs.totalSol}</dd></div></dl>
   <p className="exposure-note">This is your own wallet&apos;s cost to send the deposit -- separate from whatever the provider&apos;s quote already reflects. Signing does not establish settlement; check the order status after sending.</p>
   <div className="exposure-actions"><button className="silo-primary" disabled={busy} onClick={() => void confirmAndSign()}>Sign deposit</button><button disabled={busy} onClick={cancelReview}>Cancel review</button></div>
   {error && <p role="alert">{error}</p>}
  </section>;
 }
 if (!pending) return null;
 return <section className="silo-review silo-conv-deposit" aria-label="Cross-chain deposit review"><h3>Conversion deposit review{orderId ? ` · order ${orderId}` : ''}</h3>
  {pending.state === 'signing' ? <p>{pending.promptStarted ? 'The wallet prompt started, but no signed transaction was captured. Keep this record; do not prepare a replacement.' : 'An unsigned deposit review is reserved.'}</p> : <p>Signed and ready to report. This has not been sent to the Solana network yet.</p>}
  {pending.state === 'signing' && pending.promptStarted === false && <button disabled={busy} onClick={cancel}>Cancel before wallet prompt</button>}
  {pending.state === 'signed' && <button className="silo-primary" disabled={busy} onClick={() => void report()}>Report signed deposit</button>}
  {error && <p role="alert">{error}</p>}
 </section>;
}
