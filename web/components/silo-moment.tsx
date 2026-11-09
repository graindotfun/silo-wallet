'use client';
import {Check} from 'lucide-react';

/** Two quiet moments in the wallet's first run (design audit mock-01 and mock-02). Display only: they read the wallet's own state, add no storage,
 * no network call and no new step; every button here only dismisses the card, scrolls to the existing backup step or goes to Home. */
export function SiloReadyMoment({walletName,network,onBackup,onLater}:{walletName:string;network:string;onBackup:()=>void;onLater:()=>void}){
 return <section className="silo-moment" aria-labelledby="silo-moment-ready" role="status">
  <span className="silo-moment-mark" aria-hidden="true"><Check size={28}/></span>
  <h3 id="silo-moment-ready">your silo is ready<span className="silo-stop" aria-hidden="true">.</span></h3>
  <p>{walletName} wallet created and encrypted on this device ({network}). Two short steps and you are set.</p>
  <ol className="silo-moment-steps">
   <li data-done="true"><strong>Create your wallet</strong><small>Done just now</small></li>
   <li><strong>Back it up</strong><small>Export the file, then verify it.</small></li>
   <li><strong>Receive your first funds</strong><small>Your address opens after the backup.</small></li>
  </ol>
  <div className="silo-moment-actions"><button type="button" className="silo-primary" onClick={onBackup}>Back up now</button><button type="button" className="silo-moment-ghost" onClick={onLater}>Look around first</button></div>
  <p className="silo-moment-note">Nothing moves until you say so.</p>
 </section>;
}

export function SiloBackedUpMoment({walletName,canShowAddress,onAddress,onHome}:{walletName:string;canShowAddress:boolean;onAddress:()=>void;onHome:()=>void}){
 return <section className="silo-moment" aria-labelledby="silo-moment-done" role="status">
  <h3 id="silo-moment-done">backed up<span className="silo-stop" aria-hidden="true">.</span></h3>
  <p>Your exported backup file opened with its passphrase on this device.{canShowAddress?' The receive address is now open.':''}</p>
  <dl className="silo-moment-rows"><div><dt>Verified</dt><dd>Opened with your passphrase ✓</dd></div><div><dt>Covers</dt><dd>{walletName}</dd></div><div><dt>Where to keep it</dt><dd>Off this device</dd></div></dl>
  <ul className="silo-moment-tips"><li>Move the file to a second place: a USB stick or a password manager attachment.</li><li>The passphrase is not in the file. Without both, nobody can restore it, including us.</li></ul>
  <div className="silo-moment-actions">{canShowAddress&&<button type="button" className="silo-primary" onClick={onAddress}>Show my receive address</button>}<button type="button" className={canShowAddress?'silo-moment-ghost':'silo-primary'} onClick={onHome}>Back to home</button></div>
 </section>;
}
