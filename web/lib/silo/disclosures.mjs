export const SILO_DISCLOSURES = Object.freeze({
 solana: {network:'Solana public zone',hidden:'Nothing is concealed in this public zone.',visible:'Addresses, balances, holdings, transfers and all public activity remain visible on Solana.',observers:'Your connected wallet, Grain\'s relay, its RPC provider and public chain observers can see public data. Silo never asks for your seed. A transfer is signed only in your own wallet, after you review its exact recipient, amount and network costs here.'},
 xmr: {network:'Monero stagenet · test funds only',hidden:'Native Monero protocol protects on-chain participants and amounts; the view key of your wallet is never sent to a server (a no-bridge swap shares a one-time view key for that swap address only).',visible:'Transaction existence, timing and node request patterns remain visible. External conversion providers can link their own deposits and withdrawals.',observers:'Your browser/worker holds keys locally. The Monero node you connect to (run by Grain by default, or your own if you set one) sees your IP and sync requests. Grainpad serves the code and a malicious origin can steal an unlocked seed.'},
 evm: {network:'EVM public zone · Ethereum, Base, BNB Smart Chain, Robinhood Chain · view and receive, send where enabled',hidden:'Nothing is concealed in this public zone.',visible:'Addresses, balances, tokens and all activity remain public on every EVM chain. The same address is used on all of them.',observers:'Grain reads balances through its own server relay: your address is sent to Grain\'s server and its RPC provider for that read, and is not stored. Silo never asks a browser wallet extension to sign anything. Sending is available only where this server has enabled it: the transfer you confirm is signed inside Silo with your own key and relayed through Grain\'s server, which therefore sees the signed transfer and the amount.'},
 zec: {network:'Zcash testnet · shielded native ZEC',hidden:'Shielded transfers protect participants and amounts in the supported Orchard and Ironwood pools.',visible:'Transaction existence and timing remain visible. Transparent hops disclose information and are refused by this prototype.',observers:'Your browser holds keys; lightwalletd/gRPC-web sees IP and request patterns. Grainpad supplies code; a hostile origin or extension can observe unlocked secrets.'},
});
export function siloDisclosure(zone){const row=SILO_DISCLOSURES[zone];if(!row)throw Error('Unsupported Silo zone.');return row;}
export function siloConversionDisclosure(direction){
 if(!['sol-to-xmr','usdc-to-xmr','xmr-to-sol','xmr-to-usdc','sol-to-usdc','usdc-to-sol'].includes(direction))throw Error('Unsupported conversion direction.');
 const [from,to]=direction.split('-to-');
 if(from!=='xmr'&&to!=='xmr'){const label=asset=>asset==='usdc'?'USDC':'SOL',a=label(from),b=label(to);return {visible:`Solana addresses, amounts and timing are public on both sides of this ${a} to ${b} conversion (USDC is an SPL token transfer; its amount and the token account are equally visible on-chain). Silo’s relay and the exchange see conversion details; the exchange can link both legs. RPC providers see reads.`,hidden:'Nothing about this conversion is private: both legs are ordinary public Solana transfers. Wallet keys stay local; this review shares no view key.',remaining:`Your ${a} deposit and the ${b} payout both stay on public Solana history, and the exchange can associate them. Provider records and timing remain.`};}
 const solanaSide=from==='xmr'?to:from,label=solanaSide==='usdc'?'USDC':'SOL';
 return {visible:`Solana addresses, amounts and timing are public${solanaSide==='usdc'?` (${label} is an SPL token transfer; its amount and the token account are equally visible on-chain)`:''}. Silo’s relay and exchange see conversion details; the exchange can link both legs. RPC providers see reads; Monero nodes see IP and sync requests.`,hidden:'Native Monero protects on-chain participants and amounts. Wallet keys stay local; this review shares no view key.',remaining:from!=='xmr'?'Solana history and the public deposit remain visible. Provider records and amount/timing correlations remain.':`The ${label} payout becomes public, alongside your existing Solana history. The exchange can associate it with the XMR deposit; provider records and timing remain.`};
}
export function siloNodeUrl(value){const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('Use a token-free HTTPS test node URL.');return url.href.replace(/\/$/,'');}

/** What this build can do right now, as plain sentences generated from the served configuration (the object the page embeds as
 * `configuration`). Settings, Fees and About use this instead of hand-written "planned" or "under review" text, so the copy cannot
 * drift from the flags again (review F-35, UX-09). Only a literal true counts as on; anything missing reads as off. */
export function siloBuildStatus(config) {
  const c = config && typeof config === 'object' ? config : {};
  const on = value => value === true;
  const convert = on(c.crosschain?.executionEnabled);
  const noBridgeXmrToSol = on(c.atomic?.executionEnabled) && typeof c.atomic?.programId === 'string';
  const noBridgeSolToXmr = noBridgeXmrToSol && on(c.atomic?.solXmrEnabled);
  const tokenSwaps = on(c.swap?.executionEnabled);
  const bitcoin = on(c.btc?.enabled);
  const evm = (Array.isArray(c.evmChains) ? c.evmChains : []).filter(row => row && on(row.enabled) && on(row.configured));
  const evmSend = evm.filter(row => on(row.send)).map(row => String(row.name));
  const evmViewOnly = evm.filter(row => !on(row.send)).map(row => String(row.name));
  const activity = on(c.solana?.activityEnabled);
  const cap = typeof c.atomic?.capXmr === 'string' && /^\d+(\.\d+)?$/.test(c.atomic.capXmr) ? c.atomic.capXmr : null;
  const provider = c.crosschain?.provider === 'changenow' ? 'ChangeNOW' : 'an outside provider';
  const names = list => list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0] ?? '';
  const lines = [];
  lines.push(convert
    ? `Convert between SOL, USDC and native XMR is on. ${provider}, an outside company, does the conversion and holds the money while it runs.`
    : 'Convert between SOL, USDC and native XMR is off in this build.');
  lines.push(noBridgeXmrToSol
    ? `The no-bridge swap is on ${noBridgeSolToXmr ? 'in both directions, XMR to SOL and SOL to XMR' : 'for XMR to SOL only'}${cap ? `, up to ${cap} XMR per swap` : ''}. Grain runs the swap maker.`
    : 'The no-bridge swap is off in this build.');
  lines.push(tokenSwaps ? 'Token swaps through Jupiter are on.' : 'Token swaps through Jupiter are off in this build.');
  if (evm.length) lines.push(`${names(evmViewOnly.concat(evmSend))}: ${evmSend.length ? `view and receive; send is on for ${names(evmSend)}` : 'view and receive only; send is off'}.`);
  lines.push(bitcoin ? 'Bitcoin is on.' : 'Bitcoin is off in this build.');
  return Object.freeze({ convert, noBridgeXmrToSol, noBridgeSolToXmr, tokenSwaps, bitcoin, evmViewOnly, evmSend, activity, cap, provider, lines: Object.freeze(lines) });
}
