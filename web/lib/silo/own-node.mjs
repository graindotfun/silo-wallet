// "Use my own Monero node" (design: docs/silo-trust/TOR_AND_OWN_NODE_UX.md, Part 1, clearnet https only).
//
// The saved address lives on this device only (one localStorage key). It is never sent to a Silo server, never put in a URL, never
// logged, and never written into a backup file (backups are built from wallet data, not from this key). The wallet never falls back
// to Silo's node by itself: if the chosen node fails, the wallet says so and stops until the user presses the one explicit button.
import {siloNodeUrl} from './disclosures.mjs';
import {assertSiloXmrNodeNetwork} from './xmr-node-network.mjs';
import {SILO_OWN_NODE_ENABLED} from './own-node-flag.mjs';

export {SILO_OWN_NODE_ENABLED};

export const SILO_OWN_NODE_KEY = 'silo-xmr-own-node';
/** How far behind Silo's node an own node may be and still pass. */
export const SILO_OWN_NODE_MAX_BEHIND = 3;
const MAX_FAR = 1e9;

export function siloOwnNodeEnabled(flag = SILO_OWN_NODE_ENABLED) { return flag === true; }

/** The address as the wallet will use it, or null if it fails the same rule as the configured node (plain https URL, no user,
 * password, query or fragment). */
export function normalizeOwnNode(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 300) return null;
  try { return siloNodeUrl(text); } catch { return null; }
}
export function ownNodeHost(uri) { try { return new URL(uri).host; } catch { return ''; } }

function store(storage) { if (storage) return storage; try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } }
export function loadOwnNode(storage) {
  try { const s = store(storage); const raw = s?.getItem(SILO_OWN_NODE_KEY); return raw ? normalizeOwnNode(raw) : null; } catch { return null; }
}
export function saveOwnNode(value, storage) {
  const uri = normalizeOwnNode(value); if (!uri) throw Error('Use a plain https address, for example https://node.example.com:18081');
  const s = store(storage); if (!s) throw Error('This browser cannot save the address.');
  s.setItem(SILO_OWN_NODE_KEY, uri); return uri;
}
export function clearOwnNode(storage) { try { store(storage)?.removeItem(SILO_OWN_NODE_KEY); } catch { /* nothing to clear */ } }

/** Which node a Monero action uses. `useSiloForNow` is the explicit, session-only override. Only a literal flag, a valid saved
 * address and mainnet or stagenet XMR ever select the own node; everything else is the configured node unchanged. */
export function chooseXmrNode({configured, own, enabled = SILO_OWN_NODE_ENABLED, useSiloForNow = false}) {
  if (enabled === true && own && !useSiloForNow) return {uri: own, kind: 'own', host: ownNodeHost(own)};
  return {uri: configured, kind: 'silo', host: ''};
}
/** The line shown on every Monero screen. Always one of the two. */
export function nodeInUseLine(choice) { return choice.kind === 'own' ? `Node: your node (${choice.host})` : "Node: Silo's node"; }

async function getInfo(uri, fetcher) {
  const response = await fetcher(`${uri}/get_info`, {cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(10000)});
  if (!response?.ok) { await response?.body?.cancel?.().catch(() => {}); throw Error('unreachable'); }
  const info = await response.json();
  if (!info || typeof info !== 'object') throw Error('unreachable');
  return info;
}
const heightOf = info => Number.isSafeInteger(info?.height) && info.height >= 0 && info.height < MAX_FAR ? info.height : null;

/** Test button. Reaches the user's node, runs the wallet's own network check, then compares its height with Silo's node.
 * Only the user's node and (for the height) the configured node are contacted; the user's address is sent to neither Silo
 * server nor anything else. `silo` is the configured Silo node and may be missing (then the third line says it could not compare).
 * @returns {{ok:boolean, uri:string|null, lines:{ok:boolean,text:string}[]}} */
/** @param {{address?:string,network?:string,silo?:string,fetcher?:typeof fetch,maxBehind?:number}} [options] */
export async function testOwnNode({address, network = 'mainnet', silo = '', fetcher = fetch, maxBehind = SILO_OWN_NODE_MAX_BEHIND} = {}) {
  const uri = normalizeOwnNode(address);
  if (!uri) return {ok: false, uri: null, lines: [{ok: false, text: 'Use a plain https address, for example https://node.example.com:18081.'}]};
  const lines = [];
  let info;
  try { info = await getInfo(uri, fetcher); lines.push({ok: true, text: 'Reached the node.'}); }
  catch { return {ok: false, uri, lines: [{ok: false, text: 'Could not reach the node.'}]}; }
  try { assertSiloXmrNodeNetwork(info, network); lines.push({ok: true, text: network === 'mainnet' ? 'It is Monero mainnet.' : `It is Monero ${network}.`}); }
  catch { return {ok: false, uri, lines: [...lines, {ok: false, text: network === 'mainnet' ? 'It is not Monero mainnet.' : `It is not Monero ${network}.`}]}; }
  const own = heightOf(info);
  let tip = null;
  if (silo) { try { tip = heightOf(await getInfo(siloNodeUrl(silo), fetcher)); } catch { tip = null; } }
  if (own === null || tip === null) { lines.push({ok: false, text: 'Could not compare it with the latest block.'}); return {ok: false, uri, lines}; }
  const behind = Math.max(0, tip - own);
  if (behind > maxBehind) { lines.push({ok: false, text: `It is about ${behind} blocks behind.`}); return {ok: false, uri, lines}; }
  lines.push({ok: true, text: behind === 0 ? 'It is up to date.' : `It is about ${behind} block${behind === 1 ? '' : 's'} behind.`});
  return {ok: true, uri, lines};
}

export const SILO_OWN_NODE_COPY = Object.freeze({
  heading: 'Monero node',
  silo: "Silo's node. It sees your IP address, which blocks your wallet asks for, and the transactions you send through it. It cannot spend your funds.",
  own: 'Your node. Only you see your requests and the transactions you send through it, if you run it yourself. The test step also asks Silo\'s node for its block height to compare.',
  failure: "We could not use your node. No payment was sent. Fix it, or choose Silo's node for now.",
  useSilo: "Use Silo's node for now",
  howTitle: 'How to set up your node',
  how: Object.freeze([
    'Allow the Silo page to call your node: start monerod with --rpc-access-control-origins https://silo.trading',
    'Serve it over https with a valid certificate. The wallet page is https, so the browser blocks plain http. A reverse proxy such as Caddy does this in a few lines.',
    'Add --restricted-rpc so the node answers only the calls a wallet needs. Add --confirm-external-bind whenever the node listens on anything other than this machine (a home network counts). A browser may still block a public page from calling a node on your home network; check before relying on it.',
  ]),
});
