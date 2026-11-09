/** Exact approved PNG; change only with an explicit artwork/metadata review. */
export const OFFICIAL_ARTWORK = Object.freeze({
 path:'/brand/grain-token.png',
 sha256:'c29539e0d739b00fb16e4f05c682e525dcd39cd668e5a377020b0f159deebce2',
});
const PNG_SIGNATURE = [137,80,78,71,13,10,26,10];
export function isPng(bytes) {
 return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte,index)=>bytes[index]===byte);
}
