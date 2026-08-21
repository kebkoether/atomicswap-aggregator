# Remediation Plan

Open security-relevant items, consolidated from the
[threat model](../THREAT_MODEL.md) (T-xxx IDs) and the tooling scans in
[SCANS.md](./SCANS.md). Ordered by priority. "Gate" says what event each
item must precede.

| # | Item | Source | Priority | Gate | Status |
|---|---|---|---|---|---|
| 1 | Migrate SwapBook oracle to SEP-40 reads (Reflector) — retire the admin-pushed price and its residual key risk | T-ORC-1 | High | Public launch of oracle-priced market orders | Planned; oracle-mode paths remain disabled in the UI until done |
| 2 | Harden the admin key: hardware signer or multisig for the contract-admin account | T-ADM-1..3 | High | TVL growth / public launch | Planned; key currently lives only in the operator's local `stellar` CLI keystore |
| 3 | `match_and_place` entry point on SwapBook so peer-swap fill+place plans are atomic (today: one tx per step, book can move mid-plan) | T-CH / README gaps | Medium | Public launch | Planned (contract change → new deployment) |
| 4 | GitHub branch protection on `main`: require PR + passing CI, no force-push | T-FE-1 | Medium | Now | Open — one-time repo setting |
| 5 | Frontend-side independent quote sanity check (cross-check the backend's `min_out` against a second source before signing) | T-BE-1 | Medium | Public launch | Planned |
| 6 | Event indexer + alerting on admin-surface events (`venue register/remove`, `twap fee`, `fees withdraw`, `admin set`) | T-ADM-2 | Medium | Public launch | Planned — schema exists (`backend/src/db/schema.sql`), writer missing |
| 7 | JS supply-chain scanning (Dependabot / `npm audit` triage) for backend + frontend | T-FE-2 | Low | Ongoing | Open |
| 8 | RUSTSEC-2024-0436 (`paste` unmaintained) + yanked `spin 0.9.8` — transitive deps of `soroban-sdk` | cargo audit | Info | — | Tracked; no action available downstream, resolves with future soroban-sdk releases |
| 9 | Migrate `env.events().publish` to `#[contractevent]` types (deprecation in soroban-sdk 27) | clippy | Low | Post-audit | Deferred deliberately — changes the on-chain event encoding, so it ships with the next contract deployment, not as a repo-only edit |
| 10 | `cargo fmt` normalization of the workspace | hygiene | Low | Post-audit | Deferred to a dedicated PR so audit-facing diffs stay reviewable |

Resolved recently:

- Cross-contract integration test suite covering escrow → execution → fee
  accrual → withdrawal (`contracts/integration-tests`), run in CI.
- Clippy gate in CI (`-D warnings` with three documented allows).
- `cargo audit` in CI: 0 vulnerabilities as of 2026-08-21.
- Threat model + dataflow diagram (THREAT_MODEL.md), security policy
  (SECURITY.md), Apache-2.0 license, pinned Rust toolchain.
