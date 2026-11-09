/** Durability barrier before HTTP order creation. The supplied native-wallet controller
 * saves the handle in its encrypted backup; this helper never uses plaintext storage. */
export async function persistSiloConversionAttempt({bridge,handle,assertCurrent=()=>{}}){
 if(!bridge||bridge.network!=='mainnet'||bridge.available!==true||typeof bridge.persistRecoveryHandle!=='function'||typeof handle!=='string'||handle.length<1||handle.length>2048)throw Error('conversion-recovery-save-required');
 assertCurrent();await bridge.persistRecoveryHandle(handle);assertCurrent();return handle;
}
