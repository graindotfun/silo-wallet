//! C5 evidence: differential upgrade-equivalence test between the LIVE escrow
//! binary and the Docker verified build of the same source.
//!
//! Both real SBF artifacts are loaded at the declared program id
//! 7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS under the upgradeable BPF loader,
//! exactly like mainnet. Switching binaries mid-run is done with a real
//! `bpf_loader_upgradeable::upgrade` instruction signed by a generated test
//! authority, followed by a slot warp so the new bytes become effective.
//!
//! Every script (sequence of instructions at scripted unix timestamps) is run in:
//!   * OLD only (baseline), NEW only,
//!   * OLD then upgrade to NEW before step k (every k),
//!   * NEW then "downgrade" to OLD before step k (every k),
//!   * for the multi-escrow script also every double switch OLD>NEW>OLD and NEW>OLD>NEW.
//! Per step we compare the transaction result, the program logs (compute unit
//! lines removed), and the full state of every escrow PDA (lamports, owner, data)
//! plus Bob, Alice and Mallory balances, against the OLD only baseline.
//! Compute units are recorded separately and reported (codegen may change CU).
//!
//! Run:
//!   OLD_SO=/abs/old_live.so NEW_SO=/abs/new_verified.so \
//!     cargo test --test upgrade_equivalence -- --nocapture --test-threads=1
use anchor_lang::{InstructionData, ToAccountMetas};
use curve25519_dalek::{edwards::EdwardsPoint, scalar::Scalar};
use solana_program_test::{ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::{Account, AccountSharedData},
    bpf_loader_upgradeable::{self, UpgradeableLoaderState},
    clock::Clock,
    hash::hashv,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    rent::Rent,
    signature::Keypair,
    signer::{keypair::keypair_from_seed, Signer},
    system_program,
    transaction::Transaction,
};
use xmr_sol_swap as program;

const OLD_SHA: &str = "76424c24aa28d5f74e52781df0a98d95e43003ad2374c48f47acd1c21045599d";
const NEW_SHA: &str = "4033eb70a5d4d6f7d47654d278a54633bafd5366303b7882a17032d4cbbc3515";

const BASE: i64 = 1_800_000_000;
const T0: i64 = 3_600;
const T1: i64 = 7_200;
const AMOUNT: u64 = 250_000_000;
const NE: usize = 3;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Bin {
    Old,
    New,
}

struct Bins {
    old: Vec<u8>,
    new: Vec<u8>,
}
impl Bins {
    fn get(&self, b: Bin) -> &[u8] {
        match b {
            Bin::Old => &self.old,
            Bin::New => &self.new,
        }
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn sha_hex(b: &[u8]) -> String {
    hex(&hashv(&[b]).to_bytes())
}

fn load_bins() -> Bins {
    let old = std::fs::read(std::env::var("OLD_SO").expect("set OLD_SO to the live dump")).unwrap();
    let new = std::fs::read(std::env::var("NEW_SO").expect("set NEW_SO to the verified build")).unwrap();
    assert_eq!(sha_hex(&old), OLD_SHA, "OLD_SO is not the live binary");
    assert_eq!(sha_hex(&new), NEW_SHA, "NEW_SO is not the verified build");
    Bins { old, new }
}

// ---------- deterministic test identities (generated, test only) ----------
fn seed32(tag: &str) -> [u8; 32] {
    hashv(&[b"c5-upgrade-equivalence", tag.as_bytes()]).to_bytes()
}
fn kp(tag: &str) -> Keypair {
    keypair_from_seed(&seed32(tag)).unwrap()
}
fn bob(e: usize) -> Keypair {
    kp(&format!("bob-{e}"))
}
fn alice(e: usize) -> Pubkey {
    kp(&format!("alice-{e}")).pubkey()
}
fn mallory() -> Keypair {
    kp("mallory")
}
fn authority() -> Keypair {
    kp("upgrade-authority")
}
fn sc(tag: &str) -> Scalar {
    Scalar::from_bytes_mod_order(seed32(tag))
}
fn sa(e: usize) -> Scalar {
    sc(&format!("a-{e}"))
}
fn sb(e: usize) -> Scalar {
    sc(&format!("b-{e}"))
}
fn swap_id(e: usize) -> [u8; 32] {
    seed32(&format!("swap-id-{e}"))
}
fn swap_pda(e: usize) -> Pubkey {
    Pubkey::find_program_address(&[program::SWAP_SEED, bob(e).pubkey().as_ref(), &swap_id(e)], &program::id()).0
}
/// Genesis account that funds the upgrade buffer, so total lamports (bank
/// capitalization) stay consistent when the buffer is injected with set_account.
fn reserve() -> Pubkey {
    kp("buffer-reserve").pubkey()
}
fn programdata() -> Pubkey {
    Pubkey::find_program_address(&[program::id().as_ref()], &bpf_loader_upgradeable::id()).0
}

// ---------- script language ----------
#[derive(Clone, Copy, Debug)]
enum Pt {
    A,
    B,
    OffCurve,
    Identity,
    LowOrder,
    NonCanonY,
}
#[derive(Clone, Copy, Debug)]
enum Sec {
    A,
    B,
    Zero,
    Random,
    APlusL,
    L,
    Max,
}
#[derive(Clone, Debug)]
enum Op {
    Lock { e: usize, cp: Pt, rp: Pt, amount: u64, t0: i64, t1: i64 },
    Ready { e: usize, mallory: bool },
    Claim { e: usize, s: Sec, wrong_dest: bool },
    Refund { e: usize, s: Sec, wrong_refunder: bool },
    /// Claim accounts of escrow e with arbitrary instruction data.
    Raw { e: usize, data: Vec<u8> },
}
#[derive(Clone, Debug)]
struct Step {
    at: i64,
    op: Op,
}
fn st(at: i64, op: Op) -> Step {
    Step { at, op }
}
fn lock(e: usize, at: i64) -> Step {
    st(at, Op::Lock { e, cp: Pt::A, rp: Pt::B, amount: AMOUNT, t0: T0, t1: T1 })
}
fn ready(e: usize, at: i64) -> Step {
    st(at, Op::Ready { e, mallory: false })
}
fn claim(e: usize, at: i64) -> Step {
    st(at, Op::Claim { e, s: Sec::A, wrong_dest: false })
}
fn refund(e: usize, at: i64) -> Step {
    st(at, Op::Refund { e, s: Sec::B, wrong_refunder: false })
}
fn claim_s(e: usize, at: i64, s: Sec) -> Step {
    st(at, Op::Claim { e, s, wrong_dest: false })
}
fn refund_s(e: usize, at: i64, s: Sec) -> Step {
    st(at, Op::Refund { e, s, wrong_refunder: false })
}
fn lockp(e: usize, at: i64, cp: Pt, rp: Pt, amount: u64, t0: i64, t1: i64) -> Step {
    st(at, Op::Lock { e, cp, rp, amount, t0, t1 })
}

fn point_bytes(p: Pt, e: usize) -> [u8; 32] {
    match p {
        Pt::A => EdwardsPoint::mul_base(&sa(e)).compress().to_bytes(),
        Pt::B => EdwardsPoint::mul_base(&sb(e)).compress().to_bytes(),
        Pt::OffCurve => {
            let mut x = [0u8; 32];
            x[0] = 2;
            x
        }
        Pt::Identity => program::ED25519_IDENTITY,
        Pt::LowOrder => {
            // (0, -1): y = p - 1, a point of order 2.
            let mut x = [0xffu8; 32];
            x[0] = 0xec;
            x[31] = 0x7f;
            x
        }
        Pt::NonCanonY => {
            // y = p (non-canonical encoding of 0).
            let mut x = [0xffu8; 32];
            x[0] = 0xed;
            x[31] = 0x7f;
            x
        }
    }
}
fn secret_bytes(s: Sec, e: usize) -> [u8; 32] {
    match s {
        Sec::A => sa(e).to_bytes(),
        Sec::B => sb(e).to_bytes(),
        Sec::Zero => [0u8; 32],
        Sec::Random => sc("random").to_bytes(),
        Sec::APlusL => {
            let a = sa(e).to_bytes();
            let mut out = [0u8; 32];
            let mut carry = 0u16;
            for i in 0..32 {
                let s = a[i] as u16 + program::ED25519_L[i] as u16 + carry;
                out[i] = s as u8;
                carry = s >> 8;
            }
            assert_eq!(carry, 0);
            out
        }
        Sec::L => program::ED25519_L,
        Sec::Max => [0xffu8; 32],
    }
}

fn build(op: &Op) -> (Instruction, Vec<Keypair>) {
    let pid = program::id();
    match *op {
        Op::Lock { e, cp, rp, amount, t0, t1 } => (
            Instruction {
                program_id: pid,
                accounts: program::accounts::Lock { refunder: bob(e).pubkey(), swap: swap_pda(e), system_program: system_program::id() }
                    .to_account_metas(None),
                data: program::instruction::Lock {
                    swap_id: swap_id(e),
                    claimer: alice(e),
                    claim_point: point_bytes(cp, e),
                    refund_point: point_bytes(rp, e),
                    amount,
                    t0: BASE + t0,
                    t1: BASE + t1,
                }
                .data(),
            },
            vec![bob(e)],
        ),
        Op::Ready { e, mallory: m } => {
            let signer = if m { mallory() } else { bob(e) };
            (
                Instruction {
                    program_id: pid,
                    accounts: program::accounts::SetReady { refunder: signer.pubkey(), swap: swap_pda(e) }.to_account_metas(None),
                    data: program::instruction::SetReady {}.data(),
                },
                vec![signer],
            )
        }
        Op::Claim { e, s, wrong_dest } => {
            let dest = if wrong_dest { mallory().pubkey() } else { alice(e) };
            (
                Instruction {
                    program_id: pid,
                    accounts: program::accounts::Claim { swap: swap_pda(e), claimer: dest, refunder: bob(e).pubkey() }
                        .to_account_metas(None),
                    data: program::instruction::Claim { secret: secret_bytes(s, e) }.data(),
                },
                vec![],
            )
        }
        Op::Refund { e, s, wrong_refunder } => {
            let r = if wrong_refunder { mallory().pubkey() } else { bob(e).pubkey() };
            (
                Instruction {
                    program_id: pid,
                    accounts: program::accounts::Refund { swap: swap_pda(e), refunder: r }.to_account_metas(None),
                    data: program::instruction::Refund { secret: secret_bytes(s, e) }.data(),
                },
                vec![],
            )
        }
        Op::Raw { e, ref data } => (
            Instruction {
                program_id: pid,
                accounts: vec![
                    AccountMeta::new(swap_pda(e), false),
                    AccountMeta::new(alice(e), false),
                    AccountMeta::new(bob(e).pubkey(), false),
                ],
                data: data.clone(),
            },
            vec![],
        ),
    }
}

// ---------- loader accounts ----------
fn sys_account(lamports: u64) -> AccountSharedData {
    AccountSharedData::from(Account { lamports, data: vec![], owner: system_program::id(), executable: false, rent_epoch: 0 })
}
fn programdata_bytes(elf: &[u8], len: usize, auth: &Pubkey) -> Vec<u8> {
    let mut d = Vec::with_capacity(len);
    d.extend_from_slice(&3u32.to_le_bytes()); // ProgramData
    d.extend_from_slice(&0u64.to_le_bytes()); // slot
    d.push(1);
    d.extend_from_slice(auth.as_ref());
    assert_eq!(d.len(), UpgradeableLoaderState::size_of_programdata_metadata());
    d.extend_from_slice(elf);
    d.resize(len, 0);
    d
}

fn program_test(start_elf: &[u8], pd_len: usize) -> ProgramTest {
    let rent = Rent::default();
    let mut pt = ProgramTest::default();
    let pd = programdata();
    let mut p = Vec::new();
    p.extend_from_slice(&2u32.to_le_bytes()); // Program
    p.extend_from_slice(pd.as_ref());
    assert_eq!(p.len(), UpgradeableLoaderState::size_of_program());
    pt.add_account(
        program::id(),
        Account { lamports: rent.minimum_balance(p.len()), data: p, owner: bpf_loader_upgradeable::id(), executable: true, rent_epoch: 0 },
    );
    let d = programdata_bytes(start_elf, pd_len, &authority().pubkey());
    pt.add_account(pd, Account { lamports: rent.minimum_balance(d.len()), data: d, owner: bpf_loader_upgradeable::id(), executable: false, rent_epoch: 0 });
    for e in 0..NE {
        pt.add_account(bob(e).pubkey(), sys_account(2_000_000_000).into());
    }
    pt.add_account(mallory().pubkey(), sys_account(1_000_000_000).into());
    pt.add_account(reserve(), sys_account(100_000_000_000).into());
    pt
}

async fn send_raw(ctx: &mut ProgramTestContext, ix: Instruction, signers: &[&Keypair], fresh_bh: bool) -> (String, u64, Vec<String>) {
    let bh = if fresh_bh { ctx.get_new_latest_blockhash().await.unwrap() } else { ctx.last_blockhash };
    let mut all: Vec<&Keypair> = vec![&ctx.payer];
    all.extend_from_slice(signers);
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&ctx.payer.pubkey()), &all, bh);
    let r = ctx.banks_client.process_transaction_with_metadata(tx).await.unwrap();
    let (cu, logs) = match r.metadata {
        Some(m) => (m.compute_units_consumed, m.log_messages),
        None => (0, vec![]),
    };
    (format!("{:?}", r.result), cu, logs)
}

/// Real upgrade instruction (same as mainnet), then the caller warps a slot.
async fn upgrade(ctx: &mut ProgramTestContext, elf: &[u8], pd_len: usize) {
    let rent = Rent::default();
    let auth = authority();
    let buffer = Pubkey::new_unique();
    let mut d = Vec::new();
    d.extend_from_slice(&1u32.to_le_bytes()); // Buffer
    d.push(1);
    d.extend_from_slice(auth.pubkey().as_ref());
    assert_eq!(d.len(), UpgradeableLoaderState::size_of_buffer_metadata());
    d.extend_from_slice(elf);
    let lamports = rent.minimum_balance(d.len());
    let res_bal = ctx.banks_client.get_balance(reserve()).await.unwrap();
    ctx.set_account(&reserve(), &sys_account(res_bal - lamports));
    ctx.set_account(
        &buffer,
        &AccountSharedData::from(Account { lamports, data: d, owner: bpf_loader_upgradeable::id(), executable: false, rent_epoch: 0 }),
    );
    let spill = Pubkey::new_unique();
    let ix = bpf_loader_upgradeable::upgrade(&program::id(), &buffer, &auth.pubkey(), &spill);
    let (res, _, logs) = send_raw(ctx, ix, &[&auth], true).await;
    assert_eq!(res, "Ok(())", "upgrade failed: {logs:?}");
    let pd = ctx.banks_client.get_account(programdata()).await.unwrap().unwrap();
    let meta = UpgradeableLoaderState::size_of_programdata_metadata();
    assert_eq!(pd.data.len(), pd_len);
    assert_eq!(&pd.data[meta..meta + elf.len()], elf, "programdata does not hold the new ELF");
    assert!(pd.data[meta + elf.len()..].iter().all(|b| *b == 0));
}

#[derive(Clone, Debug, PartialEq)]
struct Obs {
    result: String,
    logs: Vec<String>,
    state: Vec<String>,
}

fn filter_logs(logs: Vec<String>) -> Vec<String> {
    logs.into_iter().filter(|l| !(l.contains(" consumed ") && l.ends_with(" compute units"))).collect()
}

async fn snapshot(ctx: &mut ProgramTestContext) -> Vec<String> {
    let mut v = Vec::new();
    for e in 0..NE {
        let a = ctx.banks_client.get_account(swap_pda(e)).await.unwrap();
        v.push(match a {
            Some(a) => format!("swap{e}: lamports={} owner={} exec={} data={}", a.lamports, a.owner, a.executable, hex(&a.data)),
            None => format!("swap{e}: none"),
        });
        v.push(format!("bob{e}={}", ctx.banks_client.get_balance(bob(e).pubkey()).await.unwrap()));
        v.push(format!("alice{e}={}", ctx.banks_client.get_balance(alice(e)).await.unwrap()));
    }
    v.push(format!("mallory={}", ctx.banks_client.get_balance(mallory().pubkey()).await.unwrap()));
    v
}

/// Runs a script. `switches` = (step index, binary to upgrade to before that step).
/// Returns per step observations and compute units, plus the binary active at each step.
async fn run(bins: &Bins, script: &[Step], start: Bin, switches: &[(usize, Bin)]) -> (Vec<Obs>, Vec<u64>, Vec<Bin>) {
    let pd_len = UpgradeableLoaderState::size_of_programdata_metadata() + bins.old.len().max(bins.new.len());
    let pt = program_test(bins.get(start), pd_len);
    let mut ctx = pt.start_with_context().await;
    let mut slot = ctx.banks_client.get_sysvar::<Clock>().await.unwrap().slot;
    let mut active = start;
    let (mut obs, mut cus, mut act) = (vec![], vec![], vec![]);
    for (i, s) in script.iter().enumerate() {
        if let Some((_, b)) = switches.iter().find(|(k, _)| *k == i) {
            upgrade(&mut ctx, bins.get(*b), pd_len).await;
            active = *b;
        }
        slot += 1;
        ctx.warp_to_slot(slot).unwrap();
        let mut clock = ctx.banks_client.get_sysvar::<Clock>().await.unwrap();
        clock.unix_timestamp = BASE + s.at;
        ctx.set_sysvar(&clock);
        let (ix, signers) = build(&s.op);
        let refs: Vec<&Keypair> = signers.iter().collect();
        let (result, cu, logs) = send_raw(&mut ctx, ix, &refs, false).await;
        let state = snapshot(&mut ctx).await;
        obs.push(Obs { result, logs: filter_logs(logs), state });
        cus.push(cu);
        act.push(active);
    }
    (obs, cus, act)
}

fn scripts() -> Vec<(&'static str, Vec<Step>)> {
    use Pt::*;
    let mut v: Vec<(&'static str, Vec<Step>)> = vec![
        ("happy: lock, ready, claim", vec![lock(0, 0), ready(0, 1), claim(0, 2)]),
        ("ready then claim at t1-1 (last claim second)", vec![lock(0, 0), ready(0, 1), claim(0, T1 - 1)]),
        ("ready, claim at t1 refused, refund at t1", vec![lock(0, 0), ready(0, 1), claim(0, T1), refund(0, T1)]),
        ("ready, claim at t1+1 refused, refund at t1+1", vec![lock(0, 0), ready(0, 1), claim(0, T1 + 1), refund(0, T1 + 1)]),
        ("no ready: claim t0-1 refused, claim t0 ok", vec![lock(0, 0), claim(0, T0 - 1), claim(0, T0)]),
        ("no ready: claim at t0+1", vec![lock(0, 0), claim(0, T0 + 1)]),
        ("no ready: claim at t1-1", vec![lock(0, 0), claim(0, T1 - 1)]),
        ("no ready: refund at t0-1 (last early refund second)", vec![lock(0, 0), refund(0, T0 - 1)]),
        ("no ready: refund t0, t0+1, t1-1 refused, t1 ok", vec![lock(0, 0), refund(0, T0), refund(0, T0 + 1), refund(0, T1 - 1), refund(0, T1)]),
        ("no ready: refund at t1+1", vec![lock(0, 0), refund(0, T1 + 1)]),
        ("ready: refund t0-1 and t0 refused", vec![lock(0, 0), ready(0, 1), refund(0, T0 - 1), refund(0, T0)]),
        ("set_ready at t0-1 ok, second ready refused", vec![lock(0, 0), ready(0, T0 - 1), ready(0, T0 - 1), claim(0, T0 - 1)]),
        ("set_ready at t0 refused, at t0+1 refused", vec![lock(0, 0), ready(0, T0), ready(0, T0 + 1), claim(0, T0 + 1)]),
        ("set_ready by mallory refused", vec![lock(0, 0), st(1, Op::Ready { e: 0, mallory: true }), ready(0, 2)]),
        (
            "bad secrets on claim",
            vec![
                lock(0, 0),
                ready(0, 1),
                claim_s(0, 2, Sec::B),
                claim_s(0, 3, Sec::Zero),
                claim_s(0, 4, Sec::Random),
                claim_s(0, 5, Sec::APlusL),
                claim_s(0, 6, Sec::L),
                claim_s(0, 7, Sec::Max),
                claim(0, 8),
            ],
        ),
        (
            "bad secrets on refund",
            vec![
                lock(0, 0),
                refund_s(0, 1, Sec::A),
                refund_s(0, 2, Sec::Zero),
                refund_s(0, 3, Sec::Random),
                refund_s(0, 4, Sec::L),
                refund_s(0, 5, Sec::Max),
                refund(0, 6),
            ],
        ),
        (
            "wrong destination / wrong refunder accounts",
            vec![
                lock(0, 0),
                ready(0, 1),
                st(2, Op::Claim { e: 0, s: Sec::A, wrong_dest: true }),
                st(T1, Op::Refund { e: 0, s: Sec::B, wrong_refunder: true }),
                refund(0, T1),
            ],
        ),
        ("double claim then refund refused", vec![lock(0, 0), ready(0, 1), claim(0, 2), claim(0, 3), refund(0, T1)]),
        ("refund then claim refused", vec![lock(0, 0), refund(0, 1), claim(0, T0)]),
        ("double lock same PDA refused", vec![lock(0, 0), lock(0, 1), refund(0, 2)]),
        ("ops on never-locked escrow", vec![claim(1, 0), refund(1, 1), ready(1, 2)]),
        (
            "lock validation",
            vec![
                lockp(0, 0, OffCurve, B, AMOUNT, T0, T1),
                lockp(0, 1, A, Identity, AMOUNT, T0, T1),
                lockp(0, 2, A, A, AMOUNT, T0, T1),
                lockp(0, 3, LowOrder, B, AMOUNT, T0, T1),
                lockp(1, 4, NonCanonY, B, AMOUNT, T0, T1),
                lockp(2, 5, A, B, 0, T0, T1),
                lockp(2, 6, A, B, AMOUNT, 6, T1),
                lockp(2, 7, A, B, AMOUNT, T0, T0),
                lockp(2, 8, A, B, AMOUNT, 9, 10),
            ],
        ),
        (
            "raw / malformed instruction data",
            vec![
                lock(0, 0),
                st(1, Op::Raw { e: 0, data: vec![] }),
                st(2, Op::Raw { e: 0, data: vec![0xff; 8] }),
                st(3, Op::Raw { e: 0, data: vec![1, 2, 3] }),
                st(4, Op::Raw { e: 0, data: { let mut d = program::instruction::Claim { secret: [0; 32] }.data(); d.truncate(24); d } }),
                st(5, Op::Raw { e: 0, data: { let mut d = program::instruction::Claim { secret: sa(0).to_bytes() }.data(); d.push(7); d } }),
            ],
        ),
    ];
    // Multi-escrow: E0 created before the switch, E1 after, E2 refunded; long enough
    // for every single and double switch point.
    v.push((
        "multi-escrow lifecycle across switches",
        vec![
            lock(0, 0),
            lock(1, 1),
            ready(0, 2),
            lock(2, 3),
            claim(0, 4),
            refund(2, 5),
            claim(1, T0),
            claim(2, T0 + 1),
        ],
    ));
    v
}

fn modes(n: usize, double: bool) -> Vec<(Bin, Vec<(usize, Bin)>)> {
    let mut m = vec![(Bin::Old, vec![]), (Bin::New, vec![])];
    for k in 1..n {
        m.push((Bin::Old, vec![(k, Bin::New)]));
        m.push((Bin::New, vec![(k, Bin::Old)]));
    }
    if double {
        for k1 in 1..n {
            for k2 in (k1 + 1)..n {
                m.push((Bin::Old, vec![(k1, Bin::New), (k2, Bin::Old)]));
                m.push((Bin::New, vec![(k1, Bin::Old), (k2, Bin::New)]));
            }
        }
    }
    m
}

fn mode_name(start: Bin, sw: &[(usize, Bin)]) -> String {
    let mut s = format!("{start:?}");
    for (k, b) in sw {
        s += &format!(" >{b:?}@{k}");
    }
    s
}

#[tokio::test]
async fn upgrade_equivalence_differential() {
    let bins = load_bins();
    let diff = bins.old.iter().zip(&bins.new).filter(|(a, b)| a != b).count();
    println!("OLD {} bytes sha256 {}", bins.old.len(), OLD_SHA);
    println!("NEW {} bytes sha256 {}", bins.new.len(), NEW_SHA);
    println!("differing bytes = {diff}");
    let mut runs = 0usize;
    let mut steps = 0usize;
    let mut divergences: Vec<String> = vec![];
    let mut cu_diffs: Vec<String> = vec![];
    let mut cu_attrib_ok = 0usize;
    let mut cu_attrib_checked = 0usize;
    for (name, script) in scripts() {
        let double = name.starts_with("multi-escrow");
        let (base, base_cu, _) = run(&bins, &script, Bin::Old, &[]).await;
        let (_, new_cu, _) = run(&bins, &script, Bin::New, &[]).await;
        for (i, (o, n)) in base_cu.iter().zip(&new_cu).enumerate() {
            if o != n {
                cu_diffs.push(format!("[{name}] step {i} {:?}: old CU {o} new CU {n}", script[i].op));
            }
        }
        println!("\n== {name} ({} steps)", script.len());
        for (i, o) in base.iter().enumerate() {
            println!("  step {i} t={:+} {:?} -> {} (CU old {} new {})", script[i].at, script[i].op, o.result, base_cu[i], new_cu[i]);
        }
        for (start, sw) in modes(script.len(), double) {
            let (obs, cus, act) = run(&bins, &script, start, &sw).await;
            runs += 1;
            for i in 0..script.len() {
                steps += 1;
                if obs[i] != base[i] {
                    divergences.push(format!(
                        "[{name}] mode {} step {i} {:?}\n   OLD-only: {:?}\n   this run: {:?}",
                        mode_name(start, &sw),
                        script[i].op,
                        base[i],
                        obs[i]
                    ));
                }
                // CU attribution: if the binaries differ in CU at this step, the CU seen
                // here must be that of the binary that is supposed to be active.
                if base_cu[i] != new_cu[i] {
                    cu_attrib_checked += 1;
                    let want = if act[i] == Bin::Old { base_cu[i] } else { new_cu[i] };
                    if cus[i] == want {
                        cu_attrib_ok += 1;
                    } else {
                        println!("  CU attribution mismatch [{name}] {} step {i}: got {} want {}", mode_name(start, &sw), cus[i], want);
                    }
                }
            }
        }
    }
    println!("\nRUNS (mode runs excluding the OLD/NEW reference pair per script) = {runs}, compared steps = {steps}");
    println!("CU differences between OLD-only and NEW-only reference runs: {}", cu_diffs.len());
    for d in &cu_diffs {
        println!("  {d}");
    }
    println!("CU attribution checks passed {cu_attrib_ok}/{cu_attrib_checked}");
    println!("DIVERGENCES = {}", divergences.len());
    for d in &divergences {
        println!("{d}");
    }
    assert!(divergences.is_empty(), "behavioural divergence between OLD and NEW");
}

/// Proves the harness really swaps the executing code: after an upgrade to an
/// unrelated program (SPL Memo 3.0 bytes bundled with solana-program-test) the
/// same instruction behaves differently, and after upgrading to NEW it behaves
/// like the escrow again.
#[tokio::test]
async fn harness_canary_upgrade_changes_executing_code() {
    let bins = load_bins();
    let memo_id: Pubkey = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr".parse().unwrap();
    let memo = solana_program_test::programs::spl_programs(&Rent::default())
        .into_iter()
        .find(|(k, _)| *k == memo_id)
        .map(|(_, a)| solana_sdk::account::ReadableAccount::data(&a).to_vec())
        .expect("memo program bytes");
    let pd_len = UpgradeableLoaderState::size_of_programdata_metadata() + bins.old.len().max(bins.new.len()).max(memo.len());
    let mut ctx = program_test(&bins.old, pd_len).start_with_context().await;
    let mut slot = ctx.banks_client.get_sysvar::<Clock>().await.unwrap().slot;
    let memo_ix = || Instruction { program_id: program::id(), accounts: vec![], data: b"hello".to_vec() };
    slot += 1;
    ctx.warp_to_slot(slot).unwrap();
    let (r_old, _, _) = send_raw(&mut ctx, memo_ix(), &[], false).await;
    upgrade(&mut ctx, &memo, pd_len).await;
    slot += 1;
    ctx.warp_to_slot(slot).unwrap();
    let (r_memo, _, logs_memo) = send_raw(&mut ctx, memo_ix(), &[], false).await;
    upgrade(&mut ctx, &bins.new, pd_len).await;
    slot += 1;
    ctx.warp_to_slot(slot).unwrap();
    let (r_new, _, _) = send_raw(&mut ctx, memo_ix(), &[], false).await;
    println!("canary under OLD: {r_old}\ncanary under MEMO: {r_memo} {logs_memo:?}\ncanary under NEW: {r_new}");
    assert_ne!(r_old, "Ok(())");
    assert_eq!(r_memo, "Ok(())");
    assert_eq!(r_new, r_old);
}
