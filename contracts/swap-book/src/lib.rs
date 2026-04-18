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
    NextOrderId,
    Order(u64),
    /// Index of open order IDs for a token pair (token_in, token_out)
    PairIndex(Address, Address),
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
    pub min_amount_out: i128,
    pub expiry: u32,
    pub status: OrderStatus,
    pub created_at: u32,
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
}

// ─── Contract ───────────────────────────────────────────

#[contract]
pub struct SwapBook;

#[contractimpl]
impl SwapBook {
    /// Initialize the contract with an admin and fee vault address.
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

    /// Place a new swap order.
    ///
    /// The maker authorizes the contract to hold `amount_in` of `token_in`.
    /// The order sits in the book until a taker fills it, it expires, or
    /// the maker cancels.
    pub fn place_order(
        env: Env,
        maker: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_amount_out: i128,
        expiry: u32,
    ) -> Result<u64, SwapBookError> {
        maker.require_auth();

        if amount_in <= 0 || min_amount_out <= 0 {
            return Err(SwapBookError::InvalidAmount);
        }
        if token_in == token_out {
            return Err(SwapBookError::SameToken);
        }
        if expiry <= env.ledger().sequence() {
            return Err(SwapBookError::OrderExpired);
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

        log!(&env, "Order placed: id={}, amount_in={}", order_id, amount_in);

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

        // Calculate pro-rata min_amount_out for full fill
        let required_out = Self::pro_rata_min_out(
            order.min_amount_out,
            order.amount_in,
            order.amount_in_remaining,
        );
        if amount_out < required_out {
            return Err(SwapBookError::InsufficientOutput);
        }

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

        // Check that amount_out meets the pro-rata minimum
        let required_out = Self::pro_rata_min_out(
            order.min_amount_out,
            order.amount_in,
            fill_amount_in,
        );
        if amount_out < required_out {
            return Err(SwapBookError::InsufficientOutput);
        }

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

    // ─── Internal Helpers ───────────────────────────────

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
