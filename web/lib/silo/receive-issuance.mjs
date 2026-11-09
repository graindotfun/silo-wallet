/** Counts the receive addresses a wallet session actually ISSUES (shows or hands out), so a backup verified a little after its export can
 * tell "nothing was issued since" from "a new address exists that the file does not hold". Only wraps the wallet's own receive methods;
 * it changes no behaviour and holds no secret. `receive()` is also called by every sync and only counts when it returns a DIFFERENT
 * address than the one before (a sync that shows the same address issues nothing); `newReceive()` and `newExchangeReceive()` always create one. */
/** @param {Record<string, unknown>} wallet @param {() => void} onIssue @param {string | null} [initialAddress] */
export function trackReceiveIssuance(wallet, onIssue, initialAddress = null) {
  let lastReceive = typeof initialAddress === 'string' && initialAddress ? initialAddress : null;
  const wrap = (name, always) => {
    const original = wallet?.[name];
    if (typeof original !== 'function') return;
    wallet[name] = async (...args) => {
      const address = await original.apply(wallet, args);
      if (always || (lastReceive !== null && address !== lastReceive)) onIssue();
      if (name === 'receive' || name === 'newReceive') lastReceive = address;
      return address;
    };
  };
  wrap('receive', false);
  wrap('newReceive', true);
  wrap('newExchangeReceive', true);
  return wallet;
}
