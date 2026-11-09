/** Prepare only a local receiving destination. No exchange API, order, signer or broadcaster is used. */
export async function siloPrepareExchangeAddress(wallet,save,allowed){
 if(typeof allowed!=='function'||allowed()!==true)throw Error('External handoff is unavailable.');
 if(typeof wallet?.newExchangeReceive!=='function'||typeof save!=='function')throw Error('Separate exchange receiving is unavailable.');
 const address=await wallet.newExchangeReceive();
 if(allowed()!==true)throw Error('Wallet state changed before saving.');
 await save();
 if(allowed()!==true)throw Error('Wallet state changed after saving.');
 return address;
}
