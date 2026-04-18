#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    token, Address, Env, IntoVal, Vec, log,
};

/// Protocol fee: 0.5 basis points = 5 per 100,000
const FEE_NUMERATOR: i128 = 5;
const FEE_DENOMINATOR: i128 = 100_000;

// ─── Storage Keys ───────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    FeeVault,
    /// Map of venue_id -> contract address
    Venue(u32),
    /// List of all registered venue IDs
    VenueIds,
    /// Address of the SwapBook contract
    SwapBook,
}

// ─── Types ──────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct RouteSegment {
    /// Which venue to route through (ID from venue registry)
    pub venue_id: u32,
    /// Amount of token_in for this leg
    pub amount_in: i128,
    /// Minimum token_out expected from this leg
    pub min_amount_out: i128,
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum RouterError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    VenueNotFound = 4,
    VenueAlreadyRegistered = 5,
    InvalidRoute = 6,
    InsufficientOutput = 7,
    InvalidAmount = 8,
    RouteMismatch = 9,
    SameToken = 10,
}

// ─── Contract ───────────────────────────────────────────
// Venue adapters are called via dynamic cross-contract invocation
// (env.invoke_contract) rather than compile-time imports, since
// adapters are deployed independently and may be added/removed.

#[contract]
pub struct Router;

#[contractimpl]
impl Router {
    /// Initialize the router with admin, fee vault, and swapbook addresses.
    pub fn initialize(
        env: Env,
        admin: Address,
        fee_vault: Address,
        swap_book: Address,
    ) -> Result<(), RouterError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(RouterError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::FeeVault, &fee_vault);
        env.storage().instance().set(&DataKey::SwapBook, &swap_book);
        env.storage()
            .instance()
            .set(&DataKey::VenueIds, &Vec::<u32>::new(&env));
        Ok(())
    }

    /// Register a new DEX venue. Admin only.
    ///
    /// `venue_id`: unique numeric ID (e.g., 1 = Aqua, 2 = SushiSwap, 3 = Curve)
    /// `contract_address`: the adapter contract for this venue
    pub fn register_venue(
        env: Env,
        admin: Address,
        venue_id: u32,
        contract_address: Address,
    ) -> Result<(), RouterError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        if env.storage().persistent().has(&DataKey::Venue(venue_id)) {
            return Err(RouterError::VenueAlreadyRegistered);
        }

        env.storage()
            .persistent()
            .set(&DataKey::Venue(venue_id), &contract_address);

        // Add to venue ID list
        let mut venue_ids: Vec<u32> = env
            .storage()
            .instance()
            .get(&DataKey::VenueIds)
            .unwrap_or(Vec::new(&env));
        venue_ids.push_back(venue_id);
        env.storage()
            .instance()
            .set(&DataKey::VenueIds, &venue_ids);

        log!(&env, "Venue registered: id={}, contract={}", venue_id, contract_address);

        Ok(())
    }

    /// Remove a venue. Admin only.
    pub fn remove_venue(
        env: Env,
        admin: Address,
        venue_id: u32,
    ) -> Result<(), RouterError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        if !env.storage().persistent().has(&DataKey::Venue(venue_id)) {
            return Err(RouterError::VenueNotFound);
        }

        env.storage().persistent().remove(&DataKey::Venue(venue_id));

        // Remove from venue ID list
        let venue_ids: Vec<u32> = env
            .storage()
            .instance()
            .get(&DataKey::VenueIds)
            .unwrap_or(Vec::new(&env));
        let mut new_ids = Vec::new(&env);
        for i in 0..venue_ids.len() {
            let id = venue_ids.get(i).unwrap();
            if id != venue_id {
                new_ids.push_back(id);
            }
        }
        env.storage().instance().set(&DataKey::VenueIds, &new_ids);

        log!(&env, "Venue removed: id={}", venue_id);

        Ok(())
    }

    /// Execute a multi-venue routed swap.
    ///
    /// The route (list of segments) is computed off-chain by the backend.
    /// This contract verifies that:
    /// 1. Segment amounts sum to total_amount_in
    /// 2. Total output meets min_total_out
    /// 3. Each venue exists
    ///
    /// Protocol fee (0.5 bps) is deducted from the total output.
    pub fn execute_route(
        env: Env,
        user: Address,
        token_in: Address,
        token_out: Address,
        total_amount_in: i128,
        min_total_out: i128,
        segments: Vec<RouteSegment>,
    ) -> Result<i128, RouterError> {
        user.require_auth();

        if total_amount_in <= 0 || min_total_out <= 0 {
            return Err(RouterError::InvalidAmount);
        }
        if token_in == token_out {
            return Err(RouterError::SameToken);
        }
        if segments.is_empty() {
            return Err(RouterError::InvalidRoute);
        }

        // Verify segments sum to total
        let mut segment_sum: i128 = 0;
        for i in 0..segments.len() {
            let seg = segments.get(i).unwrap();
            segment_sum += seg.amount_in;
        }
        if segment_sum != total_amount_in {
            return Err(RouterError::RouteMismatch);
        }

        // Transfer total token_in from user to this contract
        let token_in_client = token::Client::new(&env, &token_in);
        token_in_client.transfer(&user, &env.current_contract_address(), &total_amount_in);

        // Execute each segment
        let mut total_out: i128 = 0;

        for i in 0..segments.len() {
            let seg = segments.get(i).unwrap();

            // Look up venue adapter contract
            let venue_contract: Address = env
                .storage()
                .persistent()
                .get(&DataKey::Venue(seg.venue_id))
                .ok_or(RouterError::VenueNotFound)?;

            // Approve the venue adapter to spend our token_in
            token_in_client.approve(
                &env.current_contract_address(),
                &venue_contract,
                &seg.amount_in,
                &(env.ledger().sequence() + 100), // short-lived approval
            );

            // Cross-contract call to venue adapter's swap function.
            // Each adapter implements: swap(user, token_in, token_out, amount_in, min_out) -> i128
            let amount_received: i128 = env.invoke_contract(
                &venue_contract,
                &soroban_sdk::Symbol::new(&env, "swap"),
                soroban_sdk::vec![
                    &env,
                    env.current_contract_address().into_val(&env),
                    token_in.clone().into_val(&env),
                    token_out.clone().into_val(&env),
                    seg.amount_in.into_val(&env),
                    seg.min_amount_out.into_val(&env),
                ],
            );

            total_out += amount_received;
        }

        // Deduct protocol fee from total output
        let fee = Self::calculate_fee(total_out);
        let user_receives = total_out - fee;

        if user_receives < min_total_out {
            // This would revert the entire transaction
            return Err(RouterError::InsufficientOutput);
        }

        // Transfer output to user
        let token_out_client = token::Client::new(&env, &token_out);
        token_out_client.transfer(
            &env.current_contract_address(),
            &user,
            &user_receives,
        );

        // Transfer fee to vault
        if fee > 0 {
            let fee_vault: Address = env
                .storage()
                .instance()
                .get(&DataKey::FeeVault)
                .ok_or(RouterError::NotInitialized)?;
            token_out_client.transfer(
                &env.current_contract_address(),
                &fee_vault,
                &fee,
            );
        }

        log!(
            &env,
            "Route executed: in={}, out={}, fee={}, segments={}",
            total_amount_in,
            user_receives,
            fee,
            segments.len()
        );

        Ok(user_receives)
    }

    /// Simple single-venue swap. Backend picks the best venue.
    pub fn swap(
        env: Env,
        user: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_amount_out: i128,
        venue_id: u32,
    ) -> Result<i128, RouterError> {
        // Build a single-segment route and delegate
        let segment = RouteSegment {
            venue_id,
            amount_in,
            min_amount_out,
        };
        let segments = soroban_sdk::vec![&env, segment];
        Self::execute_route(
            env,
            user,
            token_in,
            token_out,
            amount_in,
            min_amount_out,
            segments,
        )
    }

    // ─── Query Functions ────────────────────────────────

    /// Get the contract address for a venue.
    pub fn get_venue(env: Env, venue_id: u32) -> Result<Address, RouterError> {
        env.storage()
            .persistent()
            .get(&DataKey::Venue(venue_id))
            .ok_or(RouterError::VenueNotFound)
    }

    /// Get all registered venue IDs.
    pub fn get_venues(env: Env) -> Vec<u32> {
        env.storage()
            .instance()
            .get(&DataKey::VenueIds)
            .unwrap_or(Vec::new(&env))
    }

    // ─── Internal ───────────────────────────────────────

    fn calculate_fee(amount: i128) -> i128 {
        (amount * FEE_NUMERATOR) / FEE_DENOMINATOR
    }

    fn require_admin(env: &Env, caller: &Address) -> Result<(), RouterError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(RouterError::NotInitialized)?;
        if *caller != admin {
            return Err(RouterError::Unauthorized);
        }
        Ok(())
    }
}
