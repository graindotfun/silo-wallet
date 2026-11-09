/** Local SDK address validation only; never prepares a payment or contacts a node. */
export async function validateSiloXmrRecipient(sdk,address,network){
 const types={mainnet:sdk.MoneroNetworkType.MAINNET,testnet:sdk.MoneroNetworkType.TESTNET,stagenet:sdk.MoneroNetworkType.STAGENET};
 try{await sdk.MoneroUtils.validateAddress(address,types[network]);return;}catch{/* A name is shown only if another network's checksum validation succeeds. */}
 for(const [candidate,type] of Object.entries(types)){
  if(candidate===network||type===undefined)continue;
  try{await sdk.MoneroUtils.validateAddress(address,type);}catch{continue;}
  const error=Error(`This Monero address is for ${candidate}, but this wallet is on ${network}. No payment was prepared.`);error.siloAddressCode='wrong-network';error.addressNetwork=candidate;throw error;
 }
 const error=Error('This Monero recipient address could not be verified. Check the complete address. No payment was prepared.');error.siloAddressCode='unverified';throw error;
}
