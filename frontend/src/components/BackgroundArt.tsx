/**
 * Decorative background: a large orbital system parked off the right edge
 * behind the swap card, a smaller counter-rotating counterpart bottom-left,
 * and a sparse starfield. Pure inline SVG — no image assets, ~2KB. Fixed,
 * non-interactive, sits between the body gradient (z 0) and content (z 1).
 *
 * Animation is a single GPU-composited transform per system (rotate on an
 * SVG group) — no filters, no repaints. Outer ring: one turn per 150s;
 * bottom-left counter-rotates at 200s. Disabled under
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
        .ufama-orbit-spin { animation: ufamaOrbit 150s linear infinite; transform-origin: center; }
        .ufama-orbit-spin-reverse { animation: ufamaOrbit 200s linear infinite reverse; transform-origin: center; }
        @media (prefers-reduced-motion: reduce) {
          .ufama-orbit-spin, .ufama-orbit-spin-reverse { animation: none; }
        }
      `}</style>

      {/* Right-side orbital system, half off-canvas */}
      <svg
        width="1100"
        height="1100"
        viewBox="0 0 900 900"
        fill="none"
        style={{ position: 'absolute', top: '50%', right: '-440px', transform: 'translateY(-50%)' }}
      >
        <g className="ufama-orbit-spin">
          {/* Concentric orbits */}
          <circle cx="450" cy="450" r="420" stroke="#6366f1" strokeOpacity="0.14" strokeWidth="1.2" />
          <circle cx="450" cy="450" r="330" stroke="#8b5cf6" strokeOpacity="0.12" strokeWidth="1" />
          <circle cx="450" cy="450" r="240" stroke="#6366f1" strokeOpacity="0.16" strokeWidth="1.2" strokeDasharray="2 7" />
          <circle cx="450" cy="450" r="150" stroke="#c7d2fe" strokeOpacity="0.10" strokeWidth="1" />
          {/* Bodies on the orbits — soft halo behind each bright core */}
          <circle cx="450" cy="30" r="10" fill="#6366f1" fillOpacity="0.18" />
          <circle cx="450" cy="30" r="5.5" fill="#818cf8" fillOpacity="0.6" />
          <circle cx="120" cy="450" r="7" fill="#8b5cf6" fillOpacity="0.16" />
          <circle cx="120" cy="450" r="4" fill="#a78bfa" fillOpacity="0.55" />
          <circle cx="663" cy="620" r="3" fill="#c7d2fe" fillOpacity="0.6" />
          <circle cx="285" cy="215" r="2.2" fill="#c7d2fe" fillOpacity="0.5" />
        </g>
        {/* Central glow (doesn't rotate) — layered circles, no blur filter */}
        <circle cx="450" cy="450" r="90" fill="#6366f1" fillOpacity="0.06" />
        <circle cx="450" cy="450" r="52" fill="#6366f1" fillOpacity="0.10" />
        <circle cx="450" cy="450" r="20" fill="#8b5cf6" fillOpacity="0.18" />
      </svg>

      {/* Smaller system, bottom-left, mostly off-canvas, counter-rotating */}
      <svg
        width="640"
        height="640"
        viewBox="0 0 520 520"
        fill="none"
        style={{ position: 'absolute', bottom: '-280px', left: '-240px' }}
      >
        <g className="ufama-orbit-spin-reverse">
          <circle cx="260" cy="260" r="240" stroke="#8b5cf6" strokeOpacity="0.12" strokeWidth="1" />
          <circle cx="260" cy="260" r="160" stroke="#6366f1" strokeOpacity="0.14" strokeWidth="1" strokeDasharray="2 8" />
          <circle cx="420" cy="140" r="5.5" fill="#6366f1" fillOpacity="0.16" />
          <circle cx="420" cy="140" r="3.2" fill="#818cf8" fillOpacity="0.55" />
          <circle cx="140" cy="360" r="2.4" fill="#c7d2fe" fillOpacity="0.5" />
        </g>
      </svg>

      {/* Sparse starfield across the top half */}
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0 }}>
        {[
          [8, 18, 1.2, 0.65], [16, 9, 0.8, 0.45], [27, 22, 1, 0.55], [38, 7, 1.4, 0.65],
          [55, 14, 0.9, 0.45], [64, 26, 1.1, 0.6], [74, 8, 0.8, 0.4], [88, 18, 1.3, 0.65],
          [46, 33, 0.7, 0.4], [93, 38, 1, 0.55], [5, 44, 0.9, 0.45], [70, 46, 0.7, 0.4],
        ].map(([x, y, r, o], i) => (
          <circle key={i} cx={`${x}%`} cy={`${y}%`} r={r} fill="#c7d2fe" fillOpacity={o} />
        ))}
      </svg>
    </div>
  );
}
