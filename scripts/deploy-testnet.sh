#!/bin/bash
# AtomicSwap Aggregator — Testnet Deployment Script
#
# Prerequisites:
#   1. Install Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
#   2. Install Stellar CLI: cargo install stellar-cli
#   3. Add WASM target: rustup target add wasm32v1-none
#   4. Fund a testnet account: stellar keys generate deployer --network testnet --fund
#
# Contracts use __constructor (soroban-sdk 22+): constructor arguments are
# passed at deploy time after `--`. There is no separate initialize step,
# so deployment cannot be front-run.
#
# Usage: ./scripts/deploy-testnet.sh

set -e

NETWORK="testnet"
DEPLOYER="deployer"  # Stellar CLI key name
WASM_DIR="target/wasm32v1-none/release"

echo "═══════════════════════════════════════════════════"
echo "  AtomicSwap Aggregator — Testnet Deployment"
echo "═══════════════════════════════════════════════════"
echo ""

ADMIN_ADDRESS=$(stellar keys address ${DEPLOYER})
echo "  Deployer/admin: ${ADMIN_ADDRESS}"
echo ""

# Step 1: Build all contracts
echo "📦 Building contracts..."
cd contracts
cargo build --release --target wasm32v1-none
echo "   ✓ Contracts built"
echo ""

# Step 2: Optimize WASM files
echo "🔧 Optimizing WASM..."
for wasm in swap_book router fee_vault aqua_adapter; do
    stellar contract optimize --wasm "${WASM_DIR}/${wasm}.wasm"
    echo "   ✓ ${wasm} optimized"
done
echo ""

# Step 3: Deploy FeeVault first (other contracts reference it)
echo "🚀 Deploying FeeVault..."
FEE_VAULT_ID=$(stellar contract deploy \
    --wasm ${WASM_DIR}/fee_vault.wasm \
    --source ${DEPLOYER} \
    --network ${NETWORK} \
    -- \
    --admin ${ADMIN_ADDRESS})
echo "   FeeVault: ${FEE_VAULT_ID}"
echo ""

# Step 4: Deploy SwapBook
echo "🚀 Deploying SwapBook..."
SWAPBOOK_ID=$(stellar contract deploy \
    --wasm ${WASM_DIR}/swap_book.wasm \
    --source ${DEPLOYER} \
    --network ${NETWORK} \
    -- \
    --admin ${ADMIN_ADDRESS} \
    --fee_vault ${FEE_VAULT_ID})
echo "   SwapBook: ${SWAPBOOK_ID}"
echo ""

# Step 5: Deploy Aqua venue adapter
echo "🚀 Deploying Aqua Adapter..."
# Aqua testnet router (resets quarterly — verify at docs.aqua.network)
AQUA_TESTNET_ROUTER="CDGX6Q3ZZIDSX2N3SHBORWUIEG2ZZEBAAMYARAXTT7M5L6IXKNJMT3GB"
AQUA_ADAPTER_ID=$(stellar contract deploy \
    --wasm ${WASM_DIR}/aqua_adapter.wasm \
    --source ${DEPLOYER} \
    --network ${NETWORK} \
    -- \
    --admin ${ADMIN_ADDRESS} \
    --aqua_router ${AQUA_TESTNET_ROUTER})
echo "   Aqua Adapter: ${AQUA_ADAPTER_ID}"
echo "   ⚠ Register a pool per pair before trading:"
echo "     stellar contract invoke --id ${AQUA_ADAPTER_ID} ... -- set_pool \\"
echo "       --token_a <SAC> --token_b <SAC> --tokens '[...]' \\"
echo "       --pool_hash <hash> --pool_address <pool contract>"
echo ""

# NOTE: The SushiSwap adapter is NOT deployed. Its venue-side ABI is a
# placeholder — verify SushiSwap's actual Soroban router interface and
# addresses first, then deploy and register it as venue 2.

# Step 6: Deploy Router
echo "🚀 Deploying Router..."
ROUTER_ID=$(stellar contract deploy \
    --wasm ${WASM_DIR}/router.wasm \
    --source ${DEPLOYER} \
    --network ${NETWORK} \
    -- \
    --admin ${ADMIN_ADDRESS} \
    --fee_vault ${FEE_VAULT_ID} \
    --swap_book ${SWAPBOOK_ID})
echo "   Router: ${ROUTER_ID}"

# Step 7: Wire contracts together
# The Router CONTRACT is SwapBook's authorized claimant — timer claims are
# atomic (claim → route → pay maker) and the keeper key holds no custody.
stellar contract invoke \
    --id ${SWAPBOOK_ID} \
    --source ${DEPLOYER} \
    --network ${NETWORK} \
    -- set_router \
    --router ${ROUTER_ID}
echo "   ✓ SwapBook.set_router → Router contract"

# Oracle admin — use a dedicated key in production, not the deployer
stellar contract invoke \
    --id ${SWAPBOOK_ID} \
    --source ${DEPLOYER} \
    --network ${NETWORK} \
    -- set_oracle_admin \
    --oracle_admin ${ADMIN_ADDRESS}
echo "   ✓ SwapBook.set_oracle_admin"

# Register Aqua as venue 1
stellar contract invoke \
    --id ${ROUTER_ID} \
    --source ${DEPLOYER} \
    --network ${NETWORK} \
    -- register_venue \
    --venue_id 1 \
    --contract_address ${AQUA_ADAPTER_ID}
echo "   ✓ Router venue 1 = Aqua"
echo ""

# Summary
echo "═══════════════════════════════════════════════════"
echo "  Deployment Complete!"
echo "═══════════════════════════════════════════════════"
echo ""
echo "  FeeVault:        ${FEE_VAULT_ID}"
echo "  SwapBook:        ${SWAPBOOK_ID}"
echo "  Router:          ${ROUTER_ID}"
echo "  Aqua Adapter:    ${AQUA_ADAPTER_ID}"
echo ""
echo "  Admin:           ${ADMIN_ADDRESS}"
echo "  Network:         ${NETWORK}"
echo ""
echo "  Next steps:"
echo "  1. Copy contract IDs to backend/.env"
echo "  2. Register Aqua pools on the adapter (set_pool per pair)"
echo "  3. Populate SAC addresses in backend/src/stellar/tokens.ts"
echo "  4. Run: cd backend && npm install && npm run dev"
echo "  5. Run: cd frontend && npm install && npm run dev"
echo "═══════════════════════════════════════════════════"
