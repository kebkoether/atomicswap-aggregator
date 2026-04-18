/**
 * Stellar DEX (SDEX) venue adapter.
 *
 * Queries the native Stellar CLOB (central limit order book) via the
 * Horizon API. No Soroban adapter contract is needed — the SDEX is
 * built into the Stellar protocol itself, and trades execute as
 * classic path_payment operations.
 *
 * Uses:
 *   - server.orderbook() for depth/liquidity queries
 *   - server.strictSendPaths() for exact-input path quotes
 *
 * Horizon docs: https://developers.stellar.org/docs/data/horizon
 */

import { VenueAdapter, Quote, DepthQuote, SwapInstruction } from './adapter.js';
import { TOKENS } from '../stellar/tokens.js';

// Horizon SDK types
import { Horizon, Asset } from '@stellar/stellar-sdk';

export class StellarDexAdapter implements VenueAdapter {
  readonly name = 'StellarDEX';
  readonly venueId = 3; // 0=SwapBook, 1=Aqua, 2=Sushi, 3=SDEX

  private horizon: Horizon.Server;

  constructor(horizonUrl: string) {
    this.horizon = new Horizon.Server(horizonUrl);
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Quick health check — fetch the root endpoint
      await this.horizon.ledgers().order('desc').limit(1).call();
      return true;
    } catch {
      return false;
    }
  }

  async getQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint
  ): Promise<Quote> {
    const assetIn = this.resolveAsset(tokenIn);
    const assetOut = this.resolveAsset(tokenOut);

    if (!assetIn || !assetOut) {
      return this.emptyQuote(tokenIn, tokenOut, amountIn);
    }

    try {
      const displayAmount = this.toDisplayAmount(amountIn);

      const paths = await this.horizon
        .strictSendPaths(assetIn, displayAmount, [assetOut])
        .call();

      if (!paths.records || paths.records.length === 0) {
        return this.emptyQuote(tokenIn, tokenOut, amountIn);
      }

      // Pick the best path (highest destination_amount)
      const best = paths.records.reduce((a, b) =>
        parseFloat(a.destination_amount) > parseFloat(b.destination_amount)
          ? a
          : b
      );

      const amountOut = this.fromDisplayAmount(best.destination_amount);
      const effectiveBps =
        amountIn > 0n && amountOut > 0n
          ? Number(((amountIn - amountOut) * 10000n) / amountIn)
          : 9999;

      return {
        venue: this.name,
        tokenIn,
        tokenOut,
        amountIn,
        amountOut,
        effectiveBps,
        gasCost: 100n, // Classic ops are cheap
      };
    } catch (error) {
      console.warn('StellarDEX quote error:', error);
      return this.emptyQuote(tokenIn, tokenOut, amountIn);
    }
  }

  async getDepthQuotes(
    tokenIn: string,
    tokenOut: string,
    amounts: bigint[]
  ): Promise<DepthQuote[]> {
    const assetIn = this.resolveAsset(tokenIn);
    const assetOut = this.resolveAsset(tokenOut);

    if (!assetIn || !assetOut) {
      return amounts.map((a) => ({ amountIn: a, amountOut: 0n, marginalBps: Infinity }));
    }

    // Query paths for each depth level
    const quotes: DepthQuote[] = [];
    let prevAmountOut = 0n;

    for (const amount of amounts) {
      try {
        const displayAmount = this.toDisplayAmount(amount);

        const paths = await this.horizon
          .strictSendPaths(assetIn, displayAmount, [assetOut])
          .call();

        if (!paths.records || paths.records.length === 0) {
          quotes.push({ amountIn: amount, amountOut: prevAmountOut, marginalBps: Infinity });
          continue;
        }

        const best = paths.records.reduce((a, b) =>
          parseFloat(a.destination_amount) > parseFloat(b.destination_amount)
            ? a
            : b
        );

        const amountOut = this.fromDisplayAmount(best.destination_amount);
        const marginalOut = amountOut - prevAmountOut;
        const marginalIn = quotes.length > 0 ? amount - amounts[quotes.length - 1] : amount;

        const marginalBps =
          marginalIn > 0n && marginalOut > 0n
            ? Number(((marginalIn - marginalOut) * 10000n) / marginalIn)
            : Infinity;

        quotes.push({ amountIn: amount, amountOut, marginalBps });
        prevAmountOut = amountOut;
      } catch {
        quotes.push({ amountIn: amount, amountOut: prevAmountOut, marginalBps: Infinity });
      }
    }

    return quotes;
  }

  async buildSwapInstruction(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    minAmountOut: bigint
  ): Promise<SwapInstruction> {
    // SDEX swaps use classic path_payment_strict_send operations.
    // The Router contract doesn't invoke these — the frontend builds
    // a separate classic operation and bundles it into the same tx.
    // We return a marker instruction so the router knows about this leg.
    return {
      venueContractId: 'SDEX', // Marker — not a real contract
      venueId: this.venueId,
      amountIn,
      minAmountOut,
    };
  }

  // ─── Helpers ──────────────────────────────────────────

  /**
   * Resolve a token symbol or SAC address to a classic Stellar Asset.
   */
  private resolveAsset(symbolOrAddress: string): Asset | null {
    // Try by symbol
    const upper = symbolOrAddress.toUpperCase();
    const tokenConfig = TOKENS[upper];
    if (tokenConfig && tokenConfig.issuer) {
      return new Asset(tokenConfig.symbol, tokenConfig.issuer);
    }

    // Try to find by SAC address
    const byAddress = Object.values(TOKENS).find(
      (t) => t.sacAddress === symbolOrAddress && t.issuer
    );
    if (byAddress) {
      return new Asset(byAddress.symbol, byAddress.issuer);
    }

    // Handle XLM
    if (upper === 'XLM' || upper === 'NATIVE') {
      return Asset.native();
    }

    return null;
  }

  /**
   * Convert base units (7 decimals) to display string for Horizon.
   */
  private toDisplayAmount(baseUnits: bigint): string {
    const whole = baseUnits / 10000000n;
    const frac = baseUnits % 10000000n;
    const fracStr = frac.toString().padStart(7, '0');
    return `${whole}.${fracStr}`;
  }

  /**
   * Convert display string from Horizon to base units.
   */
  private fromDisplayAmount(display: string): bigint {
    const [whole, frac = ''] = display.split('.');
    const fracPadded = frac.padEnd(7, '0').slice(0, 7);
    return BigInt(whole + fracPadded);
  }

  private emptyQuote(tokenIn: string, tokenOut: string, amountIn: bigint): Quote {
    return {
      venue: this.name,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: 0n,
      effectiveBps: 9999,
      gasCost: 100n,
    };
  }
}
