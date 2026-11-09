//! Grain Silo ZEC core. A thin wasm-bindgen layer over the maintained upstream wallet stack: account, address,
//! scanning and storage logic come from `zcash_client_backend` and `zcash_client_sqlite`; this crate only binds them.
//! The wallet database lives in an in-memory SQLite and is moved in and out of Silo's encrypted envelope as bytes.
pub mod sync;

// Offline feasibility evidence only; no migration entry point is exported to the wallet.
#[cfg(all(test, not(target_arch = "wasm32")))]
mod migration_probe;

use std::time::SystemTime;

use bip0039::{English, Mnemonic};
use rand::rngs::SysRng;
type OsRng = rand::rand_core::UnwrapErr<SysRng>;
fn os_rng() -> OsRng { rand::rand_core::UnwrapErr(SysRng) }
use rusqlite::{Connection, MAIN_DB};
use secrecy::SecretVec;
use wasm_bindgen::prelude::*;
use zcash_address::unified::{self, Container, Encoding};
use zcash_client_backend::data_api::{chain::ChainState, Account as _, AccountBirthday, WalletRead, WalletWrite};
use zcash_client_backend::data_api::wallet::{
    create_proposed_transactions, propose_standard_transfer_to_address, ConfirmationsPolicy, SpendingKeys,
};
use zcash_client_backend::fees::StandardFeeRule;
use zcash_client_backend::proto::proposal::Proposal as ProtoProposal;
use zcash_client_backend::proto::service::{BlockId, ChainSpec, Empty, RawTransaction, TreeState};
use zcash_client_backend::wallet::OvkPolicy;
use prost::Message as _;
use secrecy::ExposeSecret;
use zcash_client_sqlite::{util::Clock, wallet::init::init_wallet_db, AccountUuid, WalletDb};
use zcash_primitives::block::BlockHash;
use zcash_keys::address::Address;
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedSpendingKey};
use zcash_primitives::transaction::TxId;
use zcash_protocol::consensus::{BlockHeight, BranchId, Network, NetworkType, NetworkUpgrade, Parameters};
use zcash_protocol::value::Zatoshis;
use zcash_protocol::ShieldedPool;

/// Wall clock from the JS host; `SystemTime::now` is unavailable on wasm32-unknown-unknown.
#[derive(Clone, Copy)]
struct JsClock;
impl Clock for JsClock {
    fn now(&self) -> SystemTime {
        #[cfg(target_arch = "wasm32")]
        return std::time::UNIX_EPOCH + std::time::Duration::from_millis(js_sys::Date::now() as u64);
        #[cfg(not(target_arch = "wasm32"))]
        return SystemTime::now();
    }
}

/// Upstream scanning decrypts notes on a rayon pool (`zcash_client_backend::scan::BatchRunner`) and waits on channels, so the
/// core runs in a dedicated worker (the page's main thread may not block) that calls `initThreadPool(n)`; the page must be
/// cross-origin isolated, as with the current engine.
#[cfg(target_arch = "wasm32")]
pub use wasm_bindgen_rayon::init_thread_pool;

/// An error that reaches JavaScript as an `Error` with this message (plain Rust elsewhere, so native tests can inspect it).
#[derive(Debug)]
pub struct CoreError(String);
impl CoreError {
    fn new(message: &str) -> Self {
        CoreError(message.to_string())
    }
}
impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl From<CoreError> for JsValue {
    fn from(error: CoreError) -> JsValue {
        js_sys::Error::new(&error.0).into()
    }
}

fn err<E: std::fmt::Display>(e: E) -> CoreError {
    CoreError(e.to_string())
}

fn network(name: &str) -> Result<Network, CoreError> {
    match name {
        "test" => Ok(Network::TestNetwork),
        "main" => Ok(Network::MainNetwork),
        _ => Err(CoreError::new("Invalid network")),
    }
}

fn seed(phrase: &str) -> Result<SecretVec<u8>, CoreError> {
    let mnemonic = <Mnemonic<English>>::from_phrase(phrase).map_err(|_| CoreError::new("Invalid recovery phrase"))?;
    Ok(SecretVec::new(mnemonic.to_seed("").to_vec()))
}

/// Encodes only the Orchard receiver of a unified address, as Silo shows and accepts.
fn orchard_only(encoded: &str, params: &Network) -> Result<String, CoreError> {
    let (net, _revision, address) = unified::Address::decode(encoded).map_err(|_| CoreError::new("Invalid unified address"))?;
    if net != params.network_type() {
        return Err(CoreError::new("Network mismatch"));
    }
    let receiver = address
        .items()
        .into_iter()
        .find(|item| matches!(item, unified::Receiver::Orchard(_)))
        .ok_or_else(|| CoreError::new("Orchard receiver required"))?;
    if let unified::Receiver::Orchard(raw) = &receiver {
        if !bool::from(orchard::Address::from_raw_address_bytes(&raw).is_some()) {
            return Err(CoreError::new("Invalid Orchard receiver"));
        }
    }
    Ok(unified::Address::try_from_items(zcash_protocol::address::Revision::R0, vec![unified::Uitem::Data(receiver)]).map_err(err)?.encode(&net))
}

#[wasm_bindgen]
pub fn silo_orchard_address(encoded: &str, target_network: &str) -> Result<String, CoreError> {
    orchard_only(encoded, &network(target_network)?)
}

/// A new 24-word BIP39 English recovery phrase from the platform's secure random source.
#[wasm_bindgen]
pub fn generate_phrase() -> String {
    let mut entropy = [0u8; 32];
    rand::Rng::fill_bytes(&mut os_rng(), &mut entropy);
    let phrase = <Mnemonic<English>>::from_entropy(entropy.to_vec()).expect("32 bytes is valid BIP39 entropy").into_phrase();
    entropy.fill(0);
    phrase
}

/// Activation heights compiled into this engine, so the caller can prove the upgrades it supports.
#[wasm_bindgen]
pub fn network_upgrades(target_network: &str) -> Result<JsValue, CoreError> {
    let params = network(target_network)?;
    let out = js_sys::Object::new();
    for (name, nu) in [
        ("nu5", NetworkUpgrade::Nu5),
        ("nu6", NetworkUpgrade::Nu6),
        ("nu6_1", NetworkUpgrade::Nu6_1),
        ("nu6_2", NetworkUpgrade::Nu6_2),
        ("nu6_3", NetworkUpgrade::Nu6_3),
        ("nu7", NetworkUpgrade::Nu7),
    ] {
        let height = params.activation_height(nu).map(|h| JsValue::from(u32::from(h))).unwrap_or(JsValue::NULL);
        js_sys::Reflect::set(&out, &name.into(), &height).map_err(|_| CoreError::new("upgrade table"))?;
    }
    Ok(out.into())
}

/// Native-only test hook: scans blocks already in hand, as `sync::run` does after download.
#[cfg(not(target_arch = "wasm32"))]
impl SiloZecCore {
    pub fn scan_for_test(&mut self, prior: TreeState, blocks: Vec<zcash_client_backend::proto::compact_formats::CompactBlock>) -> Result<(), String> {
        use zcash_client_backend::data_api::chain::{scan_cached_blocks, BlockCache};
        let params = self.params;
        let tip = blocks.last().map(|b| b.height()).ok_or("no blocks")?;
        let from = blocks[0].height();
        let n = blocks.len();
        let cache = sync::MemBlockCache::default();
        futures_executor_block_on(cache.insert(blocks)).map_err(|e| e.to_string())?;
        let mut db = WalletDb::from_connection(&mut self.conn, params, JsClock, os_rng());
        db.update_chain_tip(tip).map_err(|e| e.to_string())?;
        let state = prior.to_chain_state().map_err(|e| e.to_string())?;
        scan_cached_blocks(&params, &cache, &mut db, from, &state, n).map_err(|e| format!("{e:?}"))?;
        Ok(())
    }

    /// Native-only test hook: a stored transaction, for inspecting what `create_proposed_transactions` built.
    pub fn transaction_for_test(&mut self, id: &[u8]) -> Option<zcash_primitives::transaction::Transaction> {
        let txid = TxId::from_bytes(id.try_into().ok()?);
        self.db().get_transaction(txid).ok()?
    }
}
#[cfg(not(target_arch = "wasm32"))]
fn futures_executor_block_on<F: std::future::Future>(f: F) -> F::Output {
    let waker = std::task::Waker::noop();
    let mut cx = std::task::Context::from_waker(&waker);
    let mut f = std::pin::pin!(f);
    loop {
        if let std::task::Poll::Ready(v) = f.as_mut().poll(&mut cx) {
            return v;
        }
    }
}

#[wasm_bindgen]
pub struct SiloZecCore {
    conn: Connection,
    params: Network,
    account: AccountUuid,
}

/// An in-memory connection set up as `WalletDb::for_path` sets up its own: the store's queries need the `rarray` module.
fn connection(database: Option<&[u8]>) -> Result<Connection, CoreError> {
    let mut conn = Connection::open_in_memory().map_err(err)?;
    if let Some(bytes) = database {
        conn.deserialize_read_exact(MAIN_DB, bytes, bytes.len(), false).map_err(err)?;
    }
    rusqlite::vtab::array::load_module(&conn).map_err(err)?;
    Ok(conn)
}

impl SiloZecCore {
    fn db(&mut self) -> WalletDb<&mut Connection, Network, JsClock, OsRng> {
        WalletDb::from_connection(&mut self.conn, self.params, JsClock, os_rng())
    }
    fn migrate(conn: &mut Connection, params: Network, seed: Option<SecretVec<u8>>) -> Result<(), CoreError> {
        let mut db = WalletDb::from_connection(conn, params, JsClock, os_rng());
        init_wallet_db(&mut db, seed).map_err(err)
    }
}

#[wasm_bindgen]
impl SiloZecCore {
    /// New or restored wallet: ZIP-32 account 0 from the BIP39 phrase (empty passphrase). `tree_state` is the protobuf
    /// `TreeState` of the block before the birthday from lightwalletd; without it the birthday is Sapling activation.
    pub fn create(target_network: &str, phrase: &str, tree_state: Option<Vec<u8>>) -> Result<SiloZecCore, CoreError> {
        let params = network(target_network)?;
        let seed = seed(phrase)?;
        let birthday = match tree_state {
            Some(bytes) => {
                let state = TreeState::decode(bytes.as_slice()).map_err(err)?;
                AccountBirthday::from_treestate(state, None).map_err(|_| CoreError::new("Invalid tree state"))?
            }
            None => {
                // Empty trees as of the block before Sapling activation: the true state for a birthday at activation.
                let sapling = params.activation_height(NetworkUpgrade::Sapling).ok_or_else(|| CoreError::new("No Sapling activation"))?;
                AccountBirthday::from_parts(ChainState::empty(sapling - 1, BlockHash([0; 32])), None)
            }
        };
        let mut conn = connection(None)?;
        Self::migrate(&mut conn, params, None)?;
        let mut db = WalletDb::from_connection(&mut conn, params, JsClock, os_rng());
        let (account, _usk) = db
            .import_account_hd("Grain Silo", &seed, zip32::AccountId::ZERO, &birthday, None)
            .map_err(err)?;
        let account = account.id();
        Ok(SiloZecCore { conn, params, account })
    }

    /// Reopens a wallet from its database bytes and applies any pending upstream schema migrations.
    pub fn open(target_network: &str, database: &[u8]) -> Result<SiloZecCore, CoreError> {
        let params = network(target_network)?;
        let mut conn = connection(Some(database))?;
        Self::migrate(&mut conn, params, None)?;
        let ids = WalletDb::from_connection(&mut conn, params, JsClock, os_rng()).get_account_ids().map_err(err)?;
        let account = match ids.as_slice() {
            [only] => *only,
            _ => return Err(CoreError::new("Expected exactly one account")),
        };
        Ok(SiloZecCore { conn, params, account })
    }

    /// The wallet database as bytes for Silo's encrypted envelope.
    pub fn to_bytes(&self) -> Result<Vec<u8>, CoreError> {
        Ok(self.conn.serialize(MAIN_DB).map_err(err)?.to_vec())
    }

    /// ZIP-32 account index and birthday height of the single Silo account.
    pub fn account_index(&mut self) -> Result<u32, CoreError> {
        let id = self.account;
        let account = self.db().get_account(id).map_err(err)?.ok_or_else(|| CoreError::new("Account not found"))?;
        account
            .source()
            .key_derivation()
            .map(|d| u32::from(d.account_index()))
            .ok_or_else(|| CoreError::new("Account has no seed derivation"))
    }
    pub fn birthday(&mut self) -> Result<u32, CoreError> {
        let id = self.account;
        Ok(u32::from(self.db().get_account_birthday(id).map_err(err)?))
    }

    /// The Orchard-only unified address Silo displays for receiving.
    pub fn orchard_address(&mut self) -> Result<String, CoreError> {
        let (params, id) = (self.params, self.account);
        let ua = self
            .db()
            .get_last_generated_address_matching(id, UnifiedAddressRequest::ALLOW_ALL)
            .map_err(err)?
            .ok_or_else(|| CoreError::new("No address generated"))?;
        orchard_only(&ua.encode(&params), &params)
    }

    pub fn chain_height(&mut self) -> Result<Option<u32>, CoreError> {
        Ok(self.db().chain_height().map_err(err)?.map(u32::from))
    }
}

#[wasm_bindgen]
impl SiloZecCore {
    /// Scans from the wallet's birthday to the server's tip with upstream `sync::run`.
    pub async fn sync(&mut self, lightwalletd_url: String) -> Result<(), CoreError> {
        let mut client = sync::client(&lightwalletd_url);
        let cache = sync::MemBlockCache::default();
        let params = self.params;
        let mut db = WalletDb::from_connection(&mut self.conn, params, JsClock, os_rng());
        zcash_client_backend::sync::run(&mut client, &params, &cache, &mut db, 1000).await.map_err(err)
    }

    /// Per-pool balances from the upstream wallet summary (zatoshis), with the scan state they rest on.
    pub fn summary(&mut self) -> Result<String, CoreError> {
        let id = self.account;
        let summary = self.db().get_wallet_summary(ConfirmationsPolicy::default()).map_err(err)?;
        let Some(summary) = summary else { return Ok("null".into()) };
        let balance = summary.account_balances().get(&id).ok_or_else(|| CoreError::new("Account not in summary"))?;
        let pool = |b: &zcash_client_backend::data_api::Balance| serde_json::json!({
            "spendable": u64::from(b.spendable_value()),
            "pendingChange": u64::from(b.change_pending_confirmation()),
            "pendingSpendability": u64::from(b.value_pending_spendability()),
            "total": u64::from(b.total()),
        });
        Ok(serde_json::json!({
            "chainTip": u32::from(summary.chain_tip_height()),
            "fullyScanned": u32::from(summary.fully_scanned_height()),
            "sapling": pool(balance.sapling_balance()),
            "orchard": pool(balance.orchard_balance()),
            "ironwood": pool(balance.ironwood_balance()),
            "total": u64::from(balance.total()),
        }).to_string())
    }
}

/// Protobuf `TreeState` for the block before `birthday`, to pass to `SiloZecCore::create`.
#[wasm_bindgen]
pub async fn fetch_tree_state(lightwalletd_url: String, birthday: u32) -> Result<Vec<u8>, CoreError> {
    let mut client = sync::client(&lightwalletd_url);
    let state = client
        .get_tree_state(BlockId { height: u64::from(birthday.saturating_sub(1)), hash: vec![] })
        .await
        .map_err(err)?
        .into_inner();
    Ok(state.encode_to_vec())
}

/// What the server reports about its chain, compared with this engine's own rules: chain name, tip height, the consensus
/// branch the server is on and the branch this engine computes for that height, and the next upgrade the server announces.
/// A branch mismatch means the network has upgraded past this engine (or the server is on another chain): Silo then offers
/// recovery only.
#[wasm_bindgen]
pub async fn chain_check(lightwalletd_url: String, target_network: String) -> Result<String, CoreError> {
    let params = network(&target_network)?;
    let mut client = sync::client(&lightwalletd_url);
    let info = client.get_lightd_info(Empty {}).await.map_err(err)?.into_inner();
    let tip = u32::try_from(info.block_height).map_err(err)?;
    let engine_branch = format!("{:08x}", u32::from(BranchId::for_height(&params, BlockHeight::from_u32(tip))));
    let expected_chain = match params.network_type() {
        NetworkType::Main => "main",
        NetworkType::Test => "test",
        NetworkType::Regtest => "regtest",
    };
    Ok(serde_json::json!({
        "chainName": info.chain_name,
        "chainMatches": info.chain_name == expected_chain,
        "tip": tip,
        "serverBranch": info.consensus_branch_id.to_ascii_lowercase(),
        "engineBranch": engine_branch,
        "branchMatches": info.consensus_branch_id.eq_ignore_ascii_case(&engine_branch),
        "nextUpgrade": {"name": info.upgrade_name, "height": info.upgrade_height},
    })
    .to_string())
}

/// Height of the server's latest block.
#[wasm_bindgen]
pub async fn latest_height(lightwalletd_url: String) -> Result<u32, CoreError> {
    let mut client = sync::client(&lightwalletd_url);
    let block = client.get_latest_block(ChainSpec {}).await.map_err(err)?.into_inner();
    u32::try_from(block.height).map_err(err)
}

/// Silo spends and receives only in Orchard and Ironwood, so no Sapling proving parameters are shipped. A proposal that would
/// need a Sapling proof fails in the builder (`prepare_circuit` returns `None`) instead of producing one.
struct NoSaplingProofs;
impl sapling::prover::SpendProver for NoSaplingProofs {
    type Proof = ();
    #[allow(clippy::too_many_arguments)]
    fn prepare_circuit(
        _: sapling::ProofGenerationKey,
        _: sapling::Diversifier,
        _: sapling::Rseed,
        _: sapling::value::NoteValue,
        _: jubjub::Fr,
        _: sapling::value::ValueCommitTrapdoor,
        _: bls12_381::Scalar,
        _: sapling::MerklePath,
    ) -> Option<sapling::circuit::Spend> {
        None
    }
    fn create_proof<R: rand::Rng>(&self, _: sapling::circuit::Spend, _: &mut R) {
        unreachable!("no Sapling circuit is ever prepared")
    }
    fn encode_proof(_: ()) -> sapling::bundle::GrothProofBytes {
        unreachable!("no Sapling circuit is ever prepared")
    }
}
impl sapling::prover::OutputProver for NoSaplingProofs {
    type Proof = ();
    fn prepare_circuit(
        _: &sapling::keys::EphemeralSecretKey,
        _: sapling::PaymentAddress,
        _: jubjub::Fr,
        _: sapling::value::NoteValue,
        _: sapling::value::ValueCommitTrapdoor,
    ) -> sapling::circuit::Output {
        unreachable!("Silo proposals never contain Sapling outputs")
    }
    fn create_proof<R: rand::Rng>(&self, _: sapling::circuit::Output, _: &mut R) {
        unreachable!("Silo proposals never contain Sapling outputs")
    }
    fn encode_proof(_: ()) -> sapling::bundle::GrothProofBytes {
        unreachable!("Silo proposals never contain Sapling outputs")
    }
}

/// A frozen ZIP-317 proposal (protobuf) and its fee, for the user's review.
#[wasm_bindgen]
pub struct SiloProposal {
    encoded: Vec<u8>,
    fee: u64,
    steps: u32,
}

#[wasm_bindgen]
impl SiloProposal {
    pub fn fee_zatoshi(&self) -> u64 {
        self.fee
    }
    pub fn step_count(&self) -> u32 {
        self.steps
    }
}

fn txids(ids: &[u8]) -> Result<Vec<TxId>, CoreError> {
    if ids.is_empty() || ids.len() % 32 != 0 {
        return Err(CoreError::new("Invalid transaction identifiers"));
    }
    Ok(ids.chunks(32).map(|id| TxId::from_bytes(id.try_into().expect("32-byte chunk"))).collect())
}

#[wasm_bindgen]
impl SiloZecCore {
    /// Proposes paying `amount` zatoshis to an Orchard-only address with upstream input selection, ZIP-317 fees and change
    /// (which applies the Orchard turnstile: after NU6.3 value reaches an Orchard receiver through the Ironwood bundle).
    pub fn propose_transfer(&mut self, to: &str, amount: u64) -> Result<SiloProposal, CoreError> {
        let (params, id) = (self.params, self.account);
        if orchard_only(to, &params)? != to {
            return Err(CoreError::new("An Orchard-only address is required"));
        }
        let address = Address::decode(&params, to).ok_or_else(|| CoreError::new("Invalid address"))?;
        let amount = Zatoshis::from_u64(amount).map_err(|_| CoreError::new("Invalid amount"))?;
        let mut db = self.db();
        let proposal = propose_standard_transfer_to_address::<_, _, std::convert::Infallible>(
            &mut db,
            &params,
            StandardFeeRule::Zip317,
            id,
            ConfirmationsPolicy::default(),
            &address,
            amount,
            None,
            None,
            ShieldedPool::Orchard,
            None,
            None,
        )
        .map_err(err)?;
        let fee = proposal
            .steps()
            .iter()
            .try_fold(Zatoshis::ZERO, |sum, step| sum + step.balance().fee_required())
            .ok_or_else(|| CoreError::new("Fee overflow"))?;
        Ok(SiloProposal {
            encoded: ProtoProposal::from_standard_proposal(&proposal).encode_to_vec(),
            fee: u64::from(fee),
            steps: proposal.steps().len() as u32,
        })
    }

    /// Builds, proves and stores the proposal's transactions. The phrase must derive this wallet's account; nothing is sent.
    /// Returns the transaction identifiers (32 bytes each, internal byte order).
    pub fn create_proposed_transactions(&mut self, proposal: &SiloProposal, phrase: &str) -> Result<Vec<u8>, CoreError> {
        let (params, id) = (self.params, self.account);
        let seed = seed(phrase)?;
        let usk = UnifiedSpendingKey::from_seed(&params, seed.expose_secret(), zip32::AccountId::ZERO).map_err(err)?;
        let mut db = self.db();
        let account = db.get_account(id).map_err(err)?.ok_or_else(|| CoreError::new("Account not found"))?;
        let expected = account.ufvk().map(|k| k.encode(&params)).transpose().map_err(err)?;
        if expected.as_deref() != Some(usk.to_unified_full_viewing_key().encode(&params).map_err(err)?.as_str()) {
            return Err(CoreError::new("This recovery phrase does not belong to the wallet"));
        }
        let proposal = ProtoProposal::decode(proposal.encoded.as_slice())
            .map_err(err)?
            .try_into_standard_proposal(&params, &db)
            .map_err(err)?;
        let ids = create_proposed_transactions::<_, _, std::convert::Infallible, _, std::convert::Infallible, _>(
            &mut db,
            &params,
            &JsClock,
            &mut os_rng(),
            &NoSaplingProofs,
            &NoSaplingProofs,
            &SpendingKeys::from_unified_spending_key(usk),
            OvkPolicy::Sender,
            &proposal,
            None,
        )
        .map_err(err)?;
        Ok(ids.iter().flat_map(|txid| txid.as_ref().to_vec()).collect())
    }

    /// Each stored transaction's committed expiry height (ZIP 203; 0 = never expires).
    pub fn transaction_expiry_heights(&mut self, ids: &[u8]) -> Result<Vec<u32>, CoreError> {
        let db = self.db();
        txids(ids)?
            .into_iter()
            .map(|txid| {
                let tx = db.get_transaction(txid).map_err(err)?.ok_or_else(|| CoreError::new("Transaction not found"))?;
                Ok(u32::from(tx.expiry_height()))
            })
            .collect()
    }

    /// Sends the stored transactions to lightwalletd in order; stops at the first one the server rejects.
    pub async fn send_authorized_transactions(&mut self, lightwalletd_url: String, ids: Vec<u8>) -> Result<(), CoreError> {
        let mut raw = vec![];
        {
            let db = self.db();
            for txid in txids(&ids)? {
                let tx = db.get_transaction(txid).map_err(err)?.ok_or_else(|| CoreError::new("Transaction not found"))?;
                let mut data = vec![];
                tx.write(&mut data).map_err(err)?;
                raw.push(data);
            }
        }
        let mut client = sync::client(&lightwalletd_url);
        for data in raw {
            let response = client.send_transaction(RawTransaction { data, height: 0 }).await.map_err(err)?.into_inner();
            if response.error_code != 0 {
                return Err(CoreError::new(&format!("Transaction rejected ({}): {}", response.error_code, response.error_message)));
            }
        }
        Ok(())
    }

    /// The account's transactions from upstream's `v_transactions` view, newest first: txid (display order), mined height,
    /// expiry height, balance delta and whether the scanned chain shows it expired unmined.
    pub fn transaction_history(&mut self) -> Result<String, CoreError> {
        let id = self.account;
        let mut statement = self
            .conn
            .prepare(
                "SELECT txid, mined_height, expiry_height, account_balance_delta, fee_paid, expired_unmined
                 FROM v_transactions WHERE account_uuid = ?1 ORDER BY mined_height IS NOT NULL, mined_height DESC",
            )
            .map_err(err)?;
        let rows = statement
            .query_map([id.expose_uuid()], |row| {
                let mut txid: Vec<u8> = row.get(0)?;
                txid.reverse();
                Ok(serde_json::json!({
                    "txid": txid.iter().map(|b| format!("{b:02x}")).collect::<String>(),
                    "minedHeight": row.get::<_, Option<u32>>(1)?,
                    "expiryHeight": row.get::<_, Option<u32>>(2)?,
                    "balanceDelta": row.get::<_, i64>(3)?,
                    "fee": row.get::<_, Option<i64>>(4)?,
                    "expiredUnmined": row.get::<_, bool>(5)?,
                }))
            })
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        Ok(serde_json::Value::Array(rows).to_string())
    }
}

/// Parses signed transaction bytes kept from a previous engine and re-serializes them; only bytes that round-trip exactly are
/// accepted. Returns the txid (display order), version, consensus branch and expiry height, so Silo can prove that a migrated
/// pending payment is the very transaction it signed. Nothing is stored. Only v5 and v6 transactions (which commit to their
/// consensus branch) are accepted.
fn parse_signed(bytes: &[u8]) -> Result<zcash_primitives::transaction::Transaction, CoreError> {
    use zcash_primitives::transaction::{Transaction, TxVersion};
    let tx = Transaction::read(bytes, BranchId::Nu6).map_err(|_| CoreError::new("Not a valid transaction"))?;
    if !matches!(tx.version(), TxVersion::V5 | TxVersion::V6) {
        return Err(CoreError::new("Unsupported transaction version"));
    }
    let mut again = vec![];
    tx.write(&mut again).map_err(err)?;
    if again != bytes {
        return Err(CoreError::new("Transaction bytes are not canonical"));
    }
    Ok(tx)
}

#[wasm_bindgen]
pub fn inspect_transaction(bytes: &[u8]) -> Result<String, CoreError> {
    let tx = parse_signed(bytes)?;
    let mut txid = tx.txid().as_ref().to_vec();
    txid.reverse();
    Ok(serde_json::json!({
        "txid": txid.iter().map(|b| format!("{b:02x}")).collect::<String>(),
        "version": format!("{:?}", tx.version()),
        "branch": format!("{:08x}", u32::from(tx.consensus_branch_id())),
        "expiryHeight": u32::from(tx.expiry_height()),
    })
    .to_string())
}

/// Sends previously signed bytes unchanged (after the same check). Used only to resend a migrated pending payment; Silo never
/// signs a replacement for it.
#[wasm_bindgen]
pub async fn send_raw_transaction(lightwalletd_url: String, bytes: Vec<u8>) -> Result<(), CoreError> {
    parse_signed(&bytes)?;
    let mut client = sync::client(&lightwalletd_url);
    let response = client.send_transaction(RawTransaction { data: bytes, height: 0 }).await.map_err(err)?.into_inner();
    if response.error_code != 0 {
        return Err(CoreError::new(&format!("Transaction rejected ({}): {}", response.error_code, response.error_message)));
    }
    Ok(())
}
