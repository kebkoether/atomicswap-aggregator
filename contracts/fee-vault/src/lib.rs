#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    symbol_short, token, Address, Env,
};

// ─── Storage Keys ───────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
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
//
// Fee tokens are transferred directly to this contract's address by the
// SwapBook and Router contracts. The vault's balance IS the token balance —
// there is deliberately no shadow accounting to drift out of sync.

#[contract]
pub struct FeeVault;

#[contractimpl]
impl FeeVault {
    /// Deploy-time constructor — atomic with deployment, cannot be front-run.
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Withdraw accumulated fees. Admin only.
    pub fn withdraw(
        env: Env,
        token: Address,
        amount: i128,
        to: Address,
    ) -> Result<(), FeeVaultError> {
        Self::require_admin(&env)?;

        if amount <= 0 {
            return Err(FeeVaultError::InvalidAmount);
        }

        let token_client = token::Client::new(&env, &token);
        let balance = token_client.balance(&env.current_contract_address());
        if amount > balance {
            return Err(FeeVaultError::InsufficientBalance);
        }

        token_client.transfer(&env.current_contract_address(), &to, &amount);

        env.events().publish(
            (symbol_short!("fees"), symbol_short!("withdraw")),
            (token, amount, to),
        );
        Ok(())
    }

    /// Query the fee balance for a given token — the actual token balance
    /// held by this contract.
    pub fn get_balance(env: Env, token: Address) -> i128 {
        let token_client = token::Client::new(&env, &token);
        token_client.balance(&env.current_contract_address())
    }

    /// Get the admin address.
    pub fn get_admin(env: Env) -> Result<Address, FeeVaultError> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(FeeVaultError::NotInitialized)
    }

    /// Transfer admin to a new address. Admin only.
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), FeeVaultError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.events().publish(
            (symbol_short!("admin"), symbol_short!("set")),
            new_admin,
        );
        Ok(())
    }

    // ─── Internal ───────────────────────────────────────

    fn require_admin(env: &Env) -> Result<(), FeeVaultError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(FeeVaultError::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }
}

#[cfg(test)]
mod test;
