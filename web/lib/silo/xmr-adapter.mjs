import {validateSiloXmrRecipient} from './xmr-address-review.mjs';
import {xmrHistory} from './native-history.mjs';
import {xmrIncomingStatus} from './xmr-confirmations.mjs';
import {encodeRequestLabel,decodeRequestLabel,moneroSubaddressNetwork} from './xmr-request.mjs';
import {createSiloXmrUnsignedFeeEstimator} from './xmr-unsigned-fee-read.mjs';
/** Safety bounds on the network fee the node-assisted wallet reports for a payment (owner-approved, 2026-10-11). A zero fee
 * cannot be relayed and a fee above 0.01 XMR (normal fees are well under 0.001 XMR) means a misbehaving node or wallet. */
export const SILO_XMR_MAX_FEE_PICONERO=10_000_000_000n;
const checkedFee=feeRaw=>{if((typeof feeRaw!=='bigint'&&!Number.isSafeInteger(feeRaw)))throw Error('Network fee was not checked.');const fee=BigInt(feeRaw);if(fee<=0n)throw Error('The network fee is zero, so this payment cannot be sent. Sync and try again.');if(fee>SILO_XMR_MAX_FEE_PICONERO)throw Error('The network fee is above the 0.01 XMR safety limit. The node may be misreporting fees; nothing was signed for sending.');return fee;};
const keyImagesOf=tx=>{try{const images=(tx?.getInputs?.()??[]).map(input=>input?.getKeyImage?.()?.getHex?.());return images.length&&images.every(image=>/^[a-f0-9]{64}$/.test(image??''))?images:null;}catch{return null;}};
import {siloJson} from './bounded-json.mjs';
import {paymentJournal} from './payment-journal.mjs';
import {assertSiloNetwork,encodeSiloBytes,decodeSiloBytes} from './local-envelope.mjs';
import {siloAmount,siloUnits} from './amounts.mjs';
import {authorizeSiloNetwork} from './release-gate.mjs';
import {siloNodeUrl} from './disclosures.mjs';
import {assertSiloXmrNodeNetwork} from './xmr-node-network.mjs';
/** The injected SDK is loaded only inside the Silo browser action. No wallet-RPC or server key custody; local transfers require a separate explicit user consent. */
/** monero-ts encrypts keysData with this password. The AES-GCM Silo envelope is the actual protection. It is passed
 * explicitly: the worker path defaults it, but the in-thread openWalletFull path does not (BindingError on reopen). */
const WALLET_PASSWORD='';
/** Wallet data stays in memory and in the Silo envelope. openWalletFull resolves a filesystem even when keysData is supplied,
 * and the browser bundle has none (null `fs.promises`), so an explicit refusing one is passed: nothing is read or written. */
const refuseFs=async()=>{throw Error('Silo wallets do not use a filesystem.');};
const MEMORY_ONLY_FS=Object.freeze({readFile:refuseFs,writeFile:refuseFs,unlink:refuseFs,mkdir:refuseFs,stat:refuseFs,access:refuseFs,rename:refuseFs});
/** Receive addresses are account-0 subaddresses (index 1 and up), reducing receive-address reuse linkage. Payments to
 * any of them reach the same balance. A seed restore scans ahead of the last used subaddress (monero-ts/wallet2: 200), so at most
 * SILO_XMR_SUBADDRESS_GAP unused addresses may be handed out after the last one that received funds. */
export const SILO_XMR_SUBADDRESS_GAP=50;
export const SILO_XMR_SUBADDRESS_MAX=10000;
// Pinned SDK address-table coverage; not a funded scan proof.
export const SILO_XMR_SUBADDRESS_LOOKAHEAD=200;
/** `relayGuard(review)` runs immediately before a signed payment's bytes are relayed, for the page's live admission (the closed
 * beta's pause and cap, review N4); a throw leaves the pending record intact for a later retry of the same bytes.
 * @param {{sdk:any,node:string,seed?:string|null,height?:number,cache?:any,network?:string,release?:any,fetcher?:typeof fetch,relayGuard?:((review:{amount?:string})=>void|Promise<void>)|null}} options */
export async function openXmrResearch({sdk,node,seed=null,height=0,cache=null,network='stagenet',release=null,fetcher=fetch,relayGuard=null}){
 assertSiloNetwork('xmr',network);authorizeSiloNetwork('xmr',network,release);const uri=siloNodeUrl(node);
 // Requests are switched off when earlier request reservations cannot be known: a wallet restored from the phrase alone, or one reopened
 // from recovery material only (its request labels are gone). See createRequest.
 const gatedAtOpen=Boolean(seed&&!cache)||Boolean(cache?.cacheOmitted);
 if(seed&&cache)throw Error('An existing wallet opens from its encrypted backup; a recovery phrase is not accepted with it.');
 // A cache reduced to recovery material reopens from its own seed and birthday, keeping its pending journal.
 const scanCache=cache&&!cache.cacheOmitted?cache:null;
 // The stored birthday is kept; the restore-height field only applies to a new or seed-restored wallet.
 if(cache)height=cache.height;
 if(cache?.cacheOmitted){if(typeof cache.seed!=='string'||!cache.seed)throw Error('Encrypted backup has no recovery phrase.');seed=cache.seed;}
 if(!Number.isSafeInteger(height)||height<0)throw Error('Use a valid restore height.');
 // A read-only node check occurs before opening keys or performing any scan.
 const response=await fetcher(`${uri}/get_info`,{cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(10000)});
 if(!response.ok){await response.body?.cancel().catch(()=>{});throw Error('Node did not verify the selected Monero network.');}
 // The same rule for a configured node and one typed by hand: flags and nettype must name this wallet's network.
 const info=await siloJson(response);assertSiloXmrNodeNetwork(info,network);
 await sdk.LibraryUtils.setLogLevel(0);
 const config={networkType:network==='stagenet'?sdk.MoneroNetworkType.STAGENET:sdk.MoneroNetworkType.MAINNET,password:WALLET_PASSWORD,server:{uri},proxyToWorker:true,isTrustedDaemon:false};
 // monero-ts refuses a restore height for a new random wallet and picks the current height itself.
 if(seed&&!scanCache){config.seed=seed;config.restoreHeight=height;}
 if(scanCache){config.keysData=decodeSiloBytes(scanCache.keysData);config.cacheData=decodeSiloBytes(scanCache.cacheData);config.fs=MEMORY_ONLY_FS;}
 const wallet=scanCache?await sdk.openWalletFull(config):await sdk.createWalletFull(config);
 // The SDK has copied the decoded cache into its worker. Dropping the adapter's copies lets the page release them for the session
 // (the full cache of a synced wallet can be tens of megabytes); later backups read fresh data from the wallet.
 delete config.keysData;delete config.cacheData;
 let closed=false;const active=()=>{if(closed)throw Error('Wallet session is locked.');};
 const call=async(method,...args)=>{active();const value=await wallet[method](...args);active();return value;};
 try{
 const journal=paymentJournal(cache?.pending??null);
 const unsignedFeeEstimate=createSiloXmrUnsignedFeeEstimator({node:uri,network,fetcher,
  validateRecipient:address=>validateSiloXmrRecipient(sdk,address,network),
  readLocal:async({check})=>{
   check();journal.assertClear();const synced=await call('isSynced');check();
   if(synced!==true)return {synced:false};
   const priority=await call('getDefaultFeePriority');check();
   const outputs=await call('getOutputs',{accountIndex:0,isSpent:false,isFrozen:false,isLocked:false});check();
   return {synced:true,priority,outputs};
  },
 });
 const subaddresses=async()=>(await call('getSubaddresses',0)).filter(row=>row.getIndex()>0).sort((a,b)=>a.getIndex()-b.getIndex());
 const highest=async()=>(await subaddresses()).at(-1)?.getIndex()??0;
 // A backup records the highest subaddress handed out. A wallet reopened from a seed, or from recovery material only, recreates
 // them so payments to every handed-out address are scanned, even beyond the restore lookahead.
 const recorded=cache?.subaddresses??0;
 if(!Number.isSafeInteger(recorded)||recorded<0||recorded>SILO_XMR_SUBADDRESS_MAX)throw Error('Encrypted backup has an invalid receive address count.');
 const scanned=cache?.scannedSubaddresses??recorded;
 if(!Number.isSafeInteger(scanned)||scanned<recorded)throw Error('Encrypted backup has an invalid scanned receive index.');
 if(cache?.cacheOmitted&&(cache.subaddressCacheRequired===true||scanned>=SILO_XMR_SUBADDRESS_MAX+SILO_XMR_SUBADDRESS_LOOKAHEAD))throw Error('This XMR recovery needs the full wallet cache for known receive addresses.');
 if(recorded>0)for(let index=await highest();index<recorded;index++)await call('createSubaddress',0);
 // The birthday a backup records is the wallet's own restore height, so a later seed restore scans from it.
 if(!cache&&!seed){const own=await call('getRestoreHeight',);if(Number.isSafeInteger(own)&&own>=0)height=own;}
 // Pin the ordinary Receive selection only when an exchange address is issued. Older backups retain their usual behavior.
 let ordinaryReceiveIndex=cache?.ordinaryReceiveIndex??null;
 if(ordinaryReceiveIndex!==null&&(!Number.isSafeInteger(ordinaryReceiveIndex)||ordinaryReceiveIndex<1||ordinaryReceiveIndex>await highest()))throw Error('Encrypted backup has an invalid ordinary receive index.');
 // A seed-only restore marks its primary address (account 0, index 0) with a label that lives in the encrypted wallet cache, so the
 // switch-off survives later reopens from the full backup.
 const RECOVERED_LABEL='silo-recovered-from-phrase-v1',LABELS_LOST_LABEL='silo-request-labels-lost-v1';
 // Phrase-only restore: nothing is known about earlier addresses, so requests AND new receive addresses are off. Recovery material only
 // (cacheOmitted): the address count is kept, so no address is reissued, but request labels are gone, so only requests are off.
 const phraseOnlyAtOpen=Boolean(seed&&!cache);
 if(gatedAtOpen)await call('setSubaddressLabel',0,0,phraseOnlyAtOpen?RECOVERED_LABEL:LABELS_LOST_LABEL);
 let marker=null;
 // If the marker cannot be read, everything stays off (fail closed).
 try{marker=gatedAtOpen?(phraseOnlyAtOpen?RECOVERED_LABEL:LABELS_LOST_LABEL):(await call('getSubaddress',0,0)).getLabel?.();}catch(error){if(closed)throw error;marker=RECOVERED_LABEL;}
 const phraseOnly=phraseOnlyAtOpen||marker===RECOVERED_LABEL;
 const requestsGated=phraseOnly||gatedAtOpen||marker===LABELS_LOST_LABEL;
 // Requests created but not yet saved with the encrypted backup are invisible everywhere until commitRequest.
 const uncommitted=new Set();
 const nextReceive=async()=>{
  const rows=await subaddresses(),used=rows.filter(row=>row.getIsUsed()===true).at(-1)?.getIndex()??0;
  if(rows.filter(row=>row.getIndex()>used).length>=SILO_XMR_SUBADDRESS_GAP)throw Error('subaddress-gap');
  if((rows.at(-1)?.getIndex()??0)>=SILO_XMR_SUBADDRESS_MAX)throw Error('subaddress-limit');
  return (await call('createSubaddress',0)).getAddress();
 };
 const broadcast=async(metadata)=>{active();authorizeSiloNetwork('xmr',network,release);return String(await call('relayTx',metadata.metadata));};
 // The relay boundary of one review: the guard sees the frozen review (amount, recipient, network) right before the bytes go out.
 const guarded=review=>async authorized=>{if(relayGuard)await relayGuard(review);return broadcast(authorized);};
 // true at the confirmation policy. A wallet "failed" flag (relay rejected, dropped from the local pool view) does not prove the
 // signed transaction can never be mined: another node may still relay it while its inputs stay unspent. It is reported as
 // 'reported-failed' and never releases the hold; the only recovery is resending these same bytes, which cannot pay twice.
 const outcome=async pending=>{await call('sync');if(!await call('isSynced',))return false;const hash=pending.authorized?.hash;if(!/^[a-f0-9]{64}$/.test(hash??''))return false;const tx=await call('getTx',hash);const deep=row=>row?.getIsConfirmed?.()===true&&Number.isSafeInteger(row.getNumConfirmations())&&row.getNumConfirmations()>=10;if(deep(tx))return true;
  // Provable failure: a cancelling payment spent one of this payment's own inputs and is 10 blocks deep, while this payment is
  // not in the chain. Both spend the same key image, so this payment can never be included (barring a reorg deeper than 10).
  const conflict=pending.conflict;if(conflict&&pending.authorized?.keyImages?.includes(conflict.keyImage)&&tx?.getIsConfirmed?.()!==true){const cancel=await call('getTx',conflict.hash);if(deep(cancel))return 'failed';}
  if(!tx)return false;return tx.getIsFailed?.()===true?'reported-failed':false;};
 return {
  estimateFee:async input=>{active();journal.assertClear();const result=await unsignedFeeEstimate(input);active();journal.assertClear();return result;},
  paymentStatus:async()=>{
   active();const pending=journal.snapshot();if(!pending)return null;
   const unknown={confirmations:null,target:10,status:'not checked'};
   if(!await call('isSynced',))return unknown;
   const hash=pending.authorized?.hash;if(!/^[a-f0-9]{64}$/.test(hash??''))return unknown;
   const tx=await call('getTx',hash);if(!tx)return unknown;
   if(tx.getIsFailed?.()===true)return {...unknown,status:'reported-failed'};
   const confirmations=tx.getNumConfirmations();
   if(!Number.isSafeInteger(confirmations)||confirmations<0)return unknown;
   const mined=tx.getIsConfirmed()===true;
   return {confirmations:mined?confirmations:0,target:10,status:mined&&confirmations>=10?'confirmed':'pending'};
  },
  reconcile:persist=>{active();return journal.reconcile(outcome,persist);},
  release:persist=>{active();return journal.release(outcome,persist);},
  // Read-only, for account sync: the same outcome rule reconcile/release use (10 deep confirms; a 10-deep cancelling spend of
  // one of its own key images fails it), for a pending record carried by the encrypted vault. This session's journal is untouched.
  outcomeOf:async pending=>{active();return outcome(pending);},
  // Read-only, for the account signing gate: the pending payment record exactly as the wallet journal holds it (or null).
  pendingRecord:()=>{active();return journal.snapshot();},
  // Read-only, for the account vault identity: the wallet's primary address and restore height. Never keys.
  identity:async()=>{active();return {primaryAddress:await call('getPrimaryAddress'),restoreHeight:await call('getRestoreHeight')};},
  // Read-only, for a SOL→XMR order's arrival proof: what this synced wallet received in one transaction (by its hash).
  incomingOf:async hash=>{
   active();if(!/^[a-f0-9]{64}$/.test(hash??'')||!await call('isSynced'))return null;const tx=await call('getTx',hash);if(!tx)return null;
   return {hash:tx.getHash(),confirmed:tx.getIsConfirmed?.()===true,confirmations:tx.getNumConfirmations?.(),failed:tx.getIsFailed?.()===true,transfers:(tx.getIncomingTransfers?.()??[]).map(t=>({address:t.getAddress(),amount:String(t.getAmount())}))};
  },
  // Read-only: confirmations and spendability of an incoming payment by transaction id (display only; never says spendable before 10).
  incomingStatus:async(hash,expect)=>{
   active();if(!/^[a-f0-9]{64}$/.test(hash??'')||!await call('isSynced'))return {found:false,confirmations:null,spendable:false};
   const tx=await call('getTx',hash);if(!tx)return {found:false,confirmations:null,spendable:false};
   return xmrIncomingStatus({confirmed:tx.getIsConfirmed?.()===true,confirmations:tx.getNumConfirmations?.(),failed:tx.getIsFailed?.()===true,transfers:(tx.getIncomingTransfers?.()??[]).map(t=>({address:t.getAddress(),amount:String(t.getAmount())}))},expect);
  },
  // Read-only, for the no-bridge XMR to SOL swap: finds this wallet's own outgoing payment to the joint address (so a reload after
  // sending is recognised and never pays twice) and reports its confirmations and height. Display and driver input only.
  lockStatus:async({address,amountAtomic})=>{
   active();if(typeof address!=='string'||!/^\d{1,19}$/.test(String(amountAtomic??'')))throw Error('Invalid lock query.');
   await call('sync');if(!await call('isSynced'))return {found:false,txid:null,confirmations:null,height:null};
   const want=BigInt(amountAtomic),txs=await call('getTxs');
   for(const tx of Array.isArray(txs)?txs.slice(0,100000):[]){
    if(tx.getIsFailed?.()===true)continue;
    let total=0n;for(const destination of tx.getOutgoingTransfer?.()?.getDestinations?.()??[])if(destination.getAddress()===address)total+=BigInt(destination.getAmount());
    if(total>0n&&total>=want)return {found:true,txid:tx.getHash(),confirmations:tx.getNumConfirmations?.()??0,height:tx.getHeight?.()??null};
   }
   return {found:false,txid:null,confirmations:null,height:null};
  },
  daemonHeight:async()=>{active();const height=Number(await call('getDaemonHeight'));return Number.isSafeInteger(height)&&height>0?height:null;},
  // Read-only, for account sync recovery coverage: every transaction the wallet knows with an outgoing amount, plus whether the
  // wallet is synced and where its scan started. The caller decides whether that is complete coverage.
  outgoingHistory:async()=>{
   active();const synced=await call('isSynced'),restoreHeight=await call('getRestoreHeight'),primaryAddress=await call('getPrimaryAddress'),txs=await call('getTxs');
   if(!Array.isArray(txs)||txs.length>100000)throw Error('Wallet history unavailable or over its bound.');
   const outgoing=tx=>{const amount=tx.getOutgoingAmount?.();return amount!==undefined&&amount!==null&&BigInt(amount)>0n;};
   return {synced:synced===true,restoreHeight,primaryAddress,txs:txs.filter(outgoing).map(tx=>({hash:tx.getHash(),confirmed:tx.getIsConfirmed?.()===true,confirmations:tx.getNumConfirmations?.(),failed:tx.getIsFailed?.()===true}))};
  },
  // Cancels an unconfirmed payment the wallet reports failed or no longer knows: one of its own inputs is swept back to this
  // wallet's primary address. Whichever of the two is mined first wins; the other can never be, so funds cannot leave twice.
  cancelByConflict:async persist=>{
   active();const pending=journal.snapshot();if(!pending)throw Error('No unconfirmed payment to cancel.');
   const images=pending.authorized?.keyImages;if(!Array.isArray(images)||!images.length)throw Error('This payment was prepared before cancelling was supported. Resend the same payment or wait.');
   if(pending.conflict){await call('relayTx',pending.conflict.metadata);return pending.conflict.hash;}
   if(!await call('isSynced'))throw Error('Sync the wallet before cancelling.');
   const tx=await call('getTx',pending.authorized.hash);
   if(tx?.getIsConfirmed?.()===true)throw Error('This payment is already in a block. Wait for its confirmations.');
   if(tx&&tx.getIsFailed?.()!==true)throw Error('This payment is still waiting in the network. Cancel only after the wallet reports it failed.');
   const own=await call('getPrimaryAddress');let lastError=null;
   for(const keyImage of images){
    let sweep;try{sweep=await call('sweepOutput',{keyImage,address:own,relay:false});}catch(error){lastError=error;continue;}
    const destinations=sweep.getOutgoingTransfer?.()?.getDestinations?.();
    if(!Array.isArray(destinations)||destinations.length!==1||destinations[0].getAddress()!==own||!keyImagesOf(sweep)?.includes(keyImage))throw Error('The cancelling payment could not be verified.');
    checkedFee(sweep.getFee());
    const metadata=sweep.getMetadata(),hash=sweep.getHash();if(typeof metadata!=='string'||!metadata||!/^[a-f0-9]{64}$/.test(hash??''))throw Error('The cancelling payment could not be prepared.');
    const recorded=await journal.attachConflict({hash,metadata,keyImage},persist);
    await call('relayTx',recorded.metadata);return recorded.hash;
   }
   throw Error(lastError?'None of this payment\'s inputs can be spent yet. Wait for them to unlock, then try again.':'No input of this payment is available.');
  },
  // Account sync (SYNC-GATE-01): record a cancelling payment another device already prepared and published for this same
  // payment, so this wallet relays those exact bytes instead of sweeping again. Nothing is signed or relayed here.
  adoptConflict:async(conflict,persist)=>{
   active();const pending=journal.snapshot();if(!pending)throw Error('No unconfirmed payment to cancel.');
   if(!pending.authorized?.keyImages?.includes(conflict?.keyImage))throw Error('The recorded cancelling payment does not spend this payment\'s inputs.');
   return journal.attachConflict({hash:conflict.hash,metadata:conflict.metadata,keyImage:conflict.keyImage},persist);
  },
  pending:()=>journal.snapshot()?journal.draft(journal.snapshot().review,()=>{throw Error('Pending metadata missing.');},guarded(journal.snapshot().review),true):null,
  // Reuse the newest address while unused or at or beyond the supported maximum, so an existing wallet can always open. Indexes
  // beyond it can come from scanning after the same phrase was used elsewhere. Preserve the actual scanned index as well as
  // the bounded recreation count; beyond pinned lookahead, recovery must retain the full cache.
  // Otherwise issue a bounded new one. The caller saves the backup before showing it.
  receive:async()=>{
   const rows=await subaddresses(),last=ordinaryReceiveIndex===null?rows.at(-1):rows.find(row=>row.getIndex()===ordinaryReceiveIndex);
   if(last&&(last.getIsUsed()!==true||last.getIndex()>=SILO_XMR_SUBADDRESS_MAX))return last.getAddress();
   const address=await nextReceive();if(ordinaryReceiveIndex!==null)ordinaryReceiveIndex=await highest();return address;
  },
  // After a recovery from the phrase alone, an unpaid request of an earlier session cannot be known, so a new address could be that
  // request's address. New receive addresses are refused there (the current receive address keeps working).
  newReceive:async()=>{if(phraseOnly)throw Error('requests-gated');const address=await nextReceive();if(ordinaryReceiveIndex!==null)ordinaryReceiveIndex=await highest();return address;},
  // Phrase-only recovery: an unpaid request from before could sit at the next index, and giving that address to a conversion provider would
  // let the provider and the request's recipient link the two. Refused there (PR 564 round 3).
  newExchangeReceive:async()=>{
   if(phraseOnly)throw Error('Cash out to XMR is off for this wallet because it was restored from the recovery phrase alone: a new deposit address could be one handed out before. Restore from the encrypted backup to cash out.');
   // Do not change ordinary Receive, including after an encrypted or recovery-material reopen.
   if(ordinaryReceiveIndex===null){const rows=await subaddresses();if(!rows.length)await nextReceive();ordinaryReceiveIndex=await highest();}
   return nextReceive();
  },
  // Payment requests (lib/silo/xmr-request.mjs). Every request is its own fresh subaddress, pinned apart from ordinary Receive exactly
  // as newExchangeReceive does, and its amount, note and time are stored as the subaddress label inside the wallet's own encrypted data.
  // The caller saves the backup before showing the request.
  requestsGated:()=>requestsGated,
  // The address is created and labelled here but stays hidden (not listed, no payments read) until the caller has saved the encrypted
  // backup and calls commitRequest; if the save fails the caller calls discardRequest and the label is cleared.
  createRequest:async({amountAtomic=null,note=null}={})=>{
   active();
   if(requestsGated)throw Error('requests-gated');
   if(ordinaryReceiveIndex===null){const rows=await subaddresses();if(!rows.length)await nextReceive();ordinaryReceiveIndex=await highest();}
   const address=await nextReceive(),index=await highest();
   uncommitted.add(index);
   await call('setSubaddressLabel',0,index,encodeRequestLabel({amountAtomic,note,createdAt:Date.now()}));
   return {address,index};
  },
  commitRequest:async index=>{active();uncommitted.delete(index);},
  // The request leaves the hidden set only after its label is really cleared; if clearing fails it stays hidden for this session.
  discardRequest:async index=>{active();await call('setSubaddressLabel',0,index,'');uncommitted.delete(index);},
  // Read-only: every request this wallet holds (newest first), from the subaddress labels.
  listRequests:async()=>{
   active();
   return (await subaddresses()).filter(row=>!uncommitted.has(row.getIndex())).map(row=>({row,meta:decodeRequestLabel(row.getLabel?.())})).filter(item=>item.meta).map(({row,meta})=>({index:row.getIndex(),address:row.getAddress(),...meta})).sort((a,b)=>b.index-a.index);
  },
  // Read-only: payments to ONE request's subaddress. Other incoming payments are never returned.
  requestPayments:async address=>{
   active();
   if(!moneroSubaddressNetwork(address))throw Error('A valid Monero subaddress is required.');
   if(!await call('isSynced'))return null;
   const where=await call('getAddressIndex',address),account=where.getAccountIndex?.(),index=where.getIndex?.();
   if(account!==0||!Number.isSafeInteger(index)||index<1||uncommitted.has(index))throw Error('This address is not a request of this wallet.');
   const out=[];
   for(const tx of await call('getTxs',{isIncoming:true})){
    let total=0n;
    for(const t of tx.getIncomingTransfers?.()??[])if(t.getAccountIndex?.()===0&&t.getSubaddressIndex?.()===index)total+=BigInt(t.getAmount());
    if(total>0n){const seconds=tx.getBlock?.()?.getTimestamp?.();out.push({hash:tx.getHash(),amountAtomic:total.toString(),confirmed:tx.getIsConfirmed?.()===true,confirmations:tx.getNumConfirmations?.(),failed:tx.getIsFailed?.()===true,timestamp:Number.isSafeInteger(seconds)?seconds*1000:null});}
   }
   return out;
  },
  // Read-only: every request with the payments made to ITS subaddress, from one pass over the wallet's transactions.
  // `payments` is null when the wallet is not synced (unknown, never "unpaid").
  requestsOverview:async()=>{
   active();
   const byIndex=new Map((await subaddresses()).filter(row=>!uncommitted.has(row.getIndex())).map(row=>({row,meta:decodeRequestLabel(row.getLabel?.())})).filter(item=>item.meta).map(({row,meta})=>[row.getIndex(),{index:row.getIndex(),address:row.getAddress(),...meta,payments:[]}]));
   if(!byIndex.size)return [];
   if(!await call('isSynced'))return [...byIndex.values()].sort((a,b)=>b.index-a.index).map(item=>({...item,payments:null}));
   for(const tx of await call('getTxs',{isIncoming:true})){
    const totals=new Map();
    for(const t of tx.getIncomingTransfers?.()??[]){const index=t.getSubaddressIndex?.();if(t.getAccountIndex?.()===0&&byIndex.has(index))totals.set(index,(totals.get(index)??0n)+BigInt(t.getAmount()));}
    if(!totals.size)continue;
    const seconds=tx.getBlock?.()?.getTimestamp?.(),base={hash:tx.getHash(),confirmed:tx.getIsConfirmed?.()===true,confirmations:tx.getNumConfirmations?.(),failed:tx.getIsFailed?.()===true,timestamp:Number.isSafeInteger(seconds)?seconds*1000:null};
    for(const [index,total] of totals)byIndex.get(index).payments.push({...base,amountAtomic:total.toString()});
   }
   return [...byIndex.values()].sort((a,b)=>b.index-a.index);
  },
  // Payment proof for one transaction and one request address. It proves that transaction paid that address and nothing else.
  requestProof:async(hash,address)=>{
   active();
   if(!/^[a-f0-9]{64}$/.test(hash??'')||!moneroSubaddressNetwork(address))throw Error('A transaction id and a request address are required.');
   return String(await call('getTxProof',hash,address,''));
  },
  history:async()=>{
   const checked=await call('isSynced'),txs=await call('getTxs'),selfTransfers=new Set();
   // A payment is a transfer within this wallet when every destination address belongs to it.
   const own=async address=>{try{await call('getAddressIndex',address);return true;}catch(error){if(closed)throw error;return false;}};
   for(const tx of Array.isArray(txs)?txs.slice(0,100000):[]){const destinations=tx?.getOutgoingTransfer?.()?.getDestinations?.();if(!Array.isArray(destinations)||!destinations.length)continue;let all=true;for(const destination of destinations)if(!await own(destination.getAddress()))all=false;if(all)selfTransfers.add(tx.getHash());}
   return xmrHistory(txs,checked===true,selfTransfers);
  },
  balance:async()=>({amount:String(await call('getBalance',)),unlocked:String(await call('getUnlockedBalance',)),status:await call('isSynced',)?'checked':'partial coverage'}),
  sync:()=>call('sync',),
  backup:async()=>{const [keysData,cacheData]=await call('getData',),index=await highest();return {pending:journal.snapshot(),seed:await call('getSeed',),height,...(ordinaryReceiveIndex!==null?{ordinaryReceiveIndex}:{}),subaddresses:Math.min(index,SILO_XMR_SUBADDRESS_MAX),...(index>SILO_XMR_SUBADDRESS_MAX?{scannedSubaddresses:index}:{}),...(index>=SILO_XMR_SUBADDRESS_MAX+SILO_XMR_SUBADDRESS_LOOKAHEAD?{subaddressCacheRequired:true}:{}),keysData:encodeSiloBytes(new Uint8Array(keysData.buffer??keysData,keysData.byteOffset??0,keysData.byteLength)),cacheData:encodeSiloBytes(new Uint8Array(cacheData.buffer??cacheData,cacheData.byteOffset??0,cacheData.byteLength))};},
  prepare:async({address,amount})=>{
   active();journal.assertClear();authorizeSiloNetwork('xmr',network,release);await validateSiloXmrRecipient(sdk,address,network);active();
   const raw=siloAmount(amount,12),tx=await call('createTx',{accountIndex:0,address,amount:raw,relay:false});
   // The review shows what the signed transaction pays, not only what was requested.
   const destinations=tx.getOutgoingTransfer?.()?.getDestinations?.();
   if(!Array.isArray(destinations)||destinations.length!==1||destinations[0].getAddress()!==address||BigInt(destinations[0].getAmount())!==raw)throw Error('Recipient and amount could not be verified from the signed transaction.');
   const feeRaw=checkedFee(tx.getFee());
   const review={network,asset:'XMR',address,amount:siloUnits(raw,12),fee:siloUnits(String(feeRaw),12)};
   return journal.draft(review,async()=>{active();const metadata=tx.getMetadata();if(typeof metadata!=='string'||!metadata.length)throw Error('Signed payment metadata unavailable.');const hash=tx.getHash();if(!/^[a-f0-9]{64}$/.test(hash??''))throw Error('Signed transaction hash unavailable.');return {metadata,hash,keyImages:keyImagesOf(tx)};},guarded(review));
  },
  close:async()=>{if(closed)return;closed=true;try{await wallet.close(false);}finally{await sdk.shutdown();}},
 };
 }catch(error){
  closed=true;
  try{await wallet.close(false);}catch{/* Preserve the initialization failure. */}
  try{await sdk.shutdown();}catch{/* Preserve the initialization failure. */}
  throw error;
 }
}

/** What a view-only scan may count (SOL -> XMR, threat model U2): only outputs with unlock_time 0 count toward the amount,
 * and confirmations are the minimum over every incoming transaction seen (pool included), so a pending or time-locked output
 * can only delay "ready", never trigger it. Same rule as the maker's usableFromTransfers. Returns null when nothing arrived. */
export function siloXmrWatchUsable(txs){
 let atomic=0n,confirmations=Infinity,seen=0;
 for(const tx of Array.isArray(txs)?txs.slice(0,10000):[]){
  if(tx.getIsFailed?.()===true)continue;
  const amount=BigInt(tx.getIncomingAmount?.()??0n);if(amount<=0n)continue;seen++;
  const conf=tx.getInTxPool?.()===true?0:Number(tx.getNumConfirmations?.()??0);confirmations=Math.min(confirmations,Number.isFinite(conf)?conf:0);
  if(BigInt(tx.getUnlockTime?.()??0n)===0n)atomic+=amount;
 }
 return seen?{atomic:atomic.toString(),confirmations}:null;
}
/** A view-only wallet for one joint swap address (no spend key, nothing can be sent from it). */
/** @param {{sdk:any,node:string,network?:string,primaryAddress:string,privateViewKey:string,restoreHeight?:number,release?:any,fetcher?:typeof fetch}} options */
export async function openXmrWatchOnly({sdk,node,network='stagenet',primaryAddress,privateViewKey,restoreHeight=0,release=null,fetcher=fetch}){
 assertSiloNetwork('xmr',network);authorizeSiloNetwork('xmr',network,release);const uri=siloNodeUrl(node);
 if(typeof primaryAddress!=='string'||primaryAddress.length<90||primaryAddress.length>110)throw Error('Invalid swap address.');
 if(!/^[a-f0-9]{64}$/.test(privateViewKey??''))throw Error('Invalid view key.');
 if(!Number.isSafeInteger(restoreHeight)||restoreHeight<0)throw Error('Use a valid restore height.');
 const response=await fetcher(`${uri}/get_info`,{cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(10000)});
 if(!response.ok){await response.body?.cancel().catch(()=>{});throw Error('Node did not verify the selected Monero network.');}
 assertSiloXmrNodeNetwork(await siloJson(response),network);
 await sdk.LibraryUtils.setLogLevel(0);
 const wallet=await sdk.createWalletFull({networkType:network==='stagenet'?sdk.MoneroNetworkType.STAGENET:sdk.MoneroNetworkType.MAINNET,password:WALLET_PASSWORD,primaryAddress,privateViewKey,restoreHeight,server:{uri},proxyToWorker:true,isTrustedDaemon:false,fs:MEMORY_ONLY_FS});
 let closed=false,closing=null;const active=()=>{if(closed)throw Error('Watch wallet is closed.');};
 return Object.freeze({
  /** Syncs, then returns { atomic, confirmations } of usable incoming outputs, or null when nothing has arrived. */
  status:async()=>{active();await wallet.sync();active();return siloXmrWatchUsable(await wallet.getTxs({isIncoming:true}));},
  /** Stops a running sync (monero-ts stopSyncing). The wallet keeps the height it reached, so the next status() continues from there. */
  cancel:async()=>{if(closed)return;await wallet.stopSyncing();},
  // Idempotent and honest: a second call shares the first attempt and only reports closed once the wallet really closed; a failed attempt can be retried.
  close:()=>closing??=(async()=>{closed=true;try{await wallet.close(false);}catch(error){closing=null;throw error;}})(),
 });
}
/** Opens a wallet from full Monero keys (the joint address of a refunded no-bridge swap) in memory only, with the same network and
 * node authorization as openXmrResearch. It exists to sweep one address to the user's own wallet: nothing is stored or backed up. */
/** @param {{sdk:any,node:string,network?:string,primaryAddress:string,privateViewKey:string,privateSpendKey:string,restoreHeight?:number,release?:any,fetcher?:typeof fetch}} options */
export async function openXmrFromKeys({sdk,node,network='stagenet',primaryAddress,privateViewKey,privateSpendKey,restoreHeight=0,release=null,fetcher=fetch}){
 assertSiloNetwork('xmr',network);authorizeSiloNetwork('xmr',network,release);const uri=siloNodeUrl(node);
 if(typeof primaryAddress!=='string'||primaryAddress.length<90||primaryAddress.length>110)throw Error('Invalid recovery address.');
 if(!/^[a-f0-9]{64}$/.test(privateViewKey??'')||!/^[a-f0-9]{64}$/.test(privateSpendKey??''))throw Error('Invalid recovery keys.');
 if(!Number.isSafeInteger(restoreHeight)||restoreHeight<0)throw Error('Use a valid restore height.');
 const response=await fetcher(`${uri}/get_info`,{cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(10000)});
 if(!response.ok){await response.body?.cancel().catch(()=>{});throw Error('Node did not verify the selected Monero network.');}
 assertSiloXmrNodeNetwork(await siloJson(response),network);
 await sdk.LibraryUtils.setLogLevel(0);
 const wallet=await sdk.createWalletFull({networkType:network==='stagenet'?sdk.MoneroNetworkType.STAGENET:sdk.MoneroNetworkType.MAINNET,password:WALLET_PASSWORD,primaryAddress,privateViewKey,privateSpendKey,restoreHeight,server:{uri},proxyToWorker:true,isTrustedDaemon:false,fs:MEMORY_ONLY_FS});
 let closed=false;const active=()=>{if(closed)throw Error('Recovery wallet is closed.');};
 return Object.freeze({
  sync:async()=>{active();await wallet.sync();},
  balance:async()=>{active();return {amount:String(await wallet.getBalance()),unlocked:String(await wallet.getUnlockedBalance())};},
  /** Sends everything spendable to `address` (the user's own wallet). Returns the transaction hashes. */
  sweepUnlocked:async address=>{active();await validateSiloXmrRecipient(sdk,address,network);active();const txs=await wallet.sweepUnlocked({address,accountIndex:0,relay:true});return (Array.isArray(txs)?txs:[]).map(tx=>tx.getHash());},
  // The SDK worker is shared with the user's open wallet, so this close never shuts the SDK down.
  close:async()=>{if(closed)return;closed=true;await wallet.close(false);},
 });
}
