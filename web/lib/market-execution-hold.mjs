/** Source-pinned market-execution hold for every GRAIN-affecting actor that does
 * not run inside the payments-only operator: the owner treasury buyback (Worker
 * routes), legacy buyback relay and any future SILO buyback entry point.
 * There is deliberately no environment, D1 or request override: reopening needs a
 * reviewed source change together with the global market-admission controller
 * and a separate owner go. Payments and receipt observation never call this. */
export const MARKET_EXECUTION_HELD=true;
/** Non-native routes have no connected shared admission authority. A native
 * operator GO must never silently reopen treasury or legacy relay trading. */
export const NON_NATIVE_MARKET_EXECUTION_HELD=true;
export class MarketExecutionHeld extends Error{constructor(scope){super(`Market execution is held (${scope}). Payments and receipt observation continue; no buy, sell or burn is prepared, admitted or forwarded.`);this.code='market-execution-held';this.status=423;}}
export function assertMarketExecutionAllowed(scope){
 if(typeof scope!=='string'||!scope)throw Error('Explicit market-execution scope required.');
 if(MARKET_EXECUTION_HELD||NON_NATIVE_MARKET_EXECUTION_HELD)throw new MarketExecutionHeld(scope);
}
