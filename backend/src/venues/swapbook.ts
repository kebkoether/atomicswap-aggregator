/**
 * SwapBook venue adapter — queries our own on-chain orderbook
 * for sitting orders that can be matched peer-to-peer.
 *
 * Direction matters: a taker selling tokenIn for tokenOut is filled by
 * makers on the REVERSE side of the book (makers selling tokenOut for
 * tokenIn). The contract's `quote_fill(token_buy, token_pay, amount_pay)`
 * encapsulates that — we pass token_buy = the taker's tokenOut.
 */

import { VenueAdapter, Quote, DepthQuote, SwapInstruction } from './adapter.js';
import { StellarClient } from '../stellar/client.js';

export class SwapBookAdapter implements VenueAdapter {
  readonly name = 'SwapBook';
  readonly venueId = 0; // SwapBook is venue 0 (internal)
  // P2P fills execute via fill_order/partial_fill ops, not the Router.
  readonly executable = false;
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
    const { bought, paid } = await this.quoteFill(tokenIn, tokenOut, amountIn);

    const effectiveBps =
      paid > 0n && bought > 0n
        ? Number(((paid - bought) * 10000n) / paid)
        : Infinity;

    return {
      venue: this.name,
      tokenIn,
      tokenOut,
      amountIn: paid,
      amountOut: bought,
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
      const { bought } = await this.quoteFill(tokenIn, tokenOut, amount);

      if (bought === 0n) {
        quotes.push({ amountIn: amount, amountOut: 0n, marginalBps: Infinity });
      } else {
        const marginalBps = Number(((amount - bought) * 10000n) / amount);
        quotes.push({ amountIn: amount, amountOut: bought, marginalBps });
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
   * Taker-direction quote via the contract's quote_fill.
   * tokenIn = what the taker pays; tokenOut = what the taker buys.
   */
  private async quoteFill(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint
  ): Promise<{ bought: bigint; paid: bigint }> {
    const result = await this.stellar.simulateAndParse<[bigint, bigint]>(
      this.contractId,
      'quote_fill',
      [
        StellarClient.toAddress(tokenOut), // token_buy
        StellarClient.toAddress(tokenIn),  // token_pay
        StellarClient.toI128(amountIn),    // amount_pay
      ]
    );

    if (!result) return { bought: 0n, paid: 0n };
    const [bought, paid] = result;
    return { bought: BigInt(bought), paid: BigInt(paid) };
  }
}
