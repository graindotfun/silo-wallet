//! Test-only: produces the bytes a WebZjs (a50df94) Silo backup held after signing a payment, with the same fork crates WebZjs
//! wraps (librustzcash-nu61 52efe30): import the account as WebZjs's create_account does, scan the synthetic chain, propose,
//! sign with LocalTxProver::bundled (WebZjs's prover), and encode the store as WebZjs's db_to_bytes does. Nothing is sent.
//! Usage: legacy-sign <chain.json> "<phrase>" <recipient> <zatoshis>  > signed.json
use base64::Engine;
use bip0039::{English, Mnemonic};
use prost::Message;
use secrecy::{ExposeSecret, SecretVec};
use std::collections::BTreeMap;
use zcash_client_backend::data_api::chain::{error, scan_cached_blocks, BlockSource};
use zcash_client_backend::data_api::wallet::{create_proposed_transactions, input_selection::GreedyInputSelector, propose_standard_transfer_to_address, ConfirmationsPolicy, SpendingKeys};
use zcash_client_backend::data_api::{Account as _, AccountBirthday, AccountPurpose, WalletRead, WalletWrite, Zip32Derivation};
use zcash_client_backend::fees::StandardFeeRule;
use zcash_client_backend::proto::compact_formats::CompactBlock;
use zcash_client_backend::proto::service::TreeState;
use zcash_client_backend::wallet::OvkPolicy;
use zcash_client_memory::MemoryWalletDb;
use zcash_keys::{address::Address, keys::UnifiedSpendingKey};
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::{consensus::{BlockHeight, Network}, value::Zatoshis, ShieldedProtocol};

struct Blocks(BTreeMap<u32, CompactBlock>);
impl BlockSource for Blocks {
    type Error = std::convert::Infallible;
    fn with_blocks<F, E>(&self, from: Option<BlockHeight>, limit: Option<usize>, mut f: F) -> Result<(), error::Error<E, Self::Error>>
    where F: FnMut(CompactBlock) -> Result<(), error::Error<E, Self::Error>> {
        for (_, b) in self.0.range(from.map(u32::from).unwrap_or(0)..).take(limit.unwrap_or(usize::MAX)) { f(b.clone())?; }
        Ok(())
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let chain: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&args[1]).unwrap()).unwrap();
    let b64 = |v: &serde_json::Value| base64::engine::general_purpose::STANDARD.decode(v.as_str().unwrap()).unwrap();
    let params = Network::TestNetwork;
    let mnemonic = <Mnemonic<English>>::from_phrase(&args[2]).unwrap();
    let seed = SecretVec::new(mnemonic.to_seed("").to_vec());
    let fp = zip32::fingerprint::SeedFingerprint::from_seed(seed.expose_secret()).unwrap();
    let usk = UnifiedSpendingKey::from_seed(&params, seed.expose_secret(), zip32::AccountId::ZERO).unwrap();
    let birthday_height = chain["birthday"].as_u64().unwrap() as u32;
    let tip = chain["tip"].as_u64().unwrap() as u32;
    let prior = TreeState::decode(b64(&chain["treeStates"][(birthday_height - 1).to_string()]).as_slice()).unwrap();
    let mut db = MemoryWalletDb::new(params, 100);
    let account = db.import_account_ufvk("Grain Silo", &usk.to_unified_full_viewing_key(), &AccountBirthday::from_treestate(prior.clone(), None).ok().expect("tree state"),
        AccountPurpose::Spending { derivation: Some(Zip32Derivation::new(fp, zip32::AccountId::ZERO)) }, None).unwrap().id();
    let blocks = Blocks((birthday_height..=tip).map(|h| (h, CompactBlock::decode(b64(&chain["blocks"][h.to_string()]).as_slice()).unwrap())).collect());
    db.update_chain_tip(BlockHeight::from_u32(tip)).unwrap();
    scan_cached_blocks(&params, &blocks, &mut db, BlockHeight::from_u32(birthday_height), &prior.to_chain_state().unwrap(), blocks.0.len()).unwrap();
    let to = Address::decode(&params, &args[3]).unwrap();
    let proposal = propose_standard_transfer_to_address::<_, _, std::convert::Infallible>(&mut db, &params, StandardFeeRule::Zip317, account,
        ConfirmationsPolicy::default(), &to, Zatoshis::from_u64(args[4].parse().unwrap()).unwrap(), None, None, ShieldedProtocol::Orchard).unwrap();
    let fee: u64 = proposal.steps().iter().map(|s| u64::from(s.balance().fee_required())).sum();
    let prover = LocalTxProver::bundled();
    let ids = create_proposed_transactions::<_, _, std::convert::Infallible, _, std::convert::Infallible, _>(&mut db, &params, &prover, &prover,
        &SpendingKeys::from_unified_spending_key(usk), OvkPolicy::Sender, &proposal).unwrap();
    let expiries: Vec<u32> = ids.iter().map(|id| u32::from(db.get_transaction(*id).unwrap().unwrap().expiry_height())).collect();
    let mut database = vec![];
    db.encode(&mut database).unwrap();
    let flat: Vec<u8> = ids.iter().flat_map(|id| id.as_ref().to_vec()).collect();
    let e = base64::engine::general_purpose::STANDARD;
    println!("{}", serde_json::json!({"ids": e.encode(flat), "expiries": expiries, "fee": fee.to_string(), "database": e.encode(database)}));
}
