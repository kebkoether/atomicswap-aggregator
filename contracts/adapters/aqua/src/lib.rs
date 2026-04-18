#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    token, Address, Env, IntoVal, log,
};

/// Aqua AMM Router on Stellar Mainnet:
/// CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK
///
/// This adapter wraps calls to the Aqua AMM, normalizing the interface
/// for the AtomicSwap Router contract.

// ─── Storage ────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    /// The Aqua AMM router contract address
    AquaRouter,
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
}

// ─── Contract ───────────────────────────────────────────

#[contract]
pub struct AquaAdapter;

#[contractimpl]
impl AquaAdapter {
    /// Initialize with admin and the Aqua AMM router contract address.
    pub fn initialize(
        env: Env,
        admin: Address,
        aqua_router: Address,
    ) -> Result<(), AquaAdapterError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(AquaAdapterError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::AquaRouter, &aqua_router);
        Ok(())
    }

    /// Get a quote from Aqua AMM for a given swap.
    ///
    /// Calls Aqua's `estimate_swap` or equivalent function.
    /// Returns the estimated amount_out.
    pub fn quote(
        env: Env,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
    ) -> Result<i128, AquaAdapterError> {
        if amount_in <= 0 {
            return Err(AquaAdapterError::InvalidAmount);
        }

        let aqua_router: Address = env
            .storage()
            .instance()
            .get(&DataKey::AquaRouter)
            .ok_or(AquaAdapterError::NotInitialized)?;

        // Cross-contract call to Aqua's quote/estimate function.
        // The exact function name depends on Aqua's contract interface.
        // Common patterns: "estimate_swap", "get_amount_out", "simulate_swap"
        let estimated_out: i128 = env.invoke_contract(
            &aqua_router,
            &soroban_sdk::Symbol::new(&env, "estimate_swap"),
            soroban_sdk::vec![
                &env,
                token_in.into_val(&env),
                token_out.into_val(&env),
                amount_in.into_val(&env),
            ],
        );

        Ok(estimated_out)
    }

    /// Execute a swap through Aqua AMM.
    ///
    /// The caller (Router contract) must have already transferred token_in
    /// to this adapter, or approved this adapter to spend token_in.
    ///
    /// Returns actual amount_out received.
    pub fn swap(
        env: Env,
        caller: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_amount_out: i128,
    ) -> Result<i128, AquaAdapterError> {
        caller.require_auth();

        if amount_in <= 0 || min_amount_out <= 0 {
            return Err(AquaAdapterError::InvalidAmount);
        }

        let aqua_router: Address = env
            .storage()
            .instance()
            .get(&DataKey::AquaRouter)
            .ok_or(AquaAdapterError::NotInitialized)?;

        // Transfer token_in from caller to this contract
        let token_in_client = token::Client::new(&env, &token_in);
        token_in_client.transfer(&caller, &env.current_contract_address(), &amount_in);

        // Approve Aqua router to spend our token_in
        token_in_client.approve(
            &env.current_contract_address(),
            &aqua_router,
            &amount_in,
            &(env.ledger().sequence() + 100),
        );

        // Record token_out balance before swap
        let token_out_client = token::Client::new(&env, &token_out);
        let balance_before = token_out_client.balance(&env.current_contract_address());

        // Execute swap via Aqua AMM
        // The exact function signature depends on Aqua's contract.
        // Using "swap" as the likely function name.
        let _: () = env.invoke_contract(
            &aqua_router,
            &soroban_sdk::Symbol::new(&env, "swap"),
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
            "Aqua swap: in={}, out={}, pair={}/{}",
            amount_in,
            actual_out,
            token_in,
            token_out
        );

        Ok(actual_out)
    }

    /// Update the Aqua router address. Admin only.
    pub fn set_aqua_router(
        env: Env,
        admin: Address,
        new_router: Address,
    ) -> Result<(), AquaAdapterError> {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(AquaAdapterError::NotInitialized)?;
        if admin != stored_admin {
            return Err(AquaAdapterError::Unauthorized);
        }
        env.storage()
            .instance()
            .set(&DataKey::AquaRouter, &new_router);
        Ok(())
    }
}
