/** Account-sync gate around every Silo signing window, composed with the existing per-browser journals.
 *
 * The existing journals stay the first line of safety and are not changed in meaning: each still reserves durably,
 * marks its prompt, captures exact signed bytes and holds submission on any failure. The gate adds the cross-device rule
 * at the same points, in this order:
 *
 *   local reservation saved (promptStarted: false)
 *   → gate: sync; refuse while any operation on any device blocks; reserve the same message hash on the account;
 *     record "prompt started" on the account                         (failure: the local reservation is cancelled as before,
 *                                                                     and an account reservation without a prompt is cancelled)
 *   → local promptStarted: true → wallet prompt / Monero commit
 *   → local capture of the exact signed bytes
 *   → gate: record the signed record on the account                    (failure: submission stays held, as for any
 *                                                                     post-capture failure; `resume` records it later)
 *   → existing post-capture checks and submission.
 *
 * So no wallet prompt opens unless every device can see the operation, and nothing is submitted unless the signed
 * evidence another device needs to check it is on the account. A device that went offline, was closed or got a late
 * wallet answer finishes the record with `resume`, from its own saved journal. Closing an operation is never done
 * here: each device closes it only through its own verifier (outcome.mjs).
 *
 * This module never builds, signs or sends a transaction and never changes fees, routes or terms. It does not open a
 * wallet. It reads the existing journals only through their own validating readers (journal-bridge.mjs). */
import {XMR_RECORD, xmrIntent, xmrIntentHash, xmrRecordMatches} from './xmr-intent.mjs';
import {describeSavedSwap as describeSwap, describeSavedTransfer as describeTransfer, recordSavedAsSigned, SILO_JUPITER_STORAGE_KEY, SILO_TRANSFER_STORAGE_KEY} from './journal-bridge.mjs';

const transferAdmissions=new WeakMap();
/** Only an actual gate prompt check mints this object. JSON/callbacks cannot
 * supply account admission at the native transfer boundary. */
export function consumeSiloTransferAccountAdmission(token,{wire,owner,network}){
 const cap=transferAdmissions.get(token);if(!cap||cap.used)throw Error('One-use account transfer admission required.');cap.used=true;
 if(cap.wire!==wire||cap.owner!==owner||cap.network!==network)throw Error('Account transfer admission differs.');
 const guard=()=>{const result=cap.guard();if(result===false||result?.then)throw Error('Synchronous account transfer admission required.');};guard();return guard;
}

const TERMINAL = new Set(['finalized', 'failed-proven', 'cancelled-before-prompt']);
export {XMR_RECORD, xmrIntent, xmrIntentHash, xmrRecordMatches};
export const gateRefusal = (message, code, extra = {}) => Object.assign(Error(message), {gateCode: code, ...extra});

/** Maps a sync client error to one refusal the UI can show. Nothing was signed when this is thrown before a prompt. */
function refuse(error) {
  if (error?.gateCode) return error;
  const code = error?.syncCode;
  if (code === 'pending-operation') return gateRefusal('Another operation on this account is unresolved. Check it before signing again.', 'held', {blocking: error.blocking ?? []});
  if (code === 'locked' || code === 'signed-out') return gateRefusal('Unlock the account vault to sign.', 'locked');
  if (code === 'not-trusted') return gateRefusal('This device is not approved for new actions yet.', 'not-trusted');
  if (code === 'conflict') return gateRefusal('Sync needs recovery review. Signing is held.', 'conflict');
  if (error?.syncOffline) return gateRefusal('The account service is unavailable. Nothing was signed.', 'offline');
  return gateRefusal('The account could not record this operation. Nothing was signed.', 'unavailable');
}

/** `readers` replaces the journals' own validating readers in tests only (journal-bridge.mjs `impl`). */
export function createSigningGate({client, readers, captureContext = () => () => {}}) {
  if (!client || typeof client.reserveOperation !== 'function') throw Error('Account sync client required.');
  const describeSavedTransfer = (storage) => describeTransfer(storage, readers);
  const describeSavedSwap = (storage) => describeSwap(storage, readers);

  /** Reserve on the account and record the prompt. Reuses this device's own open reservation of the same message. */
  async function admit(described) {
    if (!described || !described.messageHash || !['reserved', 'prompt-started'].includes(described.state)) throw gateRefusal('The local reservation is missing. Nothing was signed.', 'no-reservation');
    let opId;
    try {
      const mine = (await client.operations()).find((op) => op.own && !op.legacy && op.kind === described.kind && op.binding?.messageHash === described.messageHash && !TERMINAL.has(op.state));
      opId = mine?.opId ?? (await client.reserveOperation({kind: described.kind, network: described.network, review: described.record, binding: {messageHash: described.messageHash, owner: described.owner ?? null}})).opId;
      const state = mine?.state ?? 'reserved';
      if (state === 'reserved') await client.markPromptStarted(opId);
      return opId;
    } catch (error) {
      // The prompt was not recorded, so it will not open: retire an account reservation this call made.
      if (opId) await client.cancelBeforePrompt(opId).catch(() => {});
      throw refuse(error);
    }
  }

  async function signed(opId, described) {
    let result;
    try { result = await recordSavedAsSigned(client, opId, described); }
    catch (error) { throw gateRefusal('Signed record saved on this device; the account could not record it yet. Submission is held until it does.', 'record-held', {cause: error}); }
    // Offline the evidence is kept encrypted on this device and published by the next sync — but not yet on the account.
    if (result?.queued) throw gateRefusal('Signed record saved on this device; the account will record it when it reconnects. Submission is held until then.', 'record-held');
    return result;
  }

  const gate = {
    admit, signed,
    transferContext(owner){const check=captureContext();if(typeof check!=='function'||typeof client.transferOwnerGuard!=='function')throw gateRefusal('Live native account context required.','locked');const own=client.transferOwnerGuard(owner);if(typeof own!=='function')throw gateRefusal('Current native account owner required.','locked');const guard=()=>{for(const current of [check,own]){const result=current();if(result===false||result?.then)throw gateRefusal('Synchronous account context required.','locked');}};guard();return guard;},

    /** Hooks for signSiloTransferDurably (solana-transfer-journal.mjs). */
    transferHooks(storage) {
      let opId=null,check=null,account=null,expected=null,began=false,admission=null,own=null;
      const context=()=>{if(typeof check!=='function')throw gateRefusal('Live transfer account context required.','locked');for(const current of [check,...(own?[own]:[])]){const result=current();if(result===false||result?.then)throw gateRefusal('Synchronous transfer account context required.','locked');}};
      const hooks={
        beforeWalletPrompt:async()=>{
          if(began)throw gateRefusal('Transfer prompt admission is one-use.','locked');began=true;
          check=captureContext();context();const described=describeSavedTransfer(storage);
          if(typeof client.transferOwnerGuard!=='function')throw gateRefusal('Current native account owner required.','locked');own=client.transferOwnerGuard(described?.owner);if(typeof own!=='function')throw gateRefusal('Current native account owner required.','locked');context();
          opId=await admit(described);context();
          if(typeof client.promptGuard!=='function')throw gateRefusal('Immediate transfer account guard unavailable.','locked');
          account=await client.promptGuard(opId);context();if(typeof account!=='function')throw gateRefusal('Immediate transfer account guard unavailable.','locked');
          expected=JSON.stringify({...described.record,promptStarted:true});
        },
        assertPrompt:()=>{
          context();if(!expected||typeof account!=='function')throw gateRefusal('Live transfer account prompt required.','locked');
          const result=account();if(result===false||result?.then)throw gateRefusal('Synchronous transfer account guard required.','locked');
          const described=describeSavedTransfer(storage);if(described?.state!=='prompt-started'||JSON.stringify(described.record)!==expected)throw gateRefusal('Exact transfer prompt record changed.','no-reservation');
          const final=account();if(final===false||final?.then)throw gateRefusal('Synchronous transfer account guard required.','locked');
          if(JSON.stringify(describeSavedTransfer(storage)?.record)!==expected)throw gateRefusal('Exact transfer prompt record changed.','no-reservation');context();
          if(!admission){admission=Object.freeze({kind:'silo-account-transfer-admission-v1'});transferAdmissions.set(admission,{wire:described.record.wire,owner:described.owner,network:described.network,guard:()=>hooks.assertPrompt(),used:false});}
          return admission;
        },
        // The exact signed bytes are already durable. Publish their evidence even
        // if a later UI/context check will hold submission; never erase capture.
        afterCapture:async()=>{await signed(opId,describeSavedTransfer(storage));context();},
      };
      return hooks;
    },

    /** Stable uncertain-attempt evidence is published before any dispatch. */
    transferSubmission(storage){return async()=>{
      const check=captureContext(),context=()=>{if(typeof check!=='function')throw gateRefusal('Live account context required.','locked');const result=check();if(result===false||result?.then)throw gateRefusal('Synchronous account context required.','locked');};
      context();const described=describeSavedTransfer(storage),expected=JSON.stringify(described?.record);
      if(described?.state!=='signed'||described.record.version!==2||described.record.submissionApproved!==true)throw gateRefusal('Approved original transfer review required.','record-held');
      const same=()=>{context();if(JSON.stringify(describeSavedTransfer(storage)?.record)!==expected)throw gateRefusal('Exact saved transfer changed.','record-held');};
      await client.sync();same();const matches=(await client.operations()).filter(op=>!op.legacy&&!op.conflict&&op.kind===described.kind&&op.network===described.network&&op.binding?.owner===described.owner&&op.binding?.messageHash===described.messageHash&&op.signature===described.signature&&['signed','submitted'].includes(op.state));
      same();if(matches.length!==1)throw gateRefusal('One published signed transfer required.','record-held');const op=matches[0];
      if(op.state==='signed'){const written=await client.recordSubmitted(op.opId,{receipt:{kind:'silo-exact-transfer-attempt-v1',network:described.network,signature:described.signature,messageHash:described.messageHash}});same();if(written?.queued)throw gateRefusal('Transfer attempt is queued. Nothing was submitted.','record-held');}
      if(typeof client.transferSubmissionGuard!=='function')throw gateRefusal('Immediate transfer dispatch guard required.','record-held');
      const guard=await client.transferSubmissionGuard(op.opId,{network:described.network,messageHash:described.messageHash,owner:described.owner,signature:described.signature,record:described.record});same();
      if(typeof guard!=='function')throw gateRefusal('Immediate transfer dispatch guard required.','record-held');
      return ()=>{same();const result=guard();if(result===false||result?.then)throw gateRefusal('Synchronous transfer dispatch guard required.','record-held');same();};
    };},

    /** Account publication, independent settlement and authenticated readback must
     * finish before the transfer journal removes its last local signed bytes. */
    transferRetirement(storage) {
      return async(row,outcome)=>{
        const check=captureContext();
        const context=()=>{if(typeof check!=='function')throw gateRefusal('Current account context required.','locked');const result=check();if(result===false||result?.then)throw gateRefusal('Synchronous account context required.','locked');};
        context();const described=describeSavedTransfer(storage),expected=JSON.stringify(row);
        if(!described||described.state!=='signed'||JSON.stringify(described.record)!==expected||outcome?.signature!==described.signature||!['finalized','failed'].includes(outcome?.state))
          throw gateRefusal('Exact signed transfer outcome required.','record-held');
        const same=()=>{context();if(JSON.stringify(describeSavedTransfer(storage)?.record)!==expected)throw gateRefusal('Saved transfer changed.','record-held');};
        await client.sync();same();
        const matches=(await client.operations()).filter(op=>!op.legacy&&!op.conflict&&op.kind===described.kind&&op.network===described.network&&op.binding?.messageHash===described.messageHash&&op.binding?.owner===described.owner);
        same();if(matches.length!==1)throw gateRefusal('One exact account operation required. Recovery stays saved.','record-held');
        const op=matches[0];
        if(['reserved','prompt-started'].includes(op.state))await signed(op.opId,described);
        else if(op.signature!==described.signature)throw gateRefusal('Account signature differs. Recovery stays saved.','record-held');
        same();const settled=await client.settleOperation(op.opId);same();
        if(settled?.status!==outcome.state||settled?.written?.queued||typeof client.terminalGuard!=='function')throw gateRefusal('Account terminal proof is not published. Recovery stays saved.','record-held');
        const guard=await client.terminalGuard(op.opId,{kind:described.kind,network:described.network,messageHash:described.messageHash,owner:described.owner,signature:described.signature,status:outcome.state});same();
        if(typeof guard!=='function')throw gateRefusal('Immediate terminal guard required.','record-held');
        return ()=>{same();const allowed=guard();if(allowed===false||allowed?.then)throw gateRefusal('Synchronous terminal guard required.','record-held');same();};
      };
    },

    /** Wraps any Jupiter journal store (core, shared, direct, managed). The wrapped store is passed to the existing flow
     * in place of the original; every other method is the original's. */
    jupiterStore(store, storage) {
      const permits=new WeakMap();
      const context=()=>{const check=captureContext();if(typeof check!=='function')throw gateRefusal('Synchronous account context required.','locked');return ()=>{if(check()?.then)throw gateRefusal('Asynchronous account guard refused.','locked');};};
      return {...store,
        ...(typeof store.assertPrompt==='function'?{assertPrompt:review=>{
          const permit=permits.get(review);if(!permit)throw gateRefusal('Live account prompt reservation required.','locked');
          permit.context();if(permit.account()?.then)throw gateRefusal('Asynchronous account guard refused.','locked');store.assertPrompt(review);
        }}:{}),
        reserveAndSign: async (review, callbacks) => {
          const check=context();check();let opId=null;
          try{
            if(typeof callbacks==='function')return await store.reserveAndSign(review,(markPrompt,captureSigned)=>callbacks(
              async()=>{check();opId=await admit(describeSavedSwap(storage));check();return markPrompt();},
              async encoded=>{const row=captureSigned(encoded);await signed(opId,describeSavedSwap(storage));return row;}));
            const {beforePrompt=async()=>{},postCapture=async()=>{}}=callbacks??{};
            return await store.reserveAndSign(review,{...callbacks,
              beforePrompt:async(...args)=>{
                check();await beforePrompt(...args);check();opId=await admit(describeSavedSwap(storage));check();
                if(typeof store.assertPrompt==='function'){
                  if(typeof client.promptGuard!=='function')throw gateRefusal('Immediate account guard unavailable.','locked');
                  const account=await client.promptGuard(opId);check();if(typeof account!=='function')throw gateRefusal('Immediate account guard unavailable.','locked');
                  permits.set(review,{context:check,account});
                }
              },
              postCapture:async(row,...args)=>{await signed(opId,describeSavedSwap(storage));return postCapture(row,...args);}
            });
          }finally{permits.delete(review);}
        }
      };
    },

    /** Monero (SYNC-GATE-01). The wallet engine creates and signs the payment inside `prepare` (createTx, relay: false), and a
     * conflicting cancel sweeps and relays another one. So the account is involved before each engine action:
     *   begin()    — before prepare: sync, refuse while anything blocks or the device is not trusted, and reserve the payment
     *                intent {network, address, amount, nonce}; nothing in the engine runs without it;
     *   persist()  — wraps draft.submit's save: before the payment is saved as sent or broadcast, the account holds it as
     *                signed (prompt and signature in one commit, published or refused) with the exact pending record;
     *   abandon()  — a reservation whose payment was never committed is cancelled (creator only, never after commit).
     * `pending()` returns the wallet journal's pending record (xmr-adapter.mjs `pendingRecord`). */
    xmrPayment({network = 'mainnet'} = {}) {
      return Object.freeze({
        async begin({address, amount}) {
          const intent = xmrIntent({network, address, amount});
          try {
            const messageHash = await xmrIntentHash(intent);
            const {opId} = await client.reserveOperation({kind: 'xmr-payment', network, review: intent, binding: {messageHash, intent}});
            return Object.freeze({opId, intent, messageHash});
          } catch (error) { throw refuse(error); }
        },
        persist(ticket, pending, persist) {
          return async () => {
            const record = pending();
            const hash = record?.authorized?.hash;
            if (!ticket || !/^[a-f0-9]{64}$/.test(hash ?? '') || !xmrRecordMatches(ticket.intent, record)) throw gateRefusal('The payment differs from the reserved one. Nothing was sent.', 'no-reservation');
            if (record.status === 'unconfirmed') {
              try { await client.recordPromptAndSigned(ticket.opId, {signature: hash, messageHash: ticket.messageHash, record: {schema: XMR_RECORD, intent: ticket.intent, pending: record}}); }
              catch (error) { throw refuse(error); }
            }
            return persist();
          };
        },
        /** A payment the wallet already holds (restored after a reload, or saved before this account existed): reuse the
         * account operation that names it, or reserve its intent now so it is recorded before it is resent. */
        async ticketFor(pending) {
          const hash = pending?.authorized?.hash;
          if (!/^[a-f0-9]{64}$/.test(hash ?? '')) throw gateRefusal('No saved payment to resend.', 'no-reservation');
          try {
            const op = (await client.operations()).find((row) => row.kind === 'xmr-payment' && !row.legacy && (row.signature === hash || (row.state === 'reserved' && xmrRecordMatches(row.binding?.intent, pending))));
            if (op?.binding?.intent) return Object.freeze({opId: op.opId, intent: op.binding.intent, messageHash: op.binding.messageHash});
          } catch (error) { throw refuse(error); }
          return this.begin({address: pending.review.address, amount: pending.review.amount});
        },
        async abandon(ticket) {
          if (!ticket) return;
          // A lookup or cancellation that fails is reported, not swallowed: the caller keeps the review on screen (review N5).
          let op; try { op = await client.operation(ticket.opId); } catch (error) { throw gateRefusal('The reservation could not be read; the review is kept.', 'reservation-unknown', {cause: error}); }
          if (op?.state === 'reserved') { try { await client.cancelBeforePrompt(ticket.opId); } catch (error) { throw gateRefusal('The reservation could not be retired; the review is kept.', 'reservation-kept', {cause: error}); } }
        },
      });
    },

    /** Cancelling a Monero payment by a conflicting spend of one of its inputs (xmr-adapter.mjs `cancelByConflict`). Before
     * the engine sweeps or relays: the device must be trusted and online, the payment must be the account's open signed
     * payment, and nothing else may block. A cancelling payment already on the account is adopted and its exact bytes relayed
     * (no second sweep, on any device); a new one is published to the account before it is saved or relayed. `adopt` is
     * xmr-adapter.mjs `adoptConflict`. */
    async xmrCancel({pending, adopt}, run, persist) {
      const record = pending?.();
      const hash = record?.authorized?.hash;
      if (!/^[a-f0-9]{64}$/.test(hash ?? '')) throw gateRefusal('No unconfirmed payment to cancel.', 'no-reservation');
      let op;
      try {
        await client.sync();
        const trust = await client.trust();
        if (!trust || !['genesis', 'approval', 'recovery'].includes(trust.via) || (trust.via === 'recovery' && trust.reconciled !== true)) throw Object.assign(Error('untrusted'), {syncCode: 'not-trusted'});
        if (client.status?.status === 'conflict') throw Object.assign(Error('conflict'), {syncCode: 'conflict'});
        op = (await client.operations()).find((row) => row.kind === 'xmr-payment' && !row.legacy && row.signature === hash);
        if (!op) throw gateRefusal('This payment is not recorded on the account. Nothing was swept or sent.', 'not-on-account');
        if (TERMINAL.has(op.state) || op.conflict) throw gateRefusal('This payment is already resolved or held for review. Nothing was swept or sent.', 'held');
        const others = (await client.blockingOperations()).filter((row) => row.opId !== op.opId);
        if (others.length) throw Object.assign(Error('blocked'), {syncCode: 'pending-operation', blocking: others});
      } catch (error) { throw refuse(error); }
      const recordOnAccount = async (conflict) => {
        try { await client.recordCancellation(op.opId, conflict); }
        catch (error) { throw error?.syncCode === 'cancellation-differs' ? gateRefusal('Another device already recorded a different cancelling payment. Nothing was sent.', 'held') : refuse(error); }
      };
      const local = record.conflict ? {hash: record.conflict.hash, keyImage: record.conflict.keyImage, metadata: record.conflict.metadata} : null;
      if (op.cancellation && local && JSON.stringify(op.cancellation) !== JSON.stringify(local)) throw gateRefusal('This device holds a different cancelling payment than the account. Nothing was sent.', 'held');
      if (op.cancellation && !local) await adopt(op.cancellation, persist);
      else if (local && !op.cancellation) await recordOnAccount(local);
      // A cancelling payment the engine prepares now reaches the account before the wallet saves or relays it.
      return run(async () => { const conflict = pending()?.conflict; if (conflict) await recordOnAccount({hash: conflict.hash, keyImage: conflict.keyImage, metadata: conflict.metadata}); return persist(); });
    },

    /** The candidate preserves every local journal record as a permanent legacy hold (legacy-journals.mjs). Records this
     * gate already tracks as account operations (same kind and message hash; pending rows and their terminal receipts)
     * are not legacy and are left out; everything else, including anything unreadable, is preserved unchanged. */
    unexplainedLegacy(snapshot, operations) {
      const tracked = new Set(operations.filter((op) => !op.legacy).map((op) => `${op.kind}:${op.binding?.messageHash}`));
      const describe = (storageKey, text) => {
        try {
          const receipt = storageKey !== SILO_TRANSFER_STORAGE_KEY && storageKey !== SILO_JUPITER_STORAGE_KEY;
          if (storageKey.endsWith('-history')) return null;
          const row = receipt ? JSON.parse(text)?.journal : JSON.parse(text);
          const key = storageKey === SILO_TRANSFER_STORAGE_KEY ? SILO_TRANSFER_STORAGE_KEY : SILO_JUPITER_STORAGE_KEY;
          const one = {getItem: (k) => k === key ? JSON.stringify(row) : null, setItem() {}, removeItem() {}};
          return key === SILO_TRANSFER_STORAGE_KEY ? describeSavedTransfer(one) : describeSavedSwap(one);
        } catch { return null; }
      };
      const records = snapshot.records.filter((record) => { const d = describe(record.storageKey, record.text); return !(d && tracked.has(`${d.kind}:${d.messageHash}`)); });
      return {...snapshot, records};
    },

    /** After reconnecting, unlocking or reloading: finish this device's records from its own saved journals, retire its
     * reservations that never reached a prompt, and settle signed operations through this device's own verifiers. */
    async resume({transferStorage, swapStorage, xmrPending} = {}) {
      const saved = [];
      for (const [storage, describe] of [[transferStorage, describeSavedTransfer], [swapStorage, describeSavedSwap]]) {
        if (!storage) continue;
        try { const described = describe(storage); if (described) saved.push(described); } catch { /* An unreadable local record keeps its own hold. */ }
      }
      const pendingXmr = xmrPending?.();
      const result = {recorded: [], cancelled: [], settled: [], held: []};
      await client.sync(); // publishes evidence kept on this device while offline (e.g. a queued cancellation or signed record)
      for (const op of await client.operations()) {
        if (!op.own || op.legacy || TERMINAL.has(op.state)) continue;
        const local = saved.find((row) => row.kind === op.kind && row.messageHash === op.binding?.messageHash);
        try {
          if (op.kind === 'xmr-payment') {
            // Monero: a reservation whose payment this wallet does not hold was never committed; one it holds stays (retry).
            const held = pendingXmr && op.binding?.intent && xmrRecordMatches(op.binding.intent, pendingXmr);
            if (op.state === 'reserved' && !held) { await client.cancelBeforePrompt(op.opId); result.cancelled.push(op.opId); continue; }
            if (op.state !== 'reserved') { const settled = await client.settleOperation(op.opId); if (settled.status !== 'unknown') { result.settled.push(op.opId); continue; } }
            result.held.push(op.opId); continue;
          }
          if (op.state === 'reserved' && (!local || local.state === 'reserved')) { await client.cancelBeforePrompt(op.opId); result.cancelled.push(op.opId); continue; }
          if (['reserved', 'prompt-started'].includes(op.state) && local?.state === 'signed') { await recordSavedAsSigned(client, op.opId, local); result.recorded.push(op.opId); }
          if (local?.state === 'signed' || ['signed', 'submitted'].includes(op.state)) {
            const settled = await client.settleOperation(op.opId);
            if (settled.status !== 'unknown') { result.settled.push(op.opId); continue; }
          }
          result.held.push(op.opId);
        } catch { result.held.push(op.opId); }
      }
      return result;
    },
  };
  return Object.freeze(gate);
}

/** What each signing component composes. With account sync off (`required: false`) the existing flows are unchanged. With
 * it on, a gate must be available (vault unlocked, synced, device trusted); without one every signing window refuses
 * before a wallet prompt or a Monero broadcast, leaving the existing journals exactly as their own failure paths do. */
export function accountSigning({required = false, gate = null} = {}) {
  const missing = () => gateRefusal('Unlock the account vault on an approved device to sign. Nothing was signed.', 'locked');
  return Object.freeze({
    required,
    transferContext: (owner) => gate ? gate.transferContext(owner) : required ? (()=>{throw missing();})() : ()=>{},
    transferHooks: (storage) => gate ? gate.transferHooks(storage) : required ? {beforeWalletPrompt: async () => { throw missing(); }} : {},
    transferSubmission: (storage) => gate ? gate.transferSubmission(storage) : required ? async () => { throw missing(); } : undefined,
    transferRetirement: (storage) => gate ? gate.transferRetirement(storage) : required ? async () => { throw missing(); } : undefined,
    jupiterStore: (store, storage) => gate ? gate.jupiterStore(store, storage) : required ? {...store, reserveAndSign: async () => { throw missing(); }} : store,
    // Monero: null when account sync is off (the wallet's own journal alone, as before).
    xmr: (network = 'mainnet') => gate ? gate.xmrPayment({network}) : required ? Object.freeze({begin: async () => { throw missing(); }, persist: () => async () => { throw missing(); }, abandon: async () => {}}) : null,
    xmrCancel: (source, run, persist) => gate ? gate.xmrCancel(source, run, persist) : required ? Promise.reject(missing()) : run(persist),
  });
}

/** The closed beta without account sync (lib/silo/payment-authority.mjs, 'local-beta'). The shape every signing component
 * composes, with this device as the only authority: the Solana flow keeps its exclusive Web Lock and its durable journal and
 * is admitted by the server review and submission routes (bound to this browser's invitation); Monero keeps its own encrypted
 * pending record. Jupiter execution stays held: its mutation paths carry no beta admission yet (review N2). */
export function localBetaSigning() {
  const noop = () => {};
  // The native transfer boundary consumes a one-use admission (consumeSiloTransferAccountAdmission). With this device as the
  // only authority it binds the exact local prompt record (wire, owner, network) instead of an account operation; the server
  // review and submission routes stay the admission, bound to this browser's invitation.
  const transferHooks = (storage) => {
    let expected = null, admission = null;
    const current = () => {
      const described = describeTransfer(storage);
      if (!expected || described?.state !== 'prompt-started' || JSON.stringify(described.record) !== expected) throw gateRefusal('Exact transfer prompt record changed.', 'no-reservation');
      return described;
    };
    const hooks = {
      beforeWalletPrompt: async () => {
        if (expected) throw gateRefusal('Transfer prompt admission is one-use.', 'locked');
        const described = describeTransfer(storage);
        if (described?.state !== 'reserved') throw gateRefusal('The local reservation is missing. Nothing was signed.', 'no-reservation');
        expected = JSON.stringify({...described.record, promptStarted: true});
      },
      assertPrompt: () => {
        const described = current();
        if (!admission) { admission = Object.freeze({kind: 'silo-local-beta-transfer-admission-v1'}); transferAdmissions.set(admission, {wire: described.record.wire, owner: described.owner, network: described.network, guard: () => { current(); }, used: false}); }
        return admission;
      },
    };
    return hooks;
  };
  return Object.freeze({
    required: false,
    policy: 'local-beta',
    transferContext: () => noop,
    transferHooks,
    transferSubmission: () => async () => noop,
    transferRetirement: () => async () => noop,
    jupiterStore: (store) => ({...store, reserveAndSign: async () => { throw gateRefusal('Swaps are held in the closed beta.', 'held'); }}),
    xmr: () => null,
    xmrCancel: (_source, run, persist) => run(persist),
  });
}
