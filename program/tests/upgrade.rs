//! Upgrade compatibility: a NORMAL escrow created by the OLD artifact (the v1 build live on mainnet, 215,944 bytes: sha256 4033eb70... from the
//! same-source Docker build, live since 8 Nov 2026 and the default, or 76424c24... from the original macOS build; run-bank-tests.sh OLD_BASELINE picks one)
//! must still be claimed and refunded by the NEW artifact (Docker v2 build, sha256 6ac58cdc..., 265,488 bytes). Two phases, because one test process loads one binary:
//!   1. export, with SBF_OUT_DIR on the OLD artifact:  OLD_ARTIFACT_EXPORT_DIR=<dir> cargo test --test upgrade export_ -- --test-threads=1
//!   2. import, with SBF_OUT_DIR on the NEW artifact:  OLD_ARTIFACT_IMPORT_DIR=<dir> cargo test --test upgrade import_ -- --test-threads=1
//! Without the env variable each test is skipped (it prints that), so a plain `cargo test` is unaffected. Only normal instructions are used in phase 1
//! (they exist in both artifacts); the account bytes written are exactly what the old program produced.
use anchor_lang::{InstructionData, ToAccountMetas};
use curve25519_dalek::{edwards::EdwardsPoint, scalar::Scalar};
use solana_program_test::{ProgramTest, ProgramTestContext};
use solana_sdk::{account::Account, clock::Clock, hash::hashv, instruction::Instruction, pubkey::Pubkey, signature::Keypair, signer::Signer, system_program, transaction::Transaction};
use xmr_sol_swap as program;

const AMOUNT: u64 = 250_000_000;
const T0: i64 = 1_900_000_000 + 3_600;
const T1: i64 = 1_900_000_000 + 7_200;
fn scalar(tag: &str) -> Scalar { Scalar::from_bytes_mod_order(hashv(&[b"xmr-sol-swap-upgrade", tag.as_bytes()]).to_bytes()) }
fn point(s: &Scalar) -> [u8; 32] { EdwardsPoint::mul_base(s).compress().to_bytes() }
fn bob() -> Keypair { solana_sdk::signature::keypair_from_seed(&hashv(&[b"upgrade-bob"]).to_bytes()).unwrap() }
fn alice() -> Pubkey { solana_sdk::signature::keypair_from_seed(&hashv(&[b"upgrade-alice"]).to_bytes()).unwrap().pubkey() }
fn swap_id(tag: &str) -> [u8; 32] { hashv(&[b"upgrade-id", tag.as_bytes()]).to_bytes() }
fn swap_key(tag: &str) -> Pubkey { Pubkey::find_program_address(&[program::SWAP_SEED, bob().pubkey().as_ref(), &swap_id(tag)], &program::id()).0 }
async fn warp_to(ctx: &mut ProgramTestContext, ts: i64) { let mut c = ctx.banks_client.get_sysvar::<Clock>().await.unwrap(); c.unix_timestamp = ts; ctx.set_sysvar(&c); }
async fn send(ctx: &mut ProgramTestContext, ix: Instruction, signers: &[&Keypair]) -> bool {
    let bh = ctx.get_new_latest_blockhash().await.unwrap();
    let mut all: Vec<&Keypair> = vec![&ctx.payer]; all.extend_from_slice(signers);
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&ctx.payer.pubkey()), &all, bh);
    ctx.banks_client.process_transaction_with_metadata(tx).await.unwrap().result.is_ok()
}
async fn start() -> ProgramTestContext { let mut pt = ProgramTest::new("xmr_sol_swap", program::id(), None); pt.prefer_bpf(true); pt.start_with_context().await }
fn lock_ix(tag: &str) -> Instruction { Instruction { program_id: program::id(), accounts: program::accounts::Lock { refunder: bob().pubkey(), swap: swap_key(tag), system_program: system_program::id() }.to_account_metas(None),
    data: program::instruction::Lock { swap_id: swap_id(tag), claimer: alice(), claim_point: point(&scalar("a")), refund_point: point(&scalar("b")), amount: AMOUNT, t0: T0, t1: T1 }.data() } }
fn ready_ix(tag: &str) -> Instruction { Instruction { program_id: program::id(), accounts: program::accounts::SetReady { refunder: bob().pubkey(), swap: swap_key(tag) }.to_account_metas(None), data: program::instruction::SetReady {}.data() } }
fn claim_ix(tag: &str, secret: [u8; 32]) -> Instruction { Instruction { program_id: program::id(), accounts: program::accounts::Claim { swap: swap_key(tag), claimer: alice(), refunder: bob().pubkey() }.to_account_metas(None), data: program::instruction::Claim { secret }.data() } }
fn refund_ix(tag: &str, secret: [u8; 32]) -> Instruction { Instruction { program_id: program::id(), accounts: program::accounts::Refund { swap: swap_key(tag), refunder: bob().pubkey() }.to_account_metas(None), data: program::instruction::Refund { secret }.data() } }
fn strict_claim_ix(tag: &str) -> Instruction { Instruction { program_id: program::id(), accounts: program::accounts::ClaimStrict { swap: swap_key(tag), claimer: alice(), refunder: bob().pubkey() }.to_account_metas(None), data: program::instruction::ClaimStrict { secret: scalar("a").to_bytes() }.data() } }

async fn fund_bob(ctx: &mut ProgramTestContext) { let ix = solana_sdk::system_instruction::transfer(&ctx.payer.pubkey(), &bob().pubkey(), 2_000_000_000); assert!(send(ctx, ix, &[]).await); }
fn dir(var: &str) -> Option<std::path::PathBuf> { std::env::var_os(var).map(Into::into) }
fn hexs(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }
fn unhex(s: &str) -> Vec<u8> { (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect() }

#[tokio::test]
async fn export_old_artifact_normal_escrows() {
    let Some(out) = dir("OLD_ARTIFACT_EXPORT_DIR") else { println!("skipped: OLD_ARTIFACT_EXPORT_DIR not set"); return; };
    std::fs::create_dir_all(&out).unwrap();
    for (tag, ready) in [("locked", false), ("ready", true)] {
        let mut ctx = start().await; fund_bob(&mut ctx).await; warp_to(&mut ctx, 1_900_000_000).await;
        assert!(send(&mut ctx, lock_ix(tag), &[&bob()]).await, "old artifact: lock");
        if ready { assert!(send(&mut ctx, ready_ix(tag), &[&bob()]).await, "old artifact: set_ready"); }
        let acct = ctx.banks_client.get_account(swap_key(tag)).await.unwrap().unwrap();
        assert_eq!(acct.owner, program::id());
        std::fs::write(out.join(format!("{tag}.account")), format!("{} {}\n", acct.lamports, hexs(&acct.data))).unwrap();
        println!("exported {tag}: {} lamports, {} data bytes", acct.lamports, acct.data.len());
    }
}

async fn import(tag: &str) -> ProgramTestContext {
    let base = dir("OLD_ARTIFACT_IMPORT_DIR").unwrap();
    let text = std::fs::read_to_string(base.join(format!("{tag}.account"))).unwrap();
    let mut it = text.split_whitespace(); let lamports: u64 = it.next().unwrap().parse().unwrap(); let data = unhex(it.next().unwrap());
    let mut pt = ProgramTest::new("xmr_sol_swap", program::id(), None); pt.prefer_bpf(true);
    pt.add_account(swap_key(tag), Account { lamports, data, owner: program::id(), executable: false, rent_epoch: 0 });
    let mut ctx = pt.start_with_context().await; fund_bob(&mut ctx).await; warp_to(&mut ctx, 1_900_000_000 + 60).await; ctx
}

#[tokio::test]
async fn import_old_locked_escrow_refunds_before_t0_and_refuses_an_early_claim_under_the_new_artifact() {
    if dir("OLD_ARTIFACT_IMPORT_DIR").is_none() { println!("skipped: OLD_ARTIFACT_IMPORT_DIR not set"); return; }
    let mut ctx = import("locked").await;
    assert!(!send(&mut ctx, claim_ix("locked", scalar("a").to_bytes()), &[]).await, "no claim before t0 without ready");
    assert!(!send(&mut ctx, strict_claim_ix("locked"), &[]).await, "the strict claim must not open an old normal escrow");
    assert!(!send(&mut ctx, refund_ix("locked", scalar("a").to_bytes()), &[]).await, "wrong secret");
    let before = ctx.banks_client.get_balance(bob().pubkey()).await.unwrap();
    assert!(send(&mut ctx, refund_ix("locked", scalar("b").to_bytes()), &[]).await, "the new artifact refunds an escrow the old one created");
    assert!(ctx.banks_client.get_account(swap_key("locked")).await.unwrap().is_none());
    assert!(ctx.banks_client.get_balance(bob().pubkey()).await.unwrap() >= before + AMOUNT);
}

#[tokio::test]
async fn import_old_locked_escrow_claims_after_t0_under_the_new_artifact_normal_rules() {
    if dir("OLD_ARTIFACT_IMPORT_DIR").is_none() { println!("skipped: OLD_ARTIFACT_IMPORT_DIR not set"); return; }
    let mut ctx = import("locked").await; warp_to(&mut ctx, T0 + 1).await;
    assert!(send(&mut ctx, claim_ix("locked", scalar("a").to_bytes()), &[]).await, "normal rule kept: claim from t0 without ready");
    assert_eq!(ctx.banks_client.get_balance(alice()).await.unwrap(), AMOUNT);
}

#[tokio::test]
async fn import_old_ready_escrow_claims_before_t1_and_refunds_from_t1_under_the_new_artifact() {
    if dir("OLD_ARTIFACT_IMPORT_DIR").is_none() { println!("skipped: OLD_ARTIFACT_IMPORT_DIR not set"); return; }
    let mut ctx = import("ready").await;
    assert!(!send(&mut ctx, refund_ix("ready", scalar("b").to_bytes()), &[]).await, "no refund after ready before t1");
    assert!(send(&mut ctx, claim_ix("ready", scalar("a").to_bytes()), &[]).await);
    assert_eq!(ctx.banks_client.get_balance(alice()).await.unwrap(), AMOUNT);
    let mut ctx2 = import("ready").await; warp_to(&mut ctx2, T1).await;
    assert!(!send(&mut ctx2, claim_ix("ready", scalar("a").to_bytes()), &[]).await, "no claim from t1");
    assert!(send(&mut ctx2, refund_ix("ready", scalar("b").to_bytes()), &[]).await);
}

/// Self-test of run-bank-tests.sh: with BANK_SELFTEST_INJECT_FAILURE=1 this test fails on purpose, and the script must then fail. Otherwise it is a no-op pass.
#[tokio::test]
async fn import_zz_selftest_injected_failure() {
    if dir("OLD_ARTIFACT_IMPORT_DIR").is_none() { println!("skipped: OLD_ARTIFACT_IMPORT_DIR not set"); return; }
    assert!(std::env::var_os("BANK_SELFTEST_INJECT_FAILURE").is_none(), "injected failure (script self-test)");
}
