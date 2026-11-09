/** Public constants only: safe to load before browser crypto libraries. */
export const QUOTES=Object.freeze({
 SOL:Object.freeze({symbol:'SOL',mint:'So11111111111111111111111111111111111111112',config:'6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX',decimals:9,floor:'85000000000',target:'85',native:true}),
 wXMR:Object.freeze({symbol:'wXMR',mint:'WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp',config:'GC1ZWMKnnPBGmTkoNNKnR17SbqZwMN9coSWgW3UH5JSr',decimals:12,floor:'20000000000000',target:'20',native:false}),
});
export const WXMR_WARNING='wXMR is a wrapped token issued by wxmr.io, a third party. It is not XMR, and grainpad does not operate it. Check the issuer’s own information before you use it.';
export function quoteAsset(symbol='SOL'){const q=QUOTES[symbol];if(!q)throw Error('Unsupported quote asset. Choose SOL or wXMR.');return q;}
export function quoteByMint(mint){const q=Object.values(QUOTES).find(q=>q.mint===String(mint));if(!q)throw Error('Unsupported quote mint.');return q;}
/** Parse decimal text directly into u64 base units; never pass through Number. */
export function parseTokenUnits(text,decimals,{allowZero=false}={}){
 if(!Number.isInteger(decimals)||decimals<0||decimals>18||typeof text!=='string'||!new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${decimals}})?$`).test(text))throw Error(`Use an amount with up to ${decimals} decimal places.`);
 const [whole,fraction='']=text.split('.'),n=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0'));
 if(n>(1n<<64n)-1n||(!allowZero&&n===0n))throw Error('Amount is outside the supported range.');return n;
}
