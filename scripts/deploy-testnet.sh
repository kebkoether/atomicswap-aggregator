#!/bin/bash
# AtomicSwap Aggregator — Testnet Deployment Script
#
# Prerequisites:
#   1. Install Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
#   2. Install Stellar CLI: cargo install stellar-cli
#   3. Add WASM target: rustup target add wasm32-unknown-unknown
#   4. Fund a testnet account: stellar keys generate deployer --network testnet
#
# Usage: ./scripts/deploy-testnet.sh

set -e

NETWORK="testnet"
DEPLOYER="deployer"  # Stellar CLI key name

echo "═══════════════════════════════════════════════════"
echo "  AtomicSwap Aggregator — Testnet Deployment"
echo "═══════════════════════════════════════════════════"
echo ""

# Step 1: Build all contracts
echo "📦 Building contracts..."
cd contracts
cargo build --release --target wasm32-unknown-unknown
echo "   ✓ Contracts built"
echo ""

# Step 2: Optimize WASM files
echo "🔧 Optimizing WASM..."
for contract in swap-book router fee-vault; do
    stellar contract optimize \
        --wasm "target/wasm32-unknown-unknown/release/${contract//-/_}.wasm"
    echo "   ✓ ${contract} optimized"
done

for adapter in aqua_adapter sushiswap_adapter; do
    stellar contract optimize \
        --wasm "target/wasm32-unknown-unknown/release/${adapter}.wasm"
    echo "   ✓ ${adapter} optimized"
done
echo ""

# Step 3: Deploy FeeVault first (other contracts reference it)
echo "🚀 Deploying FeeVault..."
FEE_VAULT_ID=$(stellar contract deploy \
    --wasm target/wasm32-unknown-unknown/release/fee_vault.wasm \
    --source ${DEPLOYER} \
    --network ${NETWORK})
echo "   FeeVault: ${FEE_VAULT_ID}"

# Initialize FeeVault
ADMIN_ADDRESS=$(stellar keys address ${DEPLOYER})
stellar contract invoke \
    --id ${FEE_VAULT_ID} \
    --source ${DEPLOYER} \
    --network ${NETWORK} \
    -- initialize \
    --admin ${ADMIN_ADDRESS}
echo "   ✓ FeeVault initialized"
echo ""

# Step 4: Deploy SwapBook
echo "🚀 Deploying SwapBook..."
SWAPBOOK_ID=$(stellar contract deploy \
    --wasm target/wasm32-unknown-unknown/release/swap_book.wasm \
    --source ${DEPLOYER} \
    --network ${NETWORK})
echo "   SwapBook: ${SWAPBOOK_ID}"

# Initialize SwapBook
stellar contract invoke \
    --id ${SWAPBOOK_ID} \
    --source ${DEPLOYER} \
    --network ${NETWORK} \
    -- initialize \
    --admin ${ADMIN_ADDRESS} \
    --fee_vault ${FEE_VAULT_ID}
echo "   ✓ SwapBook initialized"
echo ""

# Step 5: Deploy venue adapters
echo "🚀 Deploying Aqua Adapter..."
AQUA_ADAPTER_ID=$(stellar contract deploy \
    --wasm target/wasm32-unknown-unknown/release/aqua_adapter.wasm \
    --source ${DEPLOYER} \
    --network ${NETWORK})
echo "   Aqua Adapter: ${AQUA_ADAPTER_ID}"

# Aqua testnet router (resets quarterly)
AQUA_TESTNET_ROUTER="CDGX6Q3ZZIDSX2N3SHBORWUIEG2ZZEBAAMYARAXTT7M5L6IXKNJMT3GB"
stellar contract invoke \
    --id ${AQUA_ADAPTER_ID} \
    --source ${DEPLOYER} \
    --network ${NETWORK} \
    -- initialize \
    --admin ${ADMIN_ADDRESS} \
    --aqua_router ${AQUA_TESTNET_ROUTER}
echo "   ✓ Aqua Adapter initialized"
echo ""

echo "🚀 Deploying SushiSwap Adapter..."
SUSHI_ADAPTER_ID=$(stellar contract deploy \
    --wasm target/wasm32-unknown-unknown/release/sushiswap_adapter.wasm \
    --source ${DEPLOYER} \
    --network ${NETWORK})
echo "   SushiSwap Adapter: ${SUSHI_ADAPTER_ID}"
echo "   ⚠ SushiSwap router address needed for initialization"
echo ""

# Step 6: Deploy Router
echo "🚀 Deploying Router..."
ROUTER_ID=$(stellar contract deploy \
    --wasm target/wasm32-unknown-unknown/release/router.wasm \
    --source ${DEPLOYER} \
    --network ${NETWORK})
echo "   Router: ${ROUTER_ID}"

# Initialize Router
stellar contract invoke \
    --id ${ROUTER_ID} \
    --source ${DEPLOYER} \
    --network ${NETWORK} \
    -- initialize \
    --admin ${ADMIN_ADDRESS} \
    --fee_vault ${FEE_VAULT_ID} \
    --swap_book ${SWAPBOOK_ID}

# Register venues
stellar contract invoke \
    --id ${ROUTER_ID} \
    --source ${DEPLOYER} \
    --network ${NETWORK} \
    -- register_venue \
    --admin ${ADMIN_ADDRESS} \
    --venue_id 1 \
    --contract_address ${AQUA_ADAPTER_ID}

stellar contract invoke \
    --id ${ROUTER_ID} \
    --source ${DEPLOYER} \
    --network ${NETWORK} \
    -- register_venue \
    --admin ${ADMIN_ADDRESS} \
    --venue_id 2 \
    --contract_address ${SUSHI_ADAPTER_ID}

echo "   ✓ Router initialized with 2 venues"
echo ""

# Step 7: Authorize SwapBook as fee depositor
stellar contract invoke \
    --id ${FEE_VAULT_ID} \
    --source ${DEPLOYER} \
    --network ${NETWORK} \
    -- authorize_depositor \
    --admin ${ADMIN_ADDRESS} \
    --depositor ${SWAPBOOK_ID}
echo "   ✓ SwapBook authorized as fee depositor"
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
echo "  Sushi Adapter:   ${SUSHI_ADAPTER_ID}"
echo ""
echo "  Admin:           ${ADMIN_ADDRESS}"
echo "  Network:         ${NETWORK}"
echo ""
echo "  Next steps:"
echo "  1. Copy contract IDs to backend/.env"
echo "  2. Initialize SushiSwap adapter with their router address"
echo "  3. Run: cd backend && npm install && npm run dev"
echo "  4. Run: cd frontend && npm install && npm run dev"
echo "═══════════════════════════════════════════════════"
