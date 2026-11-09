/** A short, safe description of an unexpected failure, for messages that would otherwise only say "could not be ...": the error name and message,
 * with long encoded strings (keys, ciphertext, addresses, tokens) cut out and the length bounded. */
export function siloFailureReason(failure) {
  const name = failure instanceof Error && failure.name && failure.name !== 'Error' ? `${failure.name}: ` : '';
  const message = failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : 'unknown';
  const cleaned = `${name}${message}`.replace(/[A-Za-z0-9+/=_-]{32,}/g, '\u2026').replace(/\s+/g, ' ').trim().slice(0, 160);
  return cleaned || 'unknown';
}
