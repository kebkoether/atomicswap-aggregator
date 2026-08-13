# AtomicSwap Aggregator — Protocol Architecture

> **Note (Aug 2026):** this is the original design document. The protocol was
> security-hardened and several interfaces changed — contracts now use
> `__constructor` (no `initialize`), timer claims settle atomically via
> `Router.route_expired_order`, quoting is taker-direction via `quote_fill`,
> the protocol fee applies to total routed output (rounded up), and SolvBTC
> is not yet live on Stellar. Where this document disagrees with the code,
> **`contracts/` and [README.md](./README.md) are the source of truth**.

## Overview

AtomicSwap Aggregator is a peer-to-peer swap protocol on Stellar's Soroban smart contract platform. It combines a passive orderbook (users placing limit swaps that wait for counterparties) with smart order routing through Stellar DEXs when no counterparty is available.

**Core thesis**: Most stablecoin-to-stablecoin swaps on Stellar are near-parity trades. By letting users sit orders at 0.5 bps and matching them peer-to-peer via atomic swaps, we eliminate AMM slippage entirely for patient traders. Impatient traders get smart-routed through the best available DEX liquidity.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Frontend (Next.js)                   │
│  Swap UI · Order Status · LP Dashboard (Phase 2)        │
└─────────────┬───────────────────────────┬───────────────┘
              │ REST/WebSocket            │ Stellar SDK
              ▼                           ▼
┌─────────────────────────┐   ┌───────────────────────────┐
│    Backend (Node/TS)     │   │   Soroban Smart Contracts  │
│                          │   │                             │
│  · Order Matching Engine │   │  · SwapBook Contract        │
│  · Smart Router          │   │    (orderbook + matching)   │
│  · Price Feed Service    │   │                             │
│  · Venue Adapters:       │   │  · AtomicSwap Contract      │
│    - Aqua Adapter        │   │    (peer-to-peer settlement)│
│    - SushiSwap Adapter   │   │                             │
│    - Curve Adapter (TBD) │   │  · Router Contract          │
│    - [Pluggable]         │   │    (venue dispatch + split) │
│                          │   │                             │
│  · Fee Collection        │   │  · FeeVault Contract        │
│  · Yield Aggregator (v2) │   │    (fee accrual + withdraw) │
└─────────────┬───────────┘   └──────────────┬──────────────┘
              │                               │
              ▼                               ▼
┌─────────────────────────────────────────────────────────┐
│                   Stellar Network (Soroban)               │
│  Soroban RPC · Horizon API · SAC Token Contracts          │
└─────────────────────────────────────────────────────────┘
```

---

## Supported Assets (Phase 1)

| Asset   | Type                        | Stellar Status | SAC Available |
|---------|-----------------------------|----------------|---------------|
| USDC    | Stablecoin (Circle)         | Live           | Yes           |
| USDT0   | Stablecoin (Tether)         | Not yet live   | TBD           |
| PYUSD   | Stablecoin (PayPal)         | Live           | Yes           |
| USDY    | Yield-bearing (Ondo)        | Live           | Yes           |
| SolvBTC | BTC derivative (Solv)       | Not confirmed  | TBD           |

All live assets use the Stellar Asset Contract (SAC) pattern — classic Stellar assets automatically wrapped for Soroban smart contract use. No custom wrapper contracts needed.

**Known Stellar Asset Issuers:**
- USDC: `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`
- PYUSD: `GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5`
- USDY: Check [Ondo Finance docs](https://docs.ondo.finance/addresses) for Stellar contract

---

## Smart Contracts (Soroban / Rust)

### Contract 1: SwapBook

The core orderbook. Stores pending swap orders and handles matching.

```rust
/// A pending swap order
pub struct Order {
    pub id: u64,
    pub maker: Address,          // who placed the order
    pub token_in: Address,       // token the maker is selling (SAC address)
    pub token_out: Address,      // token the maker wants to buy
    pub amount_in: i128,         // amount selling
    pub min_amount_out: i128,    // minimum acceptable (enforces 0.5 bps spread)
    pub expiry: u64,             // ledger sequence expiry
    pub status: OrderStatus,     // Open, Filled, Cancelled, Expired
}

pub enum OrderStatus {
    Open,
    PartialFill,
    Filled,
    Cancelled,
    Expired,
}

/// SwapBook contract interface
pub trait SwapBookTrait {
    /// Place a new swap order. Maker authorizes token_in spend.
    fn place_order(
        env: Env,
        maker: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_amount_out: i128,
        expiry: u64,
    ) -> u64; // returns order_id

    /// Cancel an open order. Only the maker can cancel.
    fn cancel_order(env: Env, maker: Address, order_id: u64);

    /// Fill an order (called by taker or by Router contract).
    /// Executes atomic swap between maker and taker.
    fn fill_order(
        env: Env,
        taker: Address,
        order_id: u64,
        amount_out: i128,  // amount taker is providing
    );

    /// Partial fill — fill a portion of an order
    fn partial_fill(
        env: Env,
        taker: Address,
        order_id: u64,
        fill_amount_in: i128,   // portion of maker's token_in being taken
        amount_out: i128,       // taker's payment for that portion
    );

    /// Query: get all open orders for a token pair
    fn get_orders(
        env: Env,
        token_in: Address,
        token_out: Address,
    ) -> Vec<Order>;

    /// Query: get best available price for a token pair
    fn get_best_price(
        env: Env,
        token_in: Address,
        token_out: Address,
        amount: i128,
    ) -> i128;
}
```

**Key design decisions:**
- Orders are stored on-chain with SAC token allowances (maker pre-authorizes the contract to spend their tokens)
- Partial fills supported — critical for the router splitting across venues
- 0.5 bps fee is embedded in `min_amount_out` calculation by the frontend/backend
- Expiry uses ledger sequence numbers (roughly 5-6 seconds per ledger on Stellar)

### Contract 2: Router

Dispatches swaps across the orderbook and external DEX venues. This is where the smart routing happens on-chain.

```rust
/// A venue the router knows about
pub enum Venue {
    SwapBook,           // Our own orderbook
    AquaAMM,           // Aquarius AMM
    SushiSwapV3,       // SushiSwap concentrated liquidity
    // Future: Curve, etc.
}

/// A route segment — one leg of a split order
pub struct RouteSegment {
    pub venue: Venue,
    pub amount_in: i128,
    pub min_amount_out: i128,
    pub venue_contract: Address,
}

/// Router contract interface
pub trait RouterTrait {
    /// Register a venue adapter (admin only)
    fn register_venue(
        env: Env,
        admin: Address,
        venue: Venue,
        contract_address: Address,
    );

    /// Remove a venue (admin only)
    fn remove_venue(env: Env, admin: Address, venue: Venue);

    /// Execute a routed swap across multiple venues.
    /// The route is computed off-chain by the backend and passed in.
    fn execute_route(
        env: Env,
        user: Address,
        token_in: Address,
        token_out: Address,
        total_amount_in: i128,
        min_total_out: i128,
        segments: Vec<RouteSegment>,
    );

    /// Simple swap — backend picks best single venue
    fn swap(
        env: Env,
        user: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_amount_out: i128,
    );
}
```

**Key design decisions:**
- Route computation happens off-chain (backend), execution happens on-chain (contract)
- This is the standard DEX aggregator pattern (1inch, Paraswap all do this) — computing routes on-chain is too expensive
- The router contract verifies the route meets `min_total_out` even if individual segments shift
- Venue registration is admin-controlled — adding Curve later is just `register_venue()`
- Each venue needs an adapter contract that normalizes the swap interface

### Contract 3: FeeVault

Collects the 0.5 bps protocol fee and allows admin withdrawal for operations.

```rust
pub trait FeeVaultTrait {
    /// Deposit fees (called by Router after each swap)
    fn deposit(env: Env, token: Address, amount: i128);

    /// Withdraw accumulated fees (admin only)
    fn withdraw(env: Env, admin: Address, token: Address, amount: i128, to: Address);

    /// Query fee balance for a token
    fn get_balance(env: Env, token: Address) -> i128;
}
```

### Contract 4: Venue Adapters

Each external DEX needs a thin adapter contract that normalizes the interface.

```rust
/// Standard interface every venue adapter must implement
pub trait VenueAdapterTrait {
    /// Get a quote: how much token_out for amount_in of token_in?
    fn quote(
        env: Env,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
    ) -> i128;

    /// Execute a swap through this venue
    fn swap(
        env: Env,
        user: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_amount_out: i128,
    ) -> i128; // returns actual amount_out
}
```

**Aqua Adapter** calls into:
- Router Contract: `CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK`
- API for quotes: `https://amm-api.aqua.network/api/external/v1`

**SushiSwap V3 Adapter** calls into:
- SushiSwap V3 contracts on Stellar (contract addresses TBD — need to look up their deployment)

**Curve Adapter** (future):
- Not yet deployed on Stellar. Adapter interface is ready; plug in when live.

---

## Smart Order Routing (Backend)

The routing engine is the brain of the protocol. It runs off-chain and computes optimal split routes.

### Routing Algorithm

```
Input: token_in, token_out, amount_in, user_slippage_tolerance

1. QUERY all venues for quotes at increasing depth levels:
   
   For each venue (SwapBook, Aqua, SushiSwap):
     - Quote $100 tranche  → price_1
     - Quote $1,000 tranche → price_2
     - Quote $10,000 tranche → price_3
     - Quote remaining → price_4
   
2. BUILD price curve for each venue:
   (Maps amount → marginal price at that depth)

3. OPTIMIZE split:
   Greedy fill from cheapest marginal price across all venues.
   
   Example for a $50,000 USDC→PYUSD swap:
   - $0-$5,000: SwapBook has a sitting order at 0.5 bps → fill there
   - $5,000-$20,000: Aqua pool is deepest, best price → fill there  
   - $20,000-$35,000: SushiSwap concentrated liquidity is tighter → fill there
   - $35,000-$50,000: Aqua still cheaper than SushiSwap at this depth → fill there

4. VERIFY total output ≥ user's min_amount_out

5. SUBMIT route to Router contract as Vec<RouteSegment>
```

### Architecture: Pluggable Venue Adapters

```typescript
// Each venue implements this interface
interface VenueAdapter {
  name: string;
  
  // Get a quote at a specific amount
  getQuote(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<Quote>;
  
  // Get quotes at multiple depth levels for routing optimization
  getDepthQuotes(
    tokenIn: string, 
    tokenOut: string, 
    amounts: bigint[]
  ): Promise<DepthQuote[]>;
  
  // Build the Soroban invocation for this venue's leg
  buildSwapInvocation(
    tokenIn: string,
    tokenOut: string, 
    amountIn: bigint,
    minAmountOut: bigint
  ): Promise<xdr.Operation>;
}

// Adding Curve later = implement this interface + register_venue on-chain
```

---

## Fee Model

| Fee Type       | Rate    | Collected By    | Notes                                      |
|----------------|---------|-----------------|---------------------------------------------|
| Protocol fee   | 0.5 bps | FeeVault        | Applied on all swaps (P2P and routed)       |
| Gas fee        | Variable| Stellar Network | ~100 stroops per contract call              |
| DEX fee        | Variable| Aqua/Sushi/etc  | Only on routed portions, passed to user     |

**0.5 bps = 0.005%**. On a $100,000 swap, that's $5.00.

For P2P matched swaps (maker ↔ taker via SwapBook), the user pays only:
- 0.5 bps protocol fee
- Stellar gas (~$0.01)
- No DEX/AMM fee

This is the value proposition: sit your order and save on DEX fees.

---

## User Flows

### Flow 1: Place a Swap Order (Patient Trader)

```
User → Frontend: "I want to swap 10,000 USDC for PYUSD"
Frontend → Backend: Check if any matching orders exist
Backend: No matching orders found
Frontend → User: "Place limit order at 0.5 bps? Or swap now via DEX?"
User: "Place limit order"
Frontend → Stellar: User signs tx authorizing SwapBook to spend 10,000 USDC
Frontend → SwapBook Contract: place_order(user, USDC, PYUSD, 10000, 9999.5, expiry)
                                                                    ↑ min_out = 10000 - 0.5bps
SwapBook: Order #42 created, stored on-chain
User: Waits for counterparty...
```

### Flow 2: Take an Order (Counterparty Arrives)

```
User B → Frontend: "I want to swap 10,000 PYUSD for USDC"
Frontend → Backend: Check matching orders
Backend: Found Order #42 (10,000 USDC → PYUSD at 0.5 bps)
Frontend → User B: "Match found! Swap at 0.5 bps (saves you ~0.3% vs Aqua)"
User B: "Take it"
Frontend → Stellar: User B signs tx authorizing SwapBook to spend 10,000 PYUSD
Frontend → SwapBook Contract: fill_order(user_b, order_id=42, amount_out=10000)
SwapBook: Atomic swap executes:
  - 10,000 USDC → User B
  - 9,999.5 PYUSD → User A (maker)
  - 0.5 PYUSD → FeeVault (protocol fee)
```

### Flow 3: Instant Swap via Smart Router (Impatient Trader)

```
User → Frontend: "Swap 50,000 USDC for PYUSD, now"
Frontend → Backend: Compute best route
Backend → Queries all venues:
  - SwapBook: 5,000 USDC available at 0.5 bps
  - Aqua: 30,000 USDC depth at 2 bps effective
  - SushiSwap: 25,000 USDC depth at 1.8 bps effective
Backend → Optimal split:
  - Leg 1: 5,000 via SwapBook (0.5 bps)
  - Leg 2: 25,000 via SushiSwap (1.8 bps)
  - Leg 3: 20,000 via Aqua (2 bps)
  - Blended rate: ~1.7 bps (better than any single venue)
Frontend → User: "Best route: blended 1.7 bps across 3 venues"
User: "Execute"
Frontend → Router Contract: execute_route(user, USDC, PYUSD, 50000, segments)
Router: Executes all legs atomically, collects 0.5 bps to FeeVault
```

---

## Phase 2: Yield Aggregation (Future)

### Concept

Users deposit their Aqua and SushiSwap LP tokens into a YieldVault contract. The protocol compounds rewards on their behalf, achieving better gas efficiency through batching.

### Why This Works

- Individual LP reward claims cost ~100 stroops each
- If the vault holds 100 users' LP positions, one claim + reinvest costs 100 stroops total instead of 10,000
- Compounding frequency can increase from daily (individual) to hourly (aggregated)

### Preliminary Contract Interface

```rust
pub trait YieldVaultTrait {
    /// Deposit LP tokens into the vault
    fn deposit(env: Env, user: Address, lp_token: Address, amount: i128);
    
    /// Withdraw LP tokens + accrued yield
    fn withdraw(env: Env, user: Address, lp_token: Address);
    
    /// Compound rewards for all depositors (called by keeper bot)
    fn compound(env: Env, keeper: Address, lp_token: Address);
    
    /// Query user's current position + accrued yield
    fn get_position(env: Env, user: Address, lp_token: Address) -> Position;
}
```

This will be built after Phase 1 is stable and has user traction.

---

## Tech Stack

| Layer            | Technology                     | Why                                             |
|------------------|--------------------------------|--------------------------------------------------|
| Smart Contracts  | Rust + Soroban SDK             | Required for Soroban                             |
| Backend          | Node.js + TypeScript           | Best Stellar SDK support (@stellar/stellar-sdk)  |
| Frontend         | Next.js + React                | SSR for SEO, API routes for backend              |
| Wallet Connect   | Freighter / WalletConnect      | Standard Stellar wallets                         |
| RPC              | mainnet.sorobanrpc.com         | Primary Soroban RPC endpoint                     |
| Horizon          | horizon.stellar.org            | Classic Stellar API for account/asset queries     |
| Database         | PostgreSQL                     | Order indexing, route caching, analytics          |
| Cache            | Redis                          | Price quote caching, rate limiting                |

### Key Dependencies

```json
{
  "@stellar/stellar-sdk": "^14.6.1",
  "next": "^14.x",
  "react": "^18.x",
  "pg": "^8.x",
  "redis": "^4.x"
}
```

---

## Project Structure

```
atomicswap-aggregator/
├── contracts/                    # Soroban smart contracts (Rust)
│   ├── swap-book/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs           # SwapBook contract
│   │       ├── order.rs         # Order types
│   │       └── test.rs          # Contract tests
│   ├── router/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs           # Router contract
│   │       ├── venue.rs         # Venue types
│   │       └── test.rs
│   ├── fee-vault/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs           # FeeVault contract
│   │       └── test.rs
│   ├── adapters/
│   │   ├── aqua/
│   │   │   └── src/lib.rs       # Aqua AMM adapter
│   │   └── sushiswap/
│   │       └── src/lib.rs       # SushiSwap V3 adapter
│   └── Cargo.toml               # Workspace Cargo.toml
│
├── backend/                      # Node.js/TypeScript backend
│   ├── src/
│   │   ├── server.ts            # Express/Fastify server
│   │   ├── router/
│   │   │   ├── engine.ts        # Smart routing engine
│   │   │   ├── optimizer.ts     # Split optimization algorithm
│   │   │   └── depth.ts         # Depth quote aggregation
│   │   ├── venues/
│   │   │   ├── adapter.ts       # VenueAdapter interface
│   │   │   ├── swapbook.ts      # Our orderbook adapter
│   │   │   ├── aqua.ts          # Aqua AMM adapter
│   │   │   ├── sushiswap.ts     # SushiSwap adapter
│   │   │   └── index.ts         # Venue registry
│   │   ├── matching/
│   │   │   ├── matcher.ts       # Order matching logic
│   │   │   └── orderbook.ts     # Off-chain order index
│   │   ├── stellar/
│   │   │   ├── client.ts        # Soroban RPC client
│   │   │   ├── contracts.ts     # Contract bindings
│   │   │   └── tokens.ts        # SAC token helpers
│   │   └── db/
│   │       ├── schema.sql       # PostgreSQL schema
│   │       └── queries.ts       # Database queries
│   ├── package.json
│   └── tsconfig.json
│
├── frontend/                     # Next.js frontend
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx         # Swap interface
│   │   │   ├── orders/
│   │   │   │   └── page.tsx     # My orders
│   │   │   └── layout.tsx
│   │   ├── components/
│   │   │   ├── SwapWidget.tsx   # Main swap component
│   │   │   ├── OrderBook.tsx    # Live orderbook display
│   │   │   ├── RoutePreview.tsx # Route visualization
│   │   │   └── WalletConnect.tsx
│   │   ├── hooks/
│   │   │   ├── useStellar.ts    # Stellar wallet hook
│   │   │   └── useSwap.ts      # Swap execution hook
│   │   └── lib/
│   │       ├── stellar.ts       # Stellar SDK setup
│   │       └── api.ts           # Backend API client
│   ├── package.json
│   └── next.config.js
│
├── scripts/
│   ├── deploy.sh                # Contract deployment script
│   └── setup-testnet.sh         # Testnet setup
│
└── README.md
```

---

## Deployment Plan

1. **Testnet first**: Deploy all contracts to Stellar testnet, test with Friendbot-funded accounts
2. **Testnet integration**: Connect to Aqua testnet router (`CDGX6Q3ZZIDSX2N3SHBORWUIEG2ZZEBAAMYARAXTT7M5L6IXKNJMT3GB`)
3. **Audit**: Smart contract security review before mainnet
4. **Mainnet deploy**: Deploy contracts, register Aqua mainnet venue, launch with limited asset list
5. **SushiSwap integration**: Add SushiSwap V3 adapter post-launch
6. **Curve integration**: When Curve deploys on Stellar, add adapter

---

## Open Questions

1. **SolveBTC**: Not confirmed on Stellar yet. Monitor for deployment announcements.
2. **USDT0**: Not live on Stellar yet. Asset contract address TBD.
3. **SushiSwap V3 contract addresses**: Need to find their specific Soroban deployment addresses for the adapter.
4. **Curve on Stellar**: No deployment announced. Adapter interface is ready; implementation blocked on their launch.
5. **MEV protection**: Stellar's consensus model (SCP) doesn't have MEV in the Ethereum sense, but front-running of orderbook fills is possible. Consider adding time-priority or sealed-bid mechanics.
6. **Order expiry gas**: Who pays gas to clean up expired orders? Options: lazy cleanup on next interaction, or a keeper bot.
