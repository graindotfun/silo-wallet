// Browser-side adapters for /api/silo/btc, kept out of the React component so tests run the REAL adapters against route-shaped answers.
// `post(body)` performs the authenticated POST and resolves the Response (sessionRpcFetch in the browser).
export function siloBtcRelayClient(post) {
  const json = async response => { try { return await response.json(); } catch { return null; } };
  return {
    /** Reads. Messages never claim anything about a send: a read can fail after an ambiguous broadcast. */
    async relay(body, network) {
      const response = await post(body), data = await json(response);
      if (!response.ok || !data) throw Object.assign(Error(response.status === 429 ? 'Bitcoin reads are busy. Try again shortly.' : 'Bitcoin data is unavailable right now, so balances and sending are paused. Your coins are not affected.'), {relay: true});
      if (data.network !== network) throw Object.assign(Error('The Bitcoin data provider answered for a different network.'), {relay: true});
      return data;
    },
    async send({hex, txid}) {
      const response = await post({action: 'broadcast', hex, txid}), data = await json(response);
      if (!response.ok || !data) throw Object.assign(Error('broadcast'), {reasons: Array.isArray(data?.reasons) && data.reasons.length ? data.reasons : [`btc:http-${response.status}`]});
      return data;
    },
    /** known and confirmed are passed through exactly as the relay reported them (the resolver clears only on known AND confirmed). */
    async status(txid) {
      const response = await post({action: 'txstatus', txid}), data = await json(response);
      if (!response.ok || !data || (typeof data.known !== 'boolean' && data.known !== null)) throw Error('status');
      return {known: data.known, confirmed: data.confirmed === true};
    },
    async outspends(outpoints) {
      const response = await post({action: 'outspends', outpoints}), data = await json(response);
      if (!response.ok || !data || !Array.isArray(data.rows)) throw Error('outspends');
      return data.rows;
    },
  };
}
