'use client';
import {useSiloUnlockState} from './silo-unlock-state';
import {SiloLockedDeck,type SiloUnlockRow} from './silo-locked-deck';
import {SiloDeviceUnlockButton} from './silo-device-unlock';
/** The central unlock on Home: one passphrase field for every wallet that exists in this browser. It shows only while at least one of them is locked, and
 * each wallet keeps its own unlock path (the "needs its own passphrase" row sends the person to that wallet's own area). Nothing is stored or tracked here. */
export function SiloUnlockHome({onOpenWallet}:{onOpenWallet:(id:SiloUnlockRow['id'])=>void}){
 const {state,submit,lockGeneration}=useSiloUnlockState();
 if(!state.rows.length||state.rows.every(row=>row.status==='open'))return null;
 // `key` drops any text typed but not submitted when a lock happens.
 return <section id="silo-unlock-home" aria-label="Unlock your wallets"><SiloDeviceUnlockButton/><SiloLockedDeck key={lockGeneration} state={state} onUnlock={submit} onOpenWallet={onOpenWallet}/></section>;
}
