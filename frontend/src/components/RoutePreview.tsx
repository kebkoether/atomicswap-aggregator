'use client';

interface RouteSegment {
  venue: string;
  amountIn: string;
  expectedOut: string;
  effectiveBps: number;
}

interface RoutePreviewProps {
  route: {
    segments: RouteSegment[];
    amountIn: string;
    blendedBps: number;
    /** True price impact vs small-size spot rate (unit-safe) */
    priceImpactBps?: number;
    /** Symbols + decimals attached by SwapWidget for labeling amounts */
    tokenInSymbol?: string;
    tokenOutSymbol?: string;
    tokenInDecimals?: number;
    tokenOutDecimals?: number;
  };
}

const VENUE_COLORS: Record<string, string> = {
  SwapBook: '#6366f1',
  StellarDEX: '#4fc3f7',
  Aqua: '#06b6d4',
  SushiSwap: '#ec4899',
  Curve: '#eab308',
};

import { formatUnits } from '@/lib/units';

function fmtAmount(raw: string, decimals: number): string {
  return formatUnits(raw, decimals);
}

export default function RoutePreview({ route }: RoutePreviewProps) {
  // A venue that contributes nothing is noise, not information —
  // "0% via SwapBook" must never render.
  const segments = (route.segments ?? []).filter((s) => {
    try { return BigInt(s.amountIn) > 0n; } catch { return false; }
  });
  if (segments.length === 0) return null;

  const totalIn = parseInt(route.amountIn);
  const inSym = route.tokenInSymbol ?? '';
  const outSym = route.tokenOutSymbol ?? '';

  return (
    <div
      style={{
        background: '#131722',
        border: '1px solid #1a1f2e',
        borderRadius: '16px',
        padding: '16px 18px',
      }}
    >
      <div
        style={{
          fontSize: '12px',
          fontWeight: 600,
          color: '#565b68',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          marginBottom: '12px',
        }}
      >
        Route
      </div>

      {/* Visual split bar */}
      <div
        style={{
          display: 'flex',
          height: '6px',
          borderRadius: '3px',
          overflow: 'hidden',
          gap: '2px',
          marginBottom: '14px',
        }}
      >
        {segments.map((seg, i) => {
          const pct = (parseInt(seg.amountIn) / totalIn) * 100;
          return (
            <div
              key={i}
              style={{
                width: `${pct}%`,
                background: VENUE_COLORS[seg.venue] || '#565b68',
                borderRadius: '3px',
                minWidth: '4px',
              }}
            />
          );
        })}
      </div>

      {/* Segment rows: venue, share, and in → out amounts in TOKEN units.
          (Amounts previously carried a hardcoded "$" — 10,000 XLM read as
          "$10,000". Per-segment effectiveBps was also dropped: it compared
          token-in units to token-out units, meaningless off stable pairs.) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {segments.map((seg, i) => {
          const pct = (parseInt(seg.amountIn) / totalIn) * 100;
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: VENUE_COLORS[seg.venue] || '#565b68',
                  }}
                />
                <span style={{ fontSize: '13px', color: '#e1e4ea', fontWeight: 500 }}>
                  {seg.venue}
                </span>
                <span style={{ fontSize: '12px', color: '#565b68' }}>
                  {pct.toFixed(0)}%
                </span>
              </div>
              <span style={{ fontSize: '13px', color: '#8a8f9c' }}>
                {fmtAmount(seg.amountIn, route.tokenInDecimals ?? 7)}{inSym ? ` ${inSym}` : ''}
                <span style={{ color: '#565b68' }}> → </span>
                {fmtAmount(seg.expectedOut, route.tokenOutDecimals ?? 7)}{outSym ? ` ${outSym}` : ''}
              </span>
            </div>
          );
        })}
      </div>

      {/* Footer: true price impact (falls back to hiding when unavailable) */}
      {route.priceImpactBps !== undefined && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: '12px',
            paddingTop: '12px',
            borderTop: '1px solid #1a1f2e',
          }}
        >
          <span style={{ fontSize: '12px', color: '#565b68' }}>Price impact</span>
          <span style={{ fontSize: '13px', fontWeight: 600, color: '#6366f1' }}>
            ~{Math.max(0, route.priceImpactBps).toFixed(1)} bps
          </span>
        </div>
      )}
    </div>
  );
}
