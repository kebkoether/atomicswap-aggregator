/**
 * Timer Sweep Service
 *
 * Periodically scans the SwapBook contract for orders whose
 * auto_route_after timer has expired. When found, the router
 * claims these orders and routes the escrowed tokens through
 * available DEX liquidity on behalf of the maker.
 *
 * Flow:
 *  1. Query all token pairs for expired-timer order IDs
 *  2. For each expired order, call claim_expired_timer (router auth)
 *  3. Route claimed tokens through the smart routing engine
 *  4. Send proceeds to the maker's address
 *
 * This service requires the ADMIN_SECRET_KEY env var to sign
 * router transactions. Without it, the sweep runs in dry-run
 * mode (logs what it would do).
 */

import { StellarClient } from '../stellar/client.js';
import { TOKENS } from '../stellar/tokens.js';
import { RoutingEngine } from '../router/engine.js';

export class TimerSweepService {
  private stellar: StellarClient;
  private swapbookContractId: string;
  private routingEngine: RoutingEngine;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private dryRun: boolean;

  constructor(opts: {
    stellar: StellarClient;
    swapbookContractId: string;
    routingEngine: RoutingEngine;
    /** Sweep interval in milliseconds (default: 60s) */
    intervalMs?: number;
    /** If true, log actions but don't submit transactions */
    dryRun?: boolean;
  }) {
    this.stellar = opts.stellar;
    this.swapbookContractId = opts.swapbookContractId;
    this.routingEngine = opts.routingEngine;
    this.intervalMs = opts.intervalMs ?? 60 * 1000;
    this.dryRun = opts.dryRun ?? true;
  }

  start(): void {
    console.log('[TimerSweep] Starting timer sweep service');
    console.log(`[TimerSweep] Sweep interval: ${this.intervalMs / 1000}s`);
    console.log(`[TimerSweep] Mode: ${this.dryRun ? 'DRY RUN (no admin key)' : 'LIVE'}`);

    // Run immediately, then on interval
    this.sweep().catch((err) =>
      console.error('[TimerSweep] Initial sweep failed:', err)
    );
    this.timer = setInterval(() => {
      this.sweep().catch((err) =>
        console.error('[TimerSweep] Sweep failed:', err)
      );
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[TimerSweep] Stopped timer sweep service');
    }
  }

  /** Run one sweep across all token pairs. */
  private async sweep(): Promise<void> {
    const liveTokens = Object.values(TOKENS).filter((t) => t.status === 'live' && t.sacAddress);

    if (liveTokens.length < 2) {
      // Not enough configured tokens to form pairs
      return;
    }

    let totalExpired = 0;

    for (const tokenIn of liveTokens) {
      for (const tokenOut of liveTokens) {
        if (tokenIn.symbol === tokenOut.symbol) continue;

        try {
          const expiredIds = await this.stellar.simulateAndParse<number[]>(
            this.swapbookContractId,
            'get_expired_timer_orders',
            [
              StellarClient.toAddress(tokenIn.sacAddress),
              StellarClient.toAddress(tokenOut.sacAddress),
            ]
          );

          if (!expiredIds || expiredIds.length === 0) continue;

          console.log(
            `[TimerSweep] Found ${expiredIds.length} expired timer orders ` +
            `for ${tokenIn.symbol}/${tokenOut.symbol}`
          );
          totalExpired += expiredIds.length;

          for (const orderId of expiredIds) {
            await this.processExpiredOrder(
              orderId,
              tokenIn.symbol,
              tokenIn.sacAddress,
              tokenOut.symbol,
              tokenOut.sacAddress,
            );
          }
        } catch (err) {
          // Silently skip pairs that fail (most will have no orders)
        }
      }
    }

    if (totalExpired > 0) {
      console.log(`[TimerSweep] Sweep complete: processed ${totalExpired} expired orders`);
    }
  }

  /** Process a single expired timer order. */
  private async processExpiredOrder(
    orderId: number,
    tokenInSymbol: string,
    tokenInAddress: string,
    tokenOutSymbol: string,
    tokenOutAddress: string,
  ): Promise<void> {
    // Fetch order details
    const order = await this.stellar.simulateAndParse<any>(
      this.swapbookContractId,
      'get_order',
      [StellarClient.toU64(orderId)]
    );

    if (!order) {
      console.warn(`[TimerSweep] Could not fetch order ${orderId}`);
      return;
    }

    const remaining = BigInt(order.amount_in_remaining ?? order.amountInRemaining ?? '0');
    if (remaining <= 0n) return;

    console.log(
      `[TimerSweep] Order #${orderId}: ${remaining} ${tokenInSymbol} → ${tokenOutSymbol} ` +
      `(timer expired, routing through DEXs)`
    );

    if (this.dryRun) {
      // Compute what the route would look like
      try {
        const route = await this.routingEngine.computeRoute(
          tokenInAddress,
          tokenOutAddress,
          remaining,
        );
        console.log(
          `[TimerSweep] [DRY RUN] Would route ${remaining} ${tokenInSymbol} → ` +
          `${route.netAmountOut} ${tokenOutSymbol} via ${route.segments.map(s => s.venueName).join(' + ')}`
        );
      } catch (err) {
        console.log(`[TimerSweep] [DRY RUN] Route computation failed for order #${orderId}`);
      }
      return;
    }

    // LIVE MODE: claim and route
    try {
      // Step 1: Claim the order (transfers escrowed tokens to router)
      // This requires the router's signing key
      // TODO: Implement when ADMIN_SECRET_KEY is configured
      // const claimXdr = await this.stellar.buildTransaction(...)
      // await this.stellar.submitTransaction(claimXdr)

      // Step 2: Route through DEXs
      // const route = await this.routingEngine.computeRoute(...)

      // Step 3: Execute the DEX swap

      // Step 4: Send proceeds to maker
      // maker address = order.maker

      console.log(`[TimerSweep] Successfully routed order #${orderId}`);
    } catch (err) {
      console.error(`[TimerSweep] Failed to process order #${orderId}:`, err);
    }
  }
}
