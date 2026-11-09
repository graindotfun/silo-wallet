// Plain-language texts for the Bitcoin screens. English, no em or en dashes, never "anonymous" or "audited" (tests enforce both).
import {siloBtcFormat} from './btc-send.mjs';
export const SILO_BTC_COPY = Object.freeze({
  review: 'Silo built this payment on your device. Check the address, the amount and the network fee. When you sign and send, the Bitcoin network cannot reverse it. The total leaving this wallet is the amount plus the fee; any change returns to an address of this wallet.',
  confirmations: 'A new payment shows as pending. The first confirmation usually takes about 10 minutes. For a large payment, wait for 6 confirmations before you treat it as final.',
  unresolved: 'Silo could not confirm whether this payment reached the Bitcoin network. It may have been sent. Do not send it again. Silo keeps the exact signed transaction and checks again; press Check status to look now. This wallet will not send anything else until this is settled.',
  outage: 'Bitcoin data is unavailable right now, so balances and sending are paused. Your coins are not affected. Try again in a few minutes.',
  historyDisagree: 'Two Bitcoin data providers do not fully agree on some activity below. A payment shows as confirmed only when both say so, and the smaller amount is shown.',
  disagree: 'Two Bitcoin data providers gave different answers. Silo shows the smaller balance until they agree.',
  movedSlot: 'If you used a Bitcoin test wallet in an earlier version and it looks missing here, restore it from its backup file or its 24 words. The old encrypted copy was not deleted.',
  notRestored: 'A backup file or the 24 words restore your coins and addresses. They do not restore the record of a payment that was waiting. On a new device, look at this wallet\'s history in a block explorer before you send.',
  visible: 'What is visible: Silo\'s server passes your wallet\'s public addresses to two public Bitcoin data providers (mempool.space and blockstream.info). They can see those addresses and link them to each other, and they keep their own logs. Silo\'s relay does not store them, but ordinary server logs may exist. Your keys, phrase and passphrase never leave this device.',
  exhausted: 'This wallet has used all the addresses Silo scans. To keep using it, restore the 24 words in a standard Bitcoin wallet.',
  testNetwork: 'This is a Bitcoin test network. Its coins have no value. Do not send real bitcoin to these addresses; it would be lost.',
});
export const siloBtcLimitText = capSats => `Limit in this version: at most ${siloBtcFormat(capSats)} BTC leaves this wallet in one send, the network fee included.`;
