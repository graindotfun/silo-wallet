/** A new receive address is returned only after the encrypted backup that records it is saved. If saving fails, the address is
 * never shown; the wallet keeps the subaddress and the next successful save records it. */
export async function siloNewReceiveAddress(wallet,save){
 if(typeof wallet?.newReceive!=='function')throw Error('This wallet has no new receive addresses.');
 const address=await wallet.newReceive();await save();return address;
}
