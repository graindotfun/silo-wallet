/** Retired private review features (hard-disabled 10 Nov 2026).
 * Owner-only review features (new-wallet review, inline account unlock, the SOL/USDC owner trial, its recovery and
 * preflight checks, and the unsigned swap preview) once ran on a separate Cloudflare test hostname. The wallet moved to
 * https://silo.trading and that hostname now only redirects there.
 *
 * These features are switched off in code, not by hostname: SILO_RETIRED_REVIEW_FEATURES_ENABLED is the constant false,
 * and every gate asks siloRetiredReviewOrigin(), which therefore returns false for every input, including an origin or
 * a SILO_ORIGIN setting equal to SILO_RETIRED_REVIEW_ORIGIN. A string comparison alone would not be enough: server-side
 * SILO_ORIGIN checks need no DNS, so the host's name is not what keeps them closed. Turning any of these features back
 * on needs its own reviewed change to this constant.
 *
 * SILO_RETIRED_REVIEW_ORIGIN is only a placeholder value kept so the old call sites keep a well-formed origin. It sits
 * under the reserved `.invalid` top-level domain (RFC 6761) so it can never name a real site, and so no account hostname
 * is written into code the browser downloads or the public repository publishes. */
export const SILO_RETIRED_REVIEW_FEATURES_ENABLED=false;
export const SILO_RETIRED_REVIEW_ORIGIN='https://retired-review.silo.invalid';
export const SILO_RETIRED_REVIEW_HOST=new URL(SILO_RETIRED_REVIEW_ORIGIN).host;
/** True only when the retired review features are enabled AND the origin is the retired one: today always false. */
export function siloRetiredReviewOrigin(origin){return SILO_RETIRED_REVIEW_FEATURES_ENABLED===true&&origin===SILO_RETIRED_REVIEW_ORIGIN;}
