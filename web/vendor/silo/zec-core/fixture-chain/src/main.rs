//! Writes a synthetic testnet chain for the Silo ZEC core sync test: compact blocks, tree states and the latest block, as
//! base64 protobuf. Notes to the test phrase's account 0 are encrypted with upstream zcash_client_backend test helpers:
//! one Orchard action before NU6.3 and one Ironwood action after it. Usage: zec-fixture-chain "<phrase>" > chain.json
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use bip0039::{English, Mnemonic};
use incrementalmerkletree::frontier::CommitmentTree;
use orchard::note::ExtractedNoteCommitment;
use orchard::tree::MerkleHashOrchard;
use prost::Message;
use rand::SeedableRng;
use zcash_client_backend::data_api::testing::{AddressType, IronwoodFvk, TestFvk};
use zcash_client_backend::proto::compact_formats::{ChainMetadata, CompactBlock, CompactTx};
use zcash_client_backend::proto::service::{BlockId, LightdInfo, TreeState};
use zcash_keys::keys::UnifiedSpendingKey;
use zcash_primitives::merkle_tree::write_commitment_tree;
use zcash_protocol::consensus::{BlockHeight, BranchId, Network, NetworkUpgrade, Parameters};
use zcash_protocol::value::Zatoshis;

type Tree = CommitmentTree<MerkleHashOrchard, 32>;

fn tree_hex(tree: &Tree) -> String {
    let mut out = vec![];
    write_commitment_tree(tree, &mut out).unwrap();
    hex::encode(out)
}

fn main() {
    let phrase = std::env::args().nth(1).expect("phrase");
    let params = Network::TestNetwork;
    let seed = <Mnemonic<English>>::from_phrase(&phrase).unwrap().to_seed("");
    let ufvk = UnifiedSpendingKey::from_seed(&params, &seed, zip32::AccountId::ZERO).unwrap().to_unified_full_viewing_key();
    let orchard_fvk = ufvk.orchard().unwrap().clone();
    let nu6_3 = u32::from(params.activation_height(NetworkUpgrade::Nu6_3).unwrap());
    let center = std::env::args().nth(2).map(|h| if h == "activation" { nu6_3 } else { h.parse::<u32>().expect("center height") }).unwrap_or(nu6_3);
    let (birthday, tip) = (center - 20, center + 20);
    let (orchard_at, ironwood_at) = (center - 15, center + 5);
    let with_ironwood = ironwood_at >= nu6_3;
    // Optional larger Orchard note for the pool-migration feasibility probe. Existing fixtures keep their exact values.
    let orchard_value = std::env::args().nth(3).map(|v| v.parse::<u64>().expect("Orchard zatoshis")).unwrap_or(50_000);
    let ironwood_value = 70_000u64;
    let mut rng = rand_chacha::ChaChaRng::seed_from_u64(7);
    let (mut orchard_tree, mut ironwood_tree) = (Tree::empty(), Tree::empty());
    let hash = |h: u32| { let mut b = [0u8; 32]; b[..4].copy_from_slice(&h.to_le_bytes()); b[31] = 0x51; b.to_vec() };
    let state = |h: u32, o: &Tree, i: &Tree| {
        let mut rev = hash(h); rev.reverse();
        TreeState { network: "test".into(), height: h as u64, hash: hex::encode(rev), time: 1_700_000_000 + h, sapling_tree: String::new(), orchard_tree: tree_hex(o), ironwood_tree: tree_hex(i) }.encode_to_vec()
    };
    let mut blocks = serde_json::Map::new();
    let mut states = serde_json::Map::new();
    states.insert((birthday - 1).to_string(), B64.encode(state(birthday - 1, &orchard_tree, &ironwood_tree)).into());
    for h in birthday..=tip {
        let mut vtx = vec![];
        if h == orchard_at || (with_ironwood && h == ironwood_at) {
            let mut tx = CompactTx { index: 0, txid: { let mut t = hash(h); t[31] = 0x7a; t }, ..Default::default() };
            let value = Zatoshis::const_from_u64(if h == orchard_at { orchard_value } else { ironwood_value });
            if h == orchard_at {
                orchard_fvk.add_output(&mut tx, &params, BlockHeight::from_u32(h), None, AddressType::DefaultExternal, value, 0, &mut rng);
            } else {
                IronwoodFvk(orchard_fvk.clone()).add_output(&mut tx, &params, BlockHeight::from_u32(h), None, AddressType::DefaultExternal, value, 0, &mut rng);
            }
            for a in &tx.actions { orchard_tree.append(MerkleHashOrchard::from_cmx(&ExtractedNoteCommitment::from_bytes(&a.cmx.clone().try_into().unwrap()).unwrap())).unwrap(); }
            for a in &tx.ironwood_actions { ironwood_tree.append(MerkleHashOrchard::from_cmx(&ExtractedNoteCommitment::from_bytes(&a.cmx.clone().try_into().unwrap()).unwrap())).unwrap(); }
            vtx.push(tx);
        }
        let block = CompactBlock {
            height: h as u64, hash: hash(h), prev_hash: hash(h - 1), time: 1_700_000_000 + h, vtx,
            chain_metadata: Some(ChainMetadata { sapling_commitment_tree_size: 0, orchard_commitment_tree_size: orchard_tree.size() as u32, ironwood_commitment_tree_size: ironwood_tree.size() as u32 }),
            ..Default::default()
        };
        blocks.insert(h.to_string(), B64.encode(block.encode_to_vec()).into());
        states.insert(h.to_string(), B64.encode(state(h, &orchard_tree, &ironwood_tree)).into());
    }
    let latest = BlockId { height: tip as u64, hash: hash(tip) }.encode_to_vec();
    let lightd_info = LightdInfo {
        chain_name: "test".into(),
        block_height: tip as u64,
        consensus_branch_id: format!("{:08x}", u32::from(BranchId::for_height(&params, BlockHeight::from_u32(tip)))),
        sapling_activation_height: u32::from(params.activation_height(NetworkUpgrade::Sapling).unwrap()) as u64,
        vendor: "Grain Silo fixture".into(),
        ..Default::default()
    }
    .encode_to_vec();
    println!("{}", serde_json::json!({
        "network": "test", "birthday": birthday, "tip": tip, "nu6_3": nu6_3, "orchardAt": orchard_at, "ironwoodAt": ironwood_at,
        "expected": {"orchard": orchard_value, "ironwood": if with_ironwood { ironwood_value } else { 0 }}, "latest": B64.encode(latest), "lightdInfo": B64.encode(lightd_info), "blocks": blocks, "treeStates": states,
    }));
}
