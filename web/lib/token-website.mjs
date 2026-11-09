import {PublicKey} from '@solana/web3.js';

// Token metadata always points to the public product, including builds on temporary hosts.
export const TOKEN_WEBSITE_ORIGIN='https://grainpad.fun';
export function canonicalTokenWebsite(mint,options){
 let address;try{address=new PublicKey(mint).toBase58();}catch{throw Error('A valid token mint is required before publishing metadata.');}
 if(typeof mint!=='string'||address!==mint)throw Error('A canonical token mint is required before publishing metadata.');
 const official=options?.official===true||(typeof options?.officialMint==='string'&&options.officialMint===address);
 return official?TOKEN_WEBSITE_ORIGIN:`${TOKEN_WEBSITE_ORIGIN}/token/${address}`;
}
export function assertCanonicalTokenWebsite(metadata,mint){
 const official=metadata?.grainpad?.declaredCreatorBuy?.quote==='wXMR';
 const website=canonicalTokenWebsite(mint,official?{official:true}:undefined);
 if(metadata?.grainpad?.mint!==mint||metadata.website!==website||metadata.external_url!==website||metadata.extensions?.website!==website)throw Error('Token website must be the grainpad page for the actual mint. Publish a fresh metadata draft.');
 return website;
}
