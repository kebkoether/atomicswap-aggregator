#![cfg(test)]

use super::*;
use soroban_sdk::{
    contract as sdk_contract, contractimpl as sdk_contractimpl,
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Env,
};
use swap_book::{SwapBook, SwapBookClient};

// ─── Mock venue adapter ─────────────────────────────────
// Pays out token_out at a fixed rate (bps of amount_in) from its own balance.
// Mirrors the production adapter interface:
//   swap(recipient, token_in, token_out, amount_in, min_out) -> i128

#[sdk_contract]
pub struct MockVenue;

#[sdk_contractimpl]
impl MockVenue {
    pub fn __constructor(env: Env, rate_bps: i128) {
        env.storage().instance().set(&symbol_short!("rate"), &rate_bps);
    }

    pub fn swap(
        env: Env,
        recipient: Address,
        _token_in: Address,
        token_out: Address,
        amount_in: i128,
        _min_amount_out: i128,
    ) -> i128 {
        let rate: i128 = env
            .storage()
            .instance()
            .get(&symbol_short!("rate"))
            .unwrap();
        let out = amount_in * rate / 10_000;
        token::Client::new(&env, &token_out).transfer(
            &env.current_contract_address(),
            &recipient,
            &out,
        );
        out
    }
}

// ─── Test setup ─────────────────────────────────────────

struct TestCtx {
    env: Env,
    router_id: Address,
    swapbook_id: Address,
    fee_vault: Address,
    token_a: Address,
    token_b: Address,
    user: Address,
    maker: Address,
}

fn setup(venue_rate_bps: i128) -> TestCtx {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.sequence_number = 100;
        li.timestamp = 1000;
    });

    let admin = Address::generate(&env);
    let fee_vault = Address::generate(&env);
    let user = Address::generate(&env);
    let maker = Address::generate(&env);

    let token_a = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let token_b = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    StellarAssetClient::new(&env, &token_a).mint(&user, &1_000_000_0000000);
    StellarAssetClient::new(&env, &token_a).mint(&maker, &1_000_000_0000000);

    // SwapBook + Router wired together
    let swapbook_id = env.register(SwapBook, (admin.clone(), fee_vault.clone()));
    let router_id = env.register(
        Router,
        (admin.clone(), fee_vault.clone(), swapbook_id.clone()),
    );
    SwapBookClient::new(&env, &swapbook_id).set_router(&router_id);

    // Mock venue funded with plenty of token_b
    let venue_id = env.register(MockVenue, (venue_rate_bps,));
    StellarAssetClient::new(&env, &token_b).mint(&venue_id, &10_000_000_0000000);
    RouterClient::new(&env, &router_id).register_venue(&1u32, &venue_id);

    TestCtx {
        env,
        router_id,
        swapbook_id,
        fee_vault,
        token_a,
        token_b,
        user,
        maker,
    }
}

fn seg(venue_id: u32, amount_in: i128, min_amount_out: i128) -> RouteSegment {
    RouteSegment {
        venue_id,
        amount_in,
        min_amount_out,
    }
}

// ─── execute_route ──────────────────────────────────────

#[test]
fn test_execute_route_fee_on_total() {
    let t = setup(10_000); // 1:1 venue
    let client = RouterClient::new(&t.env, &t.router_id);

    let amount = 10_000_0000000i128;
    let segments = soroban_sdk::vec![&t.env, seg(1, amount, amount)];
    // fee = ceil(1e11 * 5 / 1e5) = 5_000_000
    let expected_net = amount - 5_000_000;

    let received = client.execute_route(
        &t.user, &t.token_a, &t.token_b,
        &amount, &expected_net, &segments,
    );
    assert_eq!(received, expected_net);

    let token_b = TokenClient::new(&t.env, &t.token_b);
    assert_eq!(token_b.balance(&t.user), expected_net);
    assert_eq!(token_b.balance(&t.fee_vault), 5_000_000);
    // Router holds nothing
    assert_eq!(token_b.balance(&t.router_id), 0);
    assert_eq!(TokenClient::new(&t.env, &t.token_a).balance(&t.router_id), 0);
}

#[test]
fn test_execute_route_insufficient_output_reverts() {
    let t = setup(9_000); // venue pays only 90%
    let client = RouterClient::new(&t.env, &t.router_id);

    let amount = 10_000_0000000i128;
    let segments = soroban_sdk::vec![&t.env, seg(1, amount, 0)];
    let res = client.try_execute_route(
        &t.user, &t.token_a, &t.token_b,
        &amount, &(amount - 5_000_000), &segments,
    );
    assert!(res.is_err());
    // Revert means the user kept their funds
    assert_eq!(
        TokenClient::new(&t.env, &t.token_a).balance(&t.user),
        1_000_000_0000000
    );
}

#[test]
fn test_execute_route_segment_validation() {
    let t = setup(10_000);
    let client = RouterClient::new(&t.env, &t.router_id);
    let amount = 10_000_0000000i128;

    // Sum mismatch
    let bad_sum = soroban_sdk::vec![&t.env, seg(1, amount / 2, 0)];
    assert!(client
        .try_execute_route(&t.user, &t.token_a, &t.token_b, &amount, &1, &bad_sum)
        .is_err());

    // Non-positive segment amount
    let bad_seg = soroban_sdk::vec![&t.env, seg(1, -1, 0), seg(1, amount + 1, 0)];
    assert!(client
        .try_execute_route(&t.user, &t.token_a, &t.token_b, &amount, &1, &bad_seg)
        .is_err());

    // Unknown venue
    let bad_venue = soroban_sdk::vec![&t.env, seg(99, amount, 0)];
    assert!(client
        .try_execute_route(&t.user, &t.token_a, &t.token_b, &amount, &1, &bad_venue)
        .is_err());
}

// ─── route_expired_order (atomic keeper flow) ───────────

#[test]
fn test_route_expired_order_pays_maker_atomically() {
    let t = setup(10_000); // 1:1 venue
    let router = RouterClient::new(&t.env, &t.router_id);
    let book = SwapBookClient::new(&t.env, &t.swapbook_id);

    // Maker places a timer order: 10,000 A -> min 9,999.5 B, route after ledger 150
    let amount = 10_000_0000000i128;
    let min_out = 9_999_5000000i128;
    let order_id = book.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &amount, &min_out, &10_000,
        &0, &0, &150, &soroban_sdk::vec![&t.env]);

    t.env.ledger().with_mut(|li| li.sequence_number = 200);

    let segments = soroban_sdk::vec![&t.env, seg(1, amount, min_out)];
    let maker_received = router.route_expired_order(&order_id, &segments);

    // 1:1 venue → out = 1e11, fee = 5_000_000, net = 9_999_5000000 = exactly min_out
    assert_eq!(maker_received, min_out);
    assert_eq!(
        TokenClient::new(&t.env, &t.token_b).balance(&t.maker),
        min_out
    );
    assert_eq!(
        TokenClient::new(&t.env, &t.token_b).balance(&t.fee_vault),
        5_000_000
    );
    // Order settled on the book
    let order = book.get_order(&order_id);
    assert_eq!(order.amount_in_remaining, 0);
}

#[test]
fn test_route_expired_order_enforces_maker_floor() {
    let t = setup(9_500); // venue pays 95% — below the maker's floor
    let router = RouterClient::new(&t.env, &t.router_id);
    let book = SwapBookClient::new(&t.env, &t.swapbook_id);

    let amount = 10_000_0000000i128;
    let min_out = 9_999_5000000i128;
    let order_id = book.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &amount, &min_out, &10_000,
        &0, &0, &150, &soroban_sdk::vec![&t.env]);
    t.env.ledger().with_mut(|li| li.sequence_number = 200);

    let segments = soroban_sdk::vec![&t.env, seg(1, amount, 0)];
    let res = router.try_route_expired_order(&order_id, &segments);
    assert!(res.is_err());

    // Whole tx reverted: order still open and claimable, escrow intact
    let order = book.get_order(&order_id);
    assert_eq!(order.amount_in_remaining, amount);
    assert_eq!(
        TokenClient::new(&t.env, &t.token_a).balance(&t.swapbook_id),
        amount
    );
}

#[test]
fn test_route_expired_order_timer_not_reached() {
    let t = setup(10_000);
    let router = RouterClient::new(&t.env, &t.router_id);
    let book = SwapBookClient::new(&t.env, &t.swapbook_id);

    let amount = 10_000_0000000i128;
    let order_id = book.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &amount, &9_999_5000000, &10_000,
        &0, &0, &150, &soroban_sdk::vec![&t.env]);
    // Still at ledger 100 — timer hasn't fired
    let segments = soroban_sdk::vec![&t.env, seg(1, amount, 0)];
    assert!(router.try_route_expired_order(&order_id, &segments).is_err());
}

// ─── Venue registry ─────────────────────────────────────

#[test]
fn test_venue_registry() {
    let t = setup(10_000);
    let client = RouterClient::new(&t.env, &t.router_id);

    assert_eq!(client.get_venues().len(), 1);
    assert!(client.try_register_venue(&1u32, &t.router_id).is_err()); // duplicate

    let venue2 = Address::generate(&t.env);
    client.register_venue(&2u32, &venue2);
    assert_eq!(client.get_venue(&2u32), venue2);
    assert_eq!(client.get_venues().len(), 2);

    client.remove_venue(&2u32);
    assert!(client.try_get_venue(&2u32).is_err());
    assert_eq!(client.get_venues().len(), 1);
}

// ─── v1.1: settable fee within compiled cap ──────────────

#[test]
fn test_router_fee_settable_within_cap() {
    let t = setup(10_000); // 1:1 venue
    let client = RouterClient::new(&t.env, &t.router_id);
    assert_eq!(client.get_fee(), (5, 100_000));

    // Fee holiday: user receives the full venue output
    client.set_fee(&0);
    let amount = 10_000_0000000i128;
    let segments = soroban_sdk::vec![&t.env, seg(1, amount, amount)];
    let received = client.execute_route(
        &t.user, &t.token_a, &t.token_b,
        &amount, &amount, &segments,
    );
    assert_eq!(received, amount);
    assert_eq!(TokenClient::new(&t.env, &t.token_b).balance(&t.fee_vault), 0);

    // Restore; the compiled cap holds
    client.set_fee(&5);
    assert!(client.try_set_fee(&6).is_err());
    assert!(client.try_set_fee(&-1).is_err());
}
