#!/bin/bash
# Development Environment Setup
#
# Installs all dependencies and prepares the dev environment.

set -e

echo "Setting up AtomicSwap Aggregator development environment..."
echo ""

# Check prerequisites
echo "Checking prerequisites..."

if ! command -v rustc &> /dev/null; then
    echo "❌ Rust not found. Install: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
fi
echo "  ✓ Rust $(rustc --version | awk '{print $2}')"

if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Install: https://nodejs.org"
    exit 1
fi
echo "  ✓ Node.js $(node --version)"

if ! command -v stellar &> /dev/null; then
    echo "⚠ Stellar CLI not found. Installing..."
    cargo install stellar-cli
fi
echo "  ✓ Stellar CLI"

# Add WASM target
echo ""
echo "Adding WASM compilation target..."
rustup target add wasm32-unknown-unknown
echo "  ✓ wasm32-unknown-unknown target added"

# Install backend dependencies
echo ""
echo "Installing backend dependencies..."
cd backend
npm install
cd ..
echo "  ✓ Backend dependencies installed"

# Install frontend dependencies
echo ""
echo "Installing frontend dependencies..."
cd frontend
npm install
cd ..
echo "  ✓ Frontend dependencies installed"

# Build contracts
echo ""
echo "Building Soroban contracts..."
cd contracts
cargo build --release --target wasm32-unknown-unknown
cd ..
echo "  ✓ Contracts built"

# Create .env from example
if [ ! -f backend/.env ]; then
    cp backend/.env.example backend/.env
    echo ""
    echo "  ✓ Created backend/.env (edit with your contract IDs)"
fi

echo ""
echo "═══════════════════════════════════════"
echo "  Setup complete!"
echo "═══════════════════════════════════════"
echo ""
echo "  To start developing:"
echo "  1. Deploy to testnet:  ./scripts/deploy-testnet.sh"
echo "  2. Start backend:      cd backend && npm run dev"
echo "  3. Start frontend:     cd frontend && npm run dev"
echo ""
echo "  To run contract tests:"
echo "  cd contracts && cargo test"
