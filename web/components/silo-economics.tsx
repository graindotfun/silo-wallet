import {SILO_REVENUE_POLICY,siloProviderSwapFeeBps} from '@/lib/silo/revenue-policy.mjs';
import {siloBuildStatus} from '@/lib/silo/disclosures.mjs';
/** `configuration` is the served configuration object; when the parent passes it, the on/off sentences below come from it. Without it
 * the section makes no claim about what is on (review F-35, UX-09). */
export function SiloEconomics({configuration}: {configuration?: unknown} = {}) {
 const status = configuration ? siloBuildStatus(configuration) : null;
 const collecting = (configuration as {swap?: {feeCollectionEnabled?: boolean}} | undefined)?.swap?.feeCollectionEnabled === true;
 return <section id="silo-economics" className="exposure-panel silo-setting">
  <header><h2>Fees</h2><p>What Silo charges, and what is not active.</p></header>
  <div className="silo-setting-body"><dl className="silo-disclosure">
   <dt>Send &amp; receive</dt><dd>No Silo fee. Network fees still apply.</dd>
   <dt>Convert and token swaps</dt><dd>Jupiter Solana swaps: {siloProviderSwapFeeBps('jupiter') / 100}%. XMR conversions through an outside exchange provider: {siloProviderSwapFeeBps('changenow') === 0 ? 'no additional Silo fee' : `${siloProviderSwapFeeBps('changenow') / 100}% Silo fee`}. Provider costs, network fees and any token transfer fees are separate and are shown in the review before you approve. {status ? `${status.convert ? 'Convert is on in this build.' : 'Convert is off in this build.'} ${status.tokenSwaps ? 'Token swaps are on.' : 'Token swaps are off in this build.'}` : 'Whether each one is on is shown where you use it.'}</dd>
   <dt>GRAIN burn and holder rewards</dt><dd>Not active. Silo sets nothing aside from its fees or from what providers pay it for a GRAIN burn or for holder rewards today. If that starts, what is set aside, where it goes and how to check it will be shown here first.</dd>
  </dl>
  <p className="exposure-note">{collecting ? 'Swap fee collection is on. Nothing is set aside for GRAIN yet.' : 'Swap fee collection is not active, and nothing is set aside for GRAIN yet.'}</p></div>
 </section>;
}
