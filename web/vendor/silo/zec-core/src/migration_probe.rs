//! Offline feasibility probe of upstream ZIP-318 over Silo's actual SQLite connection.
//! Uses only a synthetic chain and public BIP39 vectors. No network client or broadcast is called.
use super::*;
use base64::Engine;
use zcash_client_backend::proto::compact_formats::CompactBlock;
use zcash_client_sqlite::pool_migration::orchard_ironwood::PoolMigrations;
use zcash_pool_migration::engine::{
    commit_preparation, plan_migration, prove_preparation, MigrationTxKind, MigrationTxState,
    PoolMigrationWrite, ProveOutcome,
};
use zcash_pool_migration::satisfiability::ReplanThreshold;
use zcash_pool_migration::wallet::{WalletMigration, WalletMigrationProver};

const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
const OTHER: &str = "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title";

#[path = "migration_chain.rs"]
mod migration_chain;

#[test]
#[ignore = "requires MIGRATION_CHAIN from the synthetic fixture generator; proves locally, never broadcasts"]
fn sqlite_plan_commit_prove_and_reopen_without_broadcast() {
    let path = std::env::var("MIGRATION_CHAIN").expect("MIGRATION_CHAIN=synthetic-chain.json");
    let chain: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let b64 = |v: &serde_json::Value| base64::engine::general_purpose::STANDARD.decode(v.as_str().unwrap()).unwrap();
    let birthday = chain["birthday"].as_u64().unwrap() as u32;
    let tip = chain["tip"].as_u64().unwrap() as u32;
    let prior = b64(&chain["treeStates"][(birthday - 1).to_string()]);
    let mut core = SiloZecCore::create("test", PHRASE, Some(prior.clone())).unwrap();
    let blocks: Vec<CompactBlock> = (birthday..=tip)
        .map(|h| CompactBlock::decode(b64(&chain["blocks"][h.to_string()]).as_slice()).unwrap()).collect();
    core.scan_for_test(TreeState::decode(prior.as_slice()).unwrap(), blocks).unwrap();
    let params = core.params;
    let account = core.account;
    let usk = UnifiedSpendingKey::from_seed(&params, seed(PHRASE).unwrap().expose_secret(), zip32::AccountId::ZERO).unwrap();
    let ufvk = usk.to_unified_full_viewing_key();
    let wrong = UnifiedSpendingKey::from_seed(&params, seed(OTHER).unwrap().expose_secret(), zip32::AccountId::ZERO).unwrap();
    let before = core.to_bytes().unwrap();
    let plan = {
        let db = WalletDb::from_connection(&core.conn, params, JsClock, os_rng());
        let store = PoolMigrations::for_account(params, JsClock, &core.conn, account).unwrap();
        let adapter = WalletMigration::new(&db, account, ufvk.clone(), store);
        plan_migration(&params, &adapter, &mut os_rng()).expect("funded Orchard balance plans")
    };
    assert!(plan.value_migrated() > Zatoshis::ZERO);
    assert!(plan.transfer_tx_count() > 0);
    println!("planned transactions={} preparations={} transfers={} migrated={} residual={}",
        plan.total_transactions(), plan.preparation_tx_count(), plan.transfer_tx_count(),
        u64::from(plan.value_migrated()), u64::from(plan.residual()));
    assert_eq!(before, core.to_bytes().unwrap(), "planning must not write the wallet");
    // Upstream's adapter borrows WalletRead while the SQLite store requires mutable connection
    // access. Use an immutable copy of the exact scan snapshot; all persistent writes use the
    // original connection. The future worker integration must retain the same exclusive session.
    let scan_snapshot = connection(Some(&before)).unwrap();
    let read_db = WalletDb::from_connection(&scan_snapshot, params, JsClock, os_rng());
    {
        let store = PoolMigrations::for_account(params, JsClock, &mut core.conn, account).unwrap();
        let mut adapter = WalletMigration::new(&read_db, account, ufvk.clone(), store);
        assert!(commit_preparation(&params, BlockHeight::from_u32(tip + 1), &mut adapter,
            wrong.orchard(), &plan, &mut os_rng(), ReplanThreshold::DEFAULT).is_err(), "wrong authority refused");
    }
    assert_eq!(before, core.to_bytes().unwrap(), "wrong authority must not write the wallet");
    let mut state = {
        let store = PoolMigrations::for_account(params, JsClock, &mut core.conn, account).unwrap();
        let mut adapter = WalletMigration::new(&read_db, account, ufvk.clone(), store);
        commit_preparation(&params, BlockHeight::from_u32(tip + 1), &mut adapter,
            usk.orchard(), &plan, &mut os_rng(), ReplanThreshold::DEFAULT).expect("commit signed migration locally")
    };
    assert!(state.transactions().iter().all(|tx| matches!(tx.state(), MigrationTxState::Signed)));
    let committed = core.to_bytes().unwrap();
    core = SiloZecCore::open("test", &committed).unwrap();
    let stored = PoolMigrations::for_account(params, JsClock, &core.conn, core.account).unwrap().latest_migration().unwrap().unwrap();
    assert_eq!(state, stored, "all signed PCZTs and schedule survive SQLite reopen");

    // Preparation can be proved immediately against existing notes. Future transfers require
    // the preparation to mine and its schedule/anchors to mature; this probe does not fake those events.
    let id = state.transactions().iter().find(|tx|
        matches!(tx.kind(), MigrationTxKind::Preparation { .. }) && tx.depends_on().is_empty())
        .expect("fixture requires an initial preparation").id();
    let proof = {
        let account = core.account;
        let mut db = core.db();
        let (_, anchor) = db.get_target_and_anchor_heights(std::num::NonZeroU32::new(10).unwrap()).unwrap().unwrap();
        println!("preparation anchor={}", u32::from(anchor));
        let mut prover = WalletMigrationProver::new(&mut db, os_rng(), account, ufvk.orchard().unwrap().clone());
        match prove_preparation(&mut prover, &mut state, id, anchor).expect("prove preparation") {
            ProveOutcome::Proved(proof) => proof,
            other => panic!("unexpected prove outcome: {other:?}"),
        }
    };
    let mut store = PoolMigrations::for_account(params, JsClock, &mut core.conn, core.account).unwrap();
    store.store_proved_transaction(&mut state, proof).expect("persist proof and wallet transaction atomically");
    let tx = store.take_transaction_for_broadcast(os_rng(), &state, id).expect("finalize and verify locally; never send");
    assert_eq!(tx.version(), zcash_primitives::transaction::TxVersion::V6);
    let mut raw = Vec::new(); tx.write(&mut raw).unwrap();
    let again = store.take_transaction_for_broadcast(os_rng(), &state, id).unwrap();
    let mut raw_again = Vec::new(); again.write(&mut raw_again).unwrap();
    assert_eq!(tx.txid(), again.txid(), "re-extraction must preserve transaction identity");
    println!("upstream re-extraction bytes identical={}; relays must reuse the database artifact, not re-extract", raw == raw_again);
    println!("proved preparation txid={} bytes={} expiry={}; broadcast NOT performed", tx.txid(), raw.len(), u32::from(tx.expiry_height()));
    drop(store);
    let persisted = core.transaction_for_test(again.txid().as_ref()).expect("finalized transaction stored before relay");
    let mut persisted_raw = Vec::new(); persisted.write(&mut persisted_raw).unwrap();
    assert!(persisted_raw == raw_again, "persisted relay bytes match the last finalized artifact");
    let proved = core.to_bytes().unwrap();
    let mut reopened = SiloZecCore::open("test", &proved).unwrap();
    let restored_tx = reopened.transaction_for_test(again.txid().as_ref()).unwrap();
    let mut restored_raw = Vec::new(); restored_tx.write(&mut restored_raw).unwrap();
    assert!(persisted_raw == restored_raw, "same signed relay bytes survive close and restore");
    let restored = PoolMigrations::for_account(params, JsClock, &reopened.conn, reopened.account).unwrap().latest_migration().unwrap().unwrap();
    assert_eq!(state, restored, "proved state survives encrypted-envelope database round trip");
    assert!(restored.transactions().iter().all(|tx| !matches!(tx.state(), MigrationTxState::Broadcast { .. } | MigrationTxState::Mined { .. })));
    if std::env::var("SILO_MIGRATION_FULL").as_deref() == Ok("1") {
        migration_chain::drive(reopened, restored, &chain, ufvk);
    }
}
