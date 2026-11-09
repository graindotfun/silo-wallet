//! Test-only synthetic mining driver. No HTTP, PoW claim or network submission.
use super::*;
use incrementalmerkletree::frontier::CommitmentTree;
use orchard::tree::MerkleHashOrchard;
use zcash_client_backend::proto::compact_formats::{
    ChainMetadata, CompactOrchardAction, CompactTx,
};
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_pool_migration::engine::{prove_transfer, MigrationState};
use zcash_pool_migration::satisfiability::{
    advance_migration, AdvanceConfig, DuenessTargets, ReorgSettleDepth,
};
use zcash_pool_migration::state::AdvanceStep;
use zcash_primitives::{
    merkle_tree::{read_commitment_tree, write_commitment_tree},
    transaction::Transaction,
};

type Tree = CommitmentTree<MerkleHashOrchard, 32>;
#[derive(Clone)]
struct SyntheticChain {
    tip: u32,
    orchard: Tree,
    ironwood: Tree,
}
fn hash(height: u32) -> Vec<u8> {
    let mut h = vec![0; 32];
    h[..4].copy_from_slice(&height.to_le_bytes());
    h[31] = 0x51;
    h
}
fn tree_hex(tree: &Tree) -> String {
    let mut bytes = vec![];
    write_commitment_tree(tree, &mut bytes).unwrap();
    hex::encode(bytes)
}
impl SyntheticChain {
    fn from_fixture(chain: &serde_json::Value, height: u32) -> Self {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(chain["treeStates"][height.to_string()].as_str().unwrap())
            .unwrap();
        let state = TreeState::decode(raw.as_slice()).unwrap();
        Self {
            tip: height,
            orchard: read_commitment_tree(hex::decode(state.orchard_tree).unwrap().as_slice())
                .unwrap(),
            ironwood: read_commitment_tree(hex::decode(state.ironwood_tree).unwrap().as_slice())
                .unwrap(),
        }
    }
    fn prior(&self) -> TreeState {
        let mut reversed = hash(self.tip);
        reversed.reverse();
        TreeState {
            network: "test".into(),
            height: self.tip as u64,
            hash: hex::encode(reversed),
            time: 1_700_000_000 + self.tip,
            sapling_tree: String::new(),
            orchard_tree: tree_hex(&self.orchard),
            ironwood_tree: tree_hex(&self.ironwood),
        }
    }
    fn scan_to(&mut self, core: &mut SiloZecCore, height: u32, mined: Option<&Transaction>) {
        assert!(
            height > self.tip && height - self.tip <= 150_000,
            "bounded synthetic scan"
        );
        while self.tip < height {
            let prior = self.prior();
            let end = (self.tip + 1000).min(height);
            let mut blocks = vec![];
            for h in self.tip + 1..=end {
                let mut vtx = vec![];
                if h == height {
                    if let Some(tx) = mined {
                        assert!(
                            u32::from(tx.expiry_height()) == 0
                                || h <= u32::from(tx.expiry_height()),
                            "fixture cannot mine an expired transaction"
                        );
                        let mut compact = CompactTx {
                            index: 0,
                            txid: tx.txid().as_ref().to_vec(),
                            ..Default::default()
                        };
                        for (bundle, tree, out) in [
                            (tx.orchard_bundle(), &mut self.orchard, &mut compact.actions),
                            (
                                tx.ironwood_bundle(),
                                &mut self.ironwood,
                                &mut compact.ironwood_actions,
                            ),
                        ] {
                            if let Some(bundle) = bundle {
                                for action in bundle.actions().iter() {
                                    tree.append(MerkleHashOrchard::from_cmx(action.cmx()))
                                        .unwrap();
                                    out.push(CompactOrchardAction {
                                        nullifier: action.nullifier().to_bytes().to_vec(),
                                        cmx: action.cmx().to_bytes().to_vec(),
                                        ephemeral_key: action.encrypted_note().epk_bytes.to_vec(),
                                        ciphertext: action.encrypted_note().enc_ciphertext.as_ref()[..52]
                                            .to_vec(),
                                    });
                                }
                            }
                        }
                        vtx.push(compact);
                    }
                }
                blocks.push(CompactBlock {
                    height: h as u64,
                    hash: hash(h),
                    prev_hash: hash(h - 1),
                    time: 1_700_000_000 + h,
                    vtx,
                    chain_metadata: Some(ChainMetadata {
                        sapling_commitment_tree_size: 0,
                        orchard_commitment_tree_size: self.orchard.size() as u32,
                        ironwood_commitment_tree_size: self.ironwood.size() as u32,
                    }),
                    ..Default::default()
                });
            }
            core.scan_for_test(prior, blocks)
                .expect("scan synthetic mined transaction/empty blocks");
            self.tip = end;
        }
    }
}

pub(super) fn drive(
    mut core: SiloZecCore,
    mut state: MigrationState,
    fixture: &serde_json::Value,
    ufvk: UnifiedFullViewingKey,
) {
    let params = core.params;
    let mut chain = SyntheticChain::from_fixture(fixture, fixture["tip"].as_u64().unwrap() as u32);
    let config = AdvanceConfig::new(ReorgSettleDepth::new(100));
    let expected_crossing: u64 = state.crossing_values().iter().map(|v| u64::from(*v)).sum();
    let mut mined_count = 0;
    let mut tested_reorg = false;
    for _ in 0..100 {
        let target = BlockHeight::from_u32(chain.tip + 1);
        let next = {
            let mut store =
                PoolMigrations::for_account(params, JsClock, &mut core.conn, core.account).unwrap();
            advance_migration(
                &mut store,
                &mut state,
                DuenessTargets::new(target, target),
                &config,
                &mut os_rng(),
            )
            .unwrap()
        };
        println!("synthetic tip={} step={:?}", chain.tip, next.step());
        match next.step().clone() {
            AdvanceStep::Prove { transactions } => {
                for item in transactions {
                    let proof = {
                        let account = core.account;
                        let mut db = core.db();
                        let (_, anchor) = db
                            .get_target_and_anchor_heights(std::num::NonZeroU32::new(10).unwrap())
                            .unwrap()
                            .unwrap();
                        let mut prover = WalletMigrationProver::new(
                            &mut db, os_rng(),
                            account,
                            ufvk.orchard().unwrap().clone(),
                        );
                        let result = match item.kind() {
                            MigrationTxKind::Preparation { .. } => {
                                prove_preparation(&mut prover, &mut state, item.id(), anchor)
                            }
                            MigrationTxKind::Transfer { .. } => prove_transfer(
                                &params,
                                &mut prover,
                                &mut state,
                                item.id(),
                                BlockHeight::from_u32(chain.tip),
                                &mut os_rng(),
                            ),
                        }
                        .unwrap();
                        match result {
                            ProveOutcome::Proved(proof) => proof,
                            other => panic!("unexpected proof: {other:?}"),
                        }
                    };
                    let mut store =
                        PoolMigrations::for_account(params, JsClock, &mut core.conn, core.account)
                            .unwrap();
                    store.store_proved_transaction(&mut state, proof).unwrap();
                }
            }
            AdvanceStep::Broadcast { id } => {
                // Local finalization only. This test never opens a network connection.
                let tx = {
                    let mut store =
                        PoolMigrations::for_account(params, JsClock, &mut core.conn, core.account)
                            .unwrap();
                    let tx = store.take_transaction_for_broadcast(os_rng(), &state, id).unwrap();
                    state.mark_broadcast(id);
                    store.replace_migration(&state).unwrap();
                    tx
                };
                if !tested_reorg {
                    cancellation_preserves_inflight(&core, id);
                }
                let before = chain.tip;
                let before_chain = chain.clone();
                chain.scan_to(&mut core, before + 1, Some(&tx));
                mined_count += 1;
                if !tested_reorg {
                    let t = BlockHeight::from_u32(chain.tip + 1);
                    {
                        let mut store = PoolMigrations::for_account(
                            params,
                            JsClock,
                            &mut core.conn,
                            core.account,
                        )
                        .unwrap();
                        advance_migration(
                            &mut store,
                            &mut state,
                            DuenessTargets::new(t, t),
                            &config,
                            &mut os_rng(),
                        )
                        .unwrap();
                    }
                    assert!(
                        state.transactions().iter().any(|row| row.id() == id
                            && matches!(row.state(), MigrationTxState::Mined { .. })),
                        "scan detects mining without manual mark_mined"
                    );
                    let rollback = core
                        .db()
                        .truncate_to_height(BlockHeight::from_u32(before))
                        .unwrap();
                    chain = before_chain;
                    chain.tip = u32::from(rollback);
                    state = PoolMigrations::for_account(params, JsClock, &core.conn, core.account)
                        .unwrap()
                        .latest_migration()
                        .unwrap()
                        .unwrap();
                    assert!(
                        state.transactions().iter().any(|row| row.id() == id
                            && matches!(row.state(), MigrationTxState::Broadcast { .. })),
                        "wallet rollback also rolls back migration"
                    );
                    chain.scan_to(&mut core, before + 2, Some(&tx));
                    tested_reorg = true;
                    println!("preparation reorg and re-mine passed");
                    expiry_uses_scanned_chain(&core, &state, &chain, &config);
                }
                // Restart from the exact serialized wallet after each synthetic mining event.
                core = SiloZecCore::open("test", &core.to_bytes().unwrap()).unwrap();
                state = PoolMigrations::for_account(params, JsClock, &core.conn, core.account)
                    .unwrap()
                    .latest_migration()
                    .unwrap()
                    .unwrap();
            }
            AdvanceStep::Waiting => {
                let next_height = next
                    .next()
                    .map(|(h, _)| u32::from(h).saturating_sub(1))
                    .unwrap_or(chain.tip + 10)
                    .max(chain.tip + 1);
                chain.scan_to(&mut core, next_height, None);
            }
            AdvanceStep::Complete => {
                assert_eq!(mined_count, state.transactions().len());
                assert!(tested_reorg);
                assert!(state
                    .transactions()
                    .iter()
                    .all(|tx| matches!(tx.state(), MigrationTxState::Mined { .. })));
                // Let the final change reach the upstream confirmation policy; prove spendable,
                // not only a total that still contains pending change.
                chain.scan_to(&mut core, chain.tip + 10, None);
                let balance: serde_json::Value =
                    serde_json::from_str(&core.summary().unwrap()).unwrap();
                let original_ironwood = fixture["expected"]["ironwood"].as_u64().unwrap();
                assert_eq!(
                    balance["ironwood"]["total"].as_u64().unwrap(),
                    original_ironwood + expected_crossing
                );
                assert_eq!(
                    balance["ironwood"]["spendable"],
                    balance["ironwood"]["total"]
                );
                assert_eq!(balance["orchard"]["spendable"], balance["orchard"]["total"]);
                let final_total = balance["total"].as_u64().unwrap();
                let start = fixture["expected"]["orchard"].as_u64().unwrap() + original_ironwood;
                assert!(
                    final_total < start,
                    "fees are charged, no value is invented"
                );
                println!("full synthetic migration complete mined={} crossed={} fees={} balance={balance}",mined_count,expected_crossing,start-final_total);
                return;
            }
            step => panic!("unexpected synthetic drive step: {step:?}"),
        }
    }
    panic!("synthetic drive exceeded bounded step count");
}

fn cancellation_preserves_inflight(
    core: &SiloZecCore,
    id: zcash_pool_migration::engine::MigrationTransferId,
) {
    let mut fork = SiloZecCore::open("test", &core.to_bytes().unwrap()).unwrap();
    let outcome = {
        let mut store =
            PoolMigrations::for_account(fork.params, JsClock, &mut fork.conn, fork.account)
                .unwrap();
        store.cancel_migration().unwrap()
    };
    assert!(
        outcome.in_flight().contains(&id),
        "cancel cannot release a relayed preparation"
    );
    let recipient = fork.orchard_address().unwrap();
    assert!(
        fork.propose_transfer(&recipient, 10_000_000).is_err(),
        "cancel cannot make the relayed preparation's notes spendable"
    );
    println!("in-flight cancellation preserves note reservation");
}

fn expiry_uses_scanned_chain(
    core: &SiloZecCore,
    state: &MigrationState,
    chain: &SyntheticChain,
    config: &AdvanceConfig,
) {
    let mut fork = SiloZecCore::open("test", &core.to_bytes().unwrap()).unwrap();
    let mut fork_state = state.clone();
    let mut fork_chain = chain.clone();
    let latest_expiry = state
        .transactions()
        .iter()
        .filter(|tx| matches!(tx.kind(), MigrationTxKind::Transfer { .. }))
        .map(|tx| u32::from(tx.expiry_height()))
        .max()
        .unwrap();
    let scanned = BlockHeight::from_u32(chain.tip + 1);
    let estimated = BlockHeight::from_u32(latest_expiry + 101);
    assert!(
        fork_state
            .expired_transactions(DuenessTargets::new(scanned, estimated))
            .is_empty(),
        "a clock estimate cannot prove expiry"
    );
    {
        let mut store =
            PoolMigrations::for_account(fork.params, JsClock, &mut fork.conn, fork.account)
                .unwrap();
        advance_migration(
            &mut store,
            &mut fork_state,
            DuenessTargets::new(scanned, estimated),
            config,
            &mut os_rng(),
        )
        .unwrap();
    }
    assert!(fork_state
        .expired_transactions(DuenessTargets::new(scanned, estimated))
        .is_empty());
    fork_chain.scan_to(&mut fork, latest_expiry + 100, None);
    let observed = BlockHeight::from_u32(fork_chain.tip + 1);
    assert_eq!(
        fork_state
            .expired_transactions(DuenessTargets::new(observed, observed))
            .len(),
        state
            .transactions()
            .iter()
            .filter(|tx| matches!(tx.kind(), MigrationTxKind::Transfer { .. }))
            .count()
    );
    let verdict = {
        let mut store =
            PoolMigrations::for_account(fork.params, JsClock, &mut fork.conn, fork.account)
                .unwrap();
        advance_migration(
            &mut store,
            &mut fork_state,
            DuenessTargets::new(observed, observed),
            config,
            &mut os_rng(),
        )
        .unwrap()
    };
    assert!(
        matches!(
            verdict.step(),
            AdvanceStep::Replan | AdvanceStep::Rebuild { .. }
        ),
        "expired transfers need explicit replanning/signing, not implicit resend"
    );
    println!("expiry estimate held; observed expiry asks for explicit remediation");
}
