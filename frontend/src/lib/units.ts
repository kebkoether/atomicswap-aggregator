/**
 * Decimal-aware amount conversion. Most Stellar assets (SACs) are 7
 * decimals, but Soroban-native tokens can differ — Sushi lists 18-decimal
 * tokens like deJTRSY/deJAAA. String math throughout: Number can't
 * represent 18-decimal base units without corrupting the low digits.
 */

/** Human-entered decimal string -> integer base units (as a string). */
export function toBaseUnits(amount: string, decimals: number): string {
  const clean = amount.trim();
  if (!/^\d*(\.\d*)?$/.test(clean) || clean === '' || clean === '.') return '0';
  const [whole = '0', frac = ''] = clean.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const combined = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, '');
  return combined === '' ? '0' : combined;
}

/** Integer base-unit string -> Number of whole tokens (display only). */
export function fromBaseUnits(raw: string | number | bigint, decimals: number): number {
  try {
    const v = BigInt(raw);
    const base = 10n ** BigInt(decimals);
    const whole = v / base;
    const frac = v % base;
    // 6 fractional digits is plenty for display; avoids Number overflow
    const fracNum = Number((frac * 1_000_000n) / base) / 1_000_000;
    return Number(whole) + fracNum;
  } catch {
    return 0;
  }
}

/** Formatted display string for a base-unit amount. */
export function formatUnits(
  raw: string | number | bigint,
  decimals: number,
  fractionDigits = 2
): string {
  return fromBaseUnits(raw, decimals).toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}
