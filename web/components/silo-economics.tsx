import {SILO_REVENUE_POLICY,siloProviderSwapFeeBps} from '@/lib/silo/revenue-policy.mjs';
export function SiloEconomics() {
 return <section id="silo-economics" className="exposure-panel silo-setting">
  <header><h2>Fees</h2><p>What Silo charges, and what is not active.</p></header>
  <div className="silo-setting-body"><dl className="silo-disclosure">
   <dt>Send &amp; receive</dt><dd>No Silo fee. Network fees still apply.</dd>
   <dt>Swaps · planned</dt><dd>Jupiter Solana swaps: {siloProviderSwapFeeBps('jupiter') / 100}%. XMR conversions through an outside exchange provider: {siloProviderSwapFeeBps('changenow') === 0 ? 'no additional Silo fee' : `${siloProviderSwapFeeBps('changenow') / 100}% Silo fee`}. Provider costs, network fees and any token transfer fees are separate and will be shown in the final review. These rates do not mean execution or collection is active.</dd>
   <dt>GRAIN buybacks</dt><dd>{SILO_REVENUE_POLICY.buybackAllocationBps / 100}% of verified collected fee revenue after provider costs, execution costs and refunds is allocated to buying and burning GRAIN.</dd>
  </dl>
  <p className="exposure-note">Swap fee collection and automatic buybacks are not active yet.</p></div>
 </section>;
}
