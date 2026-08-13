/**
 * Token Discovery Service
 *
 * Aggregates the tradeable token universe from venue liquidity instead of
 * a purely hardcoded list: any token with a real pool on Aqua shows up in
 * the aggregator UI automatically, pointing at that venue's liquidity.
 * (Sushi discovery slots in the same way once their Stellar API/ABI is
 * verified.)
 *
 * Source: Aqua pools API — GET {aquaApiUrl}/pools/?page=N&size=M
 *   Each pool carries tokens_addresses (SACs), tokens_str ("CODE:ISSUER"
 *   or "native"), index (pool hash for swap_chained), address (pool
 *   contract for estimate_swap), tx_count and total_volume.
 *
 * Anti-spoof rules for the merged list:
 *   - Curated registry entries always win and are marked verified.
 *   - A curated entry with a known issuer but empty SAC gets its SAC
 *     auto-filled when a discovered token matches code AND issuer.
 *   - A discovered token whose code collides with a curated symbol but
 *     whose issuer differs is DROPPED (classic fake-USDC spam).
 *   - Pools below the tx-count floor are ignored entirely.
 */

import { TOKENS, TokenConfig } from '../stellar/tokens.js';

export interface AquaPool {
  poolHash: string;
  poolAddress: string;
  tokenAddresses: string[];
  tokenStrs: string[];
  poolType: string;
  fee: string;
  txCount: number;
  totalVolume: number;
}

export interface AggregatedToken {
  symbol: string;
  name: string;
  issuer: string;
  sacAddress: string;
  decimals: number;
  status: 'live' | 'coming_soon';
  /** Where this listing came from */
  source: 'curated' | 'aqua';
  /** Curated entries are verified; venue-discovered ones are not */
  verified: boolean;
}

export class TokenDiscoveryService {
  private aquaApiUrl: string;
  private intervalMs: number;
  private minTxCount: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pools: AquaPool[] = [];
  /** sacAddress -> discovered token */
  private discovered: Map<string, AggregatedToken> = new Map();
  private lastRefresh: Date | null = null;

  constructor(opts: {
    aquaApiUrl: string;
    /** Refresh interval (default: 10 min) */
    intervalMs?: number;
    /** Ignore pools with fewer transactions than this (spam floor) */
    minTxCount?: number;
  }) {
    this.aquaApiUrl = opts.aquaApiUrl.replace(/\/$/, '');
    this.intervalMs = opts.intervalMs ?? 10 * 60 * 1000;
    this.minTxCount = opts.minTxCount ?? 10;
  }

  start(): void {
    console.log('[Discovery] Starting token discovery service');
    console.log(`[Discovery] Source: ${this.aquaApiUrl}/pools/ (min tx count: ${this.minTxCount})`);
    this.refresh().catch((err) =>
      console.error('[Discovery] Initial refresh failed:', err)
    );
    this.timer = setInterval(() => {
      this.refresh().catch((err) =>
        console.error('[Discovery] Refresh failed:', err)
      );
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * The merged token universe: curated registry first (verified), then
   * venue-discovered tokens that pass the anti-spoof rules.
   */
  getTokens(): AggregatedToken[] {
    const curated: AggregatedToken[] = Object.values(TOKENS).map((t) => ({
      symbol: t.symbol,
      name: t.name,
      issuer: t.issuer,
      sacAddress: t.sacAddress || this.autoFillSac(t) || '',
      decimals: t.decimals,
      status: t.status,
      source: 'curated',
      verified: true,
    }));

    const curatedSymbols = new Set(curated.map((t) => t.symbol.toUpperCase()));
    const curatedSacs = new Set(curated.map((t) => t.sacAddress).filter(Boolean));

    const extras: AggregatedToken[] = [];
    for (const token of this.discovered.values()) {
      if (curatedSacs.has(token.sacAddress)) continue; // already curated
      if (curatedSymbols.has(token.symbol.toUpperCase())) continue; // spoof guard
      extras.push(token);
    }
    extras.sort((a, b) => a.symbol.localeCompare(b.symbol));

    return [...curated, ...extras];
  }

  /** All discovered pools containing both SACs (for adapter registration/quotes). */
  getPoolsForPair(sacA: string, sacB: string): AquaPool[] {
    return this.pools.filter(
      (p) => p.tokenAddresses.includes(sacA) && p.tokenAddresses.includes(sacB)
    );
  }

  getStatus(): { pools: number; discovered: number; lastRefresh: string | null } {
    return {
      pools: this.pools.length,
      discovered: this.discovered.size,
      lastRefresh: this.lastRefresh?.toISOString() ?? null,
    };
  }

  // ─── Internal ───────────────────────────────────────

  /** Fill a curated token's missing SAC from discovery iff issuer matches. */
  private autoFillSac(curated: TokenConfig): string | undefined {
    if (!curated.issuer) return undefined;
    for (const [sac, token] of this.discovered) {
      if (
        token.symbol.toUpperCase() === curated.symbol.toUpperCase() &&
        token.issuer === curated.issuer
      ) {
        return sac;
      }
    }
    return undefined;
  }

  private async refresh(): Promise<void> {
    const pools: AquaPool[] = [];
    // Aqua serves small pages regardless of the size param — follow the
    // `next` links with a generous page cap.
    let url: string | null = `${this.aquaApiUrl}/pools/?size=100`;
    let pages = 0;
    let expectedCount = 0;

    while (url && pages < 100) {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        console.warn(`[Discovery] Aqua pools API returned ${response.status}`);
        return; // keep the previous snapshot
      }
      const data = (await response.json()) as {
        count?: number;
        next: string | null;
        results: Array<{
          index: string;
          address: string;
          tokens_addresses: string[];
          tokens_str: string[];
          pool_type: string;
          fee: string;
          tx_count: number | null;
          total_volume: number | null;
        }>;
      };

      for (const raw of data.results ?? []) {
        pools.push({
          poolHash: raw.index,
          poolAddress: raw.address,
          tokenAddresses: raw.tokens_addresses ?? [],
          tokenStrs: raw.tokens_str ?? [],
          poolType: raw.pool_type,
          fee: raw.fee,
          txCount: raw.tx_count ?? 0,
          totalVolume: raw.total_volume ?? 0,
        });
      }
      expectedCount = data.count ?? expectedCount;
      url = data.next;
      pages++;
    }

    if (expectedCount > 0 && pools.length < expectedCount) {
      console.warn(
        `[Discovery] Partial pool sweep: ${pools.length}/${expectedCount} (page cap hit)`
      );
    }

    const discovered = new Map<string, AggregatedToken>();
    for (const pool of pools) {
      if (pool.txCount < this.minTxCount) continue;
      for (let i = 0; i < pool.tokenAddresses.length; i++) {
        const sac = pool.tokenAddresses[i];
        if (!sac || discovered.has(sac)) continue;
        const parsed = this.parseTokenStr(pool.tokenStrs[i] ?? '');
        if (!parsed) continue;
        discovered.set(sac, {
          ...parsed,
          sacAddress: sac,
          decimals: 7,
          status: 'live',
          source: 'aqua',
          verified: false,
        });
      }
    }

    this.pools = pools;
    this.discovered = discovered;
    this.lastRefresh = new Date();
    console.log(
      `[Discovery] Refreshed: ${pools.length} Aqua pools → ${discovered.size} tokens (≥${this.minTxCount} txs)`
    );
  }

  /** tokens_str is "native", "CODE:ISSUER", or a display name. */
  private parseTokenStr(
    str: string
  ): { symbol: string; name: string; issuer: string } | null {
    if (str === 'native') {
      return { symbol: 'XLM', name: 'Stellar Lumens', issuer: '' };
    }
    const parts = str.split(':');
    if (parts.length === 2 && /^G[A-Z2-7]{55}$/.test(parts[1])) {
      return {
        symbol: parts[0],
        name: `${parts[0]} (${parts[1].slice(0, 4)}…${parts[1].slice(-4)})`,
        issuer: parts[1],
      };
    }
    // Soroban-native tokens surface as a bare display name
    if (str.length > 0 && str.length <= 32) {
      return { symbol: str.replace(/\s+/g, ''), name: str, issuer: '' };
    }
    return null;
  }
}
