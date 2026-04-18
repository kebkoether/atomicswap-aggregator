/**
 * SushiSwap V3 venue adapter.
 *
 * Integrates with SushiSwap V3 on Stellar (concentrated liquidity,
 * launched February 2026). Uses on-chain simulation for quotes since
 * SushiSwap doesn't have a public REST API on Stellar yet.
 */

import { VenueAdapter, Quote, DepthQuote, SwapInstruction } from './adapter.js';
import { StellarClient } from '../stellar/client.js';

export class SushiSwapAdapter implements VenueAdapter {
  readonly name = 'SushiSwap';
  readonly venueId = 2;
  private stellar: StellarClient;

  constructor(
    private adapterContractId: string,
    stellar: StellarClient
  ) {
    this.stellar = stellar;
  }

  async isAvailable(): Promise<boolean> {
    // Check if our adapter contract is accessible
    try {
      const result = await this.stellar.simulateAndParse<bigint>(
        this.adapterContractId,
        'quote',
        [
          // Use dummy addresses — just testing if the contract responds
          StellarClient.toAddress(this.adapterContractId),
          StellarClient.toAddress(this.adapterContractId),
          StellarClient.toI128(0n),
        ]
      );
      // Even if it returns null/error, the contract exists
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
    const amountOut = await this.simulateQuote(tokenIn, tokenOut, amountIn);

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
      gasCost: 300n,
    };
  }

  async getDepthQuotes(
    tokenIn: string,
    tokenOut: string,
    amounts: bigint[]
  ): Promise<DepthQuote[]> {
    const quotes: DepthQuote[] = [];

    for (const amount of amounts) {
      const amountOut = await this.simulateQuote(tokenIn, tokenOut, amount);
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

  /**
   * Simulate a swap quote via Soroban RPC.
   * Calls our adapter contract's `quote` function.
   */
  private async simulateQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint
  ): Promise<bigint> {
    const result = await this.stellar.simulateAndParse<bigint>(
      this.adapterContractId,
      'quote',
      [
        StellarClient.toAddress(tokenIn),
        StellarClient.toAddress(tokenOut),
        StellarClient.toI128(amountIn),
      ]
    );

    return result ?? 0n;
  }
}
