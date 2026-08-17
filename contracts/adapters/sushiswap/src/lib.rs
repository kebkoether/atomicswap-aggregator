#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    symbol_short, token, Address, Env, IntoVal, Symbol,
};

/// SushiSwap V3 adapter for Stellar/Soroban.
///
/// SushiSwap V3 launched on Stellar in February 2026 (concentrated
/// liquidity). ⚠️ The function names used here (`quote_exact_in`,
/// `swap_exact_in`) are PLACEHOLDERS — SushiSwap's actual Soroban router
/// ABI and contract addresses must be verified before this adapter is
/// registered as a live venue. Do not register it until then.
///
/// Funds flow (AtomicSwap Router contract → this adapter):
///   The router PUSHES token_in to this adapter before invoking `swap`.

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
    /// Deploy-time constructor.
    pub fn __constructor(env: Env, admin: Address, sushi_router: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::SushiRouter, &sushi_router);
    }

    /// Get a quote from SushiSwap V3 for a given swap.
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

        // ⚠️ Placeholder function name — verify against SushiSwap's ABI.
        let estimated_out: i128 = env.invoke_contract(
            &sushi_router,
            &Symbol::new(&env, "quote_exact_in"),
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
    /// Expects `amount_in` of token_in to have been pushed to this contract
    /// by the caller beforehand. Sends output to `recipient`.
    pub fn swap(
        env: Env,
        recipient: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_amount_out: i128,
    ) -> Result<i128, SushiAdapterError> {
        if amount_in <= 0 || min_amount_out < 0 {
            return Err(SushiAdapterError::InvalidAmount);
        }

        let sushi_router: Address = env
            .storage()
            .instance()
            .get(&DataKey::SushiRouter)
            .ok_or(SushiAdapterError::NotInitialized)?;

        // Allow the Sushi router to pull our token_in
        let token_in_client = token::Client::new(&env, &token_in);
        token_in_client.approve(
            &env.current_contract_address(),
            &sushi_router,
            &amount_in,
            &(env.ledger().sequence() + 100),
        );

        let token_out_client = token::Client::new(&env, &token_out);
        let balance_before = token_out_client.balance(&env.current_contract_address());

        // ⚠️ Placeholder function name — verify against SushiSwap's ABI.
        let _: () = env.invoke_contract(
            &sushi_router,
            &Symbol::new(&env, "swap_exact_in"),
            soroban_sdk::vec![
                &env,
                env.current_contract_address().into_val(&env),
                token_in.clone().into_val(&env),
                token_out.clone().into_val(&env),
                amount_in.into_val(&env),
                min_amount_out.into_val(&env),
            ],
        );

        let balance_after = token_out_client.balance(&env.current_contract_address());
        let actual_out = balance_after - balance_before;

        if actual_out < min_amount_out {
            return Err(SushiAdapterError::SwapFailed);
        }

        token_out_client.transfer(&env.current_contract_address(), &recipient, &actual_out);

        env.events().publish(
            (symbol_short!("sushi"), symbol_short!("swap")),
            (token_in, token_out, amount_in, actual_out),
        );
        Ok(actual_out)
    }

    /// Update the SushiSwap router address. Admin only.
    pub fn set_sushi_router(env: Env, new_router: Address) -> Result<(), SushiAdapterError> {
        Self::require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::SushiRouter, &new_router);
        Ok(())
    }

    // ─── Internal ───────────────────────────────────────

    fn require_admin(env: &Env) -> Result<(), SushiAdapterError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(SushiAdapterError::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }
}
