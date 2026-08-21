#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Env, IntoVal,
};

struct TestCtx {
    env: Env,
    contract_id: Address,
    #[allow(dead_code)]
    admin: Address,
    fee_vault: Address,
    token_a: Address,
    token_b: Address,
    maker: Address,
    taker: Address,
}

fn setup() -> TestCtx {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.sequence_number = 100;
        li.timestamp = 1000;
    });

    let admin = Address::generate(&env);
    let fee_vault = Address::generate(&env);
    let maker = Address::generate(&env);
    let taker = Address::generate(&env);

    let token_a_admin = Address::generate(&env);
    let token_a = env
        .register_stellar_asset_contract_v2(token_a_admin)
        .address();
    StellarAssetClient::new(&env, &token_a).mint(&maker, &1_000_000_0000000);
    StellarAssetClient::new(&env, &token_a).mint(&taker, &1_000_000_0000000);

    let token_b_admin = Address::generate(&env);
    let token_b = env
        .register_stellar_asset_contract_v2(token_b_admin)
        .address();
    StellarAssetClient::new(&env, &token_b).mint(&maker, &1_000_000_0000000);
    StellarAssetClient::new(&env, &token_b).mint(&taker, &1_000_000_0000000);

    let contract_id = env.register(SwapBook, (admin.clone(), fee_vault.clone()));

    TestCtx {
        env,
        contract_id,
        admin,
        fee_vault,
        token_a,
        token_b,
        maker,
        taker,
    }
}

fn advance_to(env: &Env, seq: u32) {
    env.ledger().with_mut(|li| li.sequence_number = seq);
}

// ─── Fixed-Price Order Tests ──────────────────────────

#[test]
fn test_place_order_escrows_tokens() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &10_000_0000000, &9_999_5000000, &200,
        &0, &0, &0,
    );
    assert_eq!(order_id, 1);

    let order = client.get_order(&order_id);
    assert_eq!(order.maker, t.maker);
    assert_eq!(order.amount_in_remaining, 10_000_0000000);
    assert_eq!(order.status, OrderStatus::Open);

    let token_a = TokenClient::new(&t.env, &t.token_a);
    assert_eq!(token_a.balance(&t.maker), 1_000_000_0000000 - 10_000_0000000);
    assert_eq!(token_a.balance(&t.contract_id), 10_000_0000000);
}

#[test]
fn test_fill_order_pays_maker_and_fee() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &10_000_0000000, &9_999_5000000, &200,
        &0, &0, &0,
    );
    client.fill_order(&t.taker, &order_id, &10_000_0000000);

    let order = client.get_order(&order_id);
    assert_eq!(order.status, OrderStatus::Filled);
    assert_eq!(order.amount_in_remaining, 0);

    let token_a = TokenClient::new(&t.env, &t.token_a);
    let token_b = TokenClient::new(&t.env, &t.token_b);

    assert_eq!(token_a.balance(&t.taker), 1_000_000_0000000 + 10_000_0000000);

    // fee = ceil(10_000_0000000 * 5 / 100_000) = 5_000_000
    let fee = 5_000_000i128;
    assert_eq!(
        token_b.balance(&t.maker),
        1_000_000_0000000 + 10_000_0000000 - fee
    );
    assert_eq!(token_b.balance(&t.fee_vault), fee);
}

#[test]
fn test_partial_fill_and_index_retained() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &10_000_0000000, &9_999_5000000, &200,
        &0, &0, &0,
    );
    client.partial_fill(&t.taker, &order_id, &5_000_0000000, &5_000_0000000);

    let order = client.get_order(&order_id);
    assert_eq!(order.status, OrderStatus::PartialFill);
    assert_eq!(order.amount_in_remaining, 5_000_0000000);
    assert_eq!(client.get_orders(&t.token_a, &t.token_b).len(), 1);
}

#[test]
fn test_partial_fill_underpayment_rejected() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &10_000_0000000, &9_999_5000000, &200,
        &0, &0, &0,
    );
    // Exact pro-rata for half = ceil(9_999_5000000 / 2) = 4_999_7500000
    // One stroop below must be rejected.
    let res = client.try_partial_fill(&t.taker, &order_id, &5_000_0000000, &4_999_7499999);
    assert!(res.is_err());
    // Exact amount succeeds
    client.partial_fill(&t.taker, &order_id, &5_000_0000000, &4_999_7500000);
}

#[test]
fn test_dust_fill_cannot_round_to_free() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    // Cross-price order: 62,000 A for 1 B (per-unit price ≪ 1).
    // Old floor math let fills below 62,000 stroops round required_out to 0.
    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &62_000_0000000, &1_0000000, &200,
        &0, &0, &0,
    );

    // Paying zero is always rejected
    assert!(client.try_partial_fill(&t.taker, &order_id, &61_999, &0).is_err());
    // Ceiling math demands at least 1 stroop for any nonzero fill
    client.partial_fill(&t.taker, &order_id, &61_999, &1);
}

#[test]
fn test_cancel_order_refunds() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &10_000_0000000, &9_999_5000000, &200,
        &0, &0, &0,
    );
    client.cancel_order(&order_id);

    assert_eq!(client.get_order(&order_id).status, OrderStatus::Cancelled);
    assert_eq!(
        TokenClient::new(&t.env, &t.token_a).balance(&t.maker),
        1_000_000_0000000
    );
    assert_eq!(client.get_orders(&t.token_a, &t.token_b).len(), 0);
}

#[test]
fn test_cancel_requires_maker_auth() {
    let t = setup();
    // Mock ONLY the taker's auth — maker's require_auth must then fail.
    let client = SwapBookClient::new(&t.env, &t.contract_id);
    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &10_000_0000000, &9_999_5000000, &200,
        &0, &0, &0,
    );

    t.env.set_auths(&[]);
    t.env.mock_auths(&[MockAuth {
        address: &t.taker,
        invoke: &MockAuthInvoke {
            contract: &t.contract_id,
            fn_name: "cancel_order",
            args: (order_id,).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_cancel_order(&order_id).is_err());
}

#[test]
fn test_expire_order_refunds_maker() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &10_000_0000000, &9_999_5000000, &150,
        &0, &0, &0,
    );

    // Not yet expired
    assert!(client.try_expire_order(&order_id).is_err());

    advance_to(&t.env, 200);
    client.expire_order(&order_id);

    assert_eq!(client.get_order(&order_id).status, OrderStatus::Expired);
    assert_eq!(
        TokenClient::new(&t.env, &t.token_a).balance(&t.maker),
        1_000_000_0000000
    );
    assert_eq!(client.get_orders(&t.token_a, &t.token_b).len(), 0);
}

#[test]
fn test_fill_expired_order_rejected() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &10_000_0000000, &9_999_5000000, &150,
        &0, &0, &0,
    );
    advance_to(&t.env, 200);
    assert!(client.try_fill_order(&t.taker, &order_id, &10_000_0000000).is_err());
}

// ─── quote_fill (taker-direction quoting) ─────────────

#[test]
fn test_quote_fill_taker_direction() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    // Maker sells 10,000 A, wants >= 9,999.5 B
    client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &10_000_0000000, &9_999_5000000, &200,
        &0, &0, &0,
    );

    // Taker pays 5,000 B to buy A
    let (bought, paid) = client.quote_fill(&t.token_a, &t.token_b, &5_000_0000000);
    assert!(paid <= 5_000_0000000);
    // At 0.5 bps under par, 5,000 B buys slightly MORE than 5,000 A
    assert!(bought > 5_000_0000000);
    assert!(bought <= 10_000_0000000);

    // Empty reverse side quotes zero
    let (bought_rev, paid_rev) = client.quote_fill(&t.token_b, &t.token_a, &5_000_0000000);
    assert_eq!(bought_rev, 0);
    assert_eq!(paid_rev, 0);
}

// ─── Oracle Price Mode ────────────────────────────────

fn setup_oracle(t: &TestCtx) -> (SwapBookClient<'_>, Address) {
    let client = SwapBookClient::new(&t.env, &t.contract_id);
    let oracle_admin = Address::generate(&t.env);
    client.set_oracle_admin(&oracle_admin);
    // 1 A = 62,000 B
    client.update_oracle_price(&t.token_a, &t.token_b, &62_000, &1);
    (client, oracle_admin)
}

#[test]
fn test_oracle_order_fill() {
    let t = setup();
    let (client, _) = setup_oracle(&t);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &1_0000000, &0, &500,
        &1, &50, &0, // Oracle mode, 50 bps slippage
    );

    // Fill at oracle fair value (62,000 B for 1 A)
    client.fill_order(&t.taker, &order_id, &62_000_0000000);
    assert_eq!(client.get_order(&order_id).status, OrderStatus::Filled);
}

#[test]
fn test_oracle_slippage_exceeded() {
    let t = setup();
    let (client, _) = setup_oracle(&t);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &1_0000000, &0, &500,
        &1, &50, &0,
    );
    // 61,000 is ~1.6% below fair — beyond 50 bps tolerance
    assert!(client.try_fill_order(&t.taker, &order_id, &61_000_0000000).is_err());
}

#[test]
fn test_oracle_price_validation() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);
    let oracle_admin = Address::generate(&t.env);
    client.set_oracle_admin(&oracle_admin);

    // Zero / negative prices rejected
    assert!(client.try_update_oracle_price(&t.token_a, &t.token_b, &0, &1).is_err());
    assert!(client.try_update_oracle_price(&t.token_a, &t.token_b, &62_000, &0).is_err());
    assert!(client.try_update_oracle_price(&t.token_a, &t.token_b, &-62_000, &1).is_err());
}

#[test]
fn test_oracle_jump_capped() {
    let t = setup();
    let (client, _) = setup_oracle(&t); // price = 62,000

    // +19% is allowed
    client.update_oracle_price(&t.token_a, &t.token_b, &73_780, &1);
    // From 73,780, +25% must be rejected (cap is 20%)
    assert!(client.try_update_oracle_price(&t.token_a, &t.token_b, &92_225, &1).is_err());
    // A crash to ~zero must be rejected — this was the rug vector
    assert!(client.try_update_oracle_price(&t.token_a, &t.token_b, &1, &1_000_000).is_err());
}

#[test]
fn test_oracle_stale_price_rejected() {
    let t = setup();
    let (client, _) = setup_oracle(&t);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &1_0000000, &0, &5_000,
        &1, &50, &0,
    );

    // Advance past staleness window (1000 ledgers)
    advance_to(&t.env, 100 + 1001 + 1);
    assert!(client.try_fill_order(&t.taker, &order_id, &62_000_0000000).is_err());
}

#[test]
fn test_oracle_slippage_cap_enforced() {
    let t = setup();
    let (client, _) = setup_oracle(&t);

    // > MAX_SLIPPAGE_BPS (1000) rejected
    let res = client.try_place_order(
        &t.maker, &t.token_a, &t.token_b,
        &1_0000000, &0, &500,
        &1, &1001, &0,
    );
    assert!(res.is_err());
    // 0 slippage in oracle mode also rejected
    let res = client.try_place_order(
        &t.maker, &t.token_a, &t.token_b,
        &1_0000000, &0, &500,
        &1, &0, &0,
    );
    assert!(res.is_err());
}

// ─── Auto-Route Timer ─────────────────────────────────

#[test]
fn test_timer_claim_returns_price_floor() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);
    let router = Address::generate(&t.env);
    client.set_router(&router);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &10_000_0000000, &9_999_5000000, &500,
        &0, &0, &150,
    );

    // Before the timer: not claimable
    assert!(client.try_claim_expired_timer(&order_id).is_err());

    advance_to(&t.env, 200);
    assert_eq!(client.get_expired_timer_orders(&t.token_a, &t.token_b).len(), 1);

    let claimed = client.claim_expired_timer(&order_id);
    assert_eq!(claimed.maker, t.maker);
    assert_eq!(claimed.amount, 10_000_0000000);
    // Price floor = full min_amount_out (nothing was filled)
    assert_eq!(claimed.min_out, 9_999_5000000);

    let order = client.get_order(&order_id);
    assert_eq!(order.status, OrderStatus::Routed);
    assert_eq!(order.amount_in_remaining, 0);
    assert_eq!(
        TokenClient::new(&t.env, &t.token_a).balance(&router),
        10_000_0000000
    );
}

#[test]
fn test_timer_claim_no_timer_set() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);
    let router = Address::generate(&t.env);
    client.set_router(&router);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &10_000_0000000, &9_999_5000000, &500,
        &0, &0, &0, // no auto-route
    );
    advance_to(&t.env, 400);
    assert!(client.try_claim_expired_timer(&order_id).is_err());
}
