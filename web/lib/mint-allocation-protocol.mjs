import {PublicKey} from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
/** Wallet-authorized mint-only allocation. No secret or signing implementation. */
export const MINT_ALLOCATION_ORIGIN='https://grainpad.fun';
export const MINT_ALLOCATION_REVISION='grn-mint-inventory-v2';
export const MINT_ALLOCATION_PATH='/v1/mint-allocation';
export function mintAllocationMessage(p){
 return 'Grainpad mint-only address allocation\n'+JSON.stringify({revision:p.revision,origin:p.origin,action:p.action,wallet:p.wallet,mint:p.mint??null,nonce:p.nonce,issuedAt:p.issuedAt,expiresAt:p.expiresAt,encryptionKey:p.encryptionKey});
}

export function verifyMintAllocationApproval(body,now=Date.now()){
 const p=body?.payload,address=v=>typeof v==='string'&&new PublicKey(v).toBase58()===v&&PublicKey.isOnCurve(new PublicKey(v).toBytes());
 if(!p||Object.keys(body).sort().join(',')!=='payload,signature'||Object.keys(p).sort().join(',')!=='action,encryptionKey,expiresAt,issuedAt,mint,nonce,origin,revision,wallet'||p.revision!==MINT_ALLOCATION_REVISION||p.origin!==MINT_ALLOCATION_ORIGIN||!['allocate','recover'].includes(p.action)||!address(p.wallet)||!/^[a-f0-9]{64}$/.test(p.nonce)||!Number.isSafeInteger(now)||!Number.isSafeInteger(p.issuedAt)||!Number.isSafeInteger(p.expiresAt)||p.issuedAt>now+10000||p.issuedAt<now-300000||p.expiresAt<=now||p.expiresAt>p.issuedAt+300000||p.expiresAt<=p.issuedAt||p.action==='allocate'&&p.mint!==null||p.action==='recover'&&(!address(p.mint)||!p.mint.endsWith('grn'))||typeof p.encryptionKey!=='string'||p.encryptionKey.length>800||typeof body.signature!=='string'||body.signature.length>100)throw Error('Mint allocation approval is invalid or expired.');
 const signature=bs58.decode(body.signature);if(signature.length!==64||!nacl.sign.detached.verify(new TextEncoder().encode(mintAllocationMessage(p)),signature,new PublicKey(p.wallet).toBytes()))throw Error('Creator wallet must authorize mint allocation.');return p;
}
