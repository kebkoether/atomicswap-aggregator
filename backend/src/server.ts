/**
 * AtomicSwap Aggregator — Backend Server
 *
 * Express server providing:
 * - GET  /api/quote           — Get best route for an instant swap
 * - GET  /api/orders          — Get open orders for a token pair
 * - POST /api/swap/build      — Build an unsigned instant swap transaction
 * - POST /api/peer-swap/build — Build a peer swap (auto-match + escrow remainder)
 * - GET  /api/assets          — List supported assets
 * - GET  /api/health          — Health check
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { RoutingEngine } from './router/engine.js';
import { createVenueRegistry } from './venues/index.js';
import { StellarClient } from './stellar/client.js';
import { getLiveTokens, resolveToken, formatAmount } from './stellar/tokens.js';

const app = express();
app.use(cors({
  origin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',')
    : ['http://localhost:3000', 'http://localhost:3001'],
  credentials: true,
}));
app.use(express.json());

// ─── Configuration ──────────────────────────────────────

const config = {
  port: parseInt(process.env.PORT ?? '3001'),
  rpcUrl: process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org',
  networkPassphrase: process.env.NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015',
  swapbookContractId: process.env.SWAPBOOK_CONTRACT_ID ?? '',
  routerContractId: process.env.ROUTER_CONTRACT_ID ?? '',
  feeVaultContractId: process.env.FEE_VAULT_CONTRACT_ID ?? '',
  aquaAdapterContractId: process.env.AQUA_ADAPTER_CONTRACT_ID ?? '',
  aquaApiUrl: process.env.AQUA_API_URL ?? 'https://amm-api-testnet.aqua.network/api/external/v1',
  sushiAdapterContractId: process.env.SUSHI_ADAPTER_CONTRACT_ID ?? '',
  horizonUrl: process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
};

// ─── Supported Assets ───────────────────────────────────

const SUPPORTED_ASSETS = [
  { symbol: 'USDC', name: 'USD Coin', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', decimals: 7, status: 'live' },
  { symbol: 'PYUSD', name: 'PayPal USD', issuer: 'GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5', decimals: 7, status: 'live' },
  { symbol: 'USDY', name: 'Ondo US Dollar Yield', issuer: '', decimals: 7, status: 'live' },
  { symbol: 'USDT0', name: 'Tether USD', issuer: '', decimals: 7, status: 'coming_soon' },
  { symbol: 'SolvBTC', name: 'Solv BTC', issuer: '', decimals: 7, status: 'live' },
];

// ─── Initialize Services ────────────────────────────────

console.log('AtomicSwap Aggregator starting...');
console.log(`  RPC: ${config.rpcUrl}`);
console.log(`  Network: ${config.networkPassphrase}`);
console.log('');
console.log('Contracts:');
console.log(`  SwapBook: ${config.swapbookContractId || '(not set)'}`);
console.log(`  Router:   ${config.routerContractId || '(not set)'}`);
console.log(`  FeeVault: ${config.feeVaultContractId || '(not set)'}`);
console.log(`  Aqua:     ${config.aquaAdapterContractId || '(not set)'}`);
console.log(`  Sushi:    ${config.sushiAdapterContractId || '(not set)'}`);
console.log('');

const stellar = new StellarClient({
  rpcUrl: config.rpcUrl,
  networkPassphrase: config.networkPassphrase,
});

console.log('Registering venues:');
const registry = createVenueRegistry({
  swapbookContractId: config.swapbookContractId,
  aquaAdapterContractId: config.aquaAdapterContractId,
  aquaApiUrl: config.aquaApiUrl,
  sushiAdapterContractId: config.sushiAdapterContractId,
  horizonUrl: config.horizonUrl,
  rpcUrl: config.rpcUrl,
  networkPassphrase: config.networkPassphrase,
});
console.log('');

const routingEngine = new RoutingEngine(registry);

// ─── API Routes ─────────────────────────────────────────

/**
 * GET /api/assets
 */
app.get('/api/assets', (_req, res) => {
  res.json({ assets: SUPPORTED_ASSETS });
});

/**
 * GET /api/quote
 *
 * Query params:
 *   tokenIn   - SAC address or asset symbol
 *   tokenOut  - SAC address or asset symbol
 *   amountIn  - Amount in base units (7 decimals)
 *   slippage  - Max slippage in bps (default: 50)
 */
app.get('/api/quote', async (req, res) => {
  try {
    const { tokenIn, tokenOut, amountIn, slippage } = req.query;

    if (!tokenIn || !tokenOut || !amountIn) {
      res.status(400).json({ error: 'Missing required params: tokenIn, tokenOut, amountIn' });
      return;
    }

    console.log(`Quote request: ${amountIn} ${tokenIn} -> ${tokenOut}`);

    const route = await routingEngine.computeRoute(
      tokenIn as string,
      tokenOut as string,
      BigInt(amountIn as string),
      slippage ? parseInt(slippage as string) : undefined
    );

    res.json({
      tokenIn: route.tokenIn,
      tokenOut: route.tokenOut,
      amountIn: route.totalAmountIn.toString(),
      expectedOut: route.totalExpectedOut.toString(),
      netAmountOut: route.netAmountOut.toString(),
      protocolFee: route.protocolFee.toString(),
      swapBookAmountOut: route.swapBookAmountOut.toString(),
      blendedBps: route.blendedBps,
      segments: route.segments.map((s) => ({
        venue: s.venueName,
        venueId: s.venueId,
        amountIn: s.amountIn.toString(),
        expectedOut: s.expectedAmountOut.toString(),
        effectiveBps: s.effectiveBps,
      })),
      instructions: route.instructions.map((i) => ({
        venueContractId: i.venueContractId,
        venueId: i.venueId,
        amountIn: i.amountIn.toString(),
        minAmountOut: i.minAmountOut.toString(),
      })),
    });
  } catch (error) {
    console.error('Quote error:', error);
    res.status(500).json({ error: 'Failed to compute route' });
  }
});

/**
 * GET /api/orders
 */
app.get('/api/orders', async (req, res) => {
  try {
    const { tokenIn, tokenOut } = req.query;

    if (!tokenIn || !tokenOut) {
      res.status(400).json({ error: 'Missing required params: tokenIn, tokenOut' });
      return;
    }

    // Query SwapBook for open order IDs
    const orderIds = await stellar.simulateAndParse<number[]>(
      config.swapbookContractId,
      'get_orders',
      [
        StellarClient.toAddress(tokenIn as string),
        StellarClient.toAddress(tokenOut as string),
      ]
    );

    if (!orderIds || orderIds.length === 0) {
      res.json({ orders: [] });
      return;
    }

    // Fetch each order's details
    const orders = await Promise.all(
      orderIds.map(async (id) => {
        const order = await stellar.simulateAndParse<any>(
          config.swapbookContractId,
          'get_order',
          [StellarClient.toU64(id)]
        );
        return order;
      })
    );

    res.json({ orders: orders.filter(Boolean) });
  } catch (error) {
    console.error('Orders query error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

/**
 * GET /api/orders/user/:address
 *
 * Fetch all open orders placed by a specific wallet address.
 * Scans all live token pairs since on-chain storage is pair-indexed.
 */
app.get('/api/orders/user/:address', async (req, res) => {
  try {
    const userAddress = req.params.address;
    const liveAssets = SUPPORTED_ASSETS.filter((a) => a.status === 'live');

    // Build all pair permutations
    const pairs: Array<{ symbolIn: string; symbolOut: string }> = [];
    for (const a of liveAssets) {
      for (const b of liveAssets) {
        if (a.symbol !== b.symbol) {
          pairs.push({ symbolIn: a.symbol, symbolOut: b.symbol });
        }
      }
    }

    // Query each pair for order IDs, then fetch details, filter by maker
    const allOrders: any[] = [];

    await Promise.all(
      pairs.map(async (pair) => {
        try {
          const orderIds = await stellar.simulateAndParse<number[]>(
            config.swapbookContractId,
            'get_orders',
            [
              StellarClient.toAddress(pair.symbolIn),
              StellarClient.toAddress(pair.symbolOut),
            ]
          );

          if (!orderIds || orderIds.length === 0) return;

          const orders = await Promise.all(
            orderIds.map(async (id) => {
              const order = await stellar.simulateAndParse<any>(
                config.swapbookContractId,
                'get_order',
                [StellarClient.toU64(id)]
              );
              return order;
            })
          );

          for (const order of orders) {
            if (order && order.maker === userAddress) {
              allOrders.push({
                ...order,
                tokenInSymbol: pair.symbolIn,
                tokenOutSymbol: pair.symbolOut,
              });
            }
          }
        } catch {
          // Skip pairs that fail
        }
      })
    );

    res.json({ orders: allOrders });
  } catch (error) {
    console.error('User orders query error:', error);
    res.status(500).json({ error: 'Failed to fetch user orders' });
  }
});

/**
 * POST /api/orders/cancel
 *
 * Build an unsigned cancel_order transaction.
 *
 * Body:
 *   sourceAddress - User's Stellar address (must be the maker)
 *   orderId       - The order ID to cancel
 */
app.post('/api/orders/cancel', async (req, res) => {
  try {
    const { sourceAddress, orderId } = req.body;

    if (!sourceAddress || orderId === undefined) {
      res.status(400).json({ error: 'Missing required fields: sourceAddress, orderId' });
      return;
    }

    const xdr = await stellar.buildTransaction(
      sourceAddress,
      config.swapbookContractId,
      'cancel_order',
      [
        StellarClient.toAddress(sourceAddress),
        StellarClient.toU64(orderId),
      ]
    );

    res.json({ xdr });
  } catch (error) {
    console.error('Cancel order error:', error);
    res.status(500).json({ error: 'Failed to build cancel transaction' });
  }
});

/**
 * POST /api/swap/build
 * Build an unsigned transaction for a routed swap.
 *
 * Body:
 *   sourceAddress - User's Stellar address
 *   tokenIn, tokenOut - SAC addresses
 *   amountIn - Base units
 *   slippage - bps
 */
app.post('/api/swap/build', async (req, res) => {
  try {
    const { sourceAddress, tokenIn, tokenOut, amountIn, slippage } = req.body;

    if (!sourceAddress || !tokenIn || !tokenOut || !amountIn) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    // Compute route
    const route = await routingEngine.computeRoute(
      tokenIn,
      tokenOut,
      BigInt(amountIn),
      slippage ?? 50
    );

    // Build the Router.execute_route transaction
    const xdr = await stellar.buildTransaction(
      sourceAddress,
      config.routerContractId,
      'execute_route',
      [
        StellarClient.toAddress(sourceAddress),
        StellarClient.toAddress(tokenIn),
        StellarClient.toAddress(tokenOut),
        StellarClient.toI128(route.totalAmountIn),
        StellarClient.toI128(route.netAmountOut), // min_total_out
        // segments would need to be encoded as a Vec<RouteSegment> ScVal
        // This is complex — for now we return the route for frontend encoding
      ]
    );

    res.json({
      xdr,
      route: {
        totalAmountIn: route.totalAmountIn.toString(),
        netAmountOut: route.netAmountOut.toString(),
        blendedBps: route.blendedBps,
        segments: route.segments.map((s) => ({
          venue: s.venueName,
          venueId: s.venueId,
          amountIn: s.amountIn.toString(),
          expectedOut: s.expectedAmountOut.toString(),
        })),
      },
    });
  } catch (error) {
    console.error('Build swap error:', error);
    res.status(500).json({ error: 'Failed to build transaction' });
  }
});

/**
 * POST /api/peer-swap/build
 *
 * Build a Peer Swap transaction. This:
 *   1. Checks for matching orders on the reverse side (tokenOut → tokenIn)
 *   2. If matches exist, fills them (partial or full)
 *   3. Any remaining amount gets placed as a new sitting order
 *
 * All steps are bundled into one Stellar transaction so they
 * execute atomically on-chain.
 *
 * Body:
 *   sourceAddress - User's Stellar address
 *   tokenIn       - Token being sold (symbol or SAC address)
 *   tokenOut      - Token being bought (symbol or SAC address)
 *   amountIn      - Amount to sell (base units, 7 decimals)
 *   minAmountOut  - Minimum acceptable output (base units)
 *   expiry        - Ledger sequence at which unfilled remainder expires
 */
app.post('/api/peer-swap/build', async (req, res) => {
  try {
    const { sourceAddress, tokenIn, tokenOut, amountIn, minAmountOut, expiry } = req.body;

    if (!sourceAddress || !tokenIn || !tokenOut || !amountIn || !minAmountOut) {
      res.status(400).json({ error: 'Missing required fields: sourceAddress, tokenIn, tokenOut, amountIn, minAmountOut' });
      return;
    }

    const amountInBig = BigInt(amountIn);
    const minOutBig = BigInt(minAmountOut);

    // 1. Check reverse pair for sitting orders
    //    Someone selling tokenOut for tokenIn = a match for us
    const reverseOrderIds = await stellar.simulateAndParse<number[]>(
      config.swapbookContractId,
      'get_orders',
      [
        StellarClient.toAddress(tokenOut as string),
        StellarClient.toAddress(tokenIn as string),
      ]
    );

    interface MatchableOrder {
      id: number;
      amountInRemaining: bigint;
      minAmountOut: bigint;
      amountIn: bigint;
    }

    const matchableOrders: MatchableOrder[] = [];
    let totalFillable = 0n;

    if (reverseOrderIds && reverseOrderIds.length > 0) {
      // Fetch each reverse order's details
      for (const orderId of reverseOrderIds) {
        const order = await stellar.simulateAndParse<any>(
          config.swapbookContractId,
          'get_order',
          [StellarClient.toU64(orderId)]
        );

        if (order && (order.status === 'Open' || order.status === 'PartialFill')) {
          // This order is selling tokenOut, wanting tokenIn
          // Their amountInRemaining = how much tokenOut they're selling
          // Their minAmountOut (pro-rata) = how much tokenIn they want
          const remaining = BigInt(order.amount_in_remaining ?? order.amountInRemaining ?? '0');
          const totalMinOut = BigInt(order.min_amount_out ?? order.minAmountOut ?? '0');
          const totalIn = BigInt(order.amount_in ?? order.amountIn ?? '0');

          if (remaining > 0n && totalIn > 0n) {
            matchableOrders.push({
              id: orderId,
              amountInRemaining: remaining,
              minAmountOut: totalMinOut,
              amountIn: totalIn,
            });
            totalFillable += remaining; // total tokenOut available from reverse orders
          }
        }
      }
    }

    // 2. Determine how much we can fill vs how much sits
    let amountToFill = amountInBig; // how much of our tokenIn we can use to fill reverse orders
    let amountToSit = 0n;          // remainder that becomes a new order

    // Each reverse order wants tokenIn. We need to check if we have enough
    // tokenIn to satisfy their pro-rata min_amount_out.
    const fills: Array<{
      orderId: number;
      fillAmountIn: bigint;   // how much of the reverse order's tokenOut we take
      paymentOut: bigint;     // how much of our tokenIn we pay
    }> = [];

    for (const order of matchableOrders) {
      if (amountToFill <= 0n) break;

      // Pro-rata: this reverse order wants (minAmountOut * remaining / totalIn) of tokenIn
      const proRataMinOut = (order.minAmountOut * order.amountInRemaining) / order.amountIn;

      if (amountToFill >= proRataMinOut) {
        // We can satisfy this entire order
        fills.push({
          orderId: order.id,
          fillAmountIn: order.amountInRemaining,
          paymentOut: proRataMinOut,
        });
        amountToFill -= proRataMinOut;
      } else {
        // Partial fill: we can only afford part of this order
        // How much of their tokenOut can we get with our remaining tokenIn?
        const fillableFromOrder = (amountToFill * order.amountIn) / order.minAmountOut;
        if (fillableFromOrder > 0n) {
          fills.push({
            orderId: order.id,
            fillAmountIn: fillableFromOrder > order.amountInRemaining ? order.amountInRemaining : fillableFromOrder,
            paymentOut: amountToFill,
          });
          amountToFill = 0n;
        }
      }
    }

    amountToSit = amountToFill; // whatever couldn't be matched

    // 3. Calculate output summary
    const totalTokenOutFromFills = fills.reduce((sum, f) => sum + f.fillAmountIn, 0n);
    const totalTokenInUsedForFills = fills.reduce((sum, f) => sum + f.paymentOut, 0n);

    console.log(`Peer Swap: ${amountIn} ${tokenIn} -> ${tokenOut}`);
    console.log(`  Matching reverse orders: ${matchableOrders.length}`);
    console.log(`  Instant fills: ${fills.length} (${totalTokenOutFromFills} ${tokenOut} received for ${totalTokenInUsedForFills} ${tokenIn})`);
    console.log(`  Remainder to sit: ${amountToSit} ${tokenIn}`);

    // 4. Build the multi-operation transaction
    //    In Soroban, each contract call is a separate operation.
    //    The transaction contains: fill ops (if any) + place_order op (if remainder)
    //
    //    For now, we return the plan so the frontend can build it.
    //    (Building multi-op Soroban txns requires careful auth handling)

    const plan = {
      tokenIn,
      tokenOut,
      totalAmountIn: amountInBig.toString(),
      fills: fills.map((f) => ({
        orderId: f.orderId,
        youReceive: f.fillAmountIn.toString(),
        youPay: f.paymentOut.toString(),
        feesBps: 0.5,
      })),
      remainder: amountToSit > 0n ? {
        amountIn: amountToSit.toString(),
        minAmountOut: ((minOutBig * amountToSit) / amountInBig).toString(),
        expiry: expiry ?? null,
        status: 'will_escrow',
      } : null,
      summary: {
        instantFillAmount: totalTokenOutFromFills.toString(),
        instantFillCostBps: 0.5,
        escrowedAmount: amountToSit.toString(),
        totalTokenOutReceived: totalTokenOutFromFills.toString(),
      },
    };

    // If we can build a transaction, build it
    // For now, we return the plan + individual XDRs
    const xdrs: string[] = [];

    // Build fill transactions
    for (const fill of fills) {
      try {
        const fillXdr = await stellar.buildTransaction(
          sourceAddress,
          config.swapbookContractId,
          fill.fillAmountIn === matchableOrders.find(o => o.id === fill.orderId)!.amountInRemaining
            ? 'fill_order'
            : 'partial_fill',
          fill.fillAmountIn === matchableOrders.find(o => o.id === fill.orderId)!.amountInRemaining
            ? [
                StellarClient.toAddress(sourceAddress),
                StellarClient.toU64(fill.orderId),
                StellarClient.toI128(fill.paymentOut),
              ]
            : [
                StellarClient.toAddress(sourceAddress),
                StellarClient.toU64(fill.orderId),
                StellarClient.toI128(fill.fillAmountIn),
                StellarClient.toI128(fill.paymentOut),
              ]
        );
        xdrs.push(fillXdr);
      } catch (err) {
        console.warn(`Could not build fill tx for order ${fill.orderId}:`, err);
      }
    }

    // Build place_order for remainder
    if (amountToSit > 0n) {
      try {
        const proRataMinOut = (minOutBig * amountToSit) / amountInBig;
        const orderExpiry = expiry ?? 1_000_000; // ~46 days at 5s/ledger
        const placeXdr = await stellar.buildTransaction(
          sourceAddress,
          config.swapbookContractId,
          'place_order',
          [
            StellarClient.toAddress(sourceAddress),
            StellarClient.toAddress(tokenIn),
            StellarClient.toAddress(tokenOut),
            StellarClient.toI128(amountToSit),
            StellarClient.toI128(proRataMinOut),
            StellarClient.toU32(orderExpiry),
          ]
        );
        xdrs.push(placeXdr);
      } catch (err) {
        console.warn('Could not build place_order tx:', err);
      }
    }

    res.json({
      plan,
      xdrs, // Array of transaction XDRs to sign and submit in order
    });
  } catch (error) {
    console.error('Peer swap error:', error);
    res.status(500).json({ error: 'Failed to build peer swap' });
  }
});

/**
 * POST /api/swap/submit
 *
 * Submit a signed transaction XDR to the Stellar network.
 *
 * Body:
 *   signedXdr - The signed transaction XDR string
 */
app.post('/api/swap/submit', async (req, res) => {
  try {
    const { signedXdr } = req.body;

    if (!signedXdr) {
      res.status(400).json({ error: 'Missing required field: signedXdr' });
      return;
    }

    const result = await stellar.submitTransaction(signedXdr);
    res.json({ status: result.status, result });
  } catch (error) {
    console.error('Submit transaction error:', error);
    res.status(500).json({ error: 'Failed to submit transaction' });
  }
});

/**
 * GET /api/health
 */
app.get('/api/health', async (_req, res) => {
  const venues = await registry.getAvailable();
  res.json({
    status: 'ok',
    venues: venues.map((v) => v.name),
    contracts: {
      swapbook: config.swapbookContractId,
      router: config.routerContractId,
      feeVault: config.feeVaultContractId,
    },
    network: config.rpcUrl,
  });
});

// ─── Start Server ───────────────────────────────────────

app.listen(config.port, () => {
  console.log(`Server running on http://localhost:${config.port}`);
  console.log('');
  console.log('Endpoints:');
  console.log(`  GET  /api/health`);
  console.log(`  GET  /api/assets`);
  console.log(`  GET  /api/quote?tokenIn=...&tokenOut=...&amountIn=...`);
  console.log(`  GET  /api/orders?tokenIn=...&tokenOut=...`);
  console.log(`  POST /api/swap/build         — Build instant swap tx`);
  console.log(`  POST /api/peer-swap/build    — Build peer swap (auto-match + escrow remainder)`);
});

export default app;
