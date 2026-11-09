/** Foundation facts only, never route or release admission. Independent bounded
 * decoding of SPL Mint + Token-2022 TLV. No SDK permissive unpacking shortcut. */
import {Buffer} from 'buffer';
import {PublicKey} from '@solana/web3.js';
import {sha256} from '@noble/hashes/sha256';
export const SILO_CLASSIC_TOKEN_PROGRAM='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const SILO_TOKEN_2022_PROGRAM='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MAX_BYTES=4096,MAX_EXTENSIONS=16;
const names={1:'TransferFeeConfig',3:'MintCloseAuthority',4:'ConfidentialTransferMint',6:'DefaultAccountState',9:'NonTransferable',10:'InterestBearingConfig',12:'PermanentDelegate',14:'TransferHook',18:'MetadataPointer',19:'TokenMetadata',20:'GroupPointer',21:'TokenGroup',22:'GroupMemberPointer',23:'TokenGroupMember',25:'ScaledUiAmountConfig',26:'PausableConfig',28:'PermissionedBurn'};
const fixedLengths={1:108,3:32,4:65,6:1,9:0,10:52,12:32,14:64,18:64,20:64,21:80,22:64,23:72,25:56,26:33,28:32};
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const address=x=>{const key=new PublicKey(x);if(String(key)!==x)throw Error('Mint address is noncanonical.');return String(key);};
const key=b=>b.every(x=>x===0)?null:String(new PublicKey(b));
function accountBytes(info){
 if(!info||info.executable!==false||![SILO_CLASSIC_TOKEN_PROGRAM,SILO_TOKEN_2022_PROGRAM].includes(String(info.owner)))throw Error('Unsupported mint account owner or executable state.');
 let bytes;if(Buffer.isBuffer(info.data)||info.data instanceof Uint8Array)bytes=Buffer.from(info.data);else if(Array.isArray(info.data)&&info.data.length===2&&info.data[1]==='base64'&&typeof info.data[0]==='string'){if(info.data[0].length>Math.ceil(MAX_BYTES/3)*4)throw Error('Mint data exceeds bound.');bytes=Buffer.from(info.data[0],'base64');if(bytes.toString('base64')!==info.data[0])throw Error('Mint base64 differs.');}else throw Error('Mint encoding unsupported.');
 if(bytes.length<82||bytes.length>MAX_BYTES)throw Error('Mint size exceeds bounds.');return bytes;
}
function metadata(bytes,mint){
 let at=0;const take=n=>{if(n<0||at+n>bytes.length)throw Error('Truncated metadata.');const value=bytes.subarray(at,at+n);at+=n;return value;};
 const authority=key(take(32)),metadataMint=String(new PublicKey(take(32)));if(metadataMint!==mint)throw Error('Token metadata mint differs.');
 const utf8=new TextDecoder('utf-8',{fatal:true});
 const string=max=>{const count=take(4).readUInt32LE();if(count>max)throw Error('Metadata string exceeds bound.');const value=utf8.decode(take(count));if(/[\u0000-\u001f\u007f]/u.test(value))throw Error('Metadata control characters unsupported.');return value;};
 const name=string(128),symbol=string(32),uri=string(2048),count=take(4).readUInt32LE();if(count>16)throw Error('Additional metadata exceeds bound.');const additionalMetadata=[],seen=new Set();
 for(let i=0;i<count;i++){const field=string(128),value=string(256);if(seen.has(field))throw Error('Duplicate metadata field.');seen.add(field);additionalMetadata.push([field,value]);}
 if(at!==bytes.length)throw Error('Unconsumed token metadata.');return {mint:metadataMint,updateAuthority:authority,name,symbol,uri,additionalMetadata};
}
/** account must be independently read for this exact mint/program; a returned
 * policyEligible fact is not executable support, token endorsement or admission.
 * @param {{mint?:string,account?:any,expectedProgram?:string,expectedDecimals?:number,maxDecimals?:number}} options */
export function decodeSiloJupiterMintPolicy({mint,account,expectedProgram,expectedDecimals,maxDecimals=9}={}){
 if(!Number.isInteger(maxDecimals)||maxDecimals<0||maxDecimals>18)throw Error('Invalid mint decimal bound.');mint=address(mint);const bytes=accountBytes(account),program=String(account.owner);if(expectedProgram!==undefined&&program!==expectedProgram)throw Error('Mint program differs from pinned identity.');
 if(program===SILO_CLASSIC_TOKEN_PROGRAM&&bytes.length!==82)throw Error('Classic Mint must have exactly 82 bytes.');
 const mintOption=bytes.readUInt32LE(0),freezeOption=bytes.readUInt32LE(46);if(![0,1].includes(mintOption)||![0,1].includes(freezeOption)||bytes[45]!==1||bytes[44]>maxDecimals)throw Error('Invalid Mint options, initialization or decimals.');
 // COption None ignores its retained 32-byte payload; revoked classic Mints
 // commonly keep their former authority bytes. Never treat those as live keys.
 const decimals=bytes[44];if(expectedDecimals!==undefined&&decimals!==expectedDecimals)throw Error('Mint decimals differ from pinned identity.');
 const mintAuthority=mintOption?String(new PublicKey(bytes.subarray(4,36))):null,freezeAuthority=freezeOption?String(new PublicKey(bytes.subarray(50,82))):null,extensions=[],reasons=[];let pointer=null,tokenMetadata=null,transferHook=null;
 if(program===SILO_TOKEN_2022_PROGRAM&&bytes.length>82){
  if(bytes.length<=166||bytes.length===355||bytes.subarray(82,165).some(Boolean)||bytes[165]!==1)throw Error('Token-2022 Mint padding/account type differs.');
  let at=166;const seen=new Set();while(at<bytes.length){
   if(extensions.length>=MAX_EXTENSIONS||at+4>bytes.length)throw Error('TLV count/header exceeds bounds.');const type=bytes.readUInt16LE(at),length=bytes.readUInt16LE(at+2);at+=4;
   if(type===0||seen.has(type)||at+length>bytes.length)throw Error('Unknown zero, duplicate or truncated TLV.');seen.add(type);const data=bytes.subarray(at,at+length);at+=length;
   if(fixedLengths[type]!==undefined&&length!==fixedLengths[type])throw Error('Extension length differs.');
   extensions.push({type,name:names[type]??'Unknown',length,dataSha256:Buffer.from(sha256(data)).toString('hex')});
   if(type===18){pointer={authority:key(data.subarray(0,32)),metadataAddress:key(data.subarray(32,64))};if(pointer.metadataAddress!==mint)throw Error('Metadata pointer is not this Mint.');}
   else if(type===19)tokenMetadata=metadata(data,mint);
   else {if(type===14)transferHook={authority:key(data.subarray(0,32)),programId:key(data.subarray(32,64))};reasons.push(`Extension ${names[type]??type} is outside metadata-only policy.`);}
  }
  if(at!==bytes.length)throw Error('Unconsumed TLV.');if((pointer===null)!==(tokenMetadata===null))throw Error('Metadata pointer and self metadata must appear together.');
 }
 const issuerException=mint===USDC&&program===SILO_CLASSIC_TOKEN_PROGRAM&&decimals===6;
 if(!issuerException&&(mintAuthority!==null||freezeAuthority!==null))reasons.push('Mint and freeze authorities must both be revoked.');
 return freeze({mint,program,decimals,initialized:true,supplyRaw:bytes.readBigUInt64LE(36).toString(),mintAuthority,freezeAuthority,issuerException,extensions,metadataPointer:pointer,tokenMetadata,transferHook,metadataMutable:!!(pointer?.authority||tokenMetadata?.updateAuthority),metadataIdentityVerified:false,dataLength:bytes.length,dataSha256:Buffer.from(sha256(bytes)).toString('hex'),policy:'metadata-only-foundation-v1',policyEligible:reasons.length===0,reasons,admission:false,releaseAccepted:false,executableSupport:false});
}
