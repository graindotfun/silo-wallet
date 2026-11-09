import {QUOTES} from '../quote-assets.mjs';
/** Tokens Silo names itself. A frozen, in-repo list: these get `verified:true` and a fixed name and symbol that override
 * anything written on chain. Every other mint is shown with its on-chain name and an "Unverified" marker, because anyone
 * can write any name or symbol (a fake "USDC") into token metadata. Mints are the issuers' published mainnet addresses:
 * - wSOL: the SPL Token program's native mint (identical on every cluster).
 * - USDC: Circle's Solana mint, already pinned in this repo (lib/silo/swap-referral.mjs SILO_USDC_MINT).
 * - USDT: Tether's Solana mint as listed on Tether's supported-protocols page.
 * - wXMR: the wrapped Monero mint Grainpad already uses as a quote asset (lib/quote-assets.mjs QUOTES.wXMR.mint).
 * The official GRAIN mint is added at request time from configuration (SILO_GRAIN_MINT or official_token), never from
 * the request. Display only: this list never selects a transfer, fee or payment. */
export const SILO_KNOWN_TOKENS=Object.freeze([
 Object.freeze({mint:'So11111111111111111111111111111111111111112',name:'Wrapped SOL',symbol:'wSOL',decimals:9,program:'spl',networks:Object.freeze(['mainnet-beta','devnet'])}),
 Object.freeze({mint:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',name:'USD Coin',symbol:'USDC',decimals:6,program:'spl',networks:Object.freeze(['mainnet-beta'])}),
 Object.freeze({mint:'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',name:'Tether USD',symbol:'USDT',decimals:6,program:'spl',networks:Object.freeze(['mainnet-beta'])}),
 Object.freeze({mint:QUOTES.wXMR.mint,name:'Wrapped Monero (bridge)',symbol:'wXMR',decimals:QUOTES.wXMR.decimals,program:'spl',networks:Object.freeze(['mainnet-beta'])}),
]);
export const SILO_GRAIN_TOKEN=Object.freeze({name:'GRAIN',symbol:'GRAIN'});
/** The known entry for a mint on a network, or null. GRAIN has no fixed decimals here: its mint account supplies them. */
export function siloKnownToken(mint,network,grainMint=null){
 if(network==='mainnet-beta'&&grainMint&&mint===grainMint)return {mint,...SILO_GRAIN_TOKEN,decimals:null,program:null};
 return SILO_KNOWN_TOKENS.find(token=>token.mint===mint&&token.networks.includes(network))??null;
}
/** Symbols a stranger's token might copy. An unknown mint with one of these symbols is labelled as not the official one. */
export const SILO_KNOWN_SYMBOLS=Object.freeze([...SILO_KNOWN_TOKENS.map(token=>token.symbol),'SOL',SILO_GRAIN_TOKEN.symbol]);
export function siloImitatedSymbol(symbol){
 const plain=String(symbol??'').normalize('NFKC').replace(/[^\p{L}\p{N}]/gu,'').toUpperCase();
 return plain?SILO_KNOWN_SYMBOLS.find(known=>known.toUpperCase()===plain)??null:null;
}
