#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    symbol_short, token, Address, BytesN, Env, IntoVal, Symbol, Vec,
};

/// Aquarius AMM adapter.
///
/// Real Aquarius interface (docs.aqua.network, AquaToken/soroban-amm):
///   Router (mainnet): CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK
///   swap_chained(user, swaps_chain: Vec<(Vec<Address>, BytesN<32>, Address)>,
///                token_in, amount: u128, amount_with_slippage: u128) -> u128
///   Per-pool quoting: estimate_swap(in_idx: u32, out_idx: u32, amount: u128) -> u128
///
/// This adapter executes SINGLE-HOP swaps through an admin-registered pool
/// per pair. Multi-hop routing goes through the backend's find-path API and
/// is out of scope for the on-chain adapter (stable pairs are single-hop).
///
/// Funds flow (AtomicSwap Router contract → this adapter):
///   The router PUSHES token_in to this adapter before invoking `swap`.
///   This adapter then approves the Aqua router and calls swap_chained.
///   NOTE: verify on testnet whether Aqua pulls via allowance
///   (transfer_from) or requires explicit sub-invocation auth
///   (authorize_as_current_contract) — adjust if the latter.

// ─── Storage ────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    /// The Aqua AMM router contract address
    AquaRouter,
    /// Registered pool for a directed pair (token_in, token_out)
    Pool(Address, Address),
}

/// An Aquarius pool used for a pair.
#[contracttype]
#[derive(Clone, Debug)]
pub struct PoolInfo {
    /// The pool's token list (order defines estimate_swap indexes)
    pub tokens: Vec<Address>,
    /// Pool hash as used in swap_chained's swaps_chain
    pub pool_hash: BytesN<32>,
    /// Pool contract address (for estimate_swap quoting)
    pub pool_address: Address,
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum AquaAdapterError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    SwapFailed = 4,
    InvalidAmount = 5,
    PoolNotSet = 6,
    TokenNotInPool = 7,
    Overflow = 8,
}

// ─── Contract ───────────────────────────────────────────

#[contract]
pub struct AquaAdapter;

#[contractimpl]
impl AquaAdapter {
    /// Deploy-time constructor.
    pub fn __constructor(env: Env, admin: Address, aqua_router: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::AquaRouter, &aqua_router);
    }

    /// Register the pool to use for a pair (both directions). Admin only.
    pub fn set_pool(
        env: Env,
        token_a: Address,
        token_b: Address,
        tokens: Vec<Address>,
        pool_hash: BytesN<32>,
        pool_address: Address,
    ) -> Result<(), AquaAdapterError> {
        Self::require_admin(&env)?;
        let info = PoolInfo {
            tokens,
            pool_hash,
            pool_address,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Pool(token_a.clone(), token_b.clone()), &info);
        env.storage()
            .persistent()
            .set(&DataKey::Pool(token_b, token_a), &info);
        Ok(())
    }

    /// Quote a swap via the registered pool's estimate_swap.
    pub fn quote(
        env: Env,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
    ) -> Result<i128, AquaAdapterError> {
        if amount_in <= 0 {
            return Err(AquaAdapterError::InvalidAmount);
        }
        let pool = Self::get_pool(&env, &token_in, &token_out)?;
        let (in_idx, out_idx) = Self::token_indexes(&pool, &token_in, &token_out)?;

        let estimated: u128 = env.invoke_contract(
            &pool.pool_address,
            &Symbol::new(&env, "estimate_swap"),
            soroban_sdk::vec![
                &env,
                in_idx.into_val(&env),
                out_idx.into_val(&env),
                (amount_in as u128).into_val(&env),
            ],
        );

        i128::try_from(estimated).map_err(|_| AquaAdapterError::Overflow)
    }

    /// Execute a single-hop swap through Aquarius.
    ///
    /// Expects `amount_in` of token_in to have been pushed to this contract
    /// by the caller beforehand. Sends the output to `recipient` and returns
    /// the actual amount out.
    pub fn swap(
        env: Env,
        recipient: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_amount_out: i128,
    ) -> Result<i128, AquaAdapterError> {
        if amount_in <= 0 || min_amount_out < 0 {
            return Err(AquaAdapterError::InvalidAmount);
        }

        let aqua_router: Address = env
            .storage()
            .instance()
            .get(&DataKey::AquaRouter)
            .ok_or(AquaAdapterError::NotInitialized)?;
        let pool = Self::get_pool(&env, &token_in, &token_out)?;

        // Allow the Aqua router to pull our token_in
        let token_in_client = token::Client::new(&env, &token_in);
        token_in_client.approve(
            &env.current_contract_address(),
            &aqua_router,
            &amount_in,
            &(env.ledger().sequence() + 100),
        );

        let token_out_client = token::Client::new(&env, &token_out);
        let balance_before = token_out_client.balance(&env.current_contract_address());

        // swaps_chain: single hop through the registered pool
        let chain_element = (pool.tokens.clone(), pool.pool_hash.clone(), token_out.clone());
        let swaps_chain = soroban_sdk::vec![&env, chain_element];

        let _out: u128 = env.invoke_contract(
            &aqua_router,
            &Symbol::new(&env, "swap_chained"),
            soroban_sdk::vec![
                &env,
                env.current_contract_address().into_val(&env),
                swaps_chain.into_val(&env),
                token_in.clone().into_val(&env),
                (amount_in as u128).into_val(&env),
                (min_amount_out as u128).into_val(&env),
            ],
        );

        // Measure by balance delta — robust to venue-side rounding
        let balance_after = token_out_client.balance(&env.current_contract_address());
        let actual_out = balance_after - balance_before;

        if actual_out < min_amount_out {
            return Err(AquaAdapterError::SwapFailed);
        }

        token_out_client.transfer(&env.current_contract_address(), &recipient, &actual_out);

        env.events().publish(
            (symbol_short!("aqua"), symbol_short!("swap")),
            (token_in, token_out, amount_in, actual_out),
        );
        Ok(actual_out)
    }

    /// Update the Aqua router address. Admin only.
    pub fn set_aqua_router(env: Env, new_router: Address) -> Result<(), AquaAdapterError> {
        Self::require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::AquaRouter, &new_router);
        Ok(())
    }

    // ─── Internal ───────────────────────────────────────

    fn require_admin(env: &Env) -> Result<(), AquaAdapterError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(AquaAdapterError::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    fn get_pool(
        env: &Env,
        token_in: &Address,
        token_out: &Address,
    ) -> Result<PoolInfo, AquaAdapterError> {
        env.storage()
            .persistent()
            .get(&DataKey::Pool(token_in.clone(), token_out.clone()))
            .ok_or(AquaAdapterError::PoolNotSet)
    }

    fn token_indexes(
        pool: &PoolInfo,
        token_in: &Address,
        token_out: &Address,
    ) -> Result<(u32, u32), AquaAdapterError> {
        let mut in_idx: Option<u32> = None;
        let mut out_idx: Option<u32> = None;
        for i in 0..pool.tokens.len() {
            let t = pool.tokens.get(i).unwrap();
            if &t == token_in {
                in_idx = Some(i);
            } else if &t == token_out {
                out_idx = Some(i);
            }
        }
        match (in_idx, out_idx) {
            (Some(a), Some(b)) => Ok((a, b)),
            _ => Err(AquaAdapterError::TokenNotInPool),
        }
    }
}
