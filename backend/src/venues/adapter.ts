/**
 * VenueAdapter — Standard interface for all DEX venue integrations.
 *
 * Each venue (SwapBook, Aqua, SushiSwap, future Curve) implements this
 * interface. The router engine queries all adapters to find the optimal
 * split route.
 *
 * Adding a new venue = implement this interface + register on-chain.
 */

export interface Quote {
  venue: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  /** Effective price in bps cost (0 = perfect 1:1, higher = worse) */
  effectiveBps: number;
  /** Estimated gas cost in stroops */
  gasCost: bigint;
}

export interface DepthQuote {
  /** Amount of token_in at this depth level */
  amountIn: bigint;
  /** Corresponding output at this depth */
  amountOut: bigint;
  /** Marginal price at this depth (bps cost) */
  marginalBps: number;
}

export interface SwapInstruction {
  /** Venue adapter contract address on Soroban */
  venueContractId: string;
  /** Venue ID registered in the Router contract */
  venueId: number;
  /** Amount to route through this venue */
  amountIn: bigint;
  /** Minimum output expected from this leg */
  minAmountOut: bigint;
}

export interface VenueAdapter {
  /** Human-readable venue name */
  readonly name: string;

  /** Venue ID (matches on-chain Router registry) */
  readonly venueId: number;

  /**
   * Whether the on-chain Router contract can execute this venue via its
   * adapter contract. SwapBook (P2P fills) and SDEX (classic ops) provide
   * liquidity through other flows and must NOT appear in execute_route /
   * route_expired_order segments.
   */
  readonly executable: boolean;

  /** Whether this venue is currently available */
  isAvailable(): Promise<boolean>;

  /**
   * Get a quote for a specific amount.
   */
  getQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint
  ): Promise<Quote>;

  /**
   * Get quotes at multiple depth levels for routing optimization.
   *
   * The router calls this to build a price curve for each venue,
   * then greedily fills from the cheapest marginal price across
   * all venues.
   *
   * @param amounts - Ascending list of cumulative amounts to quote
   *   e.g., [100e7, 1000e7, 10000e7, 50000e7] for $100, $1k, $10k, $50k
   */
  getDepthQuotes(
    tokenIn: string,
    tokenOut: string,
    amounts: bigint[]
  ): Promise<DepthQuote[]>;

  /**
   * Build the swap instruction for the Router contract.
   */
  buildSwapInstruction(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    minAmountOut: bigint
  ): Promise<SwapInstruction>;
}
