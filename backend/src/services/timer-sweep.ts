/**
 * Timer Sweep Service (keeper)
 *
 * Periodically scans the SwapBook contract for orders whose
 * auto_route_after timer has expired, then calls the Router contract's
 * route_expired_order — which atomically claims the escrow, executes the
 * DEX route, enforces the maker's on-chain price floor, and pays the
 * maker. The keeper key holds NO custody and NO special privileges:
 * route_expired_order is permissionless and reverts on any bad route.
 *
 * Without KEEPER_SECRET_KEY the sweep runs in dry-run mode (logs only).
 */

import { Keypair } from '@stellar/stellar-sdk';
import { StellarClient, scEnum } from '../stellar/client.js';
import { TOKENS } from '../stellar/tokens.js';
import { RoutingEngine } from '../router/engine.js';

export class TimerSweepService {
  private stellar: StellarClient;
  private swapbookContractId: string;
  private routerContractId: string;
  private routingEngine: RoutingEngine;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private keeper: InstanceType<typeof Keypair> | null = null;
  private sweeping = false;

  constructor(opts: {
    stellar: StellarClient;
    swapbookContractId: string;
    routerContractId: string;
    routingEngine: RoutingEngine;
    /** Sweep interval in milliseconds (default: 60s) */
    intervalMs?: number;
    /** Keeper signing key. Omit for dry-run mode. */
    keeperSecretKey?: string;
  }) {
    this.stellar = opts.stellar;
    this.swapbookContractId = opts.swapbookContractId;
    this.routerContractId = opts.routerContractId;
    this.routingEngine = opts.routingEngine;
    this.intervalMs = opts.intervalMs ?? 60 * 1000;
    if (opts.keeperSecretKey) {
      try {
        this.keeper = Keypair.fromSecret(opts.keeperSecretKey);
      } catch {
        console.error('[TimerSweep] keeper secret is not a valid Stellar key — dry-run mode');
      }
    }
  }

  start(): void {
    console.log('[TimerSweep] Starting timer sweep service');
    console.log(`[TimerSweep] Sweep interval: ${this.intervalMs / 1000}s`);
    console.log(`[TimerSweep] Mode: ${this.keeper ? 'LIVE (keeper)' : 'DRY RUN (no keeper key)'}`);

    this.runSweep();
    this.timer = setInterval(() => this.runSweep(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[TimerSweep] Stopped timer sweep service');
    }
  }

  /** Guard against overlapping sweeps when a sweep outlives the interval. */
  private runSweep(): void {
    if (this.sweeping) return;
    this.sweeping = true;
    this.sweep()
      .catch((err) => console.error('[TimerSweep] Sweep failed:', err))
      .finally(() => {
        this.sweeping = false;
      });
  }

  /** Run one sweep across all token pairs. */
  private async sweep(): Promise<void> {
    if (!this.swapbookContractId || !this.routerContractId) return;

    const liveTokens = Object.values(TOKENS).filter(
      (t) => t.status === 'live' && t.sacAddress
    );
    if (liveTokens.length < 2) return;

    let totalProcessed = 0;

    for (const tokenIn of liveTokens) {
      for (const tokenOut of liveTokens) {
        if (tokenIn.symbol === tokenOut.symbol) continue;

        try {
          const expiredIds = await this.stellar.simulateAndParse<Array<number | bigint>>(
            this.swapbookContractId,
            'get_expired_timer_orders',
            [
              StellarClient.toAddress(tokenIn.sacAddress),
              StellarClient.toAddress(tokenOut.sacAddress),
            ]
          );
          if (!expiredIds || expiredIds.length === 0) continue;

          console.log(
            `[TimerSweep] ${expiredIds.length} expired timer orders on ${tokenIn.symbol}/${tokenOut.symbol}`
          );

          for (const orderId of expiredIds) {
            const processed = await this.processExpiredOrder(
              Number(orderId),
              tokenIn.symbol,
              tokenIn.sacAddress,
              tokenOut.symbol,
              tokenOut.sacAddress
            );
            if (processed) totalProcessed++;
          }
        } catch {
          // Skip pairs that fail (most will simply have no orders)
        }
      }
    }

    if (totalProcessed > 0) {
      console.log(`[TimerSweep] Sweep complete: routed ${totalProcessed} orders`);
    }
  }

  /** Route a single expired timer order through the Router contract. */
  private async processExpiredOrder(
    orderId: number,
    tokenInSymbol: string,
    tokenInAddress: string,
    tokenOutSymbol: string,
    tokenOutAddress: string,
  ): Promise<boolean> {
    const raw = await this.stellar.simulateAndParse<any>(
      this.swapbookContractId,
      'get_order',
      [StellarClient.toU64(orderId)]
    );
    if (!raw) {
      console.warn(`[TimerSweep] Could not fetch order ${orderId}`);
      return false;
    }
    const status = scEnum(raw.status);
    if (status !== 'Open' && status !== 'PartialFill') return false;
    const remaining = BigInt(raw.amount_in_remaining ?? 0);
    if (remaining <= 0n) return false;

    // Compute a route over Router-executable venues only
    let route;
    try {
      route = await this.routingEngine.computeRoute(
        tokenInAddress,
        tokenOutAddress,
        remaining,
        50,
        { executableOnly: true }
      );
    } catch (err) {
      console.log(`[TimerSweep] No executable route for order #${orderId} — will retry next sweep`);
      return false;
    }
    if (route.instructions.length === 0) return false;

    console.log(
      `[TimerSweep] Order #${orderId}: ${remaining} ${tokenInSymbol} → est. ` +
      `${route.netAmountOut} ${tokenOutSymbol} via ${route.segments.map((s) => s.venueName).join(' + ')}`
    );

    if (!this.keeper) {
      console.log(`[TimerSweep] [DRY RUN] Would call route_expired_order(#${orderId})`);
      return false;
    }

    try {
      const result = await this.stellar.submitWithSigner(
        this.keeper,
        this.routerContractId,
        'route_expired_order',
        [
          StellarClient.toU64(orderId),
          StellarClient.toRouteSegments(
            route.instructions.map((i) => ({
              venueId: i.venueId,
              amountIn: i.amountIn,
              minAmountOut: i.minAmountOut,
            }))
          ),
        ]
      );
      console.log(`[TimerSweep] Order #${orderId} routed (${result.status})`);
      return result.status === 'SUCCESS';
    } catch (err) {
      // InsufficientOutput reverts land here — the maker's floor held.
      console.error(`[TimerSweep] route_expired_order(#${orderId}) failed:`, err);
      return false;
    }
  }
}
