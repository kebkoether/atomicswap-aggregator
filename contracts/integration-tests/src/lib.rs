#![no_std]

//! Cross-contract integration tests for the Ufama protocol.
//!
//! Unlike the per-contract unit tests (which fake the FeeVault as a plain
//! address), these wire the REAL contracts together — SwapBook, Router,
//! TwapBook, and FeeVault — and drive complete lifecycles end to end:
//! escrow → execution → fee accrual in the vault → admin withdrawal.
//!
//! Run with `cargo test -p integration-tests` (or plain `cargo test` at the
//! workspace root — CI does the latter).

#[cfg(test)]
mod e2e;
