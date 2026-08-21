# Security Tooling Scans

Scan reports for the Soroban contract workspace (`contracts/`), run against
commit-of-record on 2026-08-21. Remediation for anything actionable:
[REMEDIATION.md](./REMEDIATION.md).

## cargo audit (RustSec advisory database)

Tool: `cargo-audit` (RustSec), 1,225 advisories loaded, 193 crate
dependencies scanned. **Also runs in CI on every PR.**

Result: **0 vulnerabilities.** Two informational warnings:

| Advisory | Crate | Status |
|---|---|---|
| RUSTSEC-2024-0436 (unmaintained) | `paste` 1.0.15 | Transitive dependency of `soroban-sdk` — no downstream action available; tracked in REMEDIATION #8 |
| yanked | `spin` 0.9.8 | Transitive dependency; same handling |

## cargo clippy

Tool: `clippy` (rustc 1.95.0), `--all-targets -- -D warnings` with three
documented allows. **Gates CI on every PR.**

Result: **clean** under the policy. The allows, and why they are policy
rather than suppressed findings:

| Lint | Reason |
|---|---|
| `clippy::too_many_arguments` | Contract entry points (`place_order`: 10 args, `place_twap`: 12) take flat argument lists by design — Soroban invocations have no builder pattern, and grouping into structs changes the external ABI |
| `clippy::inconsistent_digit_grouping` | Amount literals are grouped at Stellar's 7-decimal boundary (`10_000_0000000` = 10,000 units), which is intentional and more readable for stroop math |
| `deprecated` | `env.events().publish` is soft-deprecated in soroban-sdk 27 in favor of `#[contractevent]`. Migrating changes the on-chain event encoding, so it ships with the next contract deployment, not as a repo-only edit (REMEDIATION #9) |

## CoinFabrik Scout (Soroban static analyzer)

Tool: `cargo-scout-audit` — the Soroban-specific vulnerability detector
suite used in the Stellar ecosystem.

Report: [scout-report.md](./scout-report.md).

Result: **all seven workspace crates analyzed, 0 findings at every
severity** (critical / medium / minor / enhancement):

| Crate | Status | Critical | Medium | Minor | Enhancement |
|---|---|---|---|---|---|
| swap_book | Analyzed | 0 | 0 | 0 | 0 |
| router | Analyzed | 0 | 0 | 0 | 0 |
| twap_book | Analyzed | 0 | 0 | 0 | 0 |
| fee_vault | Analyzed | 0 | 0 | 0 | 0 |
| aqua_adapter | Analyzed | 0 | 0 | 0 | 0 |
| sushiswap_adapter | Analyzed | 0 | 0 | 0 | 0 |
| integration_tests | Analyzed | 0 | 0 | 0 | 0 |

Scout's detector families exercised include divide-before-multiply,
integer-overflow-or-underflow, unprotected-update-current-contract-wasm
(n/a — no upgrade entry points exist), unsafe-unwrap/expect,
set-contract-storage authorization, DoS patterns, and
soroban-version checks.

Transparency note: during the run, Scout's auxiliary
`wasm32-unknown-unknown` build pass fails by design — soroban-sdk 27's
build script rejects that legacy target outright (this workspace builds
wasm with `wasm32v1-none`). The host-side lint analysis is unaffected:
every crate reports status "Analyzed" and the tool exits 0.

## Reproducing

```bash
cd contracts
cargo audit
cargo clippy --all-targets -- -D warnings -A clippy::too-many-arguments -A clippy::inconsistent-digit-grouping -A deprecated
cargo scout-audit --output-format md --output-path ../audit/scout-report.md
```
