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
        min_temp_entry_ttl: 100_000,
        min_persistent_entry_ttl: 100_000,
        max_entry_ttl: 3_110_400,
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
    let contract_id = env.register_contract(None, SwapBook);
    let client = SwapBookClient::new(&env, &contract_id);
    client.initialize(&admin, &fee_vault);

    (env, contract_id, token_a.address(), token_b.address(), maker, taker)
}

// ─── Fixed-Price Order Tests (backward-compat) ────────────

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
        &0,                 // Fixed price mode
        &0,                 // no slippage (N/A for fixed)
        &0,                 // no auto-route timer
    );

    assert_eq!(order_id, 1);

    let order = client.get_order(&order_id);
    assert_eq!(order.maker, maker);
    assert_eq!(order.amount_in, 10_000_0000000);
    assert_eq!(order.amount_in_remaining, 10_000_0000000);
    assert_eq!(order.status, OrderStatus::Open);
    assert_eq!(order.price_mode, PriceMode::Fixed);
    assert_eq!(order.auto_route_after, 0);

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
        &maker, &token_a, &token_b,
        &10_000_0000000, &9_999_5000000, &200,
        &0, &0, &0,
    );

    // Taker fills the order
    client.fill_order(&taker, &order_id, &10_000_0000000);

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
        &maker, &token_a, &token_b,
        &10_000_0000000, &9_999_5000000, &200,
        &0, &0, &0,
    );

    // Taker fills half the order
    client.partial_fill(&taker, &order_id, &5_000_0000000, &5_000_0000000);

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
        &maker, &token_a, &token_b,
        &10_000_0000000, &9_999_5000000, &200,
        &0, &0, &0,
    );

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
    let (env, contract_id, token_a, token_b, maker, _taker) = setup_test();
    let client = SwapBookClient::new(&env, &contract_id);

    // Place two orders at different prices
    let _id1 = client.place_order(
        &maker, &token_a, &token_b,
        &5_000_0000000, &4_999_0000000, &200,
        &0, &0, &0,
    );
    let _id2 = client.place_order(
        &maker, &token_a, &token_b,
        &5_000_0000000, &4_999_7500000, &200,
        &0, &0, &0,
    );

    let orders = client.get_orders(&token_a, &token_b);
    assert_eq!(orders.len(), 2);

    let best = client.get_best_offer(&token_a, &token_b, &3_000_0000000);
    assert!(best > 0);
}

#[test]
#[should_panic]
fn test_fill_expired_order() {
    let (env, contract_id, token_a, token_b, maker, taker) = setup_test();
    let client = SwapBookClient::new(&env, &contract_id);

    let order_id = client.place_order(
        &maker, &token_a, &token_b,
        &10_000_0000000, &9_999_5000000, &150,
        &0, &0, &0,
    );

    // Advance ledger past expiry
    env.ledger().set(LedgerInfo {
        timestamp: 2000,
        protocol_version: 20,
        sequence_number: 200,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 100_000,
        min_persistent_entry_ttl: 100_000,
        max_entry_ttl: 3_110_400,
    });

    client.fill_order(&taker, &order_id, &10_000_0000000);
}

#[test]
#[should_panic]
fn test_cancel_by_non_maker() {
    let (env, contract_id, token_a, token_b, maker, taker) = setup_test();
    let client = SwapBookClient::new(&env, &contract_id);

    let order_id = client.place_order(
        &maker, &token_a, &token_b,
        &10_000_0000000, &9_999_5000000, &200,
        &0, &0, &0,
    );

    client.cancel_order(&taker, &order_id);
}

// ─── Oracle Price Mode Tests ──────────────────────────

#[test]
fn test_oracle_order_fill() {
    let (env, contract_id, token_a, token_b, maker, taker) = setup_test();
    let client = SwapBookClient::new(&env, &contract_id);

    // Set up oracle admin and price
    // token_a = BTC (7 decimals), token_b = USDC (7 decimals)
    // Price: 1 BTC = 62,000 USDC
    let admin = Address::generate(&env);
    // Re-initialize with admin (for simplicity, use a fresh contract)
    let contract_id2 = env.register_contract(None, SwapBook);
    let client2 = SwapBookClient::new(&env, &contract_id2);
    let oracle_admin = Address::generate(&env);
    let fee_vault = Address::generate(&env);
    client2.initialize(&admin, &fee_vault);
    client2.set_oracle_admin(&admin, &oracle_admin);

    // Set oracle price: 1 token_a = 62,000 token_b
    // fair_value = fill_amount_in * num / den
    // For 1 BTC (1_0000000 raw) → 62000 USDC (62000_0000000 raw):
    // num/den ratio must equal 62000_0000000 / 1_0000000 = 62000
    client2.update_oracle_price(
        &oracle_admin,
        &token_a,
        &token_b,
        &62_000, // price numerator
        &1,      // price denominator
    );

    // Mint tokens to use with new contract
    let token_a_sac = StellarAssetClient::new(&env, &token_a);
    let token_b_sac = StellarAssetClient::new(&env, &token_b);
    token_a_sac.mint(&maker, &10_0000000);   // 10 BTC
    token_b_sac.mint(&taker, &700_000_0000000); // 700k USDC

    // Place oracle-pegged order: 1 BTC, max 50 bps slippage
    let order_id = client2.place_order(
        &maker,
        &token_a,
        &token_b,
        &1_0000000,     // 1 BTC
        &0,             // min_amount_out ignored for oracle mode
        &500,           // expiry ledger 500
        &1,             // Oracle price mode
        &50,            // 50 bps = 0.50% max slippage
        &0,             // no auto-route timer
    );

    assert_eq!(order_id, 1);
    let order = client2.get_order(&order_id);
    assert_eq!(order.price_mode, PriceMode::Oracle);
    assert_eq!(order.max_slippage_bps, 50);

    // Taker fills at oracle price (62,000 USDC) — should succeed
    client2.fill_order(&taker, &order_id, &62_000_0000000);

    let order = client2.get_order(&order_id);
    assert_eq!(order.status, OrderStatus::Filled);
}

#[test]
#[should_panic]
fn test_oracle_order_slippage_exceeded() {
    let (env, contract_id, token_a, token_b, maker, taker) = setup_test();

    let admin = Address::generate(&env);
    let oracle_admin = Address::generate(&env);
    let fee_vault = Address::generate(&env);
    let contract_id2 = env.register_contract(None, SwapBook);
    let client2 = SwapBookClient::new(&env, &contract_id2);
    client2.initialize(&admin, &fee_vault);
    client2.set_oracle_admin(&admin, &oracle_admin);

    // Price: 1 token_a = 62,000 token_b
    client2.update_oracle_price(
        &oracle_admin,
        &token_a, &token_b,
        &62_000,
        &1,
    );

    let token_a_sac = StellarAssetClient::new(&env, &token_a);
    token_a_sac.mint(&maker, &10_0000000);

    let order_id = client2.place_order(
        &maker, &token_a, &token_b,
        &1_0000000, &0, &500,
        &1, &50, &0, // 50 bps max slippage
    );

    // Taker tries to fill at 61,000 USDC (1.6% below oracle) — should fail
    client2.fill_order(&taker, &order_id, &61_000_0000000);
}

// ─── Auto-Route Timer Tests ───────────────────────────

#[test]
fn test_auto_route_timer_claim() {
    let (env, contract_id, token_a, token_b, maker, _taker) = setup_test();
    let client = SwapBookClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let router = Address::generate(&env);
    let fee_vault = Address::generate(&env);
    let contract_id2 = env.register_contract(None, SwapBook);
    let client2 = SwapBookClient::new(&env, &contract_id2);
    client2.initialize(&admin, &fee_vault);
    client2.set_router(&admin, &router);

    let token_a_sac = StellarAssetClient::new(&env, &token_a);
    token_a_sac.mint(&maker, &100_000_0000000);

    // Place order with auto_route_after = ledger 150
    let order_id = client2.place_order(
        &maker, &token_a, &token_b,
        &10_000_0000000, &9_999_5000000, &500,
        &0, &0, &150, // auto-route after ledger 150
    );

    let order = client2.get_order(&order_id);
    assert_eq!(order.auto_route_after, 150);

    // Advance ledger past timer
    env.ledger().set(LedgerInfo {
        timestamp: 2000,
        protocol_version: 20,
        sequence_number: 200,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 100_000,
        min_persistent_entry_ttl: 100_000,
        max_entry_ttl: 3_110_400,
    });

    // Check expired timer query
    let expired = client2.get_expired_timer_orders(&token_a, &token_b);
    assert_eq!(expired.len(), 1);

    // Router claims the order
    let claimed_amount = client2.claim_expired_timer(&router, &order_id);
    assert_eq!(claimed_amount, 10_000_0000000);

    // Order should be marked Routed
    let order = client2.get_order(&order_id);
    assert_eq!(order.status, OrderStatus::Routed);
    assert_eq!(order.amount_in_remaining, 0);

    // Router should have received the tokens
    let token_a_client = TokenClient::new(&env, &token_a);
    assert_eq!(token_a_client.balance(&router), 10_000_0000000);
}

#[test]
#[should_panic]
fn test_auto_route_timer_not_expired() {
    let (env, _contract_id, token_a, token_b, maker, _taker) = setup_test();

    let admin = Address::generate(&env);
    let router = Address::generate(&env);
    let fee_vault = Address::generate(&env);
    let contract_id2 = env.register_contract(None, SwapBook);
    let client2 = SwapBookClient::new(&env, &contract_id2);
    client2.initialize(&admin, &fee_vault);
    client2.set_router(&admin, &router);

    let token_a_sac = StellarAssetClient::new(&env, &token_a);
    token_a_sac.mint(&maker, &100_000_0000000);

    let order_id = client2.place_order(
        &maker, &token_a, &token_b,
        &10_000_0000000, &9_999_5000000, &500,
        &0, &0, &150,
    );

    // Try to claim before timer expired (still at ledger 100) — should panic
    client2.claim_expired_timer(&router, &order_id);
}

#[test]
#[should_panic]
fn test_auto_route_unauthorized_router() {
    let (env, _contract_id, token_a, token_b, maker, taker) = setup_test();

    let admin = Address::generate(&env);
    let router = Address::generate(&env);
    let fee_vault = Address::generate(&env);
    let contract_id2 = env.register_contract(None, SwapBook);
    let client2 = SwapBookClient::new(&env, &contract_id2);
    client2.initialize(&admin, &fee_vault);
    client2.set_router(&admin, &router);

    let token_a_sac = StellarAssetClient::new(&env, &token_a);
    token_a_sac.mint(&maker, &100_000_0000000);

    let order_id = client2.place_order(
        &maker, &token_a, &token_b,
        &10_000_0000000, &9_999_5000000, &500,
        &0, &0, &150,
    );

    env.ledger().set(LedgerInfo {
        timestamp: 2000,
        protocol_version: 20,
        sequence_number: 200,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 100_000,
        min_persistent_entry_ttl: 100_000,
        max_entry_ttl: 3_110_400,
    });

    // Taker (not the router) tries to claim — should panic
    client2.claim_expired_timer(&taker, &order_id);
}
