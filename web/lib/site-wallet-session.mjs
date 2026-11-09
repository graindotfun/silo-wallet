import {walletSession} from './wallet-session.mjs';
import {cancelWalletConnections} from './wallet-connection-intent.mjs';

const account=value=>{if(typeof value!=='string'||!/^0x[0-9a-f]{40}$/i.test(value))throw Error('Wallet returned an invalid account.');return value.toLowerCase();};
const chain=value=>{if(typeof value!=='string'||!/^0x[0-9a-f]+$/i.test(value))throw Error('Wallet returned an invalid network.');const id=Number(BigInt(value));if(!Number.isSafeInteger(id)||id<=0)throw Error('Wallet returned an invalid network.');return id;};
export const walletNetworkLabel=id=>id===4663?'Robinhood Chain':id===1?'Ethereum':`EVM chain ${id}`;

/** One active wallet family. Provider events invalidate consumers synchronously; storage is never an account authority. */
export function createSiteWalletSession(solana){
 let snapshot=null,remove=()=>{},switching=false,revision=0;const listeners=new Set();
 const remember=(family,name)=>{try{sessionStorage.setItem('grainpad-wallet-family',family);if(family==='evm')sessionStorage.setItem('grainpad-evm-wallet-provider',name);}catch{}};
 const publish=()=>{revision++;for(const fn of listeners)fn();};
 const clear=()=>{remove();remove=()=>{};snapshot=null;try{for(const key of ['grainpad-wallet-family','grainpad-evm-wallet-provider','grainpad-wallet-provider'])sessionStorage.removeItem(key);}catch{}publish();};
 const syncSolana=()=>{if(switching)return;const s=solana.getSnapshot();if(s){remove();remove=()=>{};snapshot={family:'solana',networkId:'solana:mainnet-beta',name:s.name,owner:s.owner,wallet:s.wallet};remember('solana',s.name);publish();}else if(snapshot?.family==='solana')clear();};
 solana.subscribe(syncSolana);syncSolana();
 return {
  getSnapshot:()=>snapshot,
  getRevision:()=>revision,
  invalidateRestore(){revision++;cancelWalletConnections();},
  subscribe(fn){listeners.add(fn);return()=>{listeners.delete(fn);};},
  activateEvm(session,name){
   account(session.account);if(!Number.isSafeInteger(session.chainId)||session.chainId<=0||typeof session.provider?.request!=='function')throw Error('Invalid EVM connection.');
   cancelWalletConnections();switching=true;try{solana.clear();}finally{switching=false;}remove();
   let active=true;const provider=session.provider;
   const update=next=>{snapshot={family:'evm',networkId:next.chainId===4663?'robinhood:mainnet':`evm:${next.chainId}`,name,owner:account(next.account),session:next};publish();};
   const disconnect=()=>{if(active)clear();};
   const accountsChanged=accounts=>{if(!active)return;try{if(!Array.isArray(accounts)||!accounts.length)return disconnect();update({...snapshot.session,account:account(accounts[0])});}catch{disconnect();}};
   const chainChanged=value=>{if(!active)return;try{const chainId=chain(value);update({...snapshot.session,chainId,networkId:chainId===4663?'robinhood:mainnet':`evm:${chainId}`});}catch{disconnect();}};
   provider.on?.('accountsChanged',accountsChanged);provider.on?.('chainChanged',chainChanged);provider.on?.('disconnect',disconnect);
   remove=()=>{active=false;provider.removeListener?.('accountsChanged',accountsChanged);provider.removeListener?.('chainChanged',chainChanged);provider.removeListener?.('disconnect',disconnect);};
   remember('evm',name);update(session.account===account(session.account)?session:{...session,account:account(session.account)});
  },
  clear(){cancelWalletConnections();if(snapshot?.family==='solana')solana.clear();else clear();},
 };
}
export const siteWalletSession=createSiteWalletSession(walletSession);

/** Opens a chooser only. Connecting, switching networks and signing require separate user actions. */
export function openSiteWallet(network='solana'){if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('grainpad-open-wallet',{detail:{network:network==='robinhood'?'robinhood':'solana'}}));}
