'use client';
import {SiloAccountPanel,type SiloProductAccount} from './silo-account-panel';
import {SiloInlineAccountUnlock} from './silo-inline-account-unlock';
import type {NativeChain} from '@/lib/silo/native-keyring.mjs';
import {useCallback,useEffect,useRef,useState} from 'react';
import {SiloNativeZone,type SiloBalanceState} from './silo-native-zone';
import {SiloAtomicPanel,type SiloAtomicNativeBridge} from './silo-atomic-panel';
import {SiloConversionPanel,type SiloConversionNativeBridge,type SiloConversionDeposit} from './silo-conversion-panel';
import {SiloConversionSolanaDeposit} from './silo-conversion-solana-deposit';
import {SiloSwapPanel} from './silo-swap-panel';
import {SiloOverview,type SiloXmrHistoryRow} from './silo-overview';
import {SiloHiddenAmount} from './silo-balance-visibility';
import {SiloEconomics} from './silo-economics';
import {SiloBtcZone} from './silo-btc-zone';
import {SiloSolanaActivity,type SiloActivityPage} from './silo-solana-activity';
import {SiloSolanaTransfer} from './silo-solana-transfer';
import {SiloDevnetTrade} from './silo-devnet-trade';
import {SiloReceiveAddress} from './silo-receive-address';
import {SiloNativePublicWallet,type SiloNativeSession} from './silo-native-public-wallet';
import {SiloEvmZone,type SiloEvmChainStatus,type SiloEvmReport} from './silo-evm-zone';
import {siloEvmChainStatus} from '@/lib/silo/evm.mjs';
import {SiloAssetIcon} from './silo-asset-icon';
import {SiloPriceChart,SiloGrainPanel} from './silo-price';
import {SiloTokenList,useSiloTokens} from './silo-tokens';
import {siloDisclosure} from '@/lib/silo/disclosures.mjs';
import {siloUnits} from '@/lib/silo/amounts.mjs';
import {assertSiloNativeTransferAccepted} from '@/lib/silo/solana-transfer-acceptance.mjs';
import {siloNativeSolanaProvider} from '@/lib/silo/native-solana-provider';
import {SILO_TEST_NETWORK_SIGNING_BUILD} from '@/lib/silo/native-keyring-testnet.mjs';
import type {WalletProvider} from '@/lib/wallet';
import {SiloAccountSigningProvider} from './silo-account-signing';
import {SiloBackupPartsProvider} from './silo-backup-parts';
import {SiloSharedPassphraseProvider} from './silo-shared-passphrase';
import {SiloBetaGate,useSiloBetaLive,type SiloBeta} from './silo-beta';
import {SiloGrainy} from './silo-grainy';
import {accountSigning,localBetaSigning} from '@/lib/silo/sync/signing-gate.mjs';
import type {SILO_PAYMENT_AUTHORITIES} from '@/lib/silo/payment-authority.mjs';
type PaymentAuthority=(typeof SILO_PAYMENT_AUTHORITIES)[number];
import {solanaStartMarkerFromActivity} from '@/lib/silo/sync/vault-identity.mjs';
import {sessionRpcFetch} from '@/lib/browser-rpc-session.mjs';
import {siloJson} from '@/lib/silo/bounded-json.mjs';
import {readSiloAutoReads,writeSiloAutoReads,SILO_AUTO_READS_NOTICE} from '@/lib/silo/auto-reads.mjs';
type Configuration={btc?:{enabled:boolean;sendEnabled:boolean;network:'signet'|'testnet'|'mainnet';capSats:number};trialRelease?:{ready:boolean};beta?:SiloBeta;solana?:{network:'mainnet-beta'|'devnet';activityEnabled?:boolean;transfersEnabled:boolean};devnetTrading?:{enabled:boolean};swap?:{quotesEnabled:boolean;feeBps:number;executionEnabled:boolean;privateTrial?:boolean;trialSlippageBps?:number;trialState?:string};getXmr?:{enabled:boolean};crosschain?:{executionEnabled:boolean;executionReasons?:string[]};atomic?:{executionEnabled:boolean;executionReasons?:string[];network:'mainnet'|'devnet';programId:string|null;capXmr?:string};flags:{fieldScan:boolean;silo:boolean;xmr:boolean;zec:boolean};mode:string;reviewedOrigin:string|null;release:{ready:boolean;reasons:string[]};xmrNode:string;zecNode:string;nativeAllowed:boolean};
type PublicReport={network:'mainnet-beta'|'devnet';address:string;lamports:string|null;holdings:{mint:string;amount:string;decimals:number}[];coverage:string};
export function SiloWorkspace({configuration:config,publicReadEnabled=true,launchpad='',evmChains,previewEnabled=false,accountEnabled=false,accountNewWalletEnabled=false,paymentAuthority='held'}:{paymentAuthority?:PaymentAuthority;accountNewWalletEnabled?:boolean;accountEnabled?:boolean;configuration:Configuration;publicReadEnabled?:boolean;launchpad?:string;evmChains?:SiloEvmChainStatus[];previewEnabled?:boolean}){
 const account=useRef<SiloProductAccount|null>(null);
 const [accountUnlocked,setAccountUnlocked]=useState(false),[accountController,setAccountController]=useState<SiloProductAccount|null>(null),[accountState,setAccountState]=useState<ReturnType<SiloProductAccount['snapshot']>|null>(null);
 const accountWatch=useRef<(()=>void)|null>(null);
 const resumeWatch=useRef<(()=>void)|null>(null),xmrIdentity=useRef<{primaryAddress:string;restoreHeight:number}|null>(null);
 // After each unlock: this device's readers are attached and its account records finished from its own saved journals.
 const onAccount=useCallback((controller:SiloProductAccount|null)=>{accountWatch.current?.();resumeWatch.current?.();resumeWatch.current=null;account.current=controller;setAccountController(controller);setAccountState(null);setAccountUnlocked(false);accountWatch.current=controller?.subscribe((value:ReturnType<SiloProductAccount['snapshot']>)=>{setAccountState(value);setAccountUnlocked(value.authenticated&&value.vaultUnlocked&&value.phase==='synced');})??null;if(!controller)return;
  attachVerifiers(controller);let resumed=false;resumeWatch.current=controller.subscribe((state:{vaultUnlocked:boolean;phase:string;busy:boolean})=>{if(!state.vaultUnlocked){resumed=false;return;}if(['synced','recovery-held'].includes(state.phase)&&!state.busy&&!resumed){resumed=true;void controller.resumeSigning(resumeSources()).catch(()=>{});}});},[]);
 const privateNativeReview=accountNewWalletEnabled&&accountUnlocked,accountPrerequisite=accountNewWalletEnabled&&accountState?.authenticated===true&&accountState.vaultUnlocked!==true;
 type XmrSession={pendingRecord:()=>unknown};
 const xmrSession=useRef<XmrSession|null>(null);
 // The server's own single activation gate (siloConfiguration().crosschain). Quotes and orders are both refused server-side unless it is true, so the panel mirrors it exactly; anything but a literal true stays held.
 const crosschainEnabled=config.crosschain?.executionEnabled===true;
 // Server-computed gate for "Swap XMR to SOL, no bridge (beta)" (siloConfiguration().atomic); anything but a literal true keeps it hidden.
 const atomicEnabled=config.atomic?.executionEnabled===true&&typeof config.atomic.programId==='string';
 const [atomicBridge,setAtomicBridge]=useState<SiloAtomicNativeBridge|null>(null);
 const onAtomicBridge=useCallback((bridge:SiloAtomicNativeBridge|null)=>setAtomicBridge(bridge),[]);
 const [conversionBridge,setConversionBridge]=useState<SiloConversionNativeBridge|null>(null);
 const onConversionBridge=useCallback((bridge:SiloConversionNativeBridge|null)=>setConversionBridge(bridge),[]);
 const [prepareSolanaDeposit,setPrepareSolanaDeposit]=useState<((request:SiloConversionDeposit)=>Promise<void>)|null>(null);
 const onSolanaDepositBridge=useCallback((prepare:((request:SiloConversionDeposit)=>Promise<void>)|null)=>setPrepareSolanaDeposit(typeof prepare==='function'?()=>prepare:null),[]);
 // This device's own outcome and history readers (browser-verifiers.mjs via the controller); Monero only while its wallet is open.
 function attachVerifiers(controller:SiloProductAccount){try{controller.attachDeviceReaders({xmrSession:xmrSession.current});}catch{/* Without readers every operation and recovery stays held. */}}
 const resumeSources=()=>({transferStorage:localStorage,swapStorage:localStorage,xmrPending:()=>{try{return xmrSession.current?.pendingRecord()??null;}catch{return null;}}});
 // Every signing window reads this when it opens. Account policy: the unlocked, synced, trusted vault. Local-beta policy (the
 // closed beta without account sync, review N1): this device's journals and locks, admitted by the server routes. Held: refuses.
 const signing=useCallback(()=>paymentAuthority==='local-beta'?localBetaSigning():accountSigning({required:true,gate:account.current?.signingGate()??null}),[paymentAuthority]);
 // What a new account vault records: the Solana start marker (from the existing anchored activity read) and the open
 // mainnet Monero wallet's primary address and restore height, if one is open. Public identifiers only.
 // Test-network account vaults (owner decision Q2) only on a site in test mode with Solana on devnet; mainnet otherwise.
 const accountNetworkProfile=config.mode!=='mainnet'&&config.solana?.network==='devnet'?'test-networks':'mainnet';
 const vaultIdentity=useCallback(async({solanaOwner,network='mainnet-beta'}:{solanaOwner:string|null;network?:string})=>{
  let solanaStartMarker=null;
  if(solanaOwner){const response=await sessionRpcFetch(`/api/silo/solana/activity?network=${network==='devnet'?'devnet':'mainnet-beta'}`,{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({owner:solanaOwner}),signal:AbortSignal.timeout(21000)});const body=await siloJson(response,256*1024);if(!response.ok)throw Error('Solana history start unavailable.');solanaStartMarker=solanaStartMarkerFromActivity(body,solanaOwner);}
  const xmr=xmrIdentity.current;return {solanaStartMarker,xmrWallet:xmr?.primaryAddress??null,xmrBirthday:xmr?.restoreHeight??null};
 },[]);
 const onXmrIdentity=useCallback((identity:{primaryAddress:string;restoreHeight:number}|null)=>{xmrIdentity.current=identity;},[]);
 // The open mainnet Monero wallet is this device's Monero reader; when it opens, settle what it can now prove.
 const onXmrSession=useCallback((session:unknown)=>{xmrSession.current=session as XmrSession|null;const controller=account.current;if(!controller)return;attachVerifiers(controller);if(session&&controller.snapshot().vaultUnlocked)void controller.resumeSigning(resumeSources()).catch(()=>{});},[]);
 const getAccountBackup=useCallback(async(chain:NativeChain)=>{if(!account.current)throw Error('Account unavailable.');return account.current.nativeEncryptedBackup(chain);},[]);
 const solanaNetwork=config.solana?.network??'mainnet-beta';
 // Closed beta: the live pause state and this browser's invitation, polled every minute (owner decisions, 21 October 2026).
 const betaLive=useSiloBetaLive(config.beta);
 const previewOnly=previewEnabled===true&&publicReadEnabled;
 const [publicReport,setPublicReport]=useState<PublicReport|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[providerName,setProviderName]=useState(''),[connectedProvider,setConnectedProvider]=useState<WalletProvider|null>(null);
 // Silo's own Solana wallet. Its address is used only after its backup gate clears, and only for mainnet reads.
 const nativeSession=useRef<SiloNativeSession|null>(null);
 const [nativeSolana,setNativeSolana]=useState<string|null>(null),[solanaReceive,setSolanaReceive]=useState(false),[nativePreviewReady,setNativePreviewReady]=useState(false),[nativeSwapProvider,setNativeSwapProvider]=useState<WalletProvider|null>(null);
 // Test networks (V1 test-network stage): in test mode with Solana on devnet, the Silo wallet holds a devnet-labelled key; it
 // signs only reviewed devnet layouts (native-keyring signTestNetworkTransaction). Mainnet release conditions are unchanged.
 // Also a build capability: a production build resolves the test-network module to its held stand-in, so this is false there
 // whatever the runtime configuration says (security review of the test-network stage, part 2; owner decision, 21 October 2026).
 const testNetworkSolana=SILO_TEST_NETWORK_SIGNING_BUILD&&config.mode!=='mainnet'&&solanaNetwork==='devnet';
 const nativeHeld=!config.release.ready,privateTrialReady=config.swap?.privateTrial===true&&config.trialRelease?.ready===true,solanaKeyringPermitted=!nativeHeld||privateTrialReady||testNetworkSolana,nativeOwner=(solanaNetwork==='mainnet-beta'||testNetworkSolana)&&(solanaReceive||previewOnly&&privateNativeReview&&nativePreviewReady)?nativeSolana:null;
 const transferPolicyReady=(()=>{try{assertSiloNativeTransferAccepted();return true;}catch{return false;}})(),transfersReady=transferPolicyReady&&config.release.ready&&config.solana?.transfersEnabled===true&&config.reviewedOrigin==='https://silo.trading'&&solanaNetwork==='mainnet-beta'&&!privateTrialReady&&!previewOnly&&publicReadEnabled&&!!nativeOwner&&solanaReceive&&(paymentAuthority==='account'?accountUnlocked:paymentAuthority==='local-beta');
 // Test networks (V1 test-network stage): the devnet send rehearsal and devnet trading use the Silo wallet's own key; no mainnet release condition applies, and none is implied.
 const devnetReady=solanaNetwork==='devnet'&&!previewOnly&&publicReadEnabled&&!!nativeOwner&&solanaReceive,devnetSendReady=devnetReady&&config.solana?.transfersEnabled===true,devnetTradeReady=devnetReady&&config.devnetTrading?.enabled===true;
 const [xmr,setXmr]=useState<SiloBalanceState>({amount:null,coverage:'not checked',opened:false}),[zec]=useState<SiloBalanceState>({amount:null,coverage:'not checked',opened:false});
 const [activityPage,setActivityPage]=useState<SiloActivityPage|null>(null),[xmrHistory,setXmrHistory]=useState<SiloXmrHistoryRow[]|null>(null);
 const onXmrHistory=useCallback((rows:SiloXmrHistoryRow[]|null)=>setXmrHistory(rows),[]);
 const onActivity=useCallback((page:SiloActivityPage|null)=>setActivityPage(page),[]);
 const [evm,setEvm]=useState<SiloEvmReport|null>(null);
 // Without server configuration every chain is listed as not configured, and no address is sent.
 const evmStatus=evmChains??siloEvmChainStatus({}) as SiloEvmChainStatus[];
 const [solNeedsBackup,setSolNeedsBackup]=useState(false);
 const onXmr=useCallback((state:SiloBalanceState)=>setXmr(state),[]);
 const remove=useRef<(()=>void)|null>(null),providerRef=useRef<WalletProvider|null>(null),publicEpoch=useRef(0);
 useEffect(()=>{const epoch=publicEpoch,watch=remove;return()=>{epoch.current++;watch.current?.();};},[]);
 // Retire public state and in-flight reads when the selected network changes.
 // eslint-disable-next-line react-hooks/set-state-in-effect
 useEffect(()=>{publicEpoch.current++;remove.current?.();remove.current=null;providerRef.current=null;setConnectedProvider(null);setPublicReport(null);setActivityPage(null);setProviderName('');setBusy(false);},[solanaNetwork]);
 // Public balance reads take a provider; the held-signer adapter for the native session supplies it. No external wallet is discovered.
 async function connect(provider:WalletProvider,automatic=false){if(busy)return;const operation=++publicEpoch.current;setBusy(true);setError('');
  // An automatic read stops before its next request once the choice is withdrawn or the page is hidden (Sol, baf30097, M1).
  const controller=new AbortController();readAbort.current?.abort();readAbort.current=controller;
  const current=()=>{if(operation!==publicEpoch.current||automatic&&(autoReadsRef.current!==true||document.visibilityState==='hidden'))throw Error('Automatic read withdrawn.');};
  try{const [{readSiloPublicZone},{watchWalletIdentity}]=await Promise.all([import('@/lib/silo/public-zone'),import('@/lib/wallet')]);const data=await readSiloPublicZone(provider,solanaNetwork,{signal:controller.signal,assertCurrent:current});if(operation!==publicEpoch.current||data.network!==solanaNetwork)return;remove.current?.();providerRef.current=provider;setConnectedProvider(provider);remove.current=watchWalletIdentity(provider.wallet,()=>{publicEpoch.current++;providerRef.current=null;setConnectedProvider(null);setProviderName('');setPublicReport(null);setActivityPage(null);setBusy(false);setError('Wallet changed or disconnected. Public balances and swap quotes were cleared.');});setProviderName(provider.name);setPublicReport(data);}catch{if(operation===publicEpoch.current){providerRef.current=null;setConnectedProvider(null);setProviderName('');setPublicReport(null);setActivityPage(null);setError('Public balances were not checked. No transaction signature was requested.');}}finally{if(operation===publicEpoch.current)setBusy(false);if(readAbort.current===controller)readAbort.current=null;}}
 function clearNativePublicContext(){publicEpoch.current++;remove.current?.();remove.current=null;providerRef.current=null;setConnectedProvider(null);setPublicReport(null);setActivityPage(null);setProviderName('');setBusy(false);setNativeSwapProvider(null);setSolanaReceive(false);setNativePreviewReady(false);}
 function onNativeSolana(session:SiloNativeSession|null){clearNativePublicContext();nativeSession.current=session;setNativeSolana(session?session.metadata().address:null);}
 function onNativeReceiveReady(ready:boolean){const active=nativeSession.current;if(!ready||!active||!solanaKeyringPermitted||!(solanaNetwork==='mainnet-beta'||testNetworkSolana)||active.metadata().network!==(testNetworkSolana?'devnet':'mainnet')){clearNativePublicContext();return;}try{const provider=siloNativeSolanaProvider(active);setNativeSwapProvider(provider);setSolanaReceive(true);}catch{clearNativePublicContext();}}

 function onNativeBackupVerified(ready:boolean){if(!previewOnly||solanaKeyringPermitted)return;const active=nativeSession.current;if(!ready||!active||!privateNativeReview||solanaNetwork!=='mainnet-beta'){clearNativePublicContext();return;}try{setNativeSwapProvider(siloNativeSolanaProvider(active,true));setNativePreviewReady(true);}catch{clearNativePublicContext();}}

 // Automatic balances and activity only after this browser's one-time choice (owner and Sol, 23 October 2026, UX Q3).
 const [autoReads,setAutoReads]=useState<boolean|null>(null),[pageVisible,setPageVisible]=useState(true),autoChecked=useRef<string|null>(null),autoReadsRef=useRef<boolean|null>(null),readAbort=useRef<AbortController|null>(null);
 autoReadsRef.current=autoReads;
 // eslint-disable-next-line react-hooks/set-state-in-effect -- the stored choice for the selected network
 useEffect(()=>{const stored=readSiloAutoReads(localStorage,solanaNetwork);autoReadsRef.current=stored;setAutoReads(stored);autoChecked.current=null;},[solanaNetwork]);
 const chooseAutoReads=(enabled:boolean)=>{writeSiloAutoReads(localStorage,solanaNetwork,enabled);autoReadsRef.current=enabled;setAutoReads(enabled);if(!enabled){autoChecked.current=null;if(automaticRead.current){automaticRead.current=false;publicEpoch.current++;readAbort.current?.abort();readAbort.current=null;setBusy(false);}}};
 useEffect(()=>{if(autoReads!==true||!nativeOwner||!solanaReceive||publicReport||busy||!publicReadEnabled||!pageVisible||document.visibilityState==='hidden')return;const key=`${solanaNetwork}:${nativeOwner}`;if(autoChecked.current===key)return;autoChecked.current=key;void checkNativeBalances(true);// eslint-disable-next-line react-hooks/exhaustive-deps
 },[autoReads,nativeOwner,solanaReceive,publicReport,busy,publicReadEnabled,solanaNetwork,pageVisible]);
 const automaticRead=useRef(false);
 // A hidden page withdraws a running automatic read at once; returning to the page starts it again (once) when still chosen
 // (Sol, review of 0f518142, R4-L1): pageVisible re-runs the guarded automatic-read effect above.
 useEffect(()=>{const changed=()=>{const visible=document.visibilityState!=='hidden';setPageVisible(visible);if(!visible&&automaticRead.current){automaticRead.current=false;publicEpoch.current++;readAbort.current?.abort();readAbort.current=null;autoChecked.current=null;setBusy(false);}};changed();document.addEventListener('visibilitychange',changed);return()=>document.removeEventListener('visibilitychange',changed);},[]);
 async function checkNativeBalances(automatic=false){const active=nativeSession.current;if(!active||!solanaReceive||!(solanaNetwork==='mainnet-beta'||testNetworkSolana))return;automaticRead.current=automatic;try{await connect(siloNativeSolanaProvider(active),automatic);}finally{automaticRead.current=false;}}
 async function disconnectPublic(){const active=nativeSession.current;clearNativePublicContext();active?.lock();nativeSession.current=null;setNativeSolana(null);setError('');}

 const zecSoon=true;
 // Display-only USD estimates come from Grain's server (/api/silo/prices); the isolated candidate has no server reads.
 const prices=publicReadEnabled&&config.flags.silo;
 const disclosure=siloDisclosure('solana');
 // Token names and display-only USD values: the token mints (not the address) go to Grain's server.
 const tokens=useSiloTokens(publicReport?.network??solanaNetwork,publicReport?.network===solanaNetwork?publicReport.holdings:null,prices);
 return <SiloBackupPartsProvider><SiloSharedPassphraseProvider><SiloAccountSigningProvider value={signing}><SiloBetaGate open={config.beta?.open===true} invited={config.beta?.closed?betaLive.invited:true} checkedAt={betaLive.checkedAt} onAccepted={betaLive.refresh}><SiloGrainy/><SiloOverview atomicEnabled={atomicEnabled} solanaOpen={Boolean(nativeOwner&&solanaReceive)} launchpad={launchpad} prices={prices} xmr={config.flags.xmr?xmr:{...xmr,coverage:'not enabled'}} zec={config.flags.zec?zec:{...zec,coverage:'not enabled'}} publicReport={publicReport} evm={evm} zecSoon={zecSoon} backupNeeded={solNeedsBackup} conversionLive={crosschainEnabled} test={config.mode!=='mainnet'} solanaNetwork={solanaNetwork} solanaTransfersEnabled={transfersReady} releaseHeld={config.mode==='mainnet'&&!config.release.ready} swapMode={previewOnly?'preview':'held'} activityPage={publicReadEnabled&&config.flags.silo?activityPage:null} xmrHistory={config.flags.xmr&&xmr.opened&&!xmr.syncError?xmrHistory:null} beta={betaLive.beta}>
  <SiloAccountPanel newWalletReviewEnabled={accountNewWalletEnabled} enabled={accountEnabled} onController={onAccount} vaultIdentity={vaultIdentity} networkProfile={accountNetworkProfile}/>
  {config.mode==='mainnet'&&!config.release.ready&&<section className="exposure-panel silo-hold" role="status"><h2>Real-funds release is held</h2><p>{accountNewWalletEnabled?'Private account wallet creation and recovery are available; signatures, payments and execution stay held.':'No native mainnet keys or payments can be opened until exact-candidate review is complete.'}</p><ul>{config.release.reasons.map(reason=><li key={reason}>{reason}</li>)}</ul></section>}
  {/* Solana account page: who and where (identity, network), then address and balance, then what you can do, then activity.
      Network and visibility facts sit beside the account instead of in a closing disclosure. Every wallet handler and guard is unchanged. */}
  <section id="silo-public" className="exposure-panel silo-zone silo-public-workspace silo-account-page" data-connected={publicReport?'true':undefined} aria-labelledby="silo-public-title">
   <header className="silo-acct-head"><SiloAssetIcon asset="sol"/><div><h2 id="silo-public-title">Solana</h2><span className="silo-zone-network">Public · {solanaNetwork==='devnet'?'Devnet · test funds':'Mainnet · real funds'}</span></div><span className="silo-tag">Public</span></header>
   {publicReport?<div className="silo-acct-summary">
    <div className="silo-acct-identity"><span className="silo-acct-status">Connected · {providerName}</span><code className="exposure-address">{publicReport.address}</code><button className="silo-acct-disconnect" onClick={()=>void disconnectPublic()}>Disconnect Solana</button></div>
    <div className="silo-acct-balance"><span className="silo-eyebrow">Balance</span><p className="silo-public-balance"><SiloHiddenAmount>{siloUnits(publicReport.lamports,9)} SOL</SiloHiddenAmount></p><p className="exposure-note">{publicReport.coverage}</p></div>
    <nav className="silo-acct-actions" aria-label="Solana actions"><button type="button" onClick={()=>document.getElementById('silo-sol-receive')?.scrollIntoView({block:'start'})}>Receive</button><button type="button" aria-describedby={transfersReady||devnetSendReady?undefined:'silo-sol-send-why'} onClick={()=>document.getElementById('silo-sol-send')?.scrollIntoView({block:'start'})}>Send</button><a href="#swap/sol">Swap</a></nav>
    {!(transfersReady||devnetSendReady)&&<p className="silo-fine" id="silo-sol-send-why">Sending is held in this build. Send opens its review; nothing is signed or sent.</p>}
   </div>:null}
   {/* Always mounted: changing balance layout cannot unlock or retire a native session. */}
   <SiloInlineAccountUnlock controller={accountController} enabled={accountNewWalletEnabled} authenticated={accountState?.authenticated===true} vaultUnlocked={accountState?.vaultUnlocked===true} accountBusy={accountState?.busy===true} reviewedOrigin={accountNewWalletEnabled?'https://grain-silo.omer-034.workers.dev':null}/>
   <div hidden={accountPrerequisite}><SiloNativePublicWallet sendEnabled={transfersReady} keyNetwork={accountNetworkProfile==='test-networks'?'devnet':'mainnet'} getAccountBackup={accountEnabled?getAccountBackup:undefined} chain="solana" limitedSwapSigningEnabled={privateTrialReady&&config.swap?.executionEnabled===true} receiveEnabled={solanaKeyringPermitted} permitted={solanaKeyringPermitted||privateNativeReview} reviewedOrigin={privateTrialReady||privateNativeReview?'https://grain-silo.omer-034.workers.dev':config.reviewedOrigin} mainnetMode={!testNetworkSolana} receive={publicReport?null:{asset:'SOL / Solana tokens',network:solanaNetwork}} onSession={onNativeSolana} onReceiveReady={onNativeReceiveReady} onBackupVerified={onNativeBackupVerified} onBackupNeeded={setSolNeedsBackup}/></div>
   {nativeOwner&&solanaReceive&&publicReadEnabled&&(autoReads===null?<div className="silo-choice" role="group" aria-labelledby="silo-auto-reads-title"><h3 id="silo-auto-reads-title">Show balances automatically?</h3><p>When this wallet opens, Silo loads this public address&apos;s balance and activity. Silo&apos;s server (on Cloudflare) sees the address, your IP address and when it loads; our Solana provider, Alchemy, sees the address but not your IP. You can turn this off at any time. <a href={`/${SILO_AUTO_READS_NOTICE}`}>Privacy notice</a></p><div className="exposure-actions"><button className="silo-primary" onClick={()=>chooseAutoReads(true)}>Yes, automatically</button><button onClick={()=>chooseAutoReads(false)}>No, I&apos;ll check myself</button></div></div>
    :<div className="exposure-actions"><button disabled={busy} onClick={()=>void checkNativeBalances(false)}>{busy?'Checking balances…':publicReport?'Refresh balances':'Check balances'}</button><button type="button" className="silo-textlink" onClick={()=>chooseAutoReads(!autoReads)}>{autoReads?'Turn off automatic balances':'Load balances automatically'}</button></div>)}
   {nativeSolana&&solanaNetwork!=='mainnet-beta'&&!testNetworkSolana&&<p className="exposure-note" role="note">This page reads Solana {solanaNetwork}. Silo wallets hold mainnet addresses, so their activity is not loaded here.</p>}
   {!publicReadEnabled&&<p className="exposure-note">Public RPC reads are available in the full site. This isolated test candidate runs the wallet zones locally.</p>}
   {error&&<p role="alert" className="exposure-error">{error}</p>}
   <details className="silo-acct-details"><summary>Details</summary><dl className="silo-acct-facts" aria-label="Solana network and visibility"><div><dt>Network</dt><dd>{solanaNetwork==='devnet'?'Devnet · test funds, separate from mainnet':'Mainnet · real funds'}</dd></div><div><dt>Visible on-chain</dt><dd>{disclosure.visible}</dd></div><div><dt>Who can inspect it</dt><dd>{disclosure.observers}</dd></div><div><dt>What is protected</dt><dd>{disclosure.hidden}</dd></div></dl></details>
   {/* The public-history reader is off unless the server enables it (policy accepted): no card, no alarming error, while it cannot work. */}
   {(publicReport||nativeOwner)&&config.solana?.activityEnabled===true&&<SiloSolanaActivity autoLoad={autoReads===true} key={`${solanaNetwork}:${publicReport?.address??nativeOwner}:${autoReads===true}`} owner={publicReport?(publicReport.network===solanaNetwork?publicReport.address:null):nativeOwner} network={solanaNetwork} onActivity={onActivity} enabled={publicReadEnabled&&config.flags.silo}/>}
   {publicReport&&<div className="silo-acct-columns">
    <div className="silo-inset silo-acct-holdings"><h3>Holdings</h3>{publicReport.holdings.length>0?<SiloTokenList holdings={publicReport.holdings} tokens={tokens} priced={publicReport.network==='mainnet-beta'}/>:<p className="silo-empty">No tokens besides SOL were found for this address.</p>}</div>
    <div id="silo-sol-receive" className="silo-inset silo-acct-receive">{solanaReceive?<SiloReceiveAddress key={publicReport.address} address={publicReport.address} asset="SOL / Solana tokens" network={solanaNetwork}/>:<p className="exposure-note" role="status">The receive address appears after this wallet&apos;s encrypted backup is verified.</p>}</div>
   </div>}
   {/* One transfer instance for both states: its saved-payment journal and review lifecycle do not depend on the layout. */}
   <div id="silo-sol-send" className="silo-inset silo-send" data-held={transfersReady||devnetSendReady?undefined:true}><SiloSolanaTransfer provider={nativeOwner&&solanaReceive?nativeSwapProvider:null} network={config.solana?.network??'mainnet-beta'} enabled={transfersReady||devnetSendReady} beta={betaLive.beta}/></div>
   {devnetTradeReady&&<div id="silo-devnet-trade" className="silo-inset silo-send"><SiloDevnetTrade provider={nativeOwner&&solanaReceive?nativeSwapProvider:null} enabled={devnetTradeReady} beta={betaLive.beta}/></div>}
   {config.mode==='mainnet'&&config.getXmr?.enabled===true&&<a className="silo-private-cta" href="#wallets/xmr"><span><strong>Get XMR</strong><small>Through an external exchange. Your public-network payment remains public.</small></span><span aria-hidden="true">→</span></a>}
   <SiloGrainPanel enabled={prices&&solanaNetwork==='mainnet-beta'} owner={publicReport?.network==='mainnet-beta'?publicReport.address:null} holdings={publicReport?.network==='mainnet-beta'?publicReport.holdings:[]} launchpad={launchpad} realFunds={solanaNetwork==='mainnet-beta'}/>
   <SiloPriceChart asset="SOL" name="Solana" enabled={prices} holding={publicReport?{atomic:publicReport.lamports,decimals:9}:undefined} realFunds={solanaNetwork==='mainnet-beta'}/>
  </section>
  {/* EVM zone: view and receive follow the same release gate as the Solana wallet; sending additionally needs the reviewed production origin and the release, and each chain's own server flag. */}
  <SiloEvmZone getAccountBackup={accountEnabled?getAccountBackup:undefined} chains={evmStatus} enabled={publicReadEnabled&&config.flags.silo} onReport={setEvm} nativePermitted={!nativeHeld} reviewedOrigin={config.reviewedOrigin} mainnetMode={true} sendPermitted={config.release.ready&&config.reviewedOrigin==='https://silo.trading'&&publicReadEnabled&&!previewOnly}/>
  <SiloSwapPanel initialSlippageBps={config.swap?.trialSlippageBps??100} key={nativeOwner??'disconnected'} publicReport={nativeOwner&&publicReport?.network==='mainnet-beta'&&publicReport.address===nativeOwner?publicReport:null} quotesEnabled={config.swap?.quotesEnabled===true&&publicReadEnabled&&solanaNetwork==='mainnet-beta'} xmrOpened={xmr.opened} xmrNetwork={config.mode==='mainnet'?'mainnet':'stagenet'} provider={publicReadEnabled&&nativeOwner&&(solanaKeyringPermitted||previewOnly&&privateNativeReview&&nativePreviewReady)?nativeSwapProvider:null} executionEnabled={!previewOnly&&privateTrialReady&&config.swap?.executionEnabled===true&&publicReadEnabled} network={solanaNetwork} previewEnabled={previewOnly}/>
  <SiloConversionPanel pricesEnabled={prices} quotesEnabled={crosschainEnabled} executionEnabled={crosschainEnabled} nativeBridge={conversionBridge} prepareSolanaDeposit={prepareSolanaDeposit??undefined} previewEnabled={previewOnly} activityPage={publicReadEnabled&&config.flags.silo?activityPage:null} publicAddress={publicReport?.network==='mainnet-beta'?publicReport.address:null} xmrOpened={xmr.opened} balances={{sol:publicReport?.network==='mainnet-beta'?publicReport.lamports:null,usdc:publicReport?.network==='mainnet-beta'?publicReport.holdings.find(h=>h.mint==='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')?.amount??'0':null,xmr:config.flags.xmr?xmr.spendable??null:null}}/>
  <SiloAtomicPanel enabled={atomicEnabled} network={config.atomic?.network==='devnet'?'devnet':'mainnet'} programId={config.atomic?.programId??null} claimer={nativeOwner&&solanaReceive?nativeOwner:null} bridge={atomicBridge} capXmr={config.atomic?.capXmr??null}/>
  {/* Rendered right under the Convert card (same view) so the wallet deposit review is never in another tab. */}
  <SiloConversionSolanaDeposit provider={nativeOwner&&solanaReceive&&config.solana?.network==='mainnet-beta'?nativeSwapProvider:null} onBridge={onSolanaDepositBridge}/>
  {config.flags.xmr?<SiloNativeZone zone="xmr" paymentAuthority={paymentAuthority} getXmrEnabled={config.getXmr?.enabled===true} node={config.xmrNode} network={config.mode==='mainnet'?'mainnet':'stagenet'} release={config.release} reviewedOrigin={config.reviewedOrigin} onBalance={onXmr} onIdentity={onXmrIdentity} onXmrSession={onXmrSession} onConversionBridge={onConversionBridge} onAtomicBridge={onAtomicBridge} atomicEnabled={atomicEnabled} onHistory={onXmrHistory} prices={prices} beta={betaLive.beta}/>: <section id="silo-xmr" className="exposure-panel silo-off" aria-labelledby="silo-xmr-off"><SiloAssetIcon asset="xmr"/><div><h2 id="silo-xmr-off">Monero is off in this build</h2><p>Monero controls are unavailable in this build. Previously saved wallets and backups still matter; switching this feature off does not erase them.</p></div><span className="silo-tag">Off</span></section>}

  {/* Bitcoin test-network wallet: both flags off by default (SILO_BTC_ENABLED, SILO_BTC_SEND_ENABLED); mainnet is refused in code. */}
  {config.btc?.enabled===true&&<SiloBtcZone network={config.btc.network} sendEnabled={config.btc.sendEnabled} capSats={config.btc.capSats} mainnetMode={config.btc.network==='mainnet'} reviewedOrigin={config.reviewedOrigin}/>}
  <SiloEconomics/>
  <section id="silo-next" className="exposure-panel silo-setting"><header><h2>What comes next</h2><p>Research, not promises.</p></header><div className="silo-setting-body"><p>We aim to bring more privacy coins into Silo and support private swaps across more chains. SOL/native-XMR conversion belongs in V1 and is under review. Additional networks are planned during beta after integration and acceptance.</p></div></section>
  <section id="silo-boundaries" className="exposure-panel silo-setting"><header><h2>Privacy and limits</h2><p>What stays public, and what this wallet cannot promise.</p></header><div className="silo-setting-body"><p>SOL, GRAIN, Grainpad tokens and wXMR remain public. wXMR is a third-party wrapped asset with bridge risk; it is not native XMR. SOL/native-XMR conversion is part of V1 and its integrated release is under review.</p><p>The web origin supplies wallet code. A malicious origin or browser extension can observe an unlocked wallet. Local encryption and asset pins do not remove that authority.</p></div></section>
 </SiloOverview></SiloBetaGate></SiloAccountSigningProvider></SiloSharedPassphraseProvider></SiloBackupPartsProvider>;
}
