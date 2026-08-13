#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Env,
};

fn setup() -> (Env, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let vault_id = env.register(FeeVault, (admin.clone(),));

    let token = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();

    (env, vault_id, admin, token)
}

#[test]
fn test_balance_is_real_token_balance() {
    let (env, vault_id, _admin, token) = setup();
    let client = FeeVaultClient::new(&env, &vault_id);

    assert_eq!(client.get_balance(&token), 0);

    // Fees arrive as direct transfers (how SwapBook/Router pay them)
    StellarAssetClient::new(&env, &token).mint(&vault_id, &123_456);
    assert_eq!(client.get_balance(&token), 123_456);
}

#[test]
fn test_withdraw_up_to_balance() {
    let (env, vault_id, _admin, token) = setup();
    let client = FeeVaultClient::new(&env, &vault_id);
    let to = Address::generate(&env);

    StellarAssetClient::new(&env, &token).mint(&vault_id, &1_000_000);

    // Over-withdrawal rejected
    assert!(client.try_withdraw(&token, &1_000_001, &to).is_err());
    // Zero / negative rejected
    assert!(client.try_withdraw(&token, &0, &to).is_err());
    assert!(client.try_withdraw(&token, &-5, &to).is_err());

    client.withdraw(&token, &400_000, &to);
    assert_eq!(TokenClient::new(&env, &token).balance(&to), 400_000);
    assert_eq!(client.get_balance(&token), 600_000);

    // Full drain works — no shadow accounting to strand funds
    client.withdraw(&token, &600_000, &to);
    assert_eq!(client.get_balance(&token), 0);
}

#[test]
fn test_admin_management() {
    let (env, vault_id, admin, _token) = setup();
    let client = FeeVaultClient::new(&env, &vault_id);

    assert_eq!(client.get_admin(), admin);
    let new_admin = Address::generate(&env);
    client.set_admin(&new_admin);
    assert_eq!(client.get_admin(), new_admin);
}
