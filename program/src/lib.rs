//! XMR<->SOL atomic swap escrow (beta program, NOT AUDITED).
//!
//! Roles (see docs/research/xmr-sol-atomic-swap/DESIGN.md):
//! * `refunder` ("Bob") holds SOL and wants XMR. He locks SOL here first.
//! * `claimer` ("Alice") holds XMR and wants SOL. She locks XMR to the Monero
//!   address whose spend key is A + B, after this escrow exists.
//!
//! A = a*G is Alice's Monero spend-key share, B = b*G is Bob's. Both are plain
//! ed25519 points, the same curve Monero uses, so no cross-curve proof is needed:
//! revealing `a` here (claim) hands Bob the missing half of the Monero key, and
//! revealing `b` (refund) hands it to Alice.
//!
//! Successful claim and refund have mutually exclusive windows. This does not prevent scalar exposure through simulation
//! or rejected transactions; clients must enforce a safe reveal timing before broadcasting secret-carrying bytes.
//!   now < t0, !ready : refund only          (Bob aborts, Alice recovers XMR)
//!   now < t0,  ready : claim only           (normal path)
//!   t0 <= now < t1   : claim only           (Bob vanished; Alice claims)
//!   t1 <= now        : refund only          (Alice vanished; Bob refunds)
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use solana_curve25519::edwards::{multiply_edwards, validate_edwards, PodEdwardsPoint};
use solana_curve25519::scalar::PodScalar;

declare_id!("7nu5ZGNAu8LbRFR5iSyAtNxRGyGqjtQ8Z9qzFqemZKuS");

/// Compressed ed25519 base point G.
pub const ED25519_BASEPOINT: [u8; 32] = [
    0x58, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
    0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
    0x66, 0x66,
];
/// Compressed identity point.
pub const ED25519_IDENTITY: [u8; 32] = {
    let mut b = [0u8; 32];
    b[0] = 1;
    b
};
/// Group order l = 2^252 + 27742317777372353535851937790883648493, little-endian.
pub const ED25519_L: [u8; 32] = [
    0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde,
    0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x10,
];

pub const SWAP_SEED: &[u8] = b"swap";

#[program]
pub mod xmr_sol_swap {
    use super::*;

    /// Bob locks `amount` lamports for `claimer`, redeemable by revealing the
    /// discrete log of `claim_point` (Alice's share A).
    #[allow(clippy::too_many_arguments)]
    pub fn lock(
        ctx: Context<Lock>,
        swap_id: [u8; 32],
        claimer: Pubkey,
        claim_point: [u8; 32],
        refund_point: [u8; 32],
        amount: u64,
        t0: i64,
        t1: i64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(amount > 0, SwapError::ZeroAmount);
        require!(t0 > now, SwapError::BadTimelocks);
        require!(t1 > t0, SwapError::BadTimelocks);
        require!(claim_point != refund_point, SwapError::BadPoint);
        for p in [&claim_point, &refund_point] {
            require!(*p != ED25519_IDENTITY, SwapError::BadPoint);
            require!(validate_edwards(&PodEdwardsPoint(*p)), SwapError::BadPoint);
        }

        let swap = &mut ctx.accounts.swap;
        swap.refunder = ctx.accounts.refunder.key();
        swap.claimer = claimer;
        swap.claim_point = claim_point;
        swap.refund_point = refund_point;
        swap.amount = amount;
        swap.t0 = t0;
        swap.t1 = t1;
        swap.ready = false;
        swap.swap_id = swap_id;
        swap.bump = ctx.bumps.swap;

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.refunder.to_account_info(),
                    to: ctx.accounts.swap.to_account_info(),
                },
            ),
            amount,
        )?;
        emit!(Locked { swap_id, claimer, amount, t0, t1 });
        Ok(())
    }

    /// Bob confirms he saw Alice's XMR lock with enough confirmations. From now on
    /// Bob can no longer refund before t1, and Alice may claim immediately.
    pub fn set_ready(ctx: Context<SetReady>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let swap = &mut ctx.accounts.swap;
        require!(!swap.ready, SwapError::AlreadyReady);
        require!(now < swap.t0, SwapError::WrongWindow);
        swap.ready = true;
        emit!(Ready { swap_id: swap.swap_id });
        Ok(())
    }

    /// Anyone may submit; funds always go to the recorded claimer. Revealing `secret`
    /// (a with a*G == A) is what lets Bob spend the Monero lock.
    pub fn claim(ctx: Context<Claim>, secret: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let swap = &ctx.accounts.swap;
        require!(claim_open(swap.ready, now, swap.t0, swap.t1), SwapError::WrongWindow);
        require!(opens(&secret, &swap.claim_point), SwapError::BadSecret);

        let amount = swap.amount;
        let swap_id = swap.swap_id;
        let swap_info = ctx.accounts.swap.to_account_info();
        **swap_info.try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.claimer.try_borrow_mut_lamports()? += amount;
        // Remaining rent goes back to Bob through `close = refunder`.
        emit!(Claimed { swap_id, secret });
        Ok(())
    }

    /// Returns the SOL to Bob. Revealing `secret` (b with b*G == B) is what lets
    /// Alice recover her Monero lock.
    pub fn refund(ctx: Context<Refund>, secret: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let swap = &ctx.accounts.swap;
        require!(refund_open(swap.ready, now, swap.t0, swap.t1), SwapError::WrongWindow);
        require!(opens(&secret, &swap.refund_point), SwapError::BadSecret);
        // Whole balance (amount + rent) returns to Bob through `close = refunder`.
        emit!(Refunded { swap_id: swap.swap_id, secret });
        Ok(())
    }
}

/// Claim window: before t1, and either Bob said ready or t0 has passed.
pub fn claim_open(ready: bool, now: i64, t0: i64, t1: i64) -> bool {
    now < t1 && (ready || now >= t0)
}

/// Refund window: before t0 while not ready, or from t1 on. Disjoint from `claim_open`.
pub fn refund_open(ready: bool, now: i64, t0: i64, t1: i64) -> bool {
    (!ready && now < t0) || now >= t1
}

/// True if `s` is a canonical scalar (s < l), non-zero, and s*G == point.
pub fn opens(s: &[u8; 32], point: &[u8; 32]) -> bool {
    if !is_canonical_scalar(s) || s.iter().all(|b| *b == 0) {
        return false;
    }
    match multiply_edwards(&PodScalar(*s), &PodEdwardsPoint(ED25519_BASEPOINT)) {
        Some(p) => p.0 == *point,
        None => false,
    }
}

pub fn is_canonical_scalar(s: &[u8; 32]) -> bool {
    for i in (0..32).rev() {
        if s[i] < ED25519_L[i] {
            return true;
        }
        if s[i] > ED25519_L[i] {
            return false;
        }
    }
    false // equal to l
}

#[derive(Accounts)]
#[instruction(swap_id: [u8; 32])]
pub struct Lock<'info> {
    #[account(mut)]
    pub refunder: Signer<'info>,
    #[account(
        init,
        payer = refunder,
        space = 8 + Swap::LEN,
        seeds = [SWAP_SEED, refunder.key().as_ref(), swap_id.as_ref()],
        bump
    )]
    pub swap: Account<'info, Swap>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetReady<'info> {
    pub refunder: Signer<'info>,
    #[account(
        mut,
        has_one = refunder,
        seeds = [SWAP_SEED, refunder.key().as_ref(), swap.swap_id.as_ref()],
        bump = swap.bump
    )]
    pub swap: Account<'info, Swap>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(
        mut,
        has_one = claimer,
        has_one = refunder,
        close = refunder,
        seeds = [SWAP_SEED, refunder.key().as_ref(), swap.swap_id.as_ref()],
        bump = swap.bump
    )]
    pub swap: Account<'info, Swap>,
    /// CHECK: destination only; must equal swap.claimer (has_one).
    #[account(mut)]
    pub claimer: UncheckedAccount<'info>,
    /// CHECK: rent destination only; must equal swap.refunder (has_one).
    #[account(mut)]
    pub refunder: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(
        mut,
        has_one = refunder,
        close = refunder,
        seeds = [SWAP_SEED, refunder.key().as_ref(), swap.swap_id.as_ref()],
        bump = swap.bump
    )]
    pub swap: Account<'info, Swap>,
    /// CHECK: destination only; must equal swap.refunder (has_one). Not a signer:
    /// the secret is the authorization and funds can only go back to Bob.
    #[account(mut)]
    pub refunder: UncheckedAccount<'info>,
}

#[account]
pub struct Swap {
    pub refunder: Pubkey,
    pub claimer: Pubkey,
    pub claim_point: [u8; 32],
    pub refund_point: [u8; 32],
    pub amount: u64,
    pub t0: i64,
    pub t1: i64,
    pub ready: bool,
    pub swap_id: [u8; 32],
    pub bump: u8,
}

impl Swap {
    pub const LEN: usize = 32 + 32 + 32 + 32 + 8 + 8 + 8 + 1 + 32 + 1;
}

#[event]
pub struct Locked {
    pub swap_id: [u8; 32],
    pub claimer: Pubkey,
    pub amount: u64,
    pub t0: i64,
    pub t1: i64,
}
#[event]
pub struct Ready {
    pub swap_id: [u8; 32],
}
#[event]
pub struct Claimed {
    pub swap_id: [u8; 32],
    pub secret: [u8; 32],
}
#[event]
pub struct Refunded {
    pub swap_id: [u8; 32],
    pub secret: [u8; 32],
}

#[error_code]
pub enum SwapError {
    #[msg("amount must be positive")]
    ZeroAmount,
    #[msg("timelocks must satisfy now < t0 < t1")]
    BadTimelocks,
    #[msg("point is invalid, identity, or claim == refund")]
    BadPoint,
    #[msg("swap is already ready")]
    AlreadyReady,
    #[msg("action not allowed in the current time window")]
    WrongWindow,
    #[msg("secret does not open the committed point")]
    BadSecret,
}
