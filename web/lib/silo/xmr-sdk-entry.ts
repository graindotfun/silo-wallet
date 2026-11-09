// Built as an isolated browser asset. Never import this entry from app/launch/trade.
import monero from 'monero-ts';
Object.defineProperty(globalThis, "GrainSiloXmrSdk", {value:monero, configurable:true});
export default monero;
