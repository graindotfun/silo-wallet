/** Entry to grainpet from the site nav. It reuses the existing wallet chooser (event grainpad-open-wallet) and the one wallet session:
 *  connected -> go to /pet/; not connected -> open the chooser and continue by itself once an eligible wallet is connected. */
export const GRAINPET_PATH='/pet/';
/** Wallets that have a grainpet identity: Solana mainnet and Robinhood Chain mainnet. */
export const grainpetEligible=s=>Boolean(s)&&((s.family==='solana'&&s.networkId==='solana:mainnet-beta')||(s.family==='evm'&&s.networkId==='robinhood:mainnet'));
export function createGrainpetEntry({session,open,go}){
 let off=null;
 const cancel=()=>{off?.();off=null;};
 return {
  cancel,
  pending:()=>off!==null,
  enter(){
   if(grainpetEligible(session.getSnapshot())){cancel();go(GRAINPET_PATH);return;}
   cancel();
   off=session.subscribe(()=>{if(grainpetEligible(session.getSnapshot())){cancel();go(GRAINPET_PATH);}});
   open();
  },
 };
}
/** The same identity string the server derives. The server re-derives and compares it; a mismatch is refused. */
export const grainpetIdentityOf=s=>grainpetEligible(s)?`${s.family}:${s.networkId}:${s.family==='evm'?s.owner.toLowerCase():s.owner}`:null;
