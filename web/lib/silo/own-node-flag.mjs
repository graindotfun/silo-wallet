/** Release switch for "use my own Monero node". The standard wallet page keeps its static Content-Security-Policy, so it can
 * never call an address the user typed. The feature lives on its own opt-in page, /app/node (a query string cannot be used: the Cloudflare route silo.trading/app is an exact match and answers any /app?x with 404 at the edge, while /app/* reaches the Worker), which the middleware serves with
 * connect-src widened to any https address (lib/silo/security-headers.mjs, ownNode option). Script rules, framing rules and every
 * other directive stay identical. Nothing a user types is sent to Silo: the saved address stays on the device. */
export const SILO_OWN_NODE_ENABLED = true;
/** The opt-in page: its own document path under the existing /app/* route. */
export const SILO_OWN_NODE_PATH = '/app/node';
/** The standard wallet document, the only page that redirects to the opt-in page. */
export const SILO_STANDARD_PATH = '/app';
export const SILO_OWN_NODE_URL = SILO_OWN_NODE_PATH;
/** True only for the opt-in page itself (exact path, trailing slash excluded). */
export function siloOwnNodeRequest(pathname, enabled = SILO_OWN_NODE_ENABLED) { return enabled === true && pathname === SILO_OWN_NODE_PATH; }
/** Where the standard page must send the user, or null. Only the standard wallet document with a saved own node is sent to the
 * opt-in page, keeping the fragment the wallet routes by. The opt-in page never redirects, so there is no loop. */
export function ownNodeRedirect(pathname, hash, saved, enabled = SILO_OWN_NODE_ENABLED) {
  if (enabled !== true || !saved || pathname !== SILO_STANDARD_PATH) return null;
  return SILO_OWN_NODE_URL + (typeof hash === 'string' && hash.startsWith('#') ? hash : '');
}
