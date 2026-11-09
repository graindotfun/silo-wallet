/** Retirement guard shared by the UI and offline identity-change regressions. */
export function siloConversionIdentity({publicAddress,nativeNetwork,nativeAddress}){
 return JSON.stringify([publicAddress??null,nativeNetwork??null,nativeAddress??null]);
}
export function assertSiloConversionIdentity(current,expected){if(current!==expected)throw Error('conversion-wallet-identity-changed');}
