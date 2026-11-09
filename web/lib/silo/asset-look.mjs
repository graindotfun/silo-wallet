/** How an asset looks in Silo (r8 art direction, owner 6 Nov 2026): one colour field per asset, used by Home, the What to send sheet,
 * Convert and Swap. Display only: nothing here selects a token, network, amount or transfer.
 *
 * Colour rule
 * - A verified asset stands on its brand colour (`fill`), with label text (`ink`) at 4.5:1 or better against every stop of the fill
 *   (tests/silo-asset-look.test.mjs measures it).
 * - Anything Silo has not verified, an unknown token, a test asset, or a bridged copy of another asset (wXMR is not native XMR), stands on
 *   the neutral cream fallback. A stranger can name a token "USDC"; only the pinned mint earns the blue (lib/silo/known-tokens.mjs).
 * - Networks are never a fill: they are dark inset chips (mark + "Public · Solana", "Private · Monero").
 * - Orange is XMR's colour. GRAIN uses the grainpad brown so it never reads as Monero.
 *
 * Adding an asset: add its key here with a fill and ink that pass the test; the screens pick it up with no screen work. */
export const SILO_FALLBACK_LOOK=Object.freeze({key:'token',fill:'#f3ebde',stops:Object.freeze(['#f3ebde']),ink:'#14110e',icon:'token'});
const look=(key,fill,stops,ink,icon=key)=>Object.freeze({key,fill,stops:Object.freeze(stops),ink,icon});
export const SILO_ASSET_LOOKS=Object.freeze({
 sol:look('sol','linear-gradient(120deg,#dc1fff,#00ffa3)',['#dc1fff','#00ffa3'],'#14110e'),
 xmr:look('xmr','#ff6600',['#ff6600'],'#14110e'),
 usdc:look('usdc','#2775ca',['#2775ca'],'#ffffff'),
 usdt:look('usdt','#26a17b',['#26a17b'],'#14110e','token'),
 grain:look('grain','#3a2b20',['#3a2b20'],'#f3ebde'),
 zec:look('zec','#f4b728',['#f4b728'],'#14110e'),
 eth:look('eth','#627eea',['#627eea'],'#14110e'),
 base:look('base','#0052ff',['#0052ff'],'#ffffff'),
 bnb:look('bnb','#f0b90b',['#f0b90b'],'#14110e'),
});
/** The look for a verified symbol, else the cream fallback. `verified` must come from the pinned registry, never from token metadata. */
export function siloAssetLook(symbol,verified=true){
 if(!verified)return SILO_FALLBACK_LOOK;
 return SILO_ASSET_LOOKS[String(symbol??'').toLowerCase()]??SILO_FALLBACK_LOOK;
}
/** The look for an EVM chain id (Ethereum 1, Base 8453, BNB 56). */
export function siloChainLook(chainId){
 return chainId===1?SILO_ASSET_LOOKS.eth:chainId===8453?SILO_ASSET_LOOKS.base:chainId===56?SILO_ASSET_LOOKS.bnb:SILO_FALLBACK_LOOK;
}
