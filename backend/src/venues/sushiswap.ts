/**
 * SushiSwap V3 (Stellar) venue adapter.
 *
 * Execution: our on-chain adapter contract calls Sushi POOLS directly
 * (pool.swap + invoker auth) — mainnet-verified 2026-08-18.
 *
 * Quotes: Sushi's quoter contract rejects third-party quote calls
 * (#1003), so we quote from pool state instead: slot0's sqrt price gives
 * the spot rate; we apply the pool fee and treat depth conservatively.
 * The contract enforces min_amount_out at execution, so a spot-based
 * estimate with slippage margin is safe for routing.
 *
 * Pairs are configured via SUSHI_PAIRS env (JSON):
 *   [{"tokenA":"<SAC>","tokenB":"<SAC>","pool":"<C...>","fee":3000}]
 */

import { VenueAdapter, Quote, DepthQuote, SwapInstruction } from './adapter.js';
import { StellarClient } from '../stellar/client.js';

const Q96 = 2n ** 96n;
const FEE_DENOM = 1_000_000n; // V3 fee units (3000 = 0.3%)

interface SushiPair {
  tokenA: string;
  tokenB: string;
  pool: string;
  fee: number;
}

export class SushiSwapAdapter implements VenueAdapter {
  readonly name = 'SushiSwap';
  readonly venueId = 2;
  readonly executable = true; // mainnet-verified via direct pool.swap
  private stellar: StellarClient;
  private pairs: SushiPair[] = [];
  private token0Cache = new Map<string, string>(); // pool -> token0

  constructor(
    private adapterContractId: string,
    stellar: StellarClient,
    pairsJson?: string
  ) {
    this.stellar = stellar;
    try {
      if (pairsJson) this.pairs = JSON.parse(pairsJson);
    } catch {
      console.warn('[Sushi] SUSHI_PAIRS env is not valid JSON — no pairs configured');
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.pairs.length > 0;
  }

  private findPair(tokenIn: string, tokenOut: string): SushiPair | undefined {
    return this.pairs.find(
      (p) =>
        (p.tokenA === tokenIn && p.tokenB === tokenOut) ||
        (p.tokenA === tokenOut && p.tokenB === tokenIn)
    );
  }

  private async token0(pool: string): Promise<string | null> {
    const cached = this.token0Cache.get(pool);
    if (cached) return cached;
    const t0 = await this.stellar.simulateAndParse<string>(pool, 'token0', []);
    if (t0) this.token0Cache.set(pool, String(t0));
    return t0 ? String(t0) : null;
  }

  /** Spot quote from pool slot0: price = (sqrtP / 2^96)^2, minus pool fee. */
  private async spotQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint
  ): Promise<bigint> {
    const pair = this.findPair(tokenIn, tokenOut);
    if (!pair) return 0n;

    const [slot0, t0] = await Promise.all([
      this.stellar.simulateAndParse<any>(pair.pool, 'slot0', []),
      this.token0(pair.pool),
    ]);
    if (!slot0 || !t0) return 0n;
    const sqrtP = BigInt(slot0.sqrt_price_x96 ?? 0);
    if (sqrtP === 0n) return 0n;

    const feeKeep = FEE_DENOM - BigInt(pair.fee);
    // price of token1 in token0 terms = (sqrtP/Q96)^2; both sides 7 decimals
    if (tokenIn === t0) {
      // token0 -> token1: out = in * sqrtP^2 / Q96^2
      return (amountIn * sqrtP * sqrtP * feeKeep) / (Q96 * Q96 * FEE_DENOM);
    }
    // token1 -> token0: out = in * Q96^2 / sqrtP^2
    return (amountIn * Q96 * Q96 * feeKeep) / (sqrtP * sqrtP * FEE_DENOM);
  }

  async getQuote(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<Quote> {
    const amountOut = await this.spotQuote(tokenIn, tokenOut, amountIn);
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
      gasCost: 300n,
    };
  }

  async getDepthQuotes(
    tokenIn: string,
    tokenOut: string,
    amounts: bigint[]
  ): Promise<DepthQuote[]> {
    // Spot price doesn't model tick-range depth; charge a soft impact
    // haircut that grows with size so the greedy allocator doesn't dump
    // the whole order here. The contract's min_out guards execution.
    const quotes: DepthQuote[] = [];
    for (const amount of amounts) {
      let amountOut = await this.spotQuote(tokenIn, tokenOut, amount);
      if (amountOut > 0n) {
        // 1 bp haircut per $10k of size (7-decimals base units)
        const haircutBps = amount / 100_000_0000000n;
        amountOut -= (amountOut * haircutBps) / 10000n;
      }
      const marginalBps =
        amount > 0n && amountOut > 0n
          ? Number(((amount - amountOut) * 10000n) / amount)
          : Infinity;
      quotes.push({ amountIn: amount, amountOut, marginalBps });
    }
    return quotes;
  }

  async buildSwapInstruction(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    minAmountOut: bigint
  ): Promise<SwapInstruction> {
    return {
      venueContractId: this.adapterContractId,
      venueId: this.venueId,
      amountIn,
      minAmountOut,
    };
  }
}
