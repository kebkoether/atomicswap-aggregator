/**
 * Stellar token configuration and SAC (Stellar Asset Contract) helpers.
 *
 * All supported assets on Stellar use the SAC pattern — classic Stellar
 * assets automatically wrapped for Soroban smart contract use.
 *
 * To get a SAC address from a classic asset:
 *   stellar contract id asset --asset CODE:ISSUER --network mainnet
 */

export interface TokenConfig {
  symbol: string;
  name: string;
  /** Classic Stellar asset issuer address */
  issuer: string;
  /** Soroban SAC contract address (derived from issuer) */
  sacAddress: string;
  decimals: number;
  status: 'live' | 'coming_soon';
}

/**
 * Supported token configurations.
 *
 * SAC addresses are derived using:
 *   stellar contract id asset --asset SYMBOL:ISSUER --network mainnet
 *
 * These need to be populated after running the above command for each asset.
 */
export const TOKENS: Record<string, TokenConfig> = {
  USDC: {
    symbol: 'USDC',
    name: 'USD Coin (Circle)',
    issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    sacAddress: '', // Run: stellar contract id asset --asset USDC:GA5ZSE... --network mainnet
    decimals: 7,
    status: 'live',
  },
  PYUSD: {
    symbol: 'PYUSD',
    name: 'PayPal USD',
    issuer: 'GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5',
    sacAddress: '', // Run: stellar contract id asset --asset PYUSD:GDQE7I... --network mainnet
    decimals: 7,
    status: 'live',
  },
  USDY: {
    symbol: 'USDY',
    name: 'Ondo US Dollar Yield',
    issuer: '', // Check: https://docs.ondo.finance/addresses
    sacAddress: '',
    decimals: 7,
    status: 'live',
  },
  USDT0: {
    symbol: 'USDT0',
    name: 'Tether USD (LayerZero)',
    issuer: '', // Not yet live on Stellar
    sacAddress: '',
    decimals: 7,
    status: 'coming_soon',
  },
  SolvBTC: {
    symbol: 'SolvBTC',
    name: 'Solv Protocol BTC',
    issuer: '', // TODO: populate with Stellar issuer address
    sacAddress: '',
    decimals: 7,
    status: 'live',
  },
};

/**
 * Get all live tokens.
 */
export function getLiveTokens(): TokenConfig[] {
  return Object.values(TOKENS).filter((t) => t.status === 'live');
}

/**
 * Get all supported token pairs.
 * Every live token can be swapped for every other live token.
 */
export function getTokenPairs(): Array<{ tokenIn: TokenConfig; tokenOut: TokenConfig }> {
  const live = getLiveTokens();
  const pairs: Array<{ tokenIn: TokenConfig; tokenOut: TokenConfig }> = [];

  for (const tokenIn of live) {
    for (const tokenOut of live) {
      if (tokenIn.symbol !== tokenOut.symbol) {
        pairs.push({ tokenIn, tokenOut });
      }
    }
  }

  return pairs;
}

/**
 * Resolve a symbol or SAC address to a TokenConfig.
 */
export function resolveToken(symbolOrAddress: string): TokenConfig | undefined {
  // Try by symbol first
  const bySymbol = TOKENS[symbolOrAddress.toUpperCase()];
  if (bySymbol) return bySymbol;

  // Try by SAC address
  return Object.values(TOKENS).find(
    (t) => t.sacAddress === symbolOrAddress
  );
}

/**
 * Format a token amount for display.
 * Stellar uses 7 decimal places for all SAC tokens.
 */
export function formatAmount(amount: bigint, decimals: number = 7): string {
  const divisor = BigInt(10 ** decimals);
  const whole = amount / divisor;
  const frac = amount % divisor;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

/**
 * Parse a display amount to base units.
 */
export function parseAmount(display: string, decimals: number = 7): bigint {
  const [whole, frac = ''] = display.split('.');
  const fracPadded = frac.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(whole + fracPadded);
}
