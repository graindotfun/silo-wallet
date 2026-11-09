/** What a new wallet holder must know before Create, stated plainly instead of a mandatory tick (Sol, 23 October 2026,
 * UX consultation Q4): self-custody, backup plus passphrase, no reset, browser storage, beta. Shown before the button on
 * every screen size; never only after creation. */
export function SiloCustodyNote({testKey=false,extra}:{testKey?:boolean;extra?:string}){
 return <div className="silo-custody" role="note">
  <ul>
   <li>{testKey?'A devnet test key for test funds only.':'Self-custody: only you hold this key.'}</li>
   <li>Your backup file and this passphrase are the only way back. Silo can&rsquo;t reset it.</li>
   <li>Clearing this browser&rsquo;s data without a backup loses the wallet.</li>
   {extra&&<li>{extra}</li>}
   <li>Beta, not externally audited. Use small amounts.</li>
  </ul>
  <details><summary>While the wallet is unlocked</summary><p>Code running on this page can use the key while the wallet is unlocked. Lock it when you are done.</p></details>
 </div>;
}
