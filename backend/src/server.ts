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
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { RoutingEngine } from './router/engine.js';
import { createVenueRegistry } from './venues/index.js';
import { StellarClient, scEnum } from './stellar/client.js';
import { TOKENS, resolveSacAddress } from './stellar/tokens.js';
import { OraclePriceService } from './services/oracle.js';
import { TimerSweepService } from './services/timer-sweep.js';

const app = express();
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',')
    : ['http://localhost:3000', 'http://localhost:3001'],
  credentials: true,
}));
app.use(express.json({ limit: '100kb' }));
app.use(
  '/api/',
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120, // per IP per minute
    standardHeaders: true,
    legacyHeaders: false,
  })
);

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

/** Ledgers per second on Stellar (approx). */
const LEDGER_SECONDS = 5;
/** Default order lifetime if the caller doesn't pass an expiry (~7 days). */
const DEFAULT_EXPIRY_LEDGERS = Math.floor((7 * 24 * 3600) / LEDGER_SECONDS);

// ─── Input validation helpers ───────────────────────────

class BadRequest extends Error {}

function parseAmount(value: unknown, field: string): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new BadRequest(`${field} is required`);
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new BadRequest(`${field} must be an integer amount in base units`);
  }
  if (parsed <= 0n) throw new BadRequest(`${field} must be positive`);
  if (parsed > 10n ** 26n) throw new BadRequest(`${field} is implausibly large`);
  return parsed;
}

function parseSlippageBps(value: unknown, fallback = 50): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    throw new BadRequest('slippage must be an integer between 1 and 1000 bps');
  }
  return n;
}

function parseStellarAccount(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^G[A-Z2-7]{55}$/.test(value)) {
    throw new BadRequest(`${field} must be a Stellar account address`);
  }
  return value;
}

function resolveTokenParam(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequest(`${field} is required`);
  }
  try {
    return resolveSacAddress(value);
  } catch (err) {
    throw new BadRequest((err as Error).message);
  }
}

function handleError(res: express.Response, error: unknown, label: string): void {
  if (error instanceof BadRequest) {
    res.status(400).json({ error: error.message });
    return;
  }
  console.error(`${label}:`, error);
  res.status(500).json({ error: label });
}

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

// ─── Background Services ───────────────────────────────

const oracleService = new OraclePriceService({
  stellar,
  swapbookContractId: config.swapbookContractId,
  intervalMs: 5 * 60 * 1000, // 5 minutes
  oracleSecretKey: process.env.ORACLE_SECRET_KEY,
});
oracleService.start();

const timerSweep = new TimerSweepService({
  stellar,
  swapbookContractId: config.swapbookContractId,
  routerContractId: config.routerContractId,
  routingEngine,
  intervalMs: 60 * 1000, // 60 seconds
  keeperSecretKey: process.env.KEEPER_SECRET_KEY ?? process.env.ADMIN_SECRET_KEY,
});
timerSweep.start();

// ─── Shared order helpers ───────────────────────────────

interface ChainOrder {
  id: number;
  maker: string;
  status: string;
  amountIn: bigint;
  amountInRemaining: bigint;
  minAmountOut: bigint;
  expiry: number;
  priceMode: string;
  raw: any;
}

function normalizeOrder(raw: any): ChainOrder | null {
  if (!raw) return null;
  try {
    return {
      id: Number(raw.id),
      maker: String(raw.maker),
      status: scEnum(raw.status),
      amountIn: BigInt(raw.amount_in ?? 0),
      amountInRemaining: BigInt(raw.amount_in_remaining ?? 0),
      minAmountOut: BigInt(raw.min_amount_out ?? 0),
      expiry: Number(raw.expiry ?? 0),
      priceMode: scEnum(raw.price_mode),
      raw,
    };
  } catch {
    return null;
  }
}

function isOpen(order: ChainOrder): boolean {
  return order.status === 'Open' || order.status === 'PartialFill';
}

async function fetchOrdersForPair(
  tokenInSac: string,
  tokenOutSac: string
): Promise<ChainOrder[]> {
  const orderIds = await stellar.simulateAndParse<Array<number | bigint>>(
    config.swapbookContractId,
    'get_orders',
    [StellarClient.toAddress(tokenInSac), StellarClient.toAddress(tokenOutSac)]
  );
  if (!orderIds || orderIds.length === 0) return [];

  const orders = await Promise.all(
    orderIds.map((id) =>
      stellar.simulateAndParse<any>(config.swapbookContractId, 'get_order', [
        StellarClient.toU64(BigInt(id)),
      ])
    )
  );
  return orders.map(normalizeOrder).filter((o): o is ChainOrder => o !== null);
}

function orderToJson(order: ChainOrder, extra: Record<string, unknown> = {}) {
  return {
    id: order.id,
    maker: order.maker,
    status: order.status,
    amountIn: order.amountIn.toString(),
    amountInRemaining: order.amountInRemaining.toString(),
    minAmountOut: order.minAmountOut.toString(),
    expiry: order.expiry,
    priceMode: order.priceMode,
    ...extra,
  };
}

/** ceil(a * b / d) for bigints — mirrors the contract's rounding. */
function muldivCeil(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b + d - 1n) / d;
}

// ─── API Routes ─────────────────────────────────────────

/**
 * GET /api/assets
 */
app.get('/api/assets', (_req, res) => {
  res.json({
    assets: Object.values(TOKENS).map((t) => ({
      symbol: t.symbol,
      name: t.name,
      issuer: t.issuer,
      sacAddress: t.sacAddress,
      decimals: t.decimals,
      status: t.status,
    })),
  });
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
    const tokenIn = resolveTokenParam(req.query.tokenIn, 'tokenIn');
    const tokenOut = resolveTokenParam(req.query.tokenOut, 'tokenOut');
    const amountIn = parseAmount(req.query.amountIn, 'amountIn');
    const slippage = parseSlippageBps(req.query.slippage);

    const route = await routingEngine.computeRoute(tokenIn, tokenOut, amountIn, slippage);

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
    handleError(res, error, 'Failed to compute route');
  }
});

/**
 * GET /api/orders
 */
app.get('/api/orders', async (req, res) => {
  try {
    const tokenIn = resolveTokenParam(req.query.tokenIn, 'tokenIn');
    const tokenOut = resolveTokenParam(req.query.tokenOut, 'tokenOut');

    const orders = await fetchOrdersForPair(tokenIn, tokenOut);
    res.json({ orders: orders.filter(isOpen).map((o) => orderToJson(o)) });
  } catch (error) {
    handleError(res, error, 'Failed to fetch orders');
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
    const userAddress = parseStellarAccount(req.params.address, 'address');
    const liveTokens = Object.values(TOKENS).filter(
      (t) => t.status === 'live' && t.sacAddress
    );

    const pairs: Array<{ in: (typeof liveTokens)[number]; out: (typeof liveTokens)[number] }> = [];
    for (const a of liveTokens) {
      for (const b of liveTokens) {
        if (a.symbol !== b.symbol) pairs.push({ in: a, out: b });
      }
    }

    const allOrders: any[] = [];
    await Promise.all(
      pairs.map(async (pair) => {
        try {
          const orders = await fetchOrdersForPair(pair.in.sacAddress, pair.out.sacAddress);
          for (const order of orders) {
            if (order.maker === userAddress && isOpen(order)) {
              allOrders.push(
                orderToJson(order, {
                  tokenInSymbol: pair.in.symbol,
                  tokenOutSymbol: pair.out.symbol,
                })
              );
            }
          }
        } catch {
          // Skip pairs that fail
        }
      })
    );

    res.json({ orders: allOrders });
  } catch (error) {
    handleError(res, error, 'Failed to fetch user orders');
  }
});

/**
 * POST /api/orders/cancel
 *
 * Build an unsigned cancel_order transaction. The maker's wallet signature
 * is what authorizes the cancel on-chain (order.maker.require_auth).
 *
 * Body:
 *   sourceAddress - User's Stellar address (must be the maker)
 *   orderId       - The order ID to cancel
 */
app.post('/api/orders/cancel', async (req, res) => {
  try {
    const sourceAddress = parseStellarAccount(req.body.sourceAddress, 'sourceAddress');
    const orderId = Number(req.body.orderId);
    if (!Number.isInteger(orderId) || orderId < 1) {
      throw new BadRequest('orderId must be a positive integer');
    }

    const xdr = await stellar.buildTransaction(
      sourceAddress,
      config.swapbookContractId,
      'cancel_order',
      [StellarClient.toU64(orderId)]
    );

    res.json({ xdr });
  } catch (error) {
    handleError(res, error, 'Failed to build cancel transaction');
  }
});

/**
 * POST /api/swap/build
 * Build an unsigned Router.execute_route transaction for an instant swap.
 *
 * Only Router-executable venues (DEX adapters) are used for the on-chain
 * route. P2P book liquidity is accessed via /api/peer-swap/build instead.
 *
 * Body:
 *   sourceAddress - User's Stellar address
 *   tokenIn, tokenOut - SAC addresses or symbols
 *   amountIn - Base units
 *   slippage - bps (default 50)
 */
app.post('/api/swap/build', async (req, res) => {
  try {
    const sourceAddress = parseStellarAccount(req.body.sourceAddress, 'sourceAddress');
    const tokenIn = resolveTokenParam(req.body.tokenIn, 'tokenIn');
    const tokenOut = resolveTokenParam(req.body.tokenOut, 'tokenOut');
    const amountIn = parseAmount(req.body.amountIn, 'amountIn');
    const slippage = parseSlippageBps(req.body.slippage);

    // Route across venues the Router contract can actually execute
    const route = await routingEngine.computeRoute(tokenIn, tokenOut, amountIn, slippage, {
      executableOnly: true,
    });

    if (route.instructions.length === 0) {
      throw new BadRequest('No executable venue liquidity for this pair');
    }

    // min_total_out: expected net output with slippage tolerance applied
    const minTotalOut =
      (route.netAmountOut * BigInt(10000 - slippage)) / 10000n;
    if (minTotalOut <= 0n) {
      throw new BadRequest('Route output too small');
    }

    const xdr = await stellar.buildTransaction(
      sourceAddress,
      config.routerContractId,
      'execute_route',
      [
        StellarClient.toAddress(sourceAddress),
        StellarClient.toAddress(tokenIn),
        StellarClient.toAddress(tokenOut),
        StellarClient.toI128(route.totalAmountIn),
        StellarClient.toI128(minTotalOut),
        StellarClient.toRouteSegments(
          route.instructions.map((i) => ({
            venueId: i.venueId,
            amountIn: i.amountIn,
            minAmountOut: i.minAmountOut,
          }))
        ),
      ]
    );

    res.json({
      xdr,
      route: {
        totalAmountIn: route.totalAmountIn.toString(),
        netAmountOut: route.netAmountOut.toString(),
        minTotalOut: minTotalOut.toString(),
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
    handleError(res, error, 'Failed to build transaction');
  }
});

/**
 * POST /api/peer-swap/build
 *
 * Build a Peer Swap plan. This:
 *   1. Checks for matching orders on the reverse side (tokenOut → tokenIn)
 *   2. If matches exist, builds fill transactions (partial or full)
 *   3. Any remaining amount gets placed as a new sitting order
 *
 * NOTE: these are returned as separate transactions the wallet signs in
 * sequence — the book can move between them. Collapsing them into one
 * multi-op transaction is tracked as follow-up work.
 *
 * Body:
 *   sourceAddress    - User's Stellar address
 *   tokenIn          - Token being sold (symbol or SAC address)
 *   tokenOut         - Token being bought (symbol or SAC address)
 *   amountIn         - Amount to sell (base units, 7 decimals)
 *   minAmountOut     - Minimum acceptable output (base units). Required for Fixed mode.
 *   expiry           - Ledger sequence at which unfilled remainder expires (optional)
 *   priceMode        - 0 = Fixed (default), 1 = Oracle (market price)
 *   maxSlippageBps   - Max slippage for Oracle mode (default: 50 = 0.50%)
 *   autoRouteMinutes - Minutes to sit on P2P book before auto-routing via DEXs.
 */
app.post('/api/peer-swap/build', async (req, res) => {
  try {
    const sourceAddress = parseStellarAccount(req.body.sourceAddress, 'sourceAddress');
    const tokenIn = resolveTokenParam(req.body.tokenIn, 'tokenIn');
    const tokenOut = resolveTokenParam(req.body.tokenOut, 'tokenOut');
    const amountInBig = parseAmount(req.body.amountIn, 'amountIn');
    const minOutBig = parseAmount(req.body.minAmountOut, 'minAmountOut');
    const priceModeVal = req.body.priceMode === 1 ? 1 : 0;
    const slippageBps = parseSlippageBps(req.body.maxSlippageBps);
    const autoRouteMinutes = Number(req.body.autoRouteMinutes ?? 0);
    if (!Number.isFinite(autoRouteMinutes) || autoRouteMinutes < 0) {
      throw new BadRequest('autoRouteMinutes must be a non-negative number');
    }

    // 1. Reverse-side sitting orders are our matches
    const reverseOrders = (await fetchOrdersForPair(tokenOut, tokenIn)).filter(
      (o) => isOpen(o) && o.priceMode === 'Fixed' && o.amountIn > 0n
    );

    // 2. Greedy fill planning (ceiling payments — mirrors contract rounding)
    let budget = amountInBig;
    const fills: Array<{
      orderId: number;
      fillAmountIn: bigint; // how much of the reverse order's token we take
      paymentOut: bigint;   // how much of our tokenIn we pay
      full: boolean;
    }> = [];

    for (const order of reverseOrders) {
      if (budget <= 0n) break;
      const remaining = order.amountInRemaining;
      if (remaining <= 0n) continue;

      // Full-fill cost for the remaining amount (ceil pro-rata)
      const fullCost = muldivCeil(order.minAmountOut, remaining, order.amountIn);

      if (budget >= fullCost) {
        fills.push({ orderId: order.id, fillAmountIn: remaining, paymentOut: fullCost, full: true });
        budget -= fullCost;
      } else {
        // Partial: how much can our budget buy at this order's rate?
        let fillable = (budget * order.amountIn) / order.minAmountOut;
        if (fillable > remaining) fillable = remaining;
        while (fillable > 0n) {
          const cost = muldivCeil(order.minAmountOut, fillable, order.amountIn);
          if (cost <= budget) {
            fills.push({ orderId: order.id, fillAmountIn: fillable, paymentOut: cost, full: false });
            budget -= cost;
            break;
          }
          fillable -= 1n;
        }
      }
    }

    const amountToSit = budget;
    const totalBought = fills.reduce((s, f) => s + f.fillAmountIn, 0n);
    const totalPaid = fills.reduce((s, f) => s + f.paymentOut, 0n);

    // 3. Build transactions
    const xdrs: string[] = [];
    for (const fill of fills) {
      const method = fill.full ? 'fill_order' : 'partial_fill';
      const args = fill.full
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
          ];
      try {
        xdrs.push(
          await stellar.buildTransaction(
            sourceAddress,
            config.swapbookContractId,
            method,
            args
          )
        );
      } catch (err) {
        console.warn(`Could not build fill tx for order ${fill.orderId}:`, err);
      }
    }

    let remainderPlan: Record<string, unknown> | null = null;
    if (amountToSit > 0n) {
      const currentLedger = await stellar.getLatestLedger();
      const orderExpiry = Number.isInteger(req.body.expiry) && req.body.expiry > currentLedger
        ? Number(req.body.expiry)
        : currentLedger + DEFAULT_EXPIRY_LEDGERS;
      const autoRouteAfter =
        autoRouteMinutes > 0
          ? currentLedger + Math.ceil((autoRouteMinutes * 60) / LEDGER_SECONDS)
          : 0;
      // Pro-rata min for the sitting remainder (round up — protects the maker)
      const proRataMinOut = muldivCeil(minOutBig, amountToSit, amountInBig);

      const placeXdr = await stellar.buildTransaction(
        sourceAddress,
        config.swapbookContractId,
        'place_order',
        [
          StellarClient.toAddress(sourceAddress),
          StellarClient.toAddress(tokenIn),
          StellarClient.toAddress(tokenOut),
          StellarClient.toI128(amountToSit),
          StellarClient.toI128(priceModeVal === 1 ? 0n : proRataMinOut),
          StellarClient.toU32(orderExpiry),
          StellarClient.toU32(priceModeVal),
          StellarClient.toU32(priceModeVal === 1 ? slippageBps : 0),
          StellarClient.toU32(autoRouteAfter),
        ]
      );
      xdrs.push(placeXdr);
      remainderPlan = {
        amountIn: amountToSit.toString(),
        minAmountOut: proRataMinOut.toString(),
        expiry: orderExpiry,
        autoRouteAfter,
        status: 'will_escrow',
      };
    }

    res.json({
      plan: {
        tokenIn,
        tokenOut,
        totalAmountIn: amountInBig.toString(),
        fills: fills.map((f) => ({
          orderId: f.orderId,
          youReceive: f.fillAmountIn.toString(),
          youPay: f.paymentOut.toString(),
          feesBps: 0.5,
        })),
        remainder: remainderPlan,
        summary: {
          instantFillAmount: totalBought.toString(),
          instantFillCost: totalPaid.toString(),
          escrowedAmount: amountToSit.toString(),
        },
      },
      xdrs, // Transactions to sign and submit in order
    });
  } catch (error) {
    handleError(res, error, 'Failed to build peer swap');
  }
});

/**
 * POST /api/swap/submit
 *
 * Submit a signed transaction XDR to the Stellar network.
 */
app.post('/api/swap/submit', async (req, res) => {
  try {
    const { signedXdr } = req.body;
    if (typeof signedXdr !== 'string' || signedXdr.length === 0 || signedXdr.length > 100_000) {
      throw new BadRequest('signedXdr must be a transaction XDR string');
    }

    const result = await stellar.submitTransaction(signedXdr);
    res.json({ status: result.status, result });
  } catch (error) {
    handleError(res, error, 'Failed to submit transaction');
  }
});

/**
 * GET /api/oracle/price
 *
 * Get the latest oracle price for a pair (symbols like 'SolvBTC', 'USDC').
 */
app.get('/api/oracle/price', (req, res) => {
  const { tokenIn, tokenOut } = req.query;

  if (!tokenIn || !tokenOut) {
    res.status(400).json({ error: 'Missing required params: tokenIn, tokenOut' });
    return;
  }

  const price = oracleService.getPrice(tokenIn as string, tokenOut as string);

  if (!price) {
    res.json({
      available: false,
      tokenIn,
      tokenOut,
      message: 'No oracle price available for this pair',
    });
    return;
  }

  res.json({
    available: true,
    tokenIn,
    tokenOut,
    price: price.humanPrice,
    priceNum: price.priceNum.toString(),
    priceDen: price.priceDen.toString(),
    fetchedAt: price.fetchedAt.toISOString(),
  });
});

/**
 * GET /api/health
 */
app.get('/api/health', async (_req, res) => {
  const venues = await registry.getAvailable();
  res.json({
    status: 'ok',
    venues: venues.map((v) => ({ name: v.name, executable: v.executable })),
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
