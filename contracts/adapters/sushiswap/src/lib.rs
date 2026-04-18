#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    token, Address, Env, IntoVal, log,
};

/// SushiSwap V3 adapter for Stellar/Soroban.
///
/// SushiSwap V3 launched on Stellar in February 2026 with concentrated
/// liquidity (Uniswap V3-style). This adapter wraps their swap router
/// for use by the AtomicSwap Router contract.

// ─── Storage ────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    /// The SushiSwap V3 router contract address
    SushiRouter,
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum SushiAdapterError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    SwapFailed = 4,
    InvalidAmount = 5,
}

// ─── Contract ───────────────────────────────────────────

#[contract]
pub struct SushiSwapAdapter;

#[contractimpl]
impl SushiSwapAdapter {
    /// Initialize with admin and the SushiSwap V3 router contract address.
    pub fn initialize(
        env: Env,
        admin: Address,
        sushi_router: Address,
    ) -> Result<(), SushiAdapterError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(SushiAdapterError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::SushiRouter, &sushi_router);
        Ok(())
    }

    /// Get a quote from SushiSwap V3 for a given swap.
    ///
    /// For concentrated liquidity, the output depends on the current tick
    /// and available liquidity at each tick range.
    pub fn quote(
        env: Env,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
    ) -> Result<i128, SushiAdapterError> {
        if amount_in <= 0 {
            return Err(SushiAdapterError::InvalidAmount);
        }

        let sushi_router: Address = env
            .storage()
            .instance()
            .get(&DataKey::SushiRouter)
            .ok_or(SushiAdapterError::NotInitialized)?;

        // Cross-contract call to SushiSwap's quote function.
        // V3-style routers typically have "quoteExactInputSingle" or similar.
        let estimated_out: i128 = env.invoke_contract(
            &sushi_router,
            &soroban_sdk::Symbol::new(&env, "quote_exact_in"),
            soroban_sdk::vec![
                &env,
                token_in.into_val(&env),
                token_out.into_val(&env),
                amount_in.into_val(&env),
            ],
        );

        Ok(estimated_out)
    }

    /// Execute a swap through SushiSwap V3.
    ///
    /// The caller (Router contract) transfers token_in to this adapter,
    /// which then executes through SushiSwap and returns the output.
    pub fn swap(
        env: Env,
        caller: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_amount_out: i128,
    ) -> Result<i128, SushiAdapterError> {
        caller.require_auth();

        if amount_in <= 0 || min_amount_out <= 0 {
            return Err(SushiAdapterError::InvalidAmount);
        }

        let sushi_router: Address = env
            .storage()
            .instance()
            .get(&DataKey::SushiRouter)
            .ok_or(SushiAdapterError::NotInitialized)?;

        // Transfer token_in from caller to this contract
        let token_in_client = token::Client::new(&env, &token_in);
        token_in_client.transfer(&caller, &env.current_contract_address(), &amount_in);

        // Approve SushiSwap router to spend our token_in
        token_in_client.approve(
            &env.current_contract_address(),
            &sushi_router,
            &amount_in,
            &(env.ledger().sequence() + 100),
        );

        // Record token_out balance before swap
        let token_out_client = token::Client::new(&env, &token_out);
        let balance_before = token_out_client.balance(&env.current_contract_address());

        // Execute swap via SushiSwap V3
        // V3 routers typically have "exactInputSingle" or "swap_exact_in"
        let _: () = env.invoke_contract(
            &sushi_router,
            &soroban_sdk::Symbol::new(&env, "swap_exact_in"),
            soroban_sdk::vec![
                &env,
                env.current_contract_address().into_val(&env),
                token_in.clone().into_val(&env),
                token_out.clone().into_val(&env),
                amount_in.into_val(&env),
                min_amount_out.into_val(&env),
            ],
        );

        // Calculate actual output
        let balance_after = token_out_client.balance(&env.current_contract_address());
        let actual_out = balance_after - balance_before;

        // Transfer output back to caller
        token_out_client.transfer(
            &env.current_contract_address(),
            &caller,
            &actual_out,
        );

        log!(
            &env,
            "SushiSwap swap: in={}, out={}, pair={}/{}",
            amount_in,
            actual_out,
            token_in,
            token_out
        );

        Ok(actual_out)
    }

    /// Update the SushiSwap router address. Admin only.
    pub fn set_sushi_router(
        env: Env,
        admin: Address,
        new_router: Address,
    ) -> Result<(), SushiAdapterError> {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(SushiAdapterError::NotInitialized)?;
        if admin != stored_admin {
            return Err(SushiAdapterError::Unauthorized);
        }
        env.storage()
            .instance()
            .set(&DataKey::SushiRouter, &new_router);
        Ok(())
    }
}
