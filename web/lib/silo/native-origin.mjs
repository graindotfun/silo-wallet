/** The rule behind "This is not the reviewed wallet origin": on a mainnet wallet a key may be created, restored or unlocked only at the origin the
 * release evidence names. A missing reviewed origin (no ready release) is a refusal, never a pass. */
export const siloNativeOriginAllowed = ({mainnetMode, origin, reviewedOrigin}) => !mainnetMode || (typeof reviewedOrigin === 'string' && reviewedOrigin.length > 0 && origin === reviewedOrigin);
