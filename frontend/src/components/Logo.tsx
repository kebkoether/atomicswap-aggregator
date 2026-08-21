/**
 * Ufama logo mark: a "U" whose right stem sweeps into an orbital arc with a
 * small satellite at its tip — routing around the star. Pure SVG, scales to
 * any size, no assets.
 */
export default function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-label="Ufama"
      style={{ display: 'block' }}
    >
      <defs>
        <linearGradient id="ufamaBadge" x1="0" y1="0" x2="48" y2="48">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#8b5cf6" />
        </linearGradient>
        <linearGradient id="ufamaArc" x1="10" y1="38" x2="44" y2="12">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#c7d2fe" stopOpacity="0.9" />
        </linearGradient>
      </defs>

      {/* Badge */}
      <rect x="1" y="1" width="46" height="46" rx="13" fill="url(#ufamaBadge)" />
      <rect
        x="1.5" y="1.5" width="45" height="45" rx="12.5"
        stroke="#ffffff" strokeOpacity="0.14" fill="none"
      />

      {/* U — left stem + bowl, right stem lifts off into an orbit arc */}
      <path
        d="M15 13 v12 c0 5.5 4 9 9 9 s9 -3.5 9 -9 v-3"
        stroke="url(#ufamaArc)"
        strokeWidth="4.4"
        strokeLinecap="round"
        fill="none"
      />
      {/* Orbit continuation: sweeps up and out of the bowl */}
      <path
        d="M33 22 c0 -6 3 -10 7.5 -11.5"
        stroke="#c7d2fe"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeDasharray="0.1 5"
        fill="none"
        opacity="0.9"
      />
      {/* Satellite at the arc's tip */}
      <circle cx="41.5" cy="9.5" r="2.6" fill="#ffffff" />
      <circle cx="41.5" cy="9.5" r="4.4" fill="none" stroke="#ffffff" strokeOpacity="0.35" strokeWidth="1" />
    </svg>
  );
}
