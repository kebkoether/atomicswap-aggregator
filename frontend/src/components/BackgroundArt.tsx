/**
 * Decorative background: a large, faded orbital system parked off the right
 * edge behind the swap card, a smaller counterpart bottom-left, and a sparse
 * starfield. Pure inline SVG — no image assets, ~2KB. Fixed, non-interactive,
 * sits between the body gradient (z 0) and content (z 1).
 *
 * The outer ring rotates once per 240s; disabled under
 * prefers-reduced-motion.
 */
export default function BackgroundArt() {
  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      <style>{`
        @keyframes ufamaOrbit { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .ufama-orbit-spin { animation: ufamaOrbit 240s linear infinite; transform-origin: center; }
        @media (prefers-reduced-motion: reduce) { .ufama-orbit-spin { animation: none; } }
      `}</style>

      {/* Right-side orbital system, half off-canvas */}
      <svg
        width="900"
        height="900"
        viewBox="0 0 900 900"
        fill="none"
        style={{ position: 'absolute', top: '50%', right: '-380px', transform: 'translateY(-50%)' }}
      >
        <g className="ufama-orbit-spin">
          {/* Concentric orbits */}
          <circle cx="450" cy="450" r="420" stroke="#6366f1" strokeOpacity="0.07" strokeWidth="1" />
          <circle cx="450" cy="450" r="330" stroke="#8b5cf6" strokeOpacity="0.06" strokeWidth="1" />
          <circle cx="450" cy="450" r="240" stroke="#6366f1" strokeOpacity="0.08" strokeWidth="1" strokeDasharray="2 7" />
          <circle cx="450" cy="450" r="150" stroke="#c7d2fe" strokeOpacity="0.05" strokeWidth="1" />
          {/* Bodies on the orbits */}
          <circle cx="450" cy="30" r="5" fill="#6366f1" fillOpacity="0.35" />
          <circle cx="120" cy="450" r="3.5" fill="#8b5cf6" fillOpacity="0.3" />
          <circle cx="663" cy="620" r="2.5" fill="#c7d2fe" fillOpacity="0.35" />
        </g>
        {/* Central glow (doesn't rotate) */}
        <circle cx="450" cy="450" r="60" fill="#6366f1" fillOpacity="0.05" />
        <circle cx="450" cy="450" r="18" fill="#8b5cf6" fillOpacity="0.09" />
      </svg>

      {/* Smaller system, bottom-left, mostly off-canvas */}
      <svg
        width="520"
        height="520"
        viewBox="0 0 520 520"
        fill="none"
        style={{ position: 'absolute', bottom: '-240px', left: '-200px' }}
      >
        <circle cx="260" cy="260" r="240" stroke="#8b5cf6" strokeOpacity="0.06" strokeWidth="1" />
        <circle cx="260" cy="260" r="160" stroke="#6366f1" strokeOpacity="0.07" strokeWidth="1" strokeDasharray="2 8" />
        <circle cx="420" cy="140" r="3" fill="#6366f1" fillOpacity="0.3" />
      </svg>

      {/* Sparse starfield across the top half */}
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0 }}>
        {[
          [8, 18, 1.2, 0.5], [16, 9, 0.8, 0.35], [27, 22, 1, 0.4], [38, 7, 1.4, 0.5],
          [55, 14, 0.9, 0.35], [64, 26, 1.1, 0.45], [74, 8, 0.8, 0.3], [88, 18, 1.3, 0.5],
          [46, 33, 0.7, 0.3], [93, 38, 1, 0.4], [5, 44, 0.9, 0.35], [70, 46, 0.7, 0.3],
        ].map(([x, y, r, o], i) => (
          <circle key={i} cx={`${x}%`} cy={`${y}%`} r={r} fill="#c7d2fe" fillOpacity={o} />
        ))}
      </svg>
    </div>
  );
}
