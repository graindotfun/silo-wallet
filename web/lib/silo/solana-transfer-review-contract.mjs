/** Pure exact unsigned transfer review contract. A valid shape is not server
 * authentication or signing permission; those remain separate boundaries. */
import {Buffer} from 'buffer';
import {sha256} from '@noble/hashes/sha256';
import {VersionedTransaction} from '@solana/web3.js';
import {canonical} from './sync/codec.mjs';
import {inspectSiloTransfer,SILO_SOLANA_GENESIS} from './solana-transfer.mjs';
const DOMAIN='silo-native-transfer-review-v1',MAX=12000;
const fail=()=>{throw Error('Transfer server review is missing, expired or changed.');};
const hash=bytes=>Buffer.from(sha256(bytes)).toString('hex');
const fields=['protocol','origin','accountBinding','sourceFingerprint','runtimeFingerprint','genesis','messageHash','terms','issuer','availableLamports','availableTokenRaw','transactionBase64','networkFeeRaw','rentRaw','lastValidBlockHeight','checkedAt','expiresAt'];
const fingerprint=x=>{if(typeof x!=='string'||! /^[a-f0-9]{64}$/.test(x))fail();};
const raw=x=>{if(typeof x!=='string'||! /^(0|[1-9][0-9]{0,19})$/.test(x)||BigInt(x)>18446744073709551615n)fail();return BigInt(x);};
export function siloTransferReviewClaims(review){
 if(!review||typeof review!=='object'||Array.isArray(review)||Object.keys(review).some(k=>!fields.includes(k)&&k!=='reviewSeal')||fields.some(k=>!Object.hasOwn(review,k)))fail();
 if(Buffer.byteLength(JSON.stringify(review))>MAX||review.protocol!==DOMAIN||review.origin!=='https://silo.trading')fail();
 fingerprint(review.accountBinding);fingerprint(review.sourceFingerprint);fingerprint(review.runtimeFingerprint);fingerprint(review.messageHash);
 if(review.terms?.network!=='mainnet-beta'||review.genesis!==SILO_SOLANA_GENESIS['mainnet-beta']||typeof review.transactionBase64!=='string'||review.transactionBase64.length>1644)fail();
 const wire=Buffer.from(review.transactionBase64,'base64');if(wire.toString('base64')!==review.transactionBase64||wire.length>1232)fail();
 const tx=VersionedTransaction.deserialize(wire),inspected=inspectSiloTransfer(tx,{network:'mainnet-beta'});
 if(canonical(inspected.terms)!==canonical(review.terms)||hash(tx.message.serialize())!==review.messageHash)fail();
 if(!Number.isSafeInteger(review.checkedAt)||review.checkedAt<0||!Number.isSafeInteger(review.expiresAt)||review.expiresAt!==review.checkedAt+30000||!Number.isSafeInteger(review.lastValidBlockHeight)||review.lastValidBlockHeight<1)fail();
 if(raw(review.networkFeeRaw)>10000000n||raw(review.rentRaw)>10000000n)fail();raw(review.availableLamports);
 if(review.terms.mint){raw(review.availableTokenRaw);if(!review.issuer||Object.keys(review.issuer).sort().join('|')!=='freezeAuthority|permanentDelegate'||Object.values(review.issuer).some(v=>typeof v!=='boolean'))fail();}
 else if(review.issuer!==null||review.availableTokenRaw!==null)fail();
 const unsigned={...review};delete unsigned.reviewSeal;return {text:canonical({domain:DOMAIN,review:unsigned}),tx};
}
export function validateSiloSealedTransferReview(review){const result=siloTransferReviewClaims(review);if(typeof review.reviewSeal!=='string'||! /^silo-native-transfer-review-v1\.[a-f0-9]{64}$/.test(review.reviewSeal))fail();return result;}
