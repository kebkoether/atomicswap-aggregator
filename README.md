# AtomicSwap Aggregator

Peer-to-peer swap protocol + DEX aggregator on Stellar (Soroban). Users sit
limit orders on an on-chain orderbook (SwapBook) and match peer-to-peer at
0.5 bps; impatient flow gets smart-routed across DEX venues (Aqua, SDEX,
SushiSwap-on-Stellar pending ABI verification) by an off-chain routing
engine, executed atomically by the on-chain Router.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the original design document.
Where the two disagree, **the contracts are the source of truth** — the
protocol was security-hardened in Aug 2026 and several interfaces changed.

## Repo layout

```
contracts/            Soroban contracts (Rust, soroban-sdk 27)
  swap-book/          On-chain orderbook: escrow, fills, oracle pricing, timers
  router/             Multi-venue route execution + permissionless keeper entry
  twap-book/          TWAP orders: escrowed schedules, keeper-run slices with
                      on-chain pace/price/cadence enforcement
  fee-vault/          Protocol fee custody (balance-based, no shadow accounting)
  adapters/aqua/      Aquarius adapter (real swap_chained ABI, pool registry)
  adapters/sushiswap/ ⚠️ placeholder ABI — do not deploy/register yet
backend/              Express + @stellar/stellar-sdk: quotes, routing, tx building,
                      keeper sweep, oracle price pusher
frontend/             Next.js + Freighter (v6 API), network-guarded signing
scripts/              Testnet deployment
```

## Security model (the important parts)

- **Atomic timer routing.** When a sitting order's auto-route timer fires,
  `Router.route_expired_order(order_id, segments)` claims the escrow,
  executes the DEX route, and pays the maker **in one invocation**, enforcing
  the maker's own price floor (`min_out`) on-chain. The keeper key that
  triggers it is permissionless and holds no custody — anyone can run one.
- **Fills round against the taker.** Pro-rata minimums and protocol fees use
  ceiling division (256-bit intermediates) — dust fills can't round the
  required payment to zero and no fill is fee-free.
- **Oracle hardening.** Oracle-pegged orders use an admin-pushed price that
  must be positive, fresh (< ~83 min), and within 20% of the previous price
  per update — bounding the damage of a compromised oracle key. Slippage
  tolerance is capped at 10%. For mainnet, migrate to a SEP-40 oracle
  (e.g. Reflector) instead of the CoinGecko pusher.
- **Constructors, not initializers.** All contracts take their admin via
  `__constructor` at deploy time — no init front-running window.
- **FeeVault balances are token balances.** Withdrawals check the actual
  token balance; there is no shadow accounting to drift or strand fees.

## TWAP orders

A maker escrows a total amount plus a schedule (`place_twap`); a
permissionless keeper executes slices through the same venue adapters as
the Router. The contract — never the keeper — enforces:

- **Pace**: cumulative fill ≤ pro-rata schedule + a bounded catch-up band
- **Price**: each slice's net proceeds must clear the maker's limit price,
  or a fresh SwapBook oracle price ± slippage when no limit is set
- **Cadence**: a minimum ledger gap between slices

Proceeds stream to the maker every slice (net of the 0.5 bps fee). Cancel
refunds the remainder instantly; anyone can `expire_twap` a lapsed order
to trigger the refund. A malfunctioning keeper can only slow execution
down — never fill at a worse price. v2 roadmap: volume-adaptive slice
sizing (participation caps vs live venue volume) and P2P-book-first fills.

## Development

Contracts (Rust 1.85+, `wasm32v1-none` target):

```bash
cd contracts
cargo test                                   # 28 tests
cargo build --release --target wasm32v1-none # deployable wasm
```

Backend:

```bash
cd backend
cp .env.example .env   # fill in contract IDs after deploying
npm install
npm run dev            # http://localhost:3001/api/health
```

Frontend:

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev            # http://localhost:3000
```

Deploy to testnet: `./scripts/deploy-testnet.sh` (deploys FeeVault, SwapBook,
Aqua adapter, Router; wires `set_router`/`set_oracle_admin`; registers Aqua
as venue 1).

## Venue status

| Venue | ID | Quotes | On-chain execution |
|---|---|---|---|
| SwapBook (P2P) | 0 | `quote_fill` (taker-direction) | fill/partial_fill ops via peer-swap flow |
| Aqua | 1 | Aqua REST + pool `estimate_swap` | ✅ `swap_chained` via adapter (register pools with `set_pool`) |
| SushiSwap | 2 | ❌ placeholder | ❌ ABI unverified — do not register |
| Stellar DEX | 3 | Horizon path-finding (includes classic AMMs) | classic `path_payment` ops only — never in Router segments |

## Known gaps / next up

- **Aqua allowance pattern**: the adapter approves the Aqua router and calls
  `swap_chained`; verify on testnet whether Aqua pulls via allowance or needs
  `authorize_as_current_contract`, and adjust.
- **SushiSwap adapter**: confirm their Soroban router ABI + addresses, then
  replace the placeholder function names.
- **Peer-swap atomicity**: `/api/peer-swap/build` returns one transaction per
  fill + placement; collapse into a single multi-op transaction (or a
  `match_and_place` contract entry point) so the book can't move mid-plan.
- **SAC addresses**: populate `backend/src/stellar/tokens.ts` (USDC/PYUSD/
  USDY) via `stellar contract id asset`.
- **Indexer**: the Postgres schema in `backend/src/db/schema.sql` has no
  writer yet — consume the contract events (`order placed/filled/...`).
- **Audit** before mainnet.
