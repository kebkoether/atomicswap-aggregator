#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    token::{StellarAssetClient, TokenClient},
    Env,
};

fn setup_test() -> (Env, Address, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    // Set ledger sequence
    env.ledger().set(LedgerInfo {
        timestamp: 1000,
        protocol_version: 20,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 10,
        min_persistent_entry_ttl: 10,
        max_entry_ttl: 3110400,
    });

    let admin = Address::generate(&env);
    let maker = Address::generate(&env);
    let taker = Address::generate(&env);

    // Deploy token contracts (simulating USDC and PYUSD)
    let token_a_admin = Address::generate(&env);
    let token_a = env.register_stellar_asset_contract_v2(token_a_admin.clone());
    let token_a_client = StellarAssetClient::new(&env, &token_a.address());
    token_a_client.mint(&maker, &1_000_000_0000000); // 1M with 7 decimals
    token_a_client.mint(&taker, &1_000_000_0000000);

    let token_b_admin = Address::generate(&env);
    let token_b = env.register_stellar_asset_contract_v2(token_b_admin.clone());
    let token_b_client = StellarAssetClient::new(&env, &token_b.address());
    token_b_client.mint(&maker, &1_000_000_0000000);
    token_b_client.mint(&taker, &1_000_000_0000000);

    // Deploy fee vault (just use a regular address for testing)
    let fee_vault = Address::generate(&env);

    // Deploy SwapBook
    let contract_id = env.register(SwapBook, ());
    let client = SwapBookClient::new(&env, &contract_id);
    client.initialize(&admin, &fee_vault);

    (env, contract_id, token_a.address(), token_b.address(), maker, taker)
}

#[test]
fn test_place_order() {
    let (env, contract_id, token_a, token_b, maker, _taker) = setup_test();
    let client = SwapBookClient::new(&env, &contract_id);

    let order_id = client.place_order(
        &maker,
        &token_a,
        &token_b,
        &10_000_0000000,    // 10,000 token_a
        &9_999_5000000,     // min 9,999.5 token_b (0.5 bps spread)
        &200,               // expires at ledger 200
    );

    assert_eq!(order_id, 1);

    let order = client.get_order(&order_id);
    assert_eq!(order.maker, maker);
    assert_eq!(order.amount_in, 10_000_0000000);
    assert_eq!(order.amount_in_remaining, 10_000_0000000);
    assert_eq!(order.status, OrderStatus::Open);

    // Verify tokens were escrowed
    let token_a_client = TokenClient::new(&env, &token_a);
    assert_eq!(
        token_a_client.balance(&maker),
        1_000_000_0000000 - 10_000_0000000
    );
    assert_eq!(token_a_client.balance(&contract_id), 10_000_0000000);
}

#[test]
fn test_fill_order() {
    let (env, contract_id, token_a, token_b, maker, taker) = setup_test();
    let client = SwapBookClient::new(&env, &contract_id);

    let order_id = client.place_order(
        &maker,
        &token_a,
        &token_b,
        &10_000_0000000,
        &9_999_5000000,
        &200,
    );

    // Taker fills the order
    client.fill_order(
        &taker,
        &order_id,
        &10_000_0000000, // taker provides 10,000 token_b
    );

    // Check order is filled
    let order = client.get_order(&order_id);
    assert_eq!(order.status, OrderStatus::Filled);
    assert_eq!(order.amount_in_remaining, 0);

    // Check balances
    let token_a_client = TokenClient::new(&env, &token_a);
    let token_b_client = TokenClient::new(&env, &token_b);

    // Taker received 10,000 token_a
    assert_eq!(
        token_a_client.balance(&taker),
        1_000_000_0000000 + 10_000_0000000
    );

    // Maker received token_b minus 0.5bps fee
    // Fee = 10,000 * 5 / 100,000 = 0.5
    let fee = (10_000_0000000i128 * 5) / 100_000;
    let maker_receives = 10_000_0000000 - fee;
    assert_eq!(
        token_b_client.balance(&maker),
        1_000_000_0000000 + maker_receives
    );
}

#[test]
fn test_partial_fill() {
    let (env, contract_id, token_a, token_b, maker, taker) = setup_test();
    let client = SwapBookClient::new(&env, &contract_id);

    let order_id = client.place_order(
        &maker,
        &token_a,
        &token_b,
        &10_000_0000000,
        &9_999_5000000,
        &200,
    );

    // Taker fills half the order
    client.partial_fill(
        &taker,
        &order_id,
        &5_000_0000000,  // take half the token_a
        &5_000_0000000,  // pay 5,000 token_b
    );

    let order = client.get_order(&order_id);
    assert_eq!(order.status, OrderStatus::PartialFill);
    assert_eq!(order.amount_in_remaining, 5_000_0000000);

    // Pair index should still contain this order
    let orders = client.get_orders(&token_a, &token_b);
    assert_eq!(orders.len(), 1);
}

#[test]
fn test_cancel_order() {
    let (env, contract_id, token_a, token_b, maker, _taker) = setup_test();
    let client = SwapBookClient::new(&env, &contract_id);

    let order_id = client.place_order(
        &maker,
        &token_a,
        &token_b,
        &10_000_0000000,
        &9_999_5000000,
        &200,
    );

    // Cancel the order
    client.cancel_order(&maker, &order_id);

    let order = client.get_order(&order_id);
    assert_eq!(order.status, OrderStatus::Cancelled);

    // Tokens returned to maker
    let token_a_client = TokenClient::new(&env, &token_a);
    assert_eq!(token_a_client.balance(&maker), 1_000_000_0000000);

    // Removed from pair index
    let orders = client.get_orders(&token_a, &token_b);
    assert_eq!(orders.len(), 0);
}

#[test]
fn test_multiple_orders_and_best_offer() {
    let (env, contract_id, token_a, token_b, maker, taker) = setup_test();
    let client = SwapBookClient::new(&env, &contract_id);

    // Place two orders at different prices
    let _id1 = client.place_order(
        &maker,
        &token_a,
        &token_b,
        &5_000_0000000,
        &4_999_0000000,  // worse price
        &200,
    );

    let _id2 = client.place_order(
        &maker,
        &token_a,
        &token_b,
        &5_000_0000000,
        &4_999_7500000,  // better price (tighter spread)
        &200,
    );

    let orders = client.get_orders(&token_a, &token_b);
    assert_eq!(orders.len(), 2);

    // Best offer for 3,000 token_a should return the better price pro-rated
    let best = client.get_best_offer(&token_a, &token_b, &3_000_0000000);
    assert!(best > 0);
}

#[test]
#[should_panic]
fn test_fill_expired_order() {
    let (env, contract_id, token_a, token_b, maker, taker) = setup_test();
    let client = SwapBookClient::new(&env, &contract_id);

    let order_id = client.place_order(
        &maker,
        &token_a,
        &token_b,
        &10_000_0000000,
        &9_999_5000000,
        &150, // expires at ledger 150
    );

    // Advance ledger past expiry
    env.ledger().set(LedgerInfo {
        timestamp: 2000,
        protocol_version: 20,
        sequence_number: 200, // past expiry
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 10,
        min_persistent_entry_ttl: 10,
        max_entry_ttl: 3110400,
    });

    // This should fail because order is expired
    client.fill_order(&taker, &order_id, &10_000_0000000);
}

#[test]
#[should_panic]
fn test_cancel_by_non_maker() {
    let (env, contract_id, token_a, token_b, maker, taker) = setup_test();
    let client = SwapBookClient::new(&env, &contract_id);

    let order_id = client.place_order(
        &maker,
        &token_a,
        &token_b,
        &10_000_0000000,
        &9_999_5000000,
        &200,
    );

    // Taker tries to cancel maker's order — should panic
    client.cancel_order(&taker, &order_id);
}
