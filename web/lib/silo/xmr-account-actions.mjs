/** Monero wallet actions as the Silo native zone runs them, with the account gate in front of every wallet-engine action
 * (SYNC-GATE-01). `gate` is `accountSigning().xmr(network)` and `cancelGate` is `accountSigning().xmrCancel`; with account
 * sync off `gate` is null and `cancelGate` just runs the action, so every path is exactly the wallet's own.
 *   prepare  — the engine creates and signs the payment (createTx); the account reservation comes first.
 *   submit   — the account records the exact signed payment before the wallet saves it as sent and relays it.
 *   discard  — a review that was never submitted: the wallet draft and the account reservation are both retired.
 *   cancel   — a conflicting spend (sweepOutput, relayTx) only through the account, which keeps one cancelling payment
 *              for every device.
 * Nothing here builds, signs or relays by itself; those stay in xmr-adapter.mjs. */
// Reservation tickets by review draft. Module-level so a component may rebuild its actions without losing them.
const tickets = new WeakMap();
/** @param {{wallet: any, gate?: any, cancelGate?: (source: any, run: (persist: () => Promise<unknown>) => Promise<string>, persist: () => Promise<unknown>) => Promise<string>}} options */
export function createXmrAccountActions({wallet, gate = null, cancelGate = (_source, run, persist) => run(persist)}) {
  const pending = () => wallet.pendingRecord?.() ?? null;
  return Object.freeze({
    async prepare({address, amount}) {
      const ticket = gate ? await gate.begin({address, amount}) : null;
      let draft;
      try { draft = await wallet.prepare({address, amount}); }
      catch (error) { if (gate) await gate.abandon(ticket); throw error; }
      if (ticket) tickets.set(draft, ticket);
      return draft;
    },
    async submit(draft, persist) {
      if (!gate) return draft.submit(draft.consent, persist);
      let ticket = tickets.get(draft);
      if (!ticket) {
        // Only a payment the wallet already saved (restored after a reload) can be brought onto the account here; a fresh
        // review prepared without a reservation is never committed.
        if (!pending()) throw Object.assign(Error('This review was prepared without the account. Prepare the payment again.'), {gateCode: 'no-reservation'});
        ticket = await gate.ticketFor(pending()); tickets.set(draft, ticket);
      }
      return draft.submit(draft.consent, gate.persist(ticket, pending, persist));
    },
    async discard(draft) {
      draft.cancel();
      const ticket = tickets.get(draft);
      // The ticket is forgotten only once the reservation is retired; a failure leaves it for a retry and reaches the caller (N5).
      if (gate && ticket) { await gate.abandon(ticket); tickets.delete(draft); }
    },
    cancel(persist) {
      if (typeof wallet.cancelByConflict !== 'function') throw Error('Cancelling is not available for this wallet.');
      return cancelGate({pending, adopt: (conflict, save) => wallet.adoptConflict(conflict, save)}, (save) => wallet.cancelByConflict(save), persist);
    },
  });
}
