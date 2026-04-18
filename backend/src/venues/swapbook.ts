/**
 * SwapBook venue adapter — queries our own on-chain orderbook
 * for sitting orders that can be matched peer-to-peer.
 */

import { VenueAdapter, Quote, DepthQuote, SwapInstruction } from './adapter.js';
import { StellarClient } from '../stellar/client.js';

export class SwapBookAdapter implements VenueAdapter {
  readonly name = 'SwapBook';
  readonly venueId = 0; // SwapBook is venue 0 (internal)
  private stellar: StellarClient;

  constructor(
    private contractId: string,
    stellar: StellarClient
  ) {
    this.stellar = stellar;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async getQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint
  ): Promise<Quote> {
    const amountOut = await this.queryBestOffer(tokenIn, tokenOut, amountIn);

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
      gasCost: 100n,
    };
  }

  async getDepthQuotes(
    tokenIn: string,
    tokenOut: string,
    amounts: bigint[]
  ): Promise<DepthQuote[]> {
    const quotes: DepthQuote[] = [];

    for (const amount of amounts) {
      const amountOut = await this.queryBestOffer(tokenIn, tokenOut, amount);

      if (amountOut === 0n) {
        quotes.push({
          amountIn: amount,
          amountOut: 0n,
          marginalBps: Infinity,
        });
      } else {
        const marginalBps = Number(((amount - amountOut) * 10000n) / amount);
        quotes.push({ amountIn: amount, amountOut, marginalBps });
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
    return {
      venueContractId: this.contractId,
      venueId: this.venueId,
      amountIn,
      minAmountOut,
    };
  }

  /**
   * Query the on-chain SwapBook for available liquidity.
   * Uses simulateTransaction to call get_best_offer without gas cost.
   */
  private async queryBestOffer(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint
  ): Promise<bigint> {
    const result = await this.stellar.simulateAndParse<bigint>(
      this.contractId,
      'get_best_offer',
      [
        StellarClient.toAddress(tokenIn),
        StellarClient.toAddress(tokenOut),
        StellarClient.toI128(amountIn),
      ]
    );

    return result ?? 0n;
  }
}
