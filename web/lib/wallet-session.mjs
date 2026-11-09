/** A connected adapter is the authority. Storage remembers only the user's provider choice. */
export function createWalletSession(){
 let snapshot=null,remove=()=>{};const listeners=new Set();
 const publish=()=>{for(const fn of listeners)fn();};
 return {
  getSnapshot:()=>snapshot,
  subscribe(fn){listeners.add(fn);return()=>{listeners.delete(fn);};},
  activate(wallet,name){
   if(!wallet.publicKey)throw Error('Wallet has no connected account.');
   const previous=snapshot;remove();if(previous?.wallet!==wallet)previous?.wallet.invalidateSession?.();
   const owner=wallet.publicKey.toBase58();snapshot={wallet,name,owner};
   const invalidated=()=>{remove();snapshot=null;publish();};
   wallet.on?.('accountChanged',invalidated);wallet.on?.('disconnect',invalidated);
   remove=()=>{wallet.removeListener?.('accountChanged',invalidated);wallet.removeListener?.('disconnect',invalidated);};
   publish();
  },
  clear(){remove();snapshot=null;publish();},
 };
}
export const walletSession=createWalletSession();
