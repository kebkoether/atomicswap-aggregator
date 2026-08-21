# Ufama

**Live at [ufama.trade](https://ufama.trade)** · formerly "AtomicSwap Aggregator"

Swap protocol on Stellar (Soroban), three execution styles in one UI:

- **Instant swap** — smart order routing across Aqua, SushiSwap-on-Stellar,
  the Stellar DEX and classic AMMs. The router builds a marginal price
  curve per venue and splits big orders at the exact crossover points;
  when blending the SDEX book with AMMs beats any single route by more
  than the fee-aware gate, it automatically returns a two-transaction
  split plan (each leg min-out protected). Protocol fee: 0.5 bps.
- **P2P match** — sit a limit order on the on-chain SwapBook and match
  peer-to-peer at 0.5 bps, with an optional auto-route timer: if nobody
  fills you in N minutes, a permissionless keeper routes the escrow
  through the DEXes, your price floor enforced on-chain.
- **TWAP** — escrow a total and a schedule; a permissionless keeper
  executes slices with contract-enforced pace, price, and cadence.
  Fee: 10 bps, admin-settable but hard-capped on-chain at 10 bps.

Non-custodial throughout: users sign every transaction in their own
wallet (Freighter, xBull, LOBSTR, Albedo, Hana, Rabet via Stellar
Wallets Kit); contracts escrow funds and enforce prices on-chain.

**Integrators:** REST API (quote → build → your user signs → send) with
partner fee economics — see [INTEGRATORS.md](./INTEGRATORS.md) or
[ufama.trade/docs](https://ufama.trade/docs). Keys: hello@ufama.trade.

Mainnet contract addresses: [DEPLOYMENTS.md](./DEPLOYMENTS.md).
Architecture: [ARCHITECTURE.md](./ARCHITECTURE.md) ·
Threat model & dataflow diagram: [THREAT_MODEL.md](./THREAT_MODEL.md) ·
Keys & disclosure policy: [SECURITY.md](./SECURITY.md).

## Repo layout

```
contracts/            Soroban contracts (Rust, soroban-sdk 27)
  swap-book/          On-chain orderbook: escrow, fills, oracle pricing, timers
  router/             Multi-venue route execution + permissionless keeper entry
  twap-book/          TWAP orders: escrowed schedules, keeper-run slices with
                      on-chain pace/price/cadence enforcement (settable fee,
                      hard-capped 10 bps)
  fee-vault/          Protocol fee custody (balance-based, no shadow accounting)
  adapters/aqua/      Aquarius adapter (swap_chained, invoker-auth pattern)
  adapters/sushiswap/ SushiSwap V3 adapter (direct pool.swap — their router is
                      not callable from contracts)
backend/              Express + @stellar/stellar-sdk: quotes, split routing,
                      tx building, TWAP keeper, timer sweep, oracle pusher,
                      integrator API (/v1)
frontend/             Next.js + Stellar Wallets Kit, network-guarded signing
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
  tolerance is capped at 10%. Before public launch, migrate to a SEP-40
  oracle (e.g. Reflector) instead of the pusher.
- **Constructors, not initializers.** All contracts take their admin via
  `__constructor` at deploy time — no init front-running window.
- **FeeVault balances are token balances.** Withdrawals check the actual
  token balance; there is no shadow accounting to drift or strand fees.
- **TWAP fee ceiling is compile-time.** `set_fee` can lower or restore the
  rate within `MAX_FEE_PER_100K` (10 bps) but can never exceed it without
  deploying a new contract makers would have to opt into.

## TWAP orders

A maker escrows a total amount plus a schedule (`place_twap`); a
permissionless keeper executes slices through the same venue adapters as
the Router. The contract — never the keeper — enforces:

- **Pace**: cumulative fill ≤ pro-rata schedule + a bounded catch-up band
- **Price**: each slice's net proceeds must clear the maker's limit price,
  or a fresh SwapBook oracle price ± slippage when no limit is set
- **Cadence**: a minimum ledger gap between slices

Proceeds stream to the maker every slice (net of the fee). The keeper
tracks the pro-rata line mid-flight and enters an end-game mode near the
window close so orders complete in full (verified live: 100% fill).
Cancel refunds the remainder instantly; anyone can `expire_twap` a lapsed
order. A malfunctioning keeper can only slow execution down — never fill
at a worse price. v2 roadmap: volume-adaptive slice sizing and
P2P-book-first fills.

## Development

Contracts (Rust 1.85+, `wasm32v1-none` target):

```bash
cd contracts
cargo test
cargo build --release --target wasm32v1-none
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

Deploy to testnet: `./scripts/deploy-testnet.sh`.

## Venue status

| Venue | ID | Quotes | On-chain execution |
|---|---|---|---|
| SwapBook (P2P) | 0 | `quote_fill` (taker-direction) | fill/partial_fill via peer-swap flow |
| Aqua | 1 | Aqua REST + pool `estimate_swap` | ✅ `swap_chained` via adapter (mainnet-verified) |
| SushiSwap V3 | 2 | pool `slot0` spot | ✅ direct `pool.swap` via adapter (mainnet-verified) |
| Stellar DEX | 3 | Horizon path-finding (includes classic AMMs) | classic `path_payment` — standalone tx or blend leg, never a Router segment |

## Known gaps / next up

- **Peer-swap atomicity**: `/api/peer-swap/build` returns one transaction per
  fill + placement; add a `match_and_place` contract entry point so the book
  can't move mid-plan.
- **Reflector migration**: replace the admin-pushed oracle with SEP-40 reads
  before opening market orders to the public.
- **Router partner-fee split**: integrator `feeBps` collects on classic legs
  today; Soroban legs need a fee-split entry point in the Router.
- **Indexer**: the Postgres schema in `backend/src/db/schema.sql` has no
  writer yet — consume the contract events (`order placed/filled/...`).
- **Audit** before public launch.

## License

[Apache-2.0](./LICENSE).

## Contact

hello@ufama.trade — security reports: see [SECURITY.md](./SECURITY.md).
