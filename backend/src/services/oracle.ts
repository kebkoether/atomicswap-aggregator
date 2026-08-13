/**
 * Oracle Price Service
 *
 * Fetches live prices from CoinGecko and pushes them on-chain
 * via the SwapBook contract's update_oracle_price method.
 *
 * For testnet: uses CoinGecko free tier (no API key needed).
 * For mainnet: replace with a SEP-40 oracle read (Reflector) or a
 * weighted-median feed — a single REST source is not production-grade.
 *
 * The contract enforces: num/den > 0, freshness (< 1000 ledgers), and a
 * max 20% jump between consecutive updates. A larger legitimate move must
 * be pushed in steps — updateAllPrices logs when the cap rejects a push.
 */

import { Keypair } from '@stellar/stellar-sdk';
import { StellarClient } from '../stellar/client.js';
import { TOKENS } from '../stellar/tokens.js';

/** Pairs that need oracle prices (non-stablecoin assets). */
const ORACLE_PAIRS: Array<{
  tokenIn: string;   // symbol of the volatile asset
  tokenOut: string;  // symbol of the quote asset (usually a stablecoin)
  coingeckoId: string;
}> = [
  // ⚠️ 'bitcoin' is a proxy for SolvBTC — track the actual SolvBTC market
  // before enabling oracle-pegged SolvBTC pairs in production.
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
  private oracleKeypair: InstanceType<typeof Keypair> | null = null;

  constructor(opts: {
    stellar: StellarClient;
    swapbookContractId: string;
    /** How often to refresh prices in milliseconds (default: 5 min) */
    intervalMs?: number;
    /** Secret key of the on-chain oracle admin. Omit to cache locally only. */
    oracleSecretKey?: string;
  }) {
    this.stellar = opts.stellar;
    this.swapbookContractId = opts.swapbookContractId;
    this.intervalMs = opts.intervalMs ?? 5 * 60 * 1000;
    if (opts.oracleSecretKey) {
      try {
        this.oracleKeypair = Keypair.fromSecret(opts.oracleSecretKey);
      } catch {
        console.error('[Oracle] ORACLE_SECRET_KEY is not a valid Stellar secret — on-chain push disabled');
      }
    }
  }

  /** Start the periodic price update loop. */
  start(): void {
    console.log('[Oracle] Starting oracle price service');
    console.log(`[Oracle] Refresh interval: ${this.intervalMs / 1000}s`);
    console.log(`[Oracle] On-chain push: ${this.oracleKeypair ? 'ENABLED' : 'disabled (no oracle key)'}`);
    console.log(`[Oracle] Tracked pairs: ${ORACLE_PAIRS.map(p => `${p.tokenIn}/${p.tokenOut}`).join(', ')}`);

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
    const uniqueIds = [...new Set(ORACLE_PAIRS.map((p) => p.coingeckoId))];
    const prices = await this.fetchCoinGeckoPrices(uniqueIds);

    if (!prices) {
      console.warn('[Oracle] Failed to fetch prices from CoinGecko');
      return;
    }

    for (const pair of ORACLE_PAIRS) {
      const usdPrice = prices[pair.coingeckoId]?.usd;
      if (!usdPrice || usdPrice <= 0) {
        console.warn(`[Oracle] No usable price for ${pair.coingeckoId}`);
        continue;
      }

      // Rational price scaled to 7 decimals (both sides use 7 on Stellar).
      const SCALE = 10_000_000n;
      const priceScaled = BigInt(Math.round(usdPrice * 10_000_000));
      if (priceScaled <= 0n) continue;

      const priceData: PriceData = {
        pair: `${pair.tokenIn}/${pair.tokenOut}`,
        priceNum: priceScaled,
        priceDen: SCALE,
        humanPrice: usdPrice,
        fetchedAt: new Date(),
      };
      this.lastPrices.set(`${pair.tokenIn}/${pair.tokenOut}`, priceData);

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
    if (!this.oracleKeypair || !this.swapbookContractId) return;

    const tokenIn = TOKENS[tokenInSymbol];
    const tokenOut = TOKENS[tokenOutSymbol];
    if (!tokenIn?.sacAddress || !tokenOut?.sacAddress) {
      // SAC addresses not yet configured — cache-only for this pair
      return;
    }

    try {
      const result = await this.stellar.submitWithSigner(
        this.oracleKeypair,
        this.swapbookContractId,
        'update_oracle_price',
        [
          StellarClient.toAddress(tokenIn.sacAddress),
          StellarClient.toAddress(tokenOut.sacAddress),
          StellarClient.toI128(priceNum),
          StellarClient.toI128(priceDen),
        ]
      );
      console.log(
        `[Oracle] Pushed ${tokenInSymbol}/${tokenOutSymbol} on-chain (${result.status})`
      );
    } catch (err) {
      // A rejected >20% jump lands here — the on-chain cap is working as
      // designed; step the price if the move is legitimate.
      console.error(
        `[Oracle] On-chain push failed for ${tokenInSymbol}/${tokenOutSymbol}:`,
        err
      );
    }
  }

  /** Fetch USD prices from CoinGecko free API. */
  private async fetchCoinGeckoPrices(
    ids: string[]
  ): Promise<Record<string, { usd: number }> | null> {
    try {
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`;
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });

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
