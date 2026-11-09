import {Buffer} from 'buffer';
import {PublicKey} from '@solana/web3.js';
import {PLATFORM_SETTINGS} from './platform-settings.mjs';
import {FEE_POLICY} from './fee-policy.mjs';
export const POLICY={program:'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',reference:'4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4',config:'6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX',cpConfig:'CRRS5ieQmBrZjWhcj99JuGrT5tyuWDaGAXLXLFjbAtjQ',protocolRate:FEE_POLICY.curve.protocol,platformRate:FEE_POLICY.curve.platform,creatorRate:FEE_POLICY.curve.creator};
export function grainpadPlatformId(){return PublicKey.findProgramAddressSync([Buffer.from('platform_config'),new PublicKey(PLATFORM_SETTINGS.admin).toBuffer()],new PublicKey(POLICY.program))[0];}
export function decodePlatform(data){
 if(data.length!==944)throw Error('Unsupported platform account layout.');
 const key=n=>new PublicKey(data.subarray(n,n+32)).toBase58(),n=at=>{const v=data.readBigUInt64LE(at);if(v>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Invalid platform value.');return Number(v);};
 return {feeWallet:key(16),lockNftWallet:key(48),platformScale:n(80),creatorScale:n(88),burnScale:n(96),platformRate:n(104),cpConfig:key(688),creatorRate:n(720),transferAuthority:key(728),vestingWallet:key(760),vestingScale:n(792),cpCreator:key(800),restrictGlobal:data[832],restrictCurve:data[833],ruleManager:key(834)};
}
/** `platformRate` defaults to the approved rate. Only the rewards setup review (before `configure`) and the
 * superseded legacy setup pass the legacy rate explicitly.
 * @param {any} p @param {{platformRate?:number}} [options] */
export function assertGrainpadPolicy(p,{platformRate=POLICY.platformRate}={}){
 if(p.feeWallet!==PLATFORM_SETTINGS.claimAuthority||p.platformRate!==platformRate||p.creatorRate!==POLICY.creatorRate||p.lockNftWallet!==PLATFORM_SETTINGS.feeKeyWallet||p.platformScale!==1000000||p.creatorScale!==0||p.burnScale!==0||p.vestingScale!==0||p.cpConfig!==POLICY.cpConfig||p.cpCreator!==PublicKey.default.toBase58()||p.transferAuthority!==PLATFORM_SETTINGS.transferAuthority||p.restrictGlobal!==1||p.restrictCurve!==1||p.ruleManager!==PublicKey.default.toBase58()||p.vestingWallet!==PLATFORM_SETTINGS.vestingWallet)throw Error('Grainpad on-chain settings differ from the published policy. Launching is disabled until reviewed.');
}
