import {siteWalletSession} from './site-wallet-session.mjs';
import {discoverEvmWalletAdapters,connectEvmWallet,type EvmDiscoveredWallet} from './chain/evm-wallet-adapter.ts';
import {ROBINHOOD_CHAIN_MAINNET as rh} from './chain/robinhood-mainnet.ts';
import {restoreWalletSession,disconnectWalletSession} from './wallet';
const network={chainId:rh.chainId,name:rh.chainName,nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18 as const},publicRpcUrl:rh.rpcUrl,explorerUrl:rh.blockExplorerUrl,executable:true};
export {discoverEvmWalletAdapters};
export async function connectSiteEvmWallet(choice:EvmDiscoveredWallet){const active=await connectEvmWallet(choice.provider,network,true);return {...active,networkId:'robinhood:mainnet' as const,chainId:4663 as const};}
let restoring:Promise<void>|null=null;
/** Restore only the chosen provider, through non-prompting account/network reads. Never switch a network silently. */
export function restoreSiteWallet(){
 if(restoring||siteWalletSession.getSnapshot())return restoring??Promise.resolve();
 const revision=siteWalletSession.getRevision();
 restoring=(async()=>{
  let family='',name='';try{family=sessionStorage.getItem('grainpad-wallet-family')??'';name=sessionStorage.getItem('grainpad-evm-wallet-provider')??'';}catch{}
  if(family!=='evm'){await restoreWalletSession();return;}if(!name)return;
  const choice=(await discoverEvmWalletAdapters()).find(row=>row.name===name);if(!choice)return;
  const accounts=await choice.provider.request({method:'eth_accounts'}),rawChain=await choice.provider.request({method:'eth_chainId'});
  if(siteWalletSession.getRevision()!==revision||siteWalletSession.getSnapshot()||!Array.isArray(accounts)||typeof accounts[0]!=='string'||!/^0x[0-9a-f]{40}$/i.test(accounts[0])||typeof rawChain!=='string'||!/^0x[0-9a-f]+$/i.test(rawChain))return;
  const chainId=Number(BigInt(rawChain));if(!Number.isSafeInteger(chainId)||chainId<=0)return;
  siteWalletSession.activateEvm({provider:choice.provider,account:accounts[0].toLowerCase(),chainId,networkId:chainId===4663?'robinhood:mainnet':`evm:${chainId}`},choice.name);
 })().catch(()=>{}).finally(()=>{restoring=null;});return restoring;
}
export async function disconnectSiteWallet(){siteWalletSession.invalidateRestore();if(siteWalletSession.getSnapshot()?.family==='solana')await disconnectWalletSession();else siteWalletSession.clear();}
