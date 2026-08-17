/**
 * Aqua AMM venue adapter.
 *
 * Integrates with the Aquarius DEX on Stellar (Soroban-native AMM).
 * Uses the Aqua REST API for quotes (faster than on-chain simulation)
 * and falls back to on-chain simulation if the API is unavailable.
 *
 * Mainnet Router: CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK
 * Testnet Router: CDGX6Q3ZZIDSX2N3SHBORWUIEG2ZZEBAAMYARAXTT7M5L6IXKNJMT3GB
 * API: https://amm-api.aqua.network/api/external/v1
 */

import { VenueAdapter, Quote, DepthQuote, SwapInstruction } from './adapter.js';
import { StellarClient } from '../stellar/client.js';

export class AquaAdapter implements VenueAdapter {
  readonly name = 'Aqua';
  readonly venueId = 1;
  readonly executable = true;
  private stellar: StellarClient;

  constructor(
    private adapterContractId: string,
    private aquaApiUrl: string,
    stellar: StellarClient
  ) {
    this.stellar = stellar;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.aquaApiUrl}/pools`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      // API down, but we can still try on-chain simulation
      return true;
    }
  }

  async getQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint
  ): Promise<Quote> {
    const amountOut = await this.fetchQuote(tokenIn, tokenOut, amountIn);

    const effectiveBps =
      amountIn > 0n && amountOut > 0n
        ? Number(((amountIn - amountOut) * 10000n) / amountIn)
        : Infinity;

    return {
      venue: this.name,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      effectiveBps: effectiveBps === Infinity ? 9999 : effectiveBps,
      gasCost: 200n,
    };
  }

  async getDepthQuotes(
    tokenIn: string,
    tokenOut: string,
    amounts: bigint[]
  ): Promise<DepthQuote[]> {
    const quotePromises = amounts.map((amount) =>
      this.fetchQuote(tokenIn, tokenOut, amount)
    );
    const outputs = await Promise.all(quotePromises);

    return amounts.map((amountIn, i) => {
      const amountOut = outputs[i];
      const marginalBps =
        amountIn > 0n && amountOut > 0n
          ? Number(((amountIn - amountOut) * 10000n) / amountIn)
          : Infinity;

      return { amountIn, amountOut, marginalBps };
    });
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

  /**
   * Fetch a swap quote — tries REST API first, falls back to on-chain sim.
   */
  private async fetchQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint
  ): Promise<bigint> {
    // Try REST API first (faster)
    const apiResult = await this.fetchApiQuote(tokenIn, tokenOut, amountIn);
    if (apiResult > 0n) return apiResult;

    // Fallback: simulate on-chain via our adapter contract
    const onChainResult = await this.stellar.simulateAndParse<bigint>(
      this.adapterContractId,
      'quote',
      [
        StellarClient.toAddress(tokenIn),
        StellarClient.toAddress(tokenOut),
        StellarClient.toI128(amountIn),
      ]
    );

    return onChainResult ?? 0n;
  }

  private async fetchApiQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint
  ): Promise<bigint> {
    try {
      const response = await fetch(
        `${this.aquaApiUrl}/estimate-swap?` +
          new URLSearchParams({
            token_in: tokenIn,
            token_out: tokenOut,
            amount_in: amountIn.toString(),
          }),
        { signal: AbortSignal.timeout(3000) }
      );

      if (!response.ok) return 0n;

      const data = (await response.json()) as { estimated_out?: string };
      return data.estimated_out ? BigInt(data.estimated_out) : 0n;
    } catch {
      return 0n;
    }
  }
}
