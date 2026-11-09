//! Scans the synthetic chain from fixture-chain (one Orchard note before NU6.3, one Ironwood note after it) and spends from
//! it offline: proposal, proving and storage only; nothing is sent anywhere. Uses public BIP39 test phrases.
use base64::Engine;
use prost::Message;
use silo_zec_core::SiloZecCore;
use zcash_client_backend::proto::{compact_formats::CompactBlock, service::TreeState};
use zcash_primitives::transaction::TxVersion;

const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
const OTHER: &str = "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title";

fn synced() -> (SiloZecCore, serde_json::Value) {
    let path = std::env::var("CHAIN").expect("CHAIN=chain.json");
    let chain: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let b64 = |v: &serde_json::Value| base64::engine::general_purpose::STANDARD.decode(v.as_str().unwrap()).unwrap();
    let birthday = chain["birthday"].as_u64().unwrap() as u32;
    let prior = b64(&chain["treeStates"][(birthday - 1).to_string()]);
    let mut core = SiloZecCore::create("test", PHRASE, Some(prior.clone())).unwrap();
    let tip = chain["tip"].as_u64().unwrap() as u32;
    let blocks: Vec<CompactBlock> =
        (birthday..=tip).map(|h| CompactBlock::decode(b64(&chain["blocks"][h.to_string()]).as_slice()).unwrap()).collect();
    core.scan_for_test(TreeState::decode(prior.as_slice()).unwrap(), blocks).unwrap();
    (core, chain)
}

#[test]
fn scans_and_spends_fixture_chain() {
    let (mut core, chain) = synced();
    let summary: serde_json::Value = serde_json::from_str(&core.summary().unwrap()).unwrap();
    println!("summary {summary}");
    assert_eq!(summary["orchard"]["spendable"], chain["expected"]["orchard"]);
    assert_eq!(summary["ironwood"]["spendable"], chain["expected"]["ironwood"]);

    // The recipient is another wallet's Orchard-only address; after NU6.3 it is paid through the Ironwood bundle.
    let recipient = SiloZecCore::create("test", OTHER, None).unwrap().orchard_address().unwrap();
    let proposal = core.propose_transfer(&recipient, 30_000).unwrap();
    println!("fee {} steps {}", proposal.fee_zatoshi(), proposal.step_count());
    assert!(core.create_proposed_transactions(&proposal, OTHER).is_err(), "a phrase for another wallet must be refused");
    let ids = core.create_proposed_transactions(&proposal, PHRASE).unwrap();
    assert_eq!(ids.len(), 32 * proposal.step_count() as usize);
    let expiries = core.transaction_expiry_heights(&ids).unwrap();
    let tip = chain["tip"].as_u64().unwrap() as u32;
    for (id, expiry) in ids.chunks(32).zip(&expiries) {
        let tx = core.transaction_for_test(id).expect("stored transaction");
        let orchard = tx.orchard_bundle().map(|b| i64::from(*b.value_balance()));
        let ironwood = tx.ironwood_bundle().map(|b| (b.actions().len(), i64::from(*b.value_balance())));
        println!("tx version {:?} expiry {expiry} sapling {} orchard balance {orchard:?} ironwood (actions, balance) {ironwood:?}", tx.version(), tx.sapling_bundle().is_some());
        assert_eq!(tx.version(), TxVersion::V6);
        assert!(tx.sapling_bundle().is_none());
        assert!(orchard.unwrap_or(0) >= 0, "the Orchard turnstile forbids adding value to the Orchard pool");
        assert!(ironwood.is_some(), "the payment to an Orchard receiver is delivered through Ironwood");
        assert!(*expiry > tip, "expiry must be a real future height");
        assert_eq!(*expiry, u32::from(tx.expiry_height()));
    }
    let history: serde_json::Value = serde_json::from_str(&core.transaction_history().unwrap()).unwrap();
    println!("history {history}");
    assert!(history.as_array().unwrap().iter().any(|t| t["minedHeight"].is_null() && t["balanceDelta"].as_i64().unwrap() < 0));
}

#[test]
fn spends_orchard_note_across_the_turnstile() {
    let (mut core, chain) = synced();
    let recipient = SiloZecCore::create("test", OTHER, None).unwrap().orchard_address().unwrap();
    // More than the Ironwood note holds: the legacy Orchard note must be spent too, and its value may only leave Orchard.
    let proposal = core.propose_transfer(&recipient, 100_000).unwrap();
    let ids = core.create_proposed_transactions(&proposal, PHRASE).unwrap();
    let tip = chain["tip"].as_u64().unwrap() as u32;
    for (id, expiry) in ids.chunks(32).zip(core.transaction_expiry_heights(&ids).unwrap()) {
        let tx = core.transaction_for_test(id).expect("stored transaction");
        let orchard = tx.orchard_bundle().map(|b| i64::from(*b.value_balance()));
        let ironwood = tx.ironwood_bundle().map(|b| i64::from(*b.value_balance()));
        println!("fee {} tx version {:?} expiry {expiry} orchard balance {orchard:?} ironwood balance {ironwood:?}", proposal.fee_zatoshi(), tx.version());
        assert_eq!(tx.version(), TxVersion::V6);
        assert!(orchard.expect("an Orchard spend") > 0, "value leaves the Orchard pool");
        assert!(ironwood.is_some());
        assert!(expiry > tip);
    }
    // Insufficient funds are refused before anything is built.
    assert!(core.propose_transfer(&recipient, 10_000_000).is_err());
}

#[test]
fn signs_at_nu7_after_a_complete_empty_block_interval() {
    use zcash_protocol::consensus::{BranchId, BlockHeight};
    let (mut core, chain) = synced();
    let old_tip = chain["tip"].as_u64().unwrap() as u32;
    let tip = 4_465_028u32;
    assert!(tip > old_tip && tip - old_tip < 500_000);
    let decode = |v: &serde_json::Value| base64::engine::general_purpose::STANDARD.decode(v.as_str().unwrap()).unwrap();
    let prior = TreeState::decode(decode(&chain["treeStates"][old_tip.to_string()]).as_slice()).unwrap();
    let last = CompactBlock::decode(decode(&chain["blocks"][old_tip.to_string()]).as_slice()).unwrap();
    let mut previous = last.hash.clone();
    let blocks = ((old_tip + 1)..=tip).map(|height| {
        let mut hash = vec![0x7b; 32];
        hash[..4].copy_from_slice(&height.to_le_bytes());
        let block = CompactBlock { height: height as u64, hash: hash.clone(), prev_hash: previous.clone(), time: last.time + 75 * (height - old_tip), chain_metadata: last.chain_metadata.clone(), ..Default::default() };
        previous = hash;
        block
    }).collect();
    core.scan_for_test(prior, blocks).unwrap();
    let recipient = SiloZecCore::create("test", OTHER, None).unwrap().orchard_address().unwrap();
    let proposal = core.propose_transfer(&recipient, 30_000).unwrap();
    let ids = core.create_proposed_transactions(&proposal, PHRASE).unwrap();
    for id in ids.chunks(32) {
        let tx = core.transaction_for_test(id).unwrap();
        assert_eq!(tx.consensus_branch_id(), BranchId::Nu7);
        assert_eq!(tx.version(), TxVersion::V6);
        assert!(tx.expiry_height() > BlockHeight::from_u32(tip));
        let mut bytes = Vec::new();tx.write(&mut bytes).unwrap();
        let inspected: serde_json::Value = serde_json::from_str(&silo_zec_core::inspect_transaction(&bytes).unwrap()).unwrap();
        assert_eq!(inspected["branch"], "77190ad9");
    }
}
