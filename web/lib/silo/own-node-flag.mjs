/** Off by default. The wallet page is served with a static Content-Security-Policy whose connect-src lists reviewed node origins
 * only (lib/silo/security-headers.mjs). A node the user types cannot be in that list, so with this flag on and the policy
 * unchanged the browser blocks every call to it. Turning it on needs an owner decision about connect-src (see PR notes).
 * Until then nothing in the wallet reads or offers an own node, and no copy promises one. */
export const SILO_OWN_NODE_ENABLED = false;
