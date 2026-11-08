//! Bank tests for the XMR<->SOL swap escrow. Run against the SBF binary:
//!   SBF_OUT_DIR=$PWD/target/deploy cargo test --test swap -- --nocapture --test-threads=1
//! The real curve25519 syscalls run inside the SBF VM, so compute units are real.
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use curve25519_dalek::{edwards::EdwardsPoint, scalar::Scalar};
use solana_program_test::{ProgramTest, ProgramTestContext};
use solana_sdk::{
    clock::Clock, hash::hashv, instruction::Instruction, pubkey::Pubkey, signature::Keypair,
    signer::Signer, system_program, transaction::Transaction,
};
use xmr_sol_swap::{self as program, Swap};

const AMOUNT: u64 = 250_000_000; // 0.25 SOL
const T0_DELTA: i64 = 3_600;
const T1_DELTA: i64 = 7_200;

fn scalar(tag: &str) -> Scalar {
    Scalar::from_bytes_mod_order(hashv(&[b"xmr-sol-swap-test", tag.as_bytes()]).to_bytes())
}
fn point(s: &Scalar) -> [u8; 32] {
    EdwardsPoint::mul_base(s).compress().to_bytes()
}

struct Env {
    bob: Keypair,
    alice: Pubkey,
    a: Scalar,
    b: Scalar,
    swap_id: [u8; 32],
    swap: Pubkey,
    t0: i64,
    t1: i64,
}

async fn now(ctx: &mut ProgramTestContext) -> i64 {
    ctx.banks_client.get_sysvar::<Clock>().await.unwrap().unix_timestamp
}
async fn warp_to(ctx: &mut ProgramTestContext, ts: i64) {
    let mut clock = ctx.banks_client.get_sysvar::<Clock>().await.unwrap();
    clock.unix_timestamp = ts;
    ctx.set_sysvar(&clock);
}

/// Sends one instruction; returns (ok, compute units, logs).
async fn send(ctx: &mut ProgramTestContext, ix: Instruction, signers: &[&Keypair]) -> (bool, u64, Vec<String>) {
    let bh = ctx.get_new_latest_blockhash().await.unwrap();
    let mut all: Vec<&Keypair> = vec![&ctx.payer];
    all.extend_from_slice(signers);
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&ctx.payer.pubkey()), &all, bh);
    let r = ctx.banks_client.process_transaction_with_metadata(tx).await.unwrap();
    let meta = r.metadata.unwrap();
    (r.result.is_ok(), meta.compute_units_consumed, meta.log_messages)
}

async fn setup(tag: &str) -> (ProgramTestContext, Env) {
    let mut pt = ProgramTest::new("xmr_sol_swap", program::id(), None);
    pt.prefer_bpf(true);
    let mut ctx = pt.start_with_context().await;
    let bob = Keypair::new();
    let fund = solana_sdk::system_instruction::transfer(&ctx.payer.pubkey(), &bob.pubkey(), 2_000_000_000);
    assert!(send(&mut ctx, fund, &[]).await.0);
    let t = now(&mut ctx).await;
    let swap_id = hashv(&[b"swap-id", tag.as_bytes()]).to_bytes();
    let (swap, _) = Pubkey::find_program_address(&[program::SWAP_SEED, bob.pubkey().as_ref(), &swap_id], &program::id());
    (ctx, Env {
        bob, alice: Pubkey::new_unique(),
        a: scalar(&format!("{tag}-alice")), b: scalar(&format!("{tag}-bob")),
        swap_id, swap, t0: t + T0_DELTA, t1: t + T1_DELTA,
    })
}

fn lock_ix(e: &Env, claim_point: [u8; 32], refund_point: [u8; 32], t0: i64, t1: i64) -> Instruction {
    Instruction {
        program_id: program::id(),
        accounts: program::accounts::Lock { refunder: e.bob.pubkey(), swap: e.swap, system_program: system_program::id() }.to_account_metas(None),
        data: program::instruction::Lock { swap_id: e.swap_id, claimer: e.alice, claim_point, refund_point, amount: AMOUNT, t0, t1 }.data(),
    }
}
fn ready_ix(e: &Env, signer: Pubkey) -> Instruction {
    Instruction {
        program_id: program::id(),
        accounts: program::accounts::SetReady { refunder: signer, swap: e.swap }.to_account_metas(None),
        data: program::instruction::SetReady {}.data(),
    }
}
fn claim_ix(e: &Env, secret: [u8; 32], claimer: Pubkey) -> Instruction {
    Instruction {
        program_id: program::id(),
        accounts: program::accounts::Claim { swap: e.swap, claimer, refunder: e.bob.pubkey() }.to_account_metas(None),
        data: program::instruction::Claim { secret }.data(),
    }
}
fn refund_ix(e: &Env, secret: [u8; 32]) -> Instruction {
    Instruction {
        program_id: program::id(),
        accounts: program::accounts::Refund { swap: e.swap, refunder: e.bob.pubkey() }.to_account_metas(None),
        data: program::instruction::Refund { secret }.data(),
    }
}

async fn locked(tag: &str) -> (ProgramTestContext, Env) {
    let (mut ctx, e) = setup(tag).await;
    let ix = lock_ix(&e, point(&e.a), point(&e.b), e.t0, e.t1);
    let (ok, cu, _) = send(&mut ctx, ix, &[&e.bob]).await;
    assert!(ok, "lock failed");
    println!("CU lock = {cu}");
    (ctx, e)
}
async fn balance(ctx: &mut ProgramTestContext, k: &Pubkey) -> u64 {
    ctx.banks_client.get_balance(*k).await.unwrap()
}
async fn swap_closed(ctx: &mut ProgramTestContext, k: &Pubkey) -> bool {
    ctx.banks_client.get_account(*k).await.unwrap().is_none()
}

#[tokio::test]
async fn happy_path_ready_then_claim_reveals_a() {
    let (mut ctx, e) = locked("happy").await;
    let acct = ctx.banks_client.get_account(e.swap).await.unwrap().unwrap();
    let s = Swap::try_deserialize(&mut acct.data.as_slice()).unwrap();
    assert_eq!(s.amount, AMOUNT);
    assert!(!s.ready);
    let bob = &e.bob;
    let (ok, cu, _) = send(&mut ctx, ready_ix(&e, bob.pubkey()), &[bob]).await;
    assert!(ok);
    println!("CU set_ready = {cu}");
    let bob_before = balance(&mut ctx, &bob.pubkey()).await;
    let (ok, cu, logs) = send(&mut ctx, claim_ix(&e, e.a.to_bytes(), e.alice), &[]).await;
    assert!(ok, "{logs:?}");
    println!("CU claim = {cu}");
    assert_eq!(balance(&mut ctx, &e.alice).await, AMOUNT);
    assert!(swap_closed(&mut ctx, &e.swap).await);
    assert!(balance(&mut ctx, &bob.pubkey()).await > bob_before, "rent returns to Bob");
    // Bob now knows a and b: the Monero spend key a+b opens A+B.
    let joint = EdwardsPoint::mul_base(&e.a) + EdwardsPoint::mul_base(&e.b);
    assert_eq!(EdwardsPoint::mul_base(&(e.a + e.b)), joint);
}

#[tokio::test]
async fn claim_before_ready_and_before_t0_is_refused() {
    let (mut ctx, e) = locked("early-claim").await;
    let (ok, _, _) = send(&mut ctx, claim_ix(&e, e.a.to_bytes(), e.alice), &[]).await;
    assert!(!ok);
}

#[tokio::test]
async fn claim_after_t0_without_ready_succeeds() {
    let (mut ctx, e) = locked("t0-claim").await;
    warp_to(&mut ctx, e.t0).await;
    let (ok, _, _) = send(&mut ctx, claim_ix(&e, e.a.to_bytes(), e.alice), &[]).await;
    assert!(ok);
    assert_eq!(balance(&mut ctx, &e.alice).await, AMOUNT);
}

#[tokio::test]
async fn claim_at_or_after_t1_is_refused_even_if_ready() {
    let (mut ctx, e) = locked("late-claim").await;
    let bob = &e.bob;
    assert!(send(&mut ctx, ready_ix(&e, bob.pubkey()), &[bob]).await.0);
    warp_to(&mut ctx, e.t1).await;
    assert!(!send(&mut ctx, claim_ix(&e, e.a.to_bytes(), e.alice), &[]).await.0);
}

#[tokio::test]
async fn claim_with_wrong_secret_or_bobs_secret_is_refused() {
    let (mut ctx, e) = locked("bad-secret").await;
    let bob = &e.bob;
    assert!(send(&mut ctx, ready_ix(&e, bob.pubkey()), &[bob]).await.0);
    assert!(!send(&mut ctx, claim_ix(&e, scalar("other").to_bytes(), e.alice), &[]).await.0);
    assert!(!send(&mut ctx, claim_ix(&e, e.b.to_bytes(), e.alice), &[]).await.0);
    assert!(!send(&mut ctx, claim_ix(&e, [0u8; 32], e.alice), &[]).await.0);
}

#[tokio::test]
async fn non_canonical_scalar_a_plus_l_is_refused() {
    let (mut ctx, e) = locked("noncanonical").await;
    let bob = &e.bob;
    assert!(send(&mut ctx, ready_ix(&e, bob.pubkey()), &[bob]).await.0);
    // a + l as a 256-bit little-endian integer (same point, non-canonical encoding).
    let a = e.a.to_bytes();
    let mut out = [0u8; 32];
    let mut carry = 0u16;
    for i in 0..32 {
        let s = a[i] as u16 + program::ED25519_L[i] as u16 + carry;
        out[i] = s as u8;
        carry = s >> 8;
    }
    assert_eq!(carry, 0);
    assert!(!program::is_canonical_scalar(&out));
    assert!(!send(&mut ctx, claim_ix(&e, out, e.alice), &[]).await.0);
    assert!(send(&mut ctx, claim_ix(&e, a, e.alice), &[]).await.0);
}

#[tokio::test]
async fn claim_to_a_different_destination_is_refused() {
    let (mut ctx, e) = locked("wrong-dest").await;
    let bob = &e.bob;
    assert!(send(&mut ctx, ready_ix(&e, bob.pubkey()), &[bob]).await.0);
    assert!(!send(&mut ctx, claim_ix(&e, e.a.to_bytes(), Pubkey::new_unique()), &[]).await.0);
}

#[tokio::test]
async fn double_claim_is_refused() {
    let (mut ctx, e) = locked("double").await;
    let bob = &e.bob;
    assert!(send(&mut ctx, ready_ix(&e, bob.pubkey()), &[bob]).await.0);
    assert!(send(&mut ctx, claim_ix(&e, e.a.to_bytes(), e.alice), &[]).await.0);
    assert!(!send(&mut ctx, claim_ix(&e, e.a.to_bytes(), e.alice), &[]).await.0);
    assert!(!send(&mut ctx, refund_ix(&e, e.b.to_bytes()), &[]).await.0);
}

#[tokio::test]
async fn refund_before_t0_when_not_ready_reveals_b() {
    let (mut ctx, e) = locked("early-refund").await;
    let bob = e.bob.pubkey();
    let before = balance(&mut ctx, &bob).await;
    assert!(!send(&mut ctx, refund_ix(&e, scalar("x").to_bytes()), &[]).await.0);
    let (ok, cu, _) = send(&mut ctx, refund_ix(&e, e.b.to_bytes()), &[]).await;
    assert!(ok);
    println!("CU refund = {cu}");
    assert!(balance(&mut ctx, &bob).await >= before + AMOUNT);
    assert!(swap_closed(&mut ctx, &e.swap).await);
}

#[tokio::test]
async fn refund_after_ready_before_t1_is_refused() {
    let (mut ctx, e) = locked("ready-refund").await;
    let bob = &e.bob;
    assert!(send(&mut ctx, ready_ix(&e, bob.pubkey()), &[bob]).await.0);
    assert!(!send(&mut ctx, refund_ix(&e, e.b.to_bytes()), &[]).await.0);
    warp_to(&mut ctx, e.t0 + 1).await;
    assert!(!send(&mut ctx, refund_ix(&e, e.b.to_bytes()), &[]).await.0);
}

#[tokio::test]
async fn refund_between_t0_and_t1_is_refused_without_ready() {
    let (mut ctx, e) = locked("mid-refund").await;
    warp_to(&mut ctx, e.t0).await;
    assert!(!send(&mut ctx, refund_ix(&e, e.b.to_bytes()), &[]).await.0);
    warp_to(&mut ctx, e.t1 - 1).await;
    assert!(!send(&mut ctx, refund_ix(&e, e.b.to_bytes()), &[]).await.0);
}

#[tokio::test]
async fn refund_after_t1_succeeds_even_if_ready() {
    let (mut ctx, e) = locked("late-refund").await;
    let bob = &e.bob;
    assert!(send(&mut ctx, ready_ix(&e, bob.pubkey()), &[bob]).await.0);
    warp_to(&mut ctx, e.t1).await;
    assert!(send(&mut ctx, refund_ix(&e, e.b.to_bytes()), &[]).await.0);
    assert!(swap_closed(&mut ctx, &e.swap).await);
}

#[tokio::test]
async fn set_ready_only_by_bob_and_only_before_t0() {
    let (mut ctx, e) = locked("ready-rules").await;
    let mallory = Keypair::new();
    assert!(!send(&mut ctx, ready_ix(&e, mallory.pubkey()), &[&mallory]).await.0);
    warp_to(&mut ctx, e.t0).await;
    let bob = &e.bob;
    assert!(!send(&mut ctx, ready_ix(&e, bob.pubkey()), &[bob]).await.0);
}

#[tokio::test]
async fn lock_rejects_bad_points_and_timelocks() {
    let (mut ctx, e) = setup("bad-lock").await;
    let bob = &e.bob;
    let (a, b) = (point(&e.a), point(&e.b));
    let mut off_curve = [0u8; 32];
    off_curve[0] = 2; // y = 2 is not on ed25519
    let identity = program::ED25519_IDENTITY;
    let cases = [
        lock_ix(&e, off_curve, b, e.t0, e.t1),
        lock_ix(&e, a, identity, e.t0, e.t1),
        lock_ix(&e, a, a, e.t0, e.t1),
        lock_ix(&e, a, b, e.t0 - T0_DELTA, e.t1),
        lock_ix(&e, a, b, e.t0, e.t0),
    ];
    for ix in cases {
        assert!(!send(&mut ctx, ix, &[bob]).await.0);
    }
    assert!(send(&mut ctx, lock_ix(&e, a, b, e.t0, e.t1), &[bob]).await.0);
}

#[test]
fn windows_are_disjoint_exhaustively() {
    let (t0, t1) = (100, 200);
    for ready in [false, true] {
        for now in 0..300 {
            let c = program::claim_open(ready, now, t0, t1);
            let r = program::refund_open(ready, now, t0, t1);
            // Exactly one path is open at every moment: never both, never neither.
            assert!(c ^ r, "now={now} ready={ready} claim={c} refund={r}");
        }
    }
}

#[test]
fn opens_matches_dalek_off_chain() {
    let a = scalar("dalek");
    assert!(program::opens(&a.to_bytes(), &point(&a)));
    assert!(!program::opens(&a.to_bytes(), &point(&scalar("other"))));
}
