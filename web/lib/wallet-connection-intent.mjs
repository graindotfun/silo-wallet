// Cancel adapter activation, including its connect event, before a stale prompt resolves.
let revision=0;
const pending=new Set();
export const walletIntentRevision=()=>revision;
export function cancelWalletConnections(){revision++;for(const wallet of pending)wallet.invalidateSession?.();pending.clear();}
export async function connectWalletWithIntent(wallet,options){
 const intent=revision;pending.add(wallet);
 try{const result=await wallet.connect(options);if(intent!==revision)throw Error('Connection canceled. Choose your wallet again.');return result;}
 finally{pending.delete(wallet);}
}
