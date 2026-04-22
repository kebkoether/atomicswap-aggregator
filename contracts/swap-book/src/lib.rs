#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    token, Address, Env, Vec, log,
};

/// Protocol fee: 0.5 basis points = 5 per 100,000
const FEE_NUMERATOR: i128 = 5;
const FEE_DENOMINATOR: i128 = 100_000;

/// Basis-point denominator for slippage calculations
const BPS_DENOMINATOR: i128 = 10_000;

// ─── Storage Keys ───────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    FeeVault,
    NextOrderId,
    Order(u64),
    /// Index of open order IDs for a token pair (token_in, token_out)
    PairIndex(Address, Address),
    /// Authorized router address (can claim timer-expired orders)
    Router,
    /// Oracle price for a directed pair, stored as (price_num, price_den)
    /// e.g. BTC/USDC = (62000, 1) meaning 1 BTC = 62,000 USDC
    OraclePrice(Address, Address),
    /// Authorized oracle updater address
    OracleAdmin,
}

// ─── Types ──────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum OrderStatus {
    Open,
    PartialFill,
    Filled,
    Cancelled,
    Expired,
    /// Timer expired — claimed by router for DEX execution
    Routed,
}

/// How the order's minimum output price is determined.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum PriceMode {
    /// Classic fixed-price order: maker sets an explicit min_amount_out.
    Fixed,
    /// Oracle-pegged order: at fill time the contract reads a stored oracle
    /// price and enforces that the taker's payment is within
    /// `max_slippage_bps` of fair value.
    Oracle,
}

/// Oracle price stored as a rational number (numerator / denominator)
/// to avoid floating-point. Example: 1 BTC = 62,000 USDC → (62000_0000000, 1_0000000)
/// when both assets have 7 decimals.
#[contracttype]
#[derive(Clone, Debug)]
pub struct OraclePriceData {
    /// price numerator (amount of token_out per unit of token_in)
    pub num: i128,
    /// price denominator
    pub den: i128,
    /// ledger sequence when this price was last updated
    pub updated_at: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Order {
    pub id: u64,
    pub maker: Address,
    pub token_in: Address,
    pub token_out: Address,
    pub amount_in: i128,
    pub amount_in_remaining: i128,
    /// For Fixed mode: the explicit minimum output.
    /// For Oracle mode: ignored at fill time (oracle price + slippage used instead).
    pub min_amount_out: i128,
    pub expiry: u32,
    pub status: OrderStatus,
    pub created_at: u32,
    /// Pricing strategy for this order
    pub price_mode: PriceMode,
    /// (Oracle mode only) maximum slippage tolerance in basis points
    /// e.g. 50 = 0.50%
    pub max_slippage_bps: u32,
    /// Ledger sequence after which the router may claim this order and
    /// execute it through DEX liquidity. 0 = no auto-route (sit forever).
    pub auto_route_after: u32,
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum SwapBookError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    OrderNotFound = 4,
    OrderNotOpen = 5,
    OrderExpired = 6,
    InsufficientOutput = 7,
    InvalidAmount = 8,
    FillExceedsRemaining = 9,
    SameToken = 10,
    OraclePriceNotSet = 11,
    OracleSlippageExceeded = 12,
    TimerNotExpired = 13,
    RouterNotSet = 14,
    OraclePriceStale = 15,
}

// ─── Contract ───────────────────────────────────────────

#[contract]
pub struct SwapBook;

#[contractimpl]
impl SwapBook {
    /// Initialize the contract with an admin, fee vault, and router address.
    pub fn initialize(
        env: Env,
        admin: Address,
        fee_vault: Address,
    ) -> Result<(), SwapBookError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(SwapBookError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::FeeVault, &fee_vault);
        env.storage().instance().set(&DataKey::NextOrderId, &1u64);
        Ok(())
    }

    /// Set the authorized router address (admin only).
    /// The router can claim timer-expired orders for DEX execution.
    pub fn set_router(env: Env, admin: Address, router: Address) -> Result<(), SwapBookError> {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(SwapBookError::NotInitialized)?;
        if admin != stored_admin {
            return Err(SwapBookError::Unauthorized);
        }
        env.storage().instance().set(&DataKey::Router, &router);
        Ok(())
    }

    /// Set the authorized oracle admin (contract admin only).
    pub fn set_oracle_admin(
        env: Env,
        admin: Address,
        oracle_admin: Address,
    ) -> Result<(), SwapBookError> {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(SwapBookError::NotInitialized)?;
        if admin != stored_admin {
            return Err(SwapBookError::Unauthorized);
        }
        env.storage()
            .instance()
            .set(&DataKey::OracleAdmin, &oracle_admin);
        Ok(())
    }

    /// Update an oracle price for a token pair. Only the oracle admin can call this.
    pub fn update_oracle_price(
        env: Env,
        caller: Address,
        token_in: Address,
        token_out: Address,
        price_num: i128,
        price_den: i128,
    ) -> Result<(), SwapBookError> {
        caller.require_auth();
        let oracle_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::OracleAdmin)
            .ok_or(SwapBookError::NotInitialized)?;
        if caller != oracle_admin {
            return Err(SwapBookError::Unauthorized);
        }

        let price = OraclePriceData {
            num: price_num,
            den: price_den,
            updated_at: env.ledger().sequence(),
        };
        env.storage()
            .persistent()
            .set(&DataKey::OraclePrice(token_in, token_out), &price);
        Ok(())
    }

    /// Place a new swap order.
    ///
    /// The maker authorizes the contract to hold `amount_in` of `token_in`.
    /// The order sits in the book until a taker fills it, it expires, or
    /// the maker cancels.
    ///
    /// `price_mode`: 0 = Fixed (uses min_amount_out), 1 = Oracle (uses live price)
    /// `max_slippage_bps`: only relevant for Oracle mode — max slippage tolerance
    /// `auto_route_after`: ledger sequence after which router can claim for DEX.
    ///                     0 = no auto-route (sit on book until expiry).
    pub fn place_order(
        env: Env,
        maker: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_amount_out: i128,
        expiry: u32,
        price_mode: u32,
        max_slippage_bps: u32,
        auto_route_after: u32,
    ) -> Result<u64, SwapBookError> {
        maker.require_auth();

        if amount_in <= 0 {
            return Err(SwapBookError::InvalidAmount);
        }

        let mode = if price_mode == 1 {
            PriceMode::Oracle
        } else {
            PriceMode::Fixed
        };

        // For Fixed mode, min_amount_out must be > 0.
        // For Oracle mode, min_amount_out can be 0 (oracle determines price).
        if mode == PriceMode::Fixed && min_amount_out <= 0 {
            return Err(SwapBookError::InvalidAmount);
        }

        if token_in == token_out {
            return Err(SwapBookError::SameToken);
        }
        if expiry <= env.ledger().sequence() {
            return Err(SwapBookError::OrderExpired);
        }

        // If Oracle mode, verify that an oracle price exists for this pair
        if mode == PriceMode::Oracle {
            let price_key = DataKey::OraclePrice(token_in.clone(), token_out.clone());
            if !env.storage().persistent().has(&price_key) {
                return Err(SwapBookError::OraclePriceNotSet);
            }
        }

        // Validate auto_route_after is in the future (if set)
        if auto_route_after > 0 && auto_route_after <= env.ledger().sequence() {
            return Err(SwapBookError::InvalidAmount);
        }

        // Transfer token_in from maker to this contract (escrow)
        let token_client = token::Client::new(&env, &token_in);
        token_client.transfer(&maker, &env.current_contract_address(), &amount_in);

        // Generate order ID
        let order_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextOrderId)
            .unwrap_or(1u64);
        env.storage()
            .instance()
            .set(&DataKey::NextOrderId, &(order_id + 1));

        // Create order
        let order = Order {
            id: order_id,
            maker: maker.clone(),
            token_in: token_in.clone(),
            token_out: token_out.clone(),
            amount_in,
            amount_in_remaining: amount_in,
            min_amount_out,
            expiry,
            status: OrderStatus::Open,
            created_at: env.ledger().sequence(),
            price_mode: mode,
            max_slippage_bps,
            auto_route_after,
        };

        // Store order
        env.storage()
            .persistent()
            .set(&DataKey::Order(order_id), &order);

        // Add to pair index
        let pair_key = DataKey::PairIndex(token_in.clone(), token_out.clone());
        let mut order_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&pair_key)
            .unwrap_or(Vec::new(&env));
        order_ids.push_back(order_id);
        env.storage().persistent().set(&pair_key, &order_ids);

        log!(&env, "Order placed: id={}, amount_in={}, mode={}", order_id, amount_in, price_mode);

        Ok(order_id)
    }

    /// Cancel an open order. Only the maker can cancel.
    /// Returns escrowed tokens to the maker.
    pub fn cancel_order(env: Env, maker: Address, order_id: u64) -> Result<(), SwapBookError> {
        maker.require_auth();

        let mut order: Order = env
            .storage()
            .persistent()
            .get(&DataKey::Order(order_id))
            .ok_or(SwapBookError::OrderNotFound)?;

        if order.maker != maker {
            return Err(SwapBookError::Unauthorized);
        }
        if order.status != OrderStatus::Open && order.status != OrderStatus::PartialFill {
            return Err(SwapBookError::OrderNotOpen);
        }

        // Return remaining escrowed tokens to maker
        let token_client = token::Client::new(&env, &order.token_in);
        token_client.transfer(
            &env.current_contract_address(),
            &maker,
            &order.amount_in_remaining,
        );

        order.status = OrderStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Order(order_id), &order);

        // Remove from pair index
        Self::remove_from_pair_index(&env, &order.token_in, &order.token_out, order_id);

        log!(&env, "Order cancelled: id={}", order_id);

        Ok(())
    }

    /// Fill an order completely. The taker provides `amount_out` of token_out,
    /// and receives the maker's escrowed token_in.
    ///
    /// For Fixed-price orders: amount_out must meet the maker's min_amount_out.
    /// For Oracle-pegged orders: amount_out must be within max_slippage_bps of
    /// the current oracle fair value.
    ///
    /// Protocol fee (0.5 bps) is deducted from the taker's payment before
    /// forwarding to the maker.
    pub fn fill_order(
        env: Env,
        taker: Address,
        order_id: u64,
        amount_out: i128,
    ) -> Result<(), SwapBookError> {
        taker.require_auth();

        let mut order: Order = env
            .storage()
            .persistent()
            .get(&DataKey::Order(order_id))
            .ok_or(SwapBookError::OrderNotFound)?;

        if order.status != OrderStatus::Open && order.status != OrderStatus::PartialFill {
            return Err(SwapBookError::OrderNotOpen);
        }
        if env.ledger().sequence() > order.expiry {
            order.status = OrderStatus::Expired;
            env.storage()
                .persistent()
                .set(&DataKey::Order(order_id), &order);
            return Err(SwapBookError::OrderExpired);
        }

        // ── Price validation ────────────────────────────────
        Self::validate_fill_price(
            &env,
            &order,
            order.amount_in_remaining, // full fill
            amount_out,
        )?;

        // Calculate fee
        let fee = Self::calculate_fee(amount_out);
        let maker_receives = amount_out - fee;

        // Transfer token_out from taker
        let token_out_client = token::Client::new(&env, &order.token_out);

        // Taker pays maker (minus fee)
        token_out_client.transfer(&taker, &order.maker, &maker_receives);

        // Taker pays fee to vault
        if fee > 0 {
            let fee_vault: Address = env
                .storage()
                .instance()
                .get(&DataKey::FeeVault)
                .ok_or(SwapBookError::NotInitialized)?;
            token_out_client.transfer(&taker, &fee_vault, &fee);
        }

        // Transfer escrowed token_in from contract to taker
        let token_in_client = token::Client::new(&env, &order.token_in);
        token_in_client.transfer(
            &env.current_contract_address(),
            &taker,
            &order.amount_in_remaining,
        );

        // Update order
        order.amount_in_remaining = 0;
        order.status = OrderStatus::Filled;
        env.storage()
            .persistent()
            .set(&DataKey::Order(order_id), &order);

        // Remove from pair index
        Self::remove_from_pair_index(&env, &order.token_in, &order.token_out, order_id);

        log!(&env, "Order filled: id={}, taker_paid={}", order_id, amount_out);

        Ok(())
    }

    /// Partially fill an order.
    ///
    /// `fill_amount_in` is the portion of the maker's token_in the taker wants.
    /// `amount_out` is what the taker pays in token_out.
    pub fn partial_fill(
        env: Env,
        taker: Address,
        order_id: u64,
        fill_amount_in: i128,
        amount_out: i128,
    ) -> Result<(), SwapBookError> {
        taker.require_auth();

        let mut order: Order = env
            .storage()
            .persistent()
            .get(&DataKey::Order(order_id))
            .ok_or(SwapBookError::OrderNotFound)?;

        if order.status != OrderStatus::Open && order.status != OrderStatus::PartialFill {
            return Err(SwapBookError::OrderNotOpen);
        }
        if env.ledger().sequence() > order.expiry {
            order.status = OrderStatus::Expired;
            env.storage()
                .persistent()
                .set(&DataKey::Order(order_id), &order);
            return Err(SwapBookError::OrderExpired);
        }
        if fill_amount_in > order.amount_in_remaining {
            return Err(SwapBookError::FillExceedsRemaining);
        }
        if fill_amount_in <= 0 || amount_out <= 0 {
            return Err(SwapBookError::InvalidAmount);
        }

        // ── Price validation ────────────────────────────────
        Self::validate_fill_price(&env, &order, fill_amount_in, amount_out)?;

        // Calculate fee
        let fee = Self::calculate_fee(amount_out);
        let maker_receives = amount_out - fee;

        // Transfer token_out from taker to maker (minus fee)
        let token_out_client = token::Client::new(&env, &order.token_out);
        token_out_client.transfer(&taker, &order.maker, &maker_receives);

        // Fee to vault
        if fee > 0 {
            let fee_vault: Address = env
                .storage()
                .instance()
                .get(&DataKey::FeeVault)
                .ok_or(SwapBookError::NotInitialized)?;
            token_out_client.transfer(&taker, &fee_vault, &fee);
        }

        // Transfer partial token_in from contract to taker
        let token_in_client = token::Client::new(&env, &order.token_in);
        token_in_client.transfer(
            &env.current_contract_address(),
            &taker,
            &fill_amount_in,
        );

        // Update order
        order.amount_in_remaining -= fill_amount_in;
        if order.amount_in_remaining == 0 {
            order.status = OrderStatus::Filled;
            Self::remove_from_pair_index(&env, &order.token_in, &order.token_out, order_id);
        } else {
            order.status = OrderStatus::PartialFill;
        }
        env.storage()
            .persistent()
            .set(&DataKey::Order(order_id), &order);

        log!(
            &env,
            "Order partial fill: id={}, filled={}, remaining={}",
            order_id,
            fill_amount_in,
            order.amount_in_remaining
        );

        Ok(())
    }

    // ─── Query Functions ────────────────────────────────

    /// Get a specific order by ID.
    pub fn get_order(env: Env, order_id: u64) -> Result<Order, SwapBookError> {
        env.storage()
            .persistent()
            .get(&DataKey::Order(order_id))
            .ok_or(SwapBookError::OrderNotFound)
    }

    /// Get all open order IDs for a token pair.
    pub fn get_orders(
        env: Env,
        token_in: Address,
        token_out: Address,
    ) -> Vec<u64> {
        let pair_key = DataKey::PairIndex(token_in, token_out);
        env.storage()
            .persistent()
            .get(&pair_key)
            .unwrap_or(Vec::new(&env))
    }

    /// Get the best available price (highest amount_out per unit of amount_in)
    /// from sitting orders for a given amount.
    pub fn get_best_offer(
        env: Env,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
    ) -> i128 {
        let order_ids = Self::get_orders(env.clone(), token_in.clone(), token_out.clone());
        let current_ledger = env.ledger().sequence();
        let mut best_out: i128 = 0;

        for i in 0..order_ids.len() {
            let order_id = order_ids.get(i).unwrap();
            if let Some(order) = env
                .storage()
                .persistent()
                .get::<DataKey, Order>(&DataKey::Order(order_id))
            {
                if order.status != OrderStatus::Open && order.status != OrderStatus::PartialFill {
                    continue;
                }
                if current_ledger > order.expiry {
                    continue;
                }

                // Calculate how much token_out this order can provide for amount_in
                let fillable = if amount_in <= order.amount_in_remaining {
                    amount_in
                } else {
                    order.amount_in_remaining
                };

                // Pro-rata output
                let output = Self::pro_rata_min_out(
                    order.min_amount_out,
                    order.amount_in,
                    fillable,
                );

                if output > best_out {
                    best_out = output;
                }
            }
        }

        best_out
    }

    // ─── Timer / Router Functions ──────────────────────

    /// Claim a timer-expired order. Only the authorized router can call this.
    ///
    /// When an order's `auto_route_after` ledger has passed, the router takes
    /// custody of the escrowed tokens and executes the swap through DEX
    /// liquidity on behalf of the maker.
    ///
    /// The router is responsible for executing the DEX swap and sending
    /// the proceeds (minus protocol fee) to the maker off-chain / in a
    /// separate transaction.
    pub fn claim_expired_timer(
        env: Env,
        router: Address,
        order_id: u64,
    ) -> Result<i128, SwapBookError> {
        router.require_auth();

        let stored_router: Address = env
            .storage()
            .instance()
            .get(&DataKey::Router)
            .ok_or(SwapBookError::RouterNotSet)?;
        if router != stored_router {
            return Err(SwapBookError::Unauthorized);
        }

        let mut order: Order = env
            .storage()
            .persistent()
            .get(&DataKey::Order(order_id))
            .ok_or(SwapBookError::OrderNotFound)?;

        if order.status != OrderStatus::Open && order.status != OrderStatus::PartialFill {
            return Err(SwapBookError::OrderNotOpen);
        }

        // Timer must be set and expired
        if order.auto_route_after == 0 {
            return Err(SwapBookError::TimerNotExpired);
        }
        if env.ledger().sequence() <= order.auto_route_after {
            return Err(SwapBookError::TimerNotExpired);
        }

        // Transfer remaining escrowed tokens to router for DEX execution
        let remaining = order.amount_in_remaining;
        let token_in_client = token::Client::new(&env, &order.token_in);
        token_in_client.transfer(
            &env.current_contract_address(),
            &router,
            &remaining,
        );

        // Mark order as routed
        order.amount_in_remaining = 0;
        order.status = OrderStatus::Routed;
        env.storage()
            .persistent()
            .set(&DataKey::Order(order_id), &order);

        // Remove from pair index
        Self::remove_from_pair_index(&env, &order.token_in, &order.token_out, order_id);

        log!(
            &env,
            "Order timer expired, claimed by router: id={}, amount={}",
            order_id,
            remaining
        );

        Ok(remaining)
    }

    /// Get all orders whose auto_route_after timer has expired.
    /// Used by the backend sweep job to find claimable orders.
    pub fn get_expired_timer_orders(
        env: Env,
        token_in: Address,
        token_out: Address,
    ) -> Vec<u64> {
        let order_ids = Self::get_orders(env.clone(), token_in, token_out);
        let current_ledger = env.ledger().sequence();
        let mut expired = Vec::new(&env);

        for i in 0..order_ids.len() {
            let order_id = order_ids.get(i).unwrap();
            if let Some(order) = env
                .storage()
                .persistent()
                .get::<DataKey, Order>(&DataKey::Order(order_id))
            {
                if (order.status == OrderStatus::Open
                    || order.status == OrderStatus::PartialFill)
                    && order.auto_route_after > 0
                    && current_ledger > order.auto_route_after
                {
                    expired.push_back(order_id);
                }
            }
        }

        expired
    }

    /// Read the current oracle price for a pair.
    pub fn get_oracle_price(
        env: Env,
        token_in: Address,
        token_out: Address,
    ) -> Result<(i128, i128, u32), SwapBookError> {
        let price: OraclePriceData = env
            .storage()
            .persistent()
            .get(&DataKey::OraclePrice(token_in, token_out))
            .ok_or(SwapBookError::OraclePriceNotSet)?;
        Ok((price.num, price.den, price.updated_at))
    }

    // ─── Internal Helpers ───────────────────────────────

    /// Validate that amount_out meets the order's price requirements.
    /// For Fixed mode: pro-rata min_amount_out check.
    /// For Oracle mode: oracle price ± max_slippage_bps check.
    fn validate_fill_price(
        env: &Env,
        order: &Order,
        fill_amount_in: i128,
        amount_out: i128,
    ) -> Result<(), SwapBookError> {
        match order.price_mode {
            PriceMode::Fixed => {
                let required_out = Self::pro_rata_min_out(
                    order.min_amount_out,
                    order.amount_in,
                    fill_amount_in,
                );
                if amount_out < required_out {
                    return Err(SwapBookError::InsufficientOutput);
                }
            }
            PriceMode::Oracle => {
                // Read oracle price
                let price: OraclePriceData = env
                    .storage()
                    .persistent()
                    .get(&DataKey::OraclePrice(
                        order.token_in.clone(),
                        order.token_out.clone(),
                    ))
                    .ok_or(SwapBookError::OraclePriceNotSet)?;

                // Oracle price must have been updated within 1000 ledgers (~83 min)
                if env.ledger().sequence() > price.updated_at + 1000 {
                    return Err(SwapBookError::OraclePriceStale);
                }

                // Fair value = fill_amount_in * (price.num / price.den)
                let fair_value = (fill_amount_in * price.num) / price.den;

                // Minimum acceptable = fair_value * (1 - max_slippage_bps / 10000)
                let slippage = order.max_slippage_bps as i128;
                let min_acceptable =
                    (fair_value * (BPS_DENOMINATOR - slippage)) / BPS_DENOMINATOR;

                if amount_out < min_acceptable {
                    return Err(SwapBookError::OracleSlippageExceeded);
                }
            }
        }
        Ok(())
    }

    /// Calculate the protocol fee (0.5 bps).
    fn calculate_fee(amount: i128) -> i128 {
        (amount * FEE_NUMERATOR) / FEE_DENOMINATOR
    }

    /// Calculate pro-rata minimum output for a partial fill.
    /// If the original order is 10,000 USDC → min 9,999.5 PYUSD,
    /// then filling 5,000 USDC requires min 4,999.75 PYUSD.
    fn pro_rata_min_out(
        total_min_out: i128,
        total_amount_in: i128,
        fill_amount_in: i128,
    ) -> i128 {
        (total_min_out * fill_amount_in) / total_amount_in
    }

    /// Remove an order ID from the pair index.
    fn remove_from_pair_index(
        env: &Env,
        token_in: &Address,
        token_out: &Address,
        order_id: u64,
    ) {
        let pair_key = DataKey::PairIndex(token_in.clone(), token_out.clone());
        if let Some(order_ids) = env
            .storage()
            .persistent()
            .get::<DataKey, Vec<u64>>(&pair_key)
        {
            let mut new_ids = Vec::new(env);
            for i in 0..order_ids.len() {
                let id = order_ids.get(i).unwrap();
                if id != order_id {
                    new_ids.push_back(id);
                }
            }
            env.storage().persistent().set(&pair_key, &new_ids);
        }
    }
}

#[cfg(test)]
mod test;
