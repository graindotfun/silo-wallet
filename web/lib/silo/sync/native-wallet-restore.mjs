// Restores a synced native wallet into the web wallet's native keyring. Kept apart from native-wallets.mjs so the vault
// validators carry no signing or transaction code.
import {restoreNativeKeyring} from '../native-keyring.mjs';
import {assertNativeSyncBackup} from './native-wallets.mjs';
/** `network` is the wallet label of the vault's profile: 'mainnet', or 'devnet' for Solana in a test-network vault. */
export async function restoreSyncedNativeWallet({client,chain,passphrase,store,signal,network='mainnet'}) {
 const trusted=async()=>{
  if(signal?.aborted||store.closed)throw Error('Native recovery was cancelled.');
  const trust=await client.trust();
  if(!trust||!['genesis','approval','recovery'].includes(trust.via)||trust.via==='recovery'&&trust.reconciled!==true)throw Error('This device is not trusted for native wallet recovery.');
  if(client.status?.status!=='synced')throw Error('Native recovery is held until sync conflicts are resolved.');
 };
 const abort=()=>store.close();signal?.addEventListener('abort',abort,{once:true});
 try {
  await client.sync();await trusted();
  const source=client.walletBackup(),payload=assertNativeSyncBackup(source.schema==='silo-sync-combined-wallets-v1'?{schema:'silo-sync-native-public-v1',wallets:source.wallets}:source,{network}),envelope=payload.wallets.find(e=>e.chain===chain);
  if(!envelope)throw Error('No synced native wallet for this chain.');
  const guarded={get closed(){return store.closed===true||signal?.aborted===true;},read:()=>store.read(),close:()=>store.close(),onClose:listener=>store.onClose?.(listener),create:async value=>{await client.sync();await trusted();return store.create(value);}};
  // GCM/identity validation occurs before durable no-overwrite installation; recheck trust after KDF.
  const restored=await restoreNativeKeyring({chain,backup:envelope,passphrase,store:guarded,network});
  if(signal?.aborted){restored.lock();throw Error('Native recovery was cancelled.');}
  return restored;
 }finally{signal?.removeEventListener('abort',abort);}
}
