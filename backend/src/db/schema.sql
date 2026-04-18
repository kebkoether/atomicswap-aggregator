-- AtomicSwap Aggregator Database Schema
-- PostgreSQL

-- Orders index (mirrors on-chain SwapBook state for fast querying)
CREATE TABLE IF NOT EXISTS orders (
    id              BIGSERIAL PRIMARY KEY,
    order_id        BIGINT NOT NULL UNIQUE,       -- On-chain order ID
    maker           TEXT NOT NULL,                  -- Stellar address
    token_in        TEXT NOT NULL,                  -- SAC contract address
    token_out       TEXT NOT NULL,                  -- SAC contract address
    amount_in       NUMERIC(38, 0) NOT NULL,       -- Original amount (i128)
    amount_remaining NUMERIC(38, 0) NOT NULL,      -- Remaining amount
    min_amount_out  NUMERIC(38, 0) NOT NULL,       -- Minimum output
    expiry_ledger   BIGINT NOT NULL,               -- Expiry ledger sequence
    status          TEXT NOT NULL DEFAULT 'open',   -- open, partial_fill, filled, cancelled, expired
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW(),
    tx_hash         TEXT                            -- Transaction hash of placement
);

CREATE INDEX idx_orders_pair ON orders (token_in, token_out, status);
CREATE INDEX idx_orders_maker ON orders (maker, status);
CREATE INDEX idx_orders_status ON orders (status);

-- Swap history (all executed swaps)
CREATE TABLE IF NOT EXISTS swaps (
    id              BIGSERIAL PRIMARY KEY,
    order_id        BIGINT REFERENCES orders(order_id),  -- NULL if pure DEX route
    taker           TEXT NOT NULL,
    token_in        TEXT NOT NULL,
    token_out       TEXT NOT NULL,
    amount_in       NUMERIC(38, 0) NOT NULL,
    amount_out      NUMERIC(38, 0) NOT NULL,
    fee_amount      NUMERIC(38, 0) NOT NULL,
    route_type      TEXT NOT NULL,                  -- 'p2p', 'routed', 'split'
    venues_used     TEXT[],                         -- Array of venue names
    tx_hash         TEXT NOT NULL,
    ledger_sequence BIGINT NOT NULL,
    created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_swaps_taker ON swaps (taker);
CREATE INDEX idx_swaps_pair ON swaps (token_in, token_out);
CREATE INDEX idx_swaps_created ON swaps (created_at);

-- Route segments (details of each leg in a split route)
CREATE TABLE IF NOT EXISTS route_segments (
    id              BIGSERIAL PRIMARY KEY,
    swap_id         BIGINT REFERENCES swaps(id),
    venue_name      TEXT NOT NULL,
    venue_id        INTEGER NOT NULL,
    amount_in       NUMERIC(38, 0) NOT NULL,
    amount_out      NUMERIC(38, 0) NOT NULL,
    effective_bps   NUMERIC(10, 4) NOT NULL
);

CREATE INDEX idx_segments_swap ON route_segments (swap_id);

-- Fee tracking
CREATE TABLE IF NOT EXISTS fees (
    id              BIGSERIAL PRIMARY KEY,
    token           TEXT NOT NULL,
    amount          NUMERIC(38, 0) NOT NULL,
    swap_id         BIGINT REFERENCES swaps(id),
    withdrawn       BOOLEAN DEFAULT FALSE,
    withdrawn_at    TIMESTAMP,
    created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_fees_token ON fees (token, withdrawn);

-- Price snapshots (for analytics and historical pricing)
CREATE TABLE IF NOT EXISTS price_snapshots (
    id              BIGSERIAL PRIMARY KEY,
    token_in        TEXT NOT NULL,
    token_out       TEXT NOT NULL,
    venue_name      TEXT NOT NULL,
    price_bps       NUMERIC(10, 4) NOT NULL,       -- Cost in bps
    liquidity_depth NUMERIC(38, 0),                -- Available depth
    captured_at     TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_prices_pair ON price_snapshots (token_in, token_out, captured_at);
