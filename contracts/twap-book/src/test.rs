#![cfg(test)]

use super::*;
use soroban_sdk::{
    contract as sdk_contract, contractimpl as sdk_contractimpl,
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Env,
};
use swap_book::{SwapBook, SwapBookClient};

// ─── Mock venue (same interface as production adapters) ─────────────────
// Pays token_out at rate_bps of amount_in from its own balance.

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
        let rate: i128 = env.storage().instance().get(&symbol_short!("rate")).unwrap();
        let out = amount_in * rate / 10_000;
        token::Client::new(&env, &token_out).transfer(
            &env.current_contract_address(),
            &recipient,
            &out,
        );
        out
    }
}

// ─── Setup ──────────────────────────────────────────────

struct Ctx {
    env: Env,
    twap_id: Address,
    swapbook_id: Address,
    fee_vault: Address,
    token_a: Address,
    token_b: Address,
    maker: Address,
    #[allow(dead_code)]
    admin: Address,
}

const TOTAL: i128 = 1_000_0000000; // 1,000 A
const START: u32 = 100;
const END: u32 = 1100; // duration 1000 ledgers

fn setup(venue_rate_bps: i128) -> Ctx {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.sequence_number = START;
        li.timestamp = 1000;
    });

    let admin = Address::generate(&env);
    let fee_vault = Address::generate(&env);
    let maker = Address::generate(&env);

    let token_a = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let token_b = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    StellarAssetClient::new(&env, &token_a).mint(&maker, &(TOTAL * 10));

    let swapbook_id = env.register(SwapBook, (admin.clone(), fee_vault.clone()));
    let twap_id = env.register(
        TwapBook,
        (admin.clone(), fee_vault.clone(), swapbook_id.clone()),
    );

    // Venue funded with plenty of token_b
    let venue = env.register(MockVenue, (venue_rate_bps,));
    StellarAssetClient::new(&env, &token_b).mint(&venue, &(TOTAL * 20));
    TwapBookClient::new(&env, &twap_id).register_venue(&1u32, &venue);

    Ctx { env, twap_id, swapbook_id, fee_vault, token_a, token_b, maker, admin }
}

fn advance_to(env: &Env, seq: u32) {
    env.ledger().with_mut(|li| li.sequence_number = seq);
}

fn seg(env: &Env, amount: i128) -> Vec<RouteSegment> {
    soroban_sdk::vec![env, RouteSegment { venue_id: 1, amount_in: amount, min_amount_out: 0 }]
}

/// Standard order: 1,000 A over 1,000 ledgers, limit 0.9985 B/A (leaves
/// room for the 10 bps default fee on a 1:1 venue),
/// 5% catch-up headroom, max slice 200 A, gap 10 ledgers.
fn place_std(c: &Ctx) -> u64 {
    TwapBookClient::new(&c.env, &c.twap_id).place_twap(
        &c.maker, &c.token_a, &c.token_b,
        &TOTAL, &END,
        &9985, &10000, // fixed limit 0.9985
        &0,
        &200_0000000, // max slice
        &10,          // min gap
        &500,         // 5% tolerance
    )
}

// ─── Placement ──────────────────────────────────────────

#[test]
fn test_place_escrows_and_indexes() {
    let c = setup(10_000);
    let client = TwapBookClient::new(&c.env, &c.twap_id);
    let id = place_std(&c);
    assert_eq!(id, 1);

    let order = client.get_order(&id);
    assert_eq!(order.status, TwapStatus::Active);
    assert_eq!(order.total_in, TOTAL);
    assert_eq!(order.filled_in, 0);
    assert_eq!(TokenClient::new(&c.env, &c.token_a).balance(&c.twap_id), TOTAL);
    assert_eq!(client.get_active_orders().len(), 1);
}

#[test]
fn test_place_validation() {
    let c = setup(10_000);
    let client = TwapBookClient::new(&c.env, &c.twap_id);

    // Too-short schedule
    assert!(client
        .try_place_twap(&c.maker, &c.token_a, &c.token_b, &TOTAL, &(START + 10),
            &9995, &10000, &0, &TOTAL, &10, &500)
        .is_err());
    // Half-set limit
    assert!(client
        .try_place_twap(&c.maker, &c.token_a, &c.token_b, &TOTAL, &END,
            &9995, &0, &0, &TOTAL, &10, &500)
        .is_err());
    // Oracle mode without an oracle price on SwapBook
    assert!(client
        .try_place_twap(&c.maker, &c.token_a, &c.token_b, &TOTAL, &END,
            &0, &0, &50, &TOTAL, &10, &500)
        .is_err());
    // Zero slice gap
    assert!(client
        .try_place_twap(&c.maker, &c.token_a, &c.token_b, &TOTAL, &END,
            &9995, &10000, &0, &TOTAL, &0, &500)
        .is_err());
    // Excess tolerance
    assert!(client
        .try_place_twap(&c.maker, &c.token_a, &c.token_b, &TOTAL, &END,
            &9995, &10000, &0, &TOTAL, &10, &5001)
        .is_err());
}

// ─── Slice execution ────────────────────────────────────

#[test]
fn test_slice_pays_maker_net_of_fee() {
    let c = setup(10_000); // 1:1 venue
    let client = TwapBookClient::new(&c.env, &c.twap_id);
    let id = place_std(&c);

    // Within the 5% immediate headroom: 50 A
    let amount = 50_0000000i128;
    let net = client.execute_slice(&id, &amount, &seg(&c.env, amount));

    // fee = ceil(50e7 * 100 / 100000) = 500000 (10 bps default)
    let fee = 500_000i128;
    assert_eq!(net, amount - fee);
    assert_eq!(TokenClient::new(&c.env, &c.token_b).balance(&c.maker), amount - fee);
    assert_eq!(TokenClient::new(&c.env, &c.token_b).balance(&c.fee_vault), fee);

    let order = client.get_order(&id);
    assert_eq!(order.filled_in, amount);
    assert_eq!(order.received_out, amount - fee);
}

#[test]
fn test_fee_settable_within_cap() {
    let c = setup(10_000);
    let client = TwapBookClient::new(&c.env, &c.twap_id);
    assert_eq!(client.get_fee(), (100, 100_000));

    // Lower to 0.5 bps, verify a slice charges the new rate
    client.set_fee(&5);
    assert_eq!(client.get_fee(), (5, 100_000));
    let id = place_std(&c);
    let amount = 50_0000000i128;
    let net = client.execute_slice(&id, &amount, &seg(&c.env, amount));
    assert_eq!(net, amount - 25_000); // ceil(50e7 * 5 / 100000)

    // Fee holiday is valid; above the cap or negative is not
    client.set_fee(&0);
    assert_eq!(client.get_fee(), (0, 100_000));
    assert!(client.try_set_fee(&101).is_err());
    assert!(client.try_set_fee(&-1).is_err());
}

#[test]
fn test_pace_enforced_with_catchup() {
    let c = setup(10_000);
    let client = TwapBookClient::new(&c.env, &c.twap_id);
    let id = place_std(&c);

    // At t=0: only the 5% headroom (50 A) is allowed — 60 A must fail
    let too_big = 60_0000000i128;
    assert!(client.try_execute_slice(&id, &too_big, &seg(&c.env, too_big)).is_err());

    // Half-way (elapsed 500/1000): on-schedule 500 A + 50 A headroom.
    // A 200-A slice (max cap) is fine; running total stays ≤ 550.
    advance_to(&c.env, START + 500);
    let a = 200_0000000i128;
    client.execute_slice(&id, &a, &seg(&c.env, a));
    advance_to(&c.env, START + 511);
    client.execute_slice(&id, &a, &seg(&c.env, a));

    // 400 filled; another 200 would hit 600 > 550 allowed — refused
    advance_to(&c.env, START + 522);
    assert!(client.try_execute_slice(&id, &a, &seg(&c.env, a)).is_err());
}

#[test]
fn test_cadence_gap_enforced() {
    let c = setup(10_000);
    let client = TwapBookClient::new(&c.env, &c.twap_id);
    let id = place_std(&c);

    let a = 20_0000000i128;
    client.execute_slice(&id, &a, &seg(&c.env, a));
    // Next ledger — inside the 10-ledger gap
    advance_to(&c.env, START + 1);
    assert!(client.try_execute_slice(&id, &a, &seg(&c.env, a)).is_err());
    // After the gap
    advance_to(&c.env, START + 10);
    client.execute_slice(&id, &a, &seg(&c.env, a));
}

#[test]
fn test_slice_cap_enforced() {
    let c = setup(10_000);
    let client = TwapBookClient::new(&c.env, &c.twap_id);
    let id = place_std(&c);
    advance_to(&c.env, START + 900); // plenty of schedule room

    let over_cap = 201_0000000i128;
    assert!(client.try_execute_slice(&id, &over_cap, &seg(&c.env, over_cap)).is_err());
}

#[test]
fn test_price_floor_reverts_bad_fills() {
    let c = setup(9_000); // venue pays only 90% — below the 0.9995 limit
    let client = TwapBookClient::new(&c.env, &c.twap_id);
    let id = place_std(&c);

    let a = 50_0000000i128;
    assert!(client.try_execute_slice(&id, &a, &seg(&c.env, a)).is_err());

    // Whole slice reverted: no fill recorded, escrow intact
    let order = client.get_order(&id);
    assert_eq!(order.filled_in, 0);
    assert_eq!(TokenClient::new(&c.env, &c.token_a).balance(&c.twap_id), TOTAL);
    assert_eq!(TokenClient::new(&c.env, &c.token_b).balance(&c.maker), 0);
}

// ─── Oracle-bound orders ────────────────────────────────

#[test]
fn test_oracle_bound_order() {
    let c = setup(10_000); // 1:1 venue
    let book = SwapBookClient::new(&c.env, &c.swapbook_id);
    let oracle_admin = Address::generate(&c.env);
    book.set_oracle_admin(&oracle_admin);
    // Fair price 1 A = 1 B
    book.update_oracle_price(&c.token_a, &c.token_b, &1, &1);

    let client = TwapBookClient::new(&c.env, &c.twap_id);
    let id = client.place_twap(
        &c.maker, &c.token_a, &c.token_b, &TOTAL, &END,
        &0, &0, &50, // oracle mode, 0.5% slippage
        &200_0000000, &10, &500,
    );

    // 1:1 venue clears the oracle bound easily (fee 10bps < 50bps slippage)
    let a = 50_0000000i128;
    client.execute_slice(&id, &a, &seg(&c.env, a));

    // Stale oracle (>1000 ledgers old) blocks further slices
    advance_to(&c.env, START + 1000 + 11);
    assert!(client.try_execute_slice(&id, &a, &seg(&c.env, a)).is_err());
}

#[test]
fn test_oracle_bound_rejects_below_fair() {
    let c = setup(9_800); // venue pays 98% — beyond the 0.5% oracle band
    let book = SwapBookClient::new(&c.env, &c.swapbook_id);
    let oracle_admin = Address::generate(&c.env);
    book.set_oracle_admin(&oracle_admin);
    book.update_oracle_price(&c.token_a, &c.token_b, &1, &1);

    let client = TwapBookClient::new(&c.env, &c.twap_id);
    let id = client.place_twap(
        &c.maker, &c.token_a, &c.token_b, &TOTAL, &END,
        &0, &0, &50,
        &200_0000000, &10, &500,
    );
    let a = 50_0000000i128;
    assert!(client.try_execute_slice(&id, &a, &seg(&c.env, a)).is_err());
}

// ─── Lifecycle ──────────────────────────────────────────

#[test]
fn test_cancel_refunds_remainder() {
    let c = setup(10_000);
    let client = TwapBookClient::new(&c.env, &c.twap_id);
    let id = place_std(&c);

    let a = 50_0000000i128;
    client.execute_slice(&id, &a, &seg(&c.env, a));

    client.cancel_twap(&id);
    let order = client.get_order(&id);
    assert_eq!(order.status, TwapStatus::Cancelled);
    // Maker got back 950 A; proceeds from the slice stay
    assert_eq!(
        TokenClient::new(&c.env, &c.token_a).balance(&c.maker),
        TOTAL * 10 - a
    );
    assert_eq!(client.get_active_orders().len(), 0);

    // No further slices
    advance_to(&c.env, START + 20);
    assert!(client.try_execute_slice(&id, &a, &seg(&c.env, a)).is_err());
}

#[test]
fn test_expire_refunds_permissionlessly() {
    let c = setup(10_000);
    let client = TwapBookClient::new(&c.env, &c.twap_id);
    let id = place_std(&c);

    // Too early
    assert!(client.try_expire_twap(&id).is_err());

    advance_to(&c.env, END + 1);
    // Slices past the end are refused
    let a = 50_0000000i128;
    assert!(client.try_execute_slice(&id, &a, &seg(&c.env, a)).is_err());

    client.expire_twap(&id);
    let order = client.get_order(&id);
    assert_eq!(order.status, TwapStatus::Expired);
    assert_eq!(TokenClient::new(&c.env, &c.token_a).balance(&c.maker), TOTAL * 10);
}

#[test]
fn test_completion() {
    let c = setup(10_000);
    let client = TwapBookClient::new(&c.env, &c.twap_id);
    // Whole-order slice allowed: max_slice = total, no tolerance needed at end
    let id = client.place_twap(
        &c.maker, &c.token_a, &c.token_b, &TOTAL, &END,
        &9985, &10000, &0,
        &TOTAL, &10, &500,
    );

    advance_to(&c.env, END); // elapsed == duration → full amount on schedule
    client.execute_slice(&id, &TOTAL, &seg(&c.env, TOTAL));

    let order = client.get_order(&id);
    assert_eq!(order.status, TwapStatus::Completed);
    assert_eq!(order.filled_in, TOTAL);
    assert_eq!(client.get_active_orders().len(), 0);
    assert_eq!(TokenClient::new(&c.env, &c.token_a).balance(&c.twap_id), 0);
}
