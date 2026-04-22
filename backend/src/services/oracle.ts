/**
 * Oracle Price Service
 *
 * Fetches live prices from CoinGecko and pushes them on-chain
 * via the SwapBook contract's update_oracle_price method.
 *
 * For testnet: uses CoinGecko free tier (no API key needed).
 * For mainnet: should be replaced with a dedicated oracle like
 * Pyth, Chainlink, or a weighted-median price feed.
 *
 * Prices are stored as rational numbers (num/den) on-chain.
 * The contract validates freshness (< 1000 ledgers ≈ 83 min).
 */

import { StellarClient } from '../stellar/client.js';
import { TOKENS, TokenConfig } from '../stellar/tokens.js';

/** Pairs that need oracle prices (non-stablecoin assets). */
const ORACLE_PAIRS: Array<{
  tokenIn: string;   // symbol of the volatile asset
  tokenOut: string;  // symbol of the quote asset (usually a stablecoin)
  coingeckoId: string;
}> = [
  { tokenIn: 'SolvBTC', tokenOut: 'USDC', coingeckoId: 'bitcoin' },
  { tokenIn: 'SolvBTC', tokenOut: 'PYUSD', coingeckoId: 'bitcoin' },
  { tokenIn: 'SolvBTC', tokenOut: 'USDY', coingeckoId: 'bitcoin' },
];

interface PriceData {
  pair: string;
  priceNum: bigint;
  priceDen: bigint;
  humanPrice: number;
  fetchedAt: Date;
}

export class OraclePriceService {
  private stellar: StellarClient;
  private swapbookContractId: string;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPrices: Map<string, PriceData> = new Map();

  constructor(opts: {
    stellar: StellarClient;
    swapbookContractId: string;
    /** How often to refresh prices in milliseconds (default: 5 min) */
    intervalMs?: number;
  }) {
    this.stellar = opts.stellar;
    this.swapbookContractId = opts.swapbookContractId;
    this.intervalMs = opts.intervalMs ?? 5 * 60 * 1000;
  }

  /** Start the periodic price update loop. */
  start(): void {
    console.log('[Oracle] Starting oracle price service');
    console.log(`[Oracle] Refresh interval: ${this.intervalMs / 1000}s`);
    console.log(`[Oracle] Tracked pairs: ${ORACLE_PAIRS.map(p => `${p.tokenIn}/${p.tokenOut}`).join(', ')}`);

    // Run immediately, then on interval
    this.updateAllPrices().catch((err) =>
      console.error('[Oracle] Initial price update failed:', err)
    );
    this.timer = setInterval(() => {
      this.updateAllPrices().catch((err) =>
        console.error('[Oracle] Price update failed:', err)
      );
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[Oracle] Stopped oracle price service');
    }
  }

  /** Get the latest cached price for a pair. */
  getPrice(tokenIn: string, tokenOut: string): PriceData | undefined {
    return this.lastPrices.get(`${tokenIn}/${tokenOut}`);
  }

  /** Fetch prices from CoinGecko and push to contract. */
  private async updateAllPrices(): Promise<void> {
    // Deduplicate coingecko IDs
    const uniqueIds = [...new Set(ORACLE_PAIRS.map((p) => p.coingeckoId))];

    // Fetch prices in one API call
    const prices = await this.fetchCoinGeckoPrices(uniqueIds);

    if (!prices) {
      console.warn('[Oracle] Failed to fetch prices from CoinGecko');
      return;
    }

    for (const pair of ORACLE_PAIRS) {
      const usdPrice = prices[pair.coingeckoId]?.usd;
      if (!usdPrice) {
        console.warn(`[Oracle] No price for ${pair.coingeckoId}`);
        continue;
      }

      // Convert USD price to the on-chain rational format.
      // Both tokens use 7 decimals on Stellar.
      // Price means: 1 unit of tokenIn = `usdPrice` units of tokenOut.
      //
      // For on-chain: fair_value = fill_amount_in * num / den
      // If fill_amount_in is in 7-decimal raw units, and we want
      // fair_value also in 7-decimal raw units, then num/den = usdPrice.
      //
      // Use integer math: multiply price by 10^7 to avoid fractions.
      const SCALE = 10_000_000n; // 10^7
      const priceScaled = BigInt(Math.round(usdPrice * 10_000_000));

      const priceData: PriceData = {
        pair: `${pair.tokenIn}/${pair.tokenOut}`,
        priceNum: priceScaled,
        priceDen: SCALE,
        humanPrice: usdPrice,
        fetchedAt: new Date(),
      };

      this.lastPrices.set(`${pair.tokenIn}/${pair.tokenOut}`, priceData);

      console.log(
        `[Oracle] ${pair.tokenIn}/${pair.tokenOut} = $${usdPrice.toLocaleString()} ` +
        `(num=${priceScaled}, den=${SCALE})`
      );

      // Push to contract (only if admin key is configured)
      await this.pushPriceOnChain(pair.tokenIn, pair.tokenOut, priceScaled, SCALE);
    }
  }

  /** Push a price update to the SwapBook contract. */
  private async pushPriceOnChain(
    tokenInSymbol: string,
    tokenOutSymbol: string,
    priceNum: bigint,
    priceDen: bigint,
  ): Promise<void> {
    const tokenIn = TOKENS[tokenInSymbol];
    const tokenOut = TOKENS[tokenOutSymbol];

    if (!tokenIn?.sacAddress || !tokenOut?.sacAddress) {
      // SAC addresses not yet configured — skip on-chain push
      return;
    }

    try {
      // For on-chain updates we need the oracle admin key.
      // If not configured, we just cache prices locally for the backend
      // to use when validating fills.
      // TODO: implement signed transaction submission once oracle admin key is set
      console.log(`[Oracle] Price cached locally for ${tokenInSymbol}/${tokenOutSymbol} (on-chain push requires oracle admin key)`);
    } catch (err) {
      console.error(`[Oracle] Failed to push price on-chain for ${tokenInSymbol}/${tokenOutSymbol}:`, err);
    }
  }

  /** Fetch USD prices from CoinGecko free API. */
  private async fetchCoinGeckoPrices(
    ids: string[]
  ): Promise<Record<string, { usd: number }> | null> {
    try {
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`;
      const response = await fetch(url);

      if (!response.ok) {
        console.warn(`[Oracle] CoinGecko API returned ${response.status}`);
        return null;
      }

      return await response.json();
    } catch (err) {
      console.error('[Oracle] CoinGecko fetch error:', err);
      return null;
    }
  }
}
