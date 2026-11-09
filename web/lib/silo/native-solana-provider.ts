import {Buffer} from 'buffer';
import {VersionedTransaction} from '@solana/web3.js';
import {PublicKey} from '@solana/web3.js';
import type {WalletProvider,Wallet} from '@/lib/wallet';
import type {NativeKeyringSession} from './native-keyring.mjs';
/** Public-read bridge with one opaque reviewed managed ticket path. Unlock alone grants no signing permission. */
export function siloNativeSolanaProvider(session:NativeKeyringSession,unsignedOnly=false):WalletProvider {
 const info=session.metadata();if(info.chain!=='solana'||!['mainnet','devnet'].includes(info.network))throw Error('Native Solana wallet required.');
 const key=new PublicKey(info.address),listeners=new Map<string,Set<()=>void>>();
 const active=()=>{const current=session.metadata();if(current.address!==info.address||current.chain!=='solana'||current.network!==info.network)throw Error('Native wallet identity changed.');return key;};
 const notify=()=>{for(const fn of listeners.get('disconnect')??[])fn();};
 const locked=()=>{session.lock();notify();};
 const wallet:Wallet={get publicKey(){try{return active();}catch{return null;}},connect:async()=>{active();},disconnect:async()=>locked(),invalidateSession:locked,signTransaction:async(tx?:unknown)=>{active();
  // A read-only adapter signs nothing, on any network (security review of the test-network stage, part 2).
  if(unsignedOnly)throw Error('Signing is held: this read-only wallet view cannot sign.');
  // A devnet wallet signs only reviewed test-network layouts, checked inside the keyring (signTestNetworkTransaction).
  if(info.network==='devnet'&&tx instanceof VersionedTransaction)return VersionedTransaction.deserialize(Buffer.from(session.signTestNetworkTransaction(Buffer.from(tx.serialize()).toString('base64')),'base64'));
  throw Error('Native signing is held pending exact transaction-policy review.');},...(unsignedOnly?{}:{transferIdentity:()=>{active();return session.transferIdentity();},signReviewedTransferTransaction:async(tx:VersionedTransaction,ticket:unknown)=>{active();return VersionedTransaction.deserialize(Buffer.from(session.signReviewedTransfer(Buffer.from(tx.serialize()).toString('base64'),ticket),'base64'));},signReviewedManagedTransaction:async(tx:VersionedTransaction,ticket:Parameters<NonNullable<Wallet['signReviewedManagedTransaction']>>[1])=>{active();return VersionedTransaction.deserialize(Buffer.from(session.signReviewedManaged(Buffer.from(tx.serialize()).toString('base64'),ticket),'base64'));}}),signMessage:async()=>{active();throw Error('Native message signing is held pending exact review.');},on:(event,fn)=>{let set=listeners.get(event);if(!set){set=new Set();listeners.set(event,set);}set.add(fn);},removeListener:(event,fn)=>{listeners.get(event)?.delete(fn);}};
 return {name:'Silo',brand:'Silo',kind:'native',icon:null,wallet};
}
