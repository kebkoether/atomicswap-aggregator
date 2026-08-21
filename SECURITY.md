# Security

## Status

The contracts are **unaudited**. The protocol runs on mainnet as an
unannounced canary with intentionally small TVL; do not route size until an
external audit completes (tracked in README §"Known gaps").

Contracts are **not upgradeable** — there is no `update_current_contract_wasm`
path in any contract. What is deployed is what runs; fixes ship as new
deployments users opt into, and superseded addresses are listed in
[DEPLOYMENTS.md](./DEPLOYMENTS.md).

## Reporting a vulnerability

Email **hello@ufama.trade** with details and reproduction steps. Please do
not open a public GitHub issue for security reports or exploit the finding
against mainnet contracts beyond a minimal proof of concept. We aim to
acknowledge within 48 hours. No formal bounty program yet; good-faith
reports will be rewarded at our discretion.

## Key inventory

| Key | Role | Stored | Blast radius if compromised |
|---|---|---|---|
| Admin (`GB3BIN23…GMQT`) | Contract admin on all contracts + FeeVault withdrawals | `stellar` CLI keystore on the operator's machine — never on hosted infra | Venue registry + TWAP fee (≤ 10 bps cap) + accumulated fees. Cannot touch user escrow directly or change deployed code. See THREAT_MODEL.md T-ADM |
| Oracle admin | Pushes SwapBook oracle prices | Railway env (backend) | Oracle-mode orders only, bounded: 20% max jump per update, ~83 min staleness window, ≤ 10% user slippage. See T-ORC-1 |
| Keeper | Triggers TWAP slices / timer routes / expiries | Railway env (backend) | Its own gas balance (~20 XLM). All keeper entry points are permissionless and price-constrained on-chain |
| Integrator API keys | `/v1` API access | Railway env + each partner | That partner's API usage and fee routing |

Separation rule: no key that can move protocol or user funds lives on
hosted infrastructure. The admin key is the only fund-moving key
(FeeVault only), and it stays on the operator's machine.

## Operational hardening

- GitHub: 2FA enforced; changes land via pull request; Vercel and Railway
  deploy from `main` only.
- No secrets in the repository — only `.env.example` templates are tracked.
- CI runs contract tests, wasm build, `clippy`, `cargo audit`, and both
  frontend/backend typechecks on every PR.
- Every contract state change emits a typed event; venue registrations and
  fee changes are on-chain and monitorable.

## Threat model

The full STRIDE analysis against the dataflow diagram, including what each
compromised party can and cannot do, is in
[THREAT_MODEL.md](./THREAT_MODEL.md). The remediation plan for open items
is in [audit/REMEDIATION.md](./audit/REMEDIATION.md).
