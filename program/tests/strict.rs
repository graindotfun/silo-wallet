//! Bank tests for strict mode, protocol v2 (two-step claim), against the SBF binary:
//!   SBF_OUT_DIR=$PWD/target/deploy cargo test --test strict -- --nocapture --test-threads=1
//! Windows (W = CLAIM_WINDOW_S = 3600, c = claim_committed_at):
//!   !ready                     : refund only, any time
//!   ready, no commit, now < t1 : nobody (the claimer may commit; no claim, no refund)
//!   ready, no commit, now >= t1: refund only
//!   ready, commit c            : claim on [c, c+W), refund from max(t1, c+W)
//! Strict and normal escrows never mix.
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use curve25519_dalek::{edwards::EdwardsPoint, scalar::Scalar};
use solana_program_test::{ProgramTest, ProgramTestContext};
use solana_sdk::{account::Account, clock::Clock, hash::hashv, instruction::Instruction, pubkey::Pubkey, signature::Keypair, signer::Signer, system_program, transaction::Transaction};
use xmr_sol_swap::{self as program, StrictSwap, CLAIM_WINDOW_S as W};

const AMOUNT: u64 = 300_000_000;
fn scalar(tag: &str) -> Scalar { Scalar::from_bytes_mod_order(hashv(&[b"xmr-sol-swap-strict", tag.as_bytes()]).to_bytes()) }
fn point(s: &Scalar) -> [u8; 32] { EdwardsPoint::mul_base(s).compress().to_bytes() }
struct Env { bob: Keypair, alice: Keypair, a: Scalar, b: Scalar, swap_id: [u8; 32], swap: Pubkey, t0: i64, t1: i64 }
async fn now(ctx: &mut ProgramTestContext) -> i64 { ctx.banks_client.get_sysvar::<Clock>().await.unwrap().unix_timestamp }
async fn warp_to(ctx: &mut ProgramTestContext, ts: i64) { let mut c = ctx.banks_client.get_sysvar::<Clock>().await.unwrap(); c.unix_timestamp = ts; ctx.set_sysvar(&c); }
async fn send(ctx: &mut ProgramTestContext, ix: Instruction, signers: &[&Keypair]) -> (bool, u64) {
    let bh = ctx.get_new_latest_blockhash().await.unwrap();
    let mut all: Vec<&Keypair> = vec![&ctx.payer]; all.extend_from_slice(signers);
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&ctx.payer.pubkey()), &all, bh);
    let r = ctx.banks_client.process_transaction_with_metadata(tx).await.unwrap();
    (r.result.is_ok(), r.metadata.unwrap().compute_units_consumed)
}
async fn setup(tag: &str) -> (ProgramTestContext, Env) {
    let mut pt = ProgramTest::new("xmr_sol_swap", program::id(), None); pt.prefer_bpf(true);
    let mut ctx = pt.start_with_context().await;
    let bob = Keypair::new(); let alice = Keypair::new();
    for k in [&bob, &alice] { let fund = solana_sdk::system_instruction::transfer(&ctx.payer.pubkey(), &k.pubkey(), 2_000_000_000); assert!(send(&mut ctx, fund, &[]).await.0); }
    let t = now(&mut ctx).await;
    let swap_id = hashv(&[b"strict-id", tag.as_bytes()]).to_bytes();
    let (swap, _) = Pubkey::find_program_address(&[program::STRICT_SEED, bob.pubkey().as_ref(), &swap_id], &program::id());
    let sc = |n: &str| scalar(&format!("{tag}-{n}"));
    (ctx, Env { bob, alice, a: sc("a"), b: sc("b"), swap_id, swap, t0: t + 10_800, t1: t + 18_000 })
}
fn lock_ix(e: &Env) -> Instruction { Instruction { program_id: program::id(), accounts: program::accounts::LockStrict { refunder: e.bob.pubkey(), swap: e.swap, system_program: system_program::id() }.to_account_metas(None),
    data: program::instruction::LockStrict { swap_id: e.swap_id, claimer: e.alice.pubkey(), claim_point: point(&e.a), refund_point: point(&e.b), amount: AMOUNT, t0: e.t0, t1: e.t1 }.data() } }
fn ready_ix(e: &Env) -> Instruction { Instruction { program_id: program::id(), accounts: program::accounts::SetReadyStrict { refunder: e.bob.pubkey(), swap: e.swap }.to_account_metas(None), data: program::instruction::SetReadyStrict {}.data() } }
fn commit_ix_for(e: &Env, signer: Pubkey) -> Instruction { Instruction { program_id: program::id(), accounts: program::accounts::ClaimCommitStrict { claimer: signer, swap: e.swap }.to_account_metas(None), data: program::instruction::ClaimCommitStrict {}.data() } }
fn commit_ix(e: &Env) -> Instruction { commit_ix_for(e, e.alice.pubkey()) }
fn claim_ix_with(e: &Env, secret: [u8; 32]) -> Instruction { Instruction { program_id: program::id(), accounts: program::accounts::ClaimStrict { swap: e.swap, claimer: e.alice.pubkey(), refunder: e.bob.pubkey() }.to_account_metas(None), data: program::instruction::ClaimStrict { secret }.data() } }
fn claim_ix(e: &Env) -> Instruction { claim_ix_with(e, e.a.to_bytes()) }
fn refund_ix_with(e: &Env, secret: [u8; 32]) -> Instruction { Instruction { program_id: program::id(), accounts: program::accounts::RefundStrict { swap: e.swap, refunder: e.bob.pubkey() }.to_account_metas(None), data: program::instruction::RefundStrict { secret }.data() } }
fn refund_ix(e: &Env) -> Instruction { refund_ix_with(e, e.b.to_bytes()) }
async fn locked(tag: &str) -> (ProgramTestContext, Env) { let (mut ctx, e) = setup(tag).await; let (ok, cu) = send(&mut ctx, lock_ix(&e), &[&e.bob]).await; assert!(ok, "lock_strict failed"); println!("CU lock_strict = {cu}"); (ctx, e) }
async fn readied(tag: &str) -> (ProgramTestContext, Env) { let (mut ctx, e) = locked(tag).await; assert!(send(&mut ctx, ready_ix(&e), &[&e.bob]).await.0); (ctx, e) }
async fn closed(ctx: &mut ProgramTestContext, k: &Pubkey) -> bool { ctx.banks_client.get_account(*k).await.unwrap().is_none() }
async fn state(ctx: &mut ProgramTestContext, e: &Env) -> StrictSwap { let a = ctx.banks_client.get_account(e.swap).await.unwrap().unwrap(); StrictSwap::try_deserialize(&mut a.data.as_slice()).unwrap() }
async fn committed_at(ctx: &mut ProgramTestContext, e: &Env) -> i64 { state(ctx, e).await.claim_committed_at }
async fn bal(ctx: &mut ProgramTestContext, k: &Pubkey) -> u64 { ctx.banks_client.get_balance(*k).await.unwrap() }

#[tokio::test]
async fn strict_happy_path_ready_commit_claim() {
    let (mut ctx, e) = locked("happy").await;
    let s = state(&mut ctx, &e).await;
    assert_eq!(s.amount, AMOUNT); assert!(!s.ready); assert_eq!(s.claim_committed_at, 0);
    let (ok, cu) = send(&mut ctx, ready_ix(&e), &[&e.bob]).await; assert!(ok); println!("CU set_ready_strict = {cu}");
    let (ok, cu) = send(&mut ctx, commit_ix(&e), &[&e.alice]).await; assert!(ok); println!("CU claim_commit_strict = {cu}");
    let c = committed_at(&mut ctx, &e).await; assert!(c > 0);
    let before = bal(&mut ctx, &e.alice.pubkey()).await;
    let (ok, cu) = send(&mut ctx, claim_ix(&e), &[]).await; assert!(ok); println!("CU claim_strict = {cu}");
    assert_eq!(bal(&mut ctx, &e.alice.pubkey()).await, before + AMOUNT);
    assert!(closed(&mut ctx, &e.swap).await);
}

#[tokio::test]
async fn strict_claim_never_works_without_ready_or_without_a_commit_at_any_time() {
    let (mut ctx, e) = locked("noready").await;
    for ts in [e.t0 - 60, e.t0, e.t0 + 1, (e.t0 + e.t1) / 2, e.t1 - 1, e.t1, e.t1 + 86_400] {
        warp_to(&mut ctx, ts).await;
        assert!(!send(&mut ctx, claim_ix(&e), &[]).await.0, "claim without ready at {ts} must fail");
        assert!(!send(&mut ctx, commit_ix(&e), &[&e.alice]).await.0, "commit without ready at {ts} must fail");
    }
    assert!(send(&mut ctx, refund_ix(&e), &[]).await.0, "refund works long after t1 while not ready");
    assert!(closed(&mut ctx, &e.swap).await);
    // ready but never committed: the claim stays closed at every time, with the right secrets
    let (mut ctx, e) = readied("nocommit").await;
    for ts in [e.t0 - 60, e.t0 + 1, e.t1 - 1, e.t1, e.t1 + 1, e.t1 + W, e.t1 + 86_400] {
        warp_to(&mut ctx, ts).await;
        assert!(!send(&mut ctx, claim_ix(&e), &[]).await.0, "claim without a commit at {ts} must fail");
    }
}

#[tokio::test]
async fn strict_refund_works_any_time_before_ready_including_after_t0() {
    let (mut ctx, e) = locked("late-refund").await;
    warp_to(&mut ctx, e.t0 + 100).await;
    assert!(!send(&mut ctx, ready_ix(&e), &[&e.bob]).await.0, "ready only before t0");
    assert!(!send(&mut ctx, refund_ix_with(&e, e.a.to_bytes()), &[]).await.0, "wrong secret");
    assert!(send(&mut ctx, refund_ix(&e), &[]).await.0);
}

#[tokio::test]
async fn strict_refund_after_ready_without_commit_only_from_t1() {
    let (mut ctx, e) = readied("ready-windows").await;
    assert!(!send(&mut ctx, refund_ix(&e), &[]).await.0, "no refund after ready before t1");
    warp_to(&mut ctx, e.t1 - 1).await;
    assert!(!send(&mut ctx, refund_ix(&e), &[]).await.0, "no refund at t1 - 1");
    warp_to(&mut ctx, e.t1).await;
    assert!(!send(&mut ctx, commit_ix(&e), &[&e.alice]).await.0, "no commit from t1");
    assert!(!send(&mut ctx, claim_ix(&e), &[]).await.0, "no claim from t1 without a commit");
    assert!(send(&mut ctx, refund_ix(&e), &[]).await.0, "refund from t1 when nothing was committed");
}

#[tokio::test]
async fn strict_commit_only_by_the_claimer_once_ready_and_before_t1() {
    let (mut ctx, e) = locked("commit-rules").await;
    assert!(!send(&mut ctx, commit_ix(&e), &[&e.alice]).await.0, "not before ready");
    assert!(send(&mut ctx, ready_ix(&e), &[&e.bob]).await.0);
    // the refunder, a stranger, an unsigned meta: all refused
    assert!(!send(&mut ctx, commit_ix_for(&e, e.bob.pubkey()), &[&e.bob]).await.0, "the refunder cannot commit");
    let rogue = Keypair::new();
    assert!(!send(&mut ctx, commit_ix_for(&e, rogue.pubkey()), &[&rogue]).await.0, "a stranger cannot commit");
    let mut unsigned = commit_ix(&e); unsigned.accounts[0].is_signer = false;
    assert!(!send(&mut ctx, unsigned, &[]).await.0, "the claimer's key must sign");
    assert_eq!(committed_at(&mut ctx, &e).await, 0);
    // a commit at t1 - 1 is the last one; a second commit never changes the first
    warp_to(&mut ctx, e.t1 - 1).await;
    assert!(send(&mut ctx, commit_ix(&e), &[&e.alice]).await.0);
    let c = committed_at(&mut ctx, &e).await; assert_eq!(c, e.t1 - 1);
    warp_to(&mut ctx, e.t1 - 1).await;
    assert!(!send(&mut ctx, commit_ix(&e), &[&e.alice]).await.0, "second commit refused");
    assert_eq!(committed_at(&mut ctx, &e).await, c);
    // late commit on a fresh escrow
    let (mut ctx2, e2) = readied("late-commit").await;
    warp_to(&mut ctx2, e2.t1).await;
    assert!(!send(&mut ctx2, commit_ix(&e2), &[&e2.alice]).await.0, "late commit refused");
    warp_to(&mut ctx2, e2.t1 + 5).await;
    assert!(!send(&mut ctx2, commit_ix(&e2), &[&e2.alice]).await.0);
}

#[tokio::test]
async fn strict_claim_window_is_exactly_c_to_c_plus_w_and_refund_waits_behind_it() {
    // commit well before t1; claim at the edges of the window
    for (name, dt, claim_ok) in [("at-c", 0, true), ("c-plus-w-minus-1", W - 1, true), ("at-c-plus-w", W, false), ("after-window", W + 600, false)] {
        let (mut ctx, e) = readied(&format!("win-{name}")).await;
        warp_to(&mut ctx, e.t0 + 100).await;
        assert!(send(&mut ctx, commit_ix(&e), &[&e.alice]).await.0);
        let c = committed_at(&mut ctx, &e).await;
        warp_to(&mut ctx, c + dt).await;
        // the refund is closed for the whole window and before t1, whatever the clock says
        let refund_ok = c + dt >= c + W && c + dt >= e.t1;
        let (r, _) = send(&mut ctx, refund_ix(&e), &[]).await;
        assert_eq!(r, refund_ok, "refund at c+{dt}");
        if r { assert!(closed(&mut ctx, &e.swap).await); continue; }
        let (cl, _) = send(&mut ctx, claim_ix(&e), &[]).await;
        assert_eq!(cl, claim_ok, "claim at c+{dt}");
    }
}

#[tokio::test]
async fn strict_commit_before_t1_keeps_the_claim_open_past_t1_and_the_refund_shut() {
    let (mut ctx, e) = readied("late-window").await;
    warp_to(&mut ctx, e.t1 - 1).await;
    assert!(send(&mut ctx, commit_ix(&e), &[&e.alice]).await.0);
    let c = e.t1 - 1;
    for ts in [e.t1, e.t1 + 1, c + W - 1] {
        warp_to(&mut ctx, ts).await;
        assert!(!send(&mut ctx, refund_ix(&e), &[]).await.0, "refund closed at {ts} (inside the window)");
    }
    // the claim lands inside the window, past t1
    warp_to(&mut ctx, c + W - 1).await;
    assert!(send(&mut ctx, claim_ix(&e), &[]).await.0, "claim inside the window after t1");
    // the other branch: nobody claims, the refund opens at max(t1, c + W) = c + W
    let (mut ctx2, e2) = readied("late-window-refund").await;
    warp_to(&mut ctx2, e2.t1 - 1).await;
    assert!(send(&mut ctx2, commit_ix(&e2), &[&e2.alice]).await.0);
    warp_to(&mut ctx2, e2.t1 - 1 + W).await;
    assert!(!send(&mut ctx2, claim_ix(&e2), &[]).await.0, "claim closed at c + W");
    assert!(send(&mut ctx2, refund_ix(&e2), &[]).await.0, "refund at c + W");
}

#[tokio::test]
async fn strict_resend_of_the_claim_is_harmless_and_replay_moves_nothing() {
    let (mut ctx, e) = readied("resend").await;
    assert!(send(&mut ctx, commit_ix(&e), &[&e.alice]).await.0);
    // failed attempts (wrong secrets, wrong destination) leave the escrow exactly as it was
    let rogue = Keypair::new();
    let mut to_rogue = claim_ix(&e); to_rogue.accounts[1].pubkey = rogue.pubkey();
    for ix in [claim_ix_with(&e, e.b.to_bytes()), claim_ix_with(&e, [0u8; 32]), to_rogue] {
        assert!(!send(&mut ctx, ix, &[]).await.0);
    }
    assert!(!closed(&mut ctx, &e.swap).await);
    assert_eq!(bal(&mut ctx, &rogue.pubkey()).await, 0);
    let before = bal(&mut ctx, &e.alice.pubkey()).await;
    assert!(send(&mut ctx, claim_ix(&e), &[]).await.0);
    // sending it again (same bytes, new blockhash) fails and moves nothing
    assert!(!send(&mut ctx, claim_ix(&e), &[]).await.0);
    assert!(!send(&mut ctx, refund_ix(&e), &[]).await.0);
    assert_eq!(bal(&mut ctx, &e.alice.pubkey()).await, before + AMOUNT);
}

#[tokio::test]
async fn strict_and_normal_escrows_never_mix() {
    let (mut ctx, e) = locked("mix").await;
    let normal_claim = Instruction { program_id: program::id(), accounts: program::accounts::Claim { swap: e.swap, claimer: e.alice.pubkey(), refunder: e.bob.pubkey() }.to_account_metas(None), data: program::instruction::Claim { secret: e.a.to_bytes() }.data() };
    warp_to(&mut ctx, e.t0 + 10).await; // the normal claim window would be open from t0 without ready
    assert!(!send(&mut ctx, normal_claim, &[]).await.0, "normal claim must not open a strict escrow");
    let normal_refund = Instruction { program_id: program::id(), accounts: program::accounts::Refund { swap: e.swap, refunder: e.bob.pubkey() }.to_account_metas(None), data: program::instruction::Refund { secret: e.b.to_bytes() }.data() };
    assert!(!send(&mut ctx, normal_refund, &[]).await.0);
    assert!(!closed(&mut ctx, &e.swap).await);
}

// ---- Rogue signers, replay, strict instructions on a normal account ----
fn ready_ix_for(e: &Env, signer: Pubkey) -> Instruction { Instruction { program_id: program::id(), accounts: program::accounts::SetReadyStrict { refunder: signer, swap: e.swap }.to_account_metas(None), data: program::instruction::SetReadyStrict {}.data() } }
async fn ready_flag(ctx: &mut ProgramTestContext, e: &Env) -> bool { state(ctx, e).await.ready }

#[tokio::test]
async fn strict_rogue_signers_and_rogue_destinations_are_refused() {
    let (mut ctx, e) = locked("rogue").await;
    let rogue = Keypair::new();
    assert!(!send(&mut ctx, ready_ix_for(&e, rogue.pubkey()), &[&rogue]).await.0);
    assert!(!ready_flag(&mut ctx, &e).await);
    let mut unsigned = ready_ix(&e); unsigned.accounts[0].is_signer = false;
    assert!(!send(&mut ctx, unsigned, &[]).await.0);
    assert!(send(&mut ctx, ready_ix(&e), &[&e.bob]).await.0);
    assert!(send(&mut ctx, commit_ix(&e), &[&e.alice]).await.0);
    let mut to_rogue = claim_ix(&e); to_rogue.accounts[1].pubkey = rogue.pubkey();
    assert!(!send(&mut ctx, to_rogue, &[]).await.0);
    let mut rogue_refunder = claim_ix(&e); rogue_refunder.accounts[2].pubkey = rogue.pubkey();
    assert!(!send(&mut ctx, rogue_refunder, &[]).await.0);
    assert!(!send(&mut ctx, claim_ix_with(&e, e.b.to_bytes()), &[]).await.0, "bob's scalar does not open alice's point");
    assert!(!closed(&mut ctx, &e.swap).await);
    assert_eq!(bal(&mut ctx, &rogue.pubkey()).await, 0);
    let c = committed_at(&mut ctx, &e).await;
    warp_to(&mut ctx, (e.t1).max(c + W)).await;
    let mut refund_to_rogue = refund_ix(&e); refund_to_rogue.accounts[1].pubkey = rogue.pubkey();
    assert!(!send(&mut ctx, refund_to_rogue, &[]).await.0);
    assert!(send(&mut ctx, refund_ix(&e), &[]).await.0);
}

#[tokio::test]
async fn strict_replay_after_close_and_double_lock_are_refused() {
    let (mut ctx, e) = locked("replay").await;
    assert!(!send(&mut ctx, lock_ix(&e), &[&e.bob]).await.0, "a second lock on an open escrow must fail");
    assert!(send(&mut ctx, ready_ix(&e), &[&e.bob]).await.0);
    assert!(!send(&mut ctx, ready_ix(&e), &[&e.bob]).await.0 || ready_flag(&mut ctx, &e).await, "ready twice changes nothing");
    assert!(send(&mut ctx, commit_ix(&e), &[&e.alice]).await.0);
    assert!(send(&mut ctx, claim_ix(&e), &[]).await.0);
    assert!(closed(&mut ctx, &e.swap).await);
    let before = bal(&mut ctx, &e.alice.pubkey()).await;
    for ix in [claim_ix(&e), refund_ix(&e)] { assert!(!send(&mut ctx, ix, &[]).await.0); }
    assert!(!send(&mut ctx, ready_ix(&e), &[&e.bob]).await.0);
    assert!(!send(&mut ctx, commit_ix(&e), &[&e.alice]).await.0);
    assert_eq!(bal(&mut ctx, &e.alice.pubkey()).await, before);
    let (mut ctx2, e2) = locked("replay-refund").await;
    assert!(send(&mut ctx2, refund_ix(&e2), &[]).await.0);
    assert!(!send(&mut ctx2, refund_ix(&e2), &[]).await.0);
    assert!(!send(&mut ctx2, claim_ix(&e2), &[]).await.0);
}

#[tokio::test]
async fn strict_instructions_refuse_a_normal_escrow() {
    let (mut ctx, e) = setup("normal-under-strict").await;
    let (normal, _) = Pubkey::find_program_address(&[program::SWAP_SEED, e.bob.pubkey().as_ref(), &e.swap_id], &program::id());
    let lock = Instruction { program_id: program::id(), accounts: program::accounts::Lock { refunder: e.bob.pubkey(), swap: normal, system_program: system_program::id() }.to_account_metas(None),
        data: program::instruction::Lock { swap_id: e.swap_id, claimer: e.alice.pubkey(), claim_point: point(&e.a), refund_point: point(&e.b), amount: AMOUNT, t0: e.t0, t1: e.t1 }.data() };
    assert!(send(&mut ctx, lock, &[&e.bob]).await.0);
    let mut strict_ready = ready_ix(&e); strict_ready.accounts[1].pubkey = normal;
    let mut strict_commit = commit_ix(&e); strict_commit.accounts[1].pubkey = normal;
    let mut strict_claim = claim_ix(&e); strict_claim.accounts[0].pubkey = normal;
    let mut strict_refund = refund_ix(&e); strict_refund.accounts[0].pubkey = normal;
    warp_to(&mut ctx, e.t0 + 10).await;
    assert!(!send(&mut ctx, strict_ready, &[&e.bob]).await.0, "strict ready must not touch a normal escrow");
    assert!(!send(&mut ctx, strict_commit, &[&e.alice]).await.0, "strict commit must not touch a normal escrow");
    assert!(!send(&mut ctx, strict_claim, &[]).await.0, "strict claim must not touch a normal escrow");
    assert!(!send(&mut ctx, strict_refund, &[]).await.0, "strict refund must not touch a normal escrow");
    assert!(ctx.banks_client.get_account(normal).await.unwrap().is_some());
    assert!(bal(&mut ctx, &normal).await > AMOUNT);
}

#[tokio::test]
async fn strict_old_layout_escrow_is_refused_by_every_instruction_and_loses_nothing() {
    // Why the upgrade's quiesce check is a hard gate: a strict escrow written by the pre-v2 binary (186 bytes of data, no commit time) cannot be read by this one. Every instruction refuses it and moves nothing; there is no way to hurt it, but no way to open it either.
    let (mut ctx, e) = readied("old-layout").await;
    let acct = ctx.banks_client.get_account(e.swap).await.unwrap().unwrap();
    let mut old = acct.clone(); old.data.truncate(8 + 186);
    ctx.set_account(&e.swap, &Account { lamports: acct.lamports, data: old.data.clone(), owner: acct.owner, executable: false, rent_epoch: 0 }.into());
    let total = bal(&mut ctx, &e.swap).await;
    warp_to(&mut ctx, e.t1 + 10).await;
    for (ix, signers) in [(ready_ix(&e), vec![&e.bob]), (commit_ix(&e), vec![&e.alice]), (claim_ix(&e), vec![]), (refund_ix(&e), vec![])] {
        assert!(!send(&mut ctx, ix, &signers).await.0);
    }
    assert_eq!(bal(&mut ctx, &e.swap).await, total);
}

/// Host-level, exhaustive over a grid of states: the claim and refund windows never overlap, and after max(t1, c + W) the refund is always open.
#[test]
fn strict_windows_are_disjoint_exhaustively() {
    let t1 = 10_000i64;
    for ready in [false, true] {
        for committed in [0i64, 1, 5_000, t1 - 1, t1 + 1, 20_000] {
            if committed != 0 && !ready { continue; } // a commit needs ready, and ready never clears
            for now in (0..40_000i64).step_by(7).chain([committed - 1, committed, committed + W - 1, committed + W, committed + W + 1, t1 - 1, t1, t1 + 1]) {
                let claim = program::strict_claim_open(ready, committed, now);
                let refund = program::strict_refund_open(ready, committed, now, t1);
                assert!(!(claim && refund), "overlap at ready={ready} c={committed} now={now}");
                if ready && committed == 0 { assert!(!claim, "claim without a commit"); }
                if !ready { assert!(!claim && refund, "not ready: refund only"); }
                if ready && now >= t1.max(committed + W) { assert!(refund && !claim, "settled state must be refundable"); }
                if ready && committed != 0 && now >= committed && now < committed + W { assert!(claim && !refund, "inside the window: claim only"); }
            }
        }
    }
}
