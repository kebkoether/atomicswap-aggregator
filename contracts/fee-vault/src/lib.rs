#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    token, Address, Env, log,
};

// ─── Storage Keys ───────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    /// Balance of a specific token held in the vault
    Balance(Address),
    /// Addresses authorized to deposit (SwapBook, Router contracts)
    Depositor(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum FeeVaultError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    InsufficientBalance = 4,
    InvalidAmount = 5,
}

// ─── Contract ───────────────────────────────────────────

#[contract]
pub struct FeeVault;

#[contractimpl]
impl FeeVault {
    /// Initialize the vault with an admin address.
    pub fn initialize(env: Env, admin: Address) -> Result<(), FeeVaultError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(FeeVaultError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }

    /// Authorize an address to deposit fees (e.g., SwapBook or Router).
    /// Admin only.
    pub fn authorize_depositor(
        env: Env,
        admin: Address,
        depositor: Address,
    ) -> Result<(), FeeVaultError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        env.storage()
            .persistent()
            .set(&DataKey::Depositor(depositor), &true);
        Ok(())
    }

    /// Record a fee deposit. The actual token transfer happens in the calling
    /// contract (SwapBook/Router transfers directly to this vault address).
    /// This function just updates the internal accounting.
    pub fn record_deposit(
        env: Env,
        token: Address,
        amount: i128,
    ) -> Result<(), FeeVaultError> {
        if amount <= 0 {
            return Err(FeeVaultError::InvalidAmount);
        }

        let balance_key = DataKey::Balance(token.clone());
        let current: i128 = env
            .storage()
            .persistent()
            .get(&balance_key)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&balance_key, &(current + amount));

        log!(&env, "Fee deposited: token={}, amount={}", token, amount);

        Ok(())
    }

    /// Withdraw accumulated fees. Admin only.
    pub fn withdraw(
        env: Env,
        admin: Address,
        token: Address,
        amount: i128,
        to: Address,
    ) -> Result<(), FeeVaultError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        if amount <= 0 {
            return Err(FeeVaultError::InvalidAmount);
        }

        let balance_key = DataKey::Balance(token.clone());
        let current: i128 = env
            .storage()
            .persistent()
            .get(&balance_key)
            .unwrap_or(0);

        if amount > current {
            return Err(FeeVaultError::InsufficientBalance);
        }

        // Transfer tokens out
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&env.current_contract_address(), &to, &amount);

        // Update accounting
        env.storage()
            .persistent()
            .set(&balance_key, &(current - amount));

        log!(&env, "Fee withdrawn: token={}, amount={}, to={}", token, amount, to);

        Ok(())
    }

    /// Query the fee balance for a given token.
    pub fn get_balance(env: Env, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(token))
            .unwrap_or(0)
    }

    /// Get the admin address.
    pub fn get_admin(env: Env) -> Result<Address, FeeVaultError> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(FeeVaultError::NotInitialized)
    }

    // ─── Internal ───────────────────────────────────────

    fn require_admin(env: &Env, caller: &Address) -> Result<(), FeeVaultError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(FeeVaultError::NotInitialized)?;
        if *caller != admin {
            return Err(FeeVaultError::Unauthorized);
        }
        Ok(())
    }
}
