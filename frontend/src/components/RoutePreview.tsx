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
  };
}

const VENUE_COLORS: Record<string, string> = {
  SwapBook: '#6366f1',
  StellarDEX: '#4fc3f7',
  Aqua: '#06b6d4',
  SushiSwap: '#ec4899',
  Curve: '#eab308',
};

export default function RoutePreview({ route }: RoutePreviewProps) {
  if (!route.segments || route.segments.length === 0) return null;

  const totalIn = parseInt(route.amountIn);

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
        {route.segments.map((seg, i) => {
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

      {/* Segment rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {route.segments.map((seg, i) => {
          const pct = (parseInt(seg.amountIn) / totalIn) * 100;
          const displayAmount = (parseInt(seg.amountIn) / 1e7).toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
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
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '13px', color: '#8a8f9c' }}>${displayAmount}</span>
                <span
                  style={{
                    fontSize: '12px',
                    fontFamily: 'monospace',
                    fontWeight: 500,
                    color:
                      seg.effectiveBps <= 1
                        ? '#22c55e'
                        : seg.effectiveBps <= 5
                        ? '#eab308'
                        : '#ef4444',
                  }}
                >
                  {seg.effectiveBps.toFixed(1)} bps
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Blended rate footer */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: '12px',
          paddingTop: '12px',
          borderTop: '1px solid #1a1f2e',
        }}
      >
        <span style={{ fontSize: '12px', color: '#565b68' }}>Blended cost</span>
        <span style={{ fontSize: '13px', fontWeight: 600, color: '#6366f1' }}>
          {route.blendedBps.toFixed(1)} bps
        </span>
      </div>
    </div>
  );
}
