'use client';
import {useSiloSharedPassphrase,type SiloOneUnlockZone} from './silo-shared-passphrase';
import type {SiloUnlockRow,SiloUnlockState,SiloUnlockStatus} from './silo-locked-deck';
import {ONE_UNLOCK_MESSAGES} from '@/lib/silo/one-unlock.mjs';
/** The contract the Locked screen renders (components/silo-locked-deck.tsx), produced from the one-unlock state (lib/silo/one-unlock.mjs).
 * One row per wallet that exists in this browser; the EVM row is one key for Ethereum, Base and BNB. `wrong` is true only for the single
 * "nothing opened" message (it never names a wallet); `busy` is true while any wallet is opening. No passphrase is stored here. */
const ROWS:Record<SiloOneUnlockZone,Omit<SiloUnlockRow,'status'>>={
 solana:{id:'solana',asset:'sol',name:'Solana'},
 evm:{id:'evm',asset:'evm',name:'Ethereum, Base and BNB'},
 btc:{id:'btc',asset:'btc',name:'Bitcoin (test network)'},
 xmr:{id:'xmr',asset:'xmr',name:'Monero'},
};
const STATUS:Record<string,SiloUnlockStatus>={locked:'locked',opening:'opening',open:'open','needs-own':'own-passphrase','other-tab':'other-tab'};
export function useSiloUnlockState():{state:SiloUnlockState;submit:(passphrase:string)=>void;lockGeneration:number}{
 const shared=useSiloSharedPassphrase();
 const rows=(['solana','evm','btc','xmr'] as SiloOneUnlockZone[]).filter(zone=>shared.unlock.statuses[zone]!==undefined).map(zone=>({...ROWS[zone],status:STATUS[shared.unlock.statuses[zone] as string]??'locked'}) as SiloUnlockRow);
 return {state:{rows,busy:rows.some(row=>row.status==='opening'),wrong:shared.unlock.message===ONE_UNLOCK_MESSAGES.wrong},submit:passphrase=>{shared.unlock.submit(passphrase);},lockGeneration:shared.lockGeneration};
}
