/**
 * Wallet screening (sanctions / compliance) — OFF-CHAIN by design.
 *
 * The contracts stay permissionless; screening happens where the industry
 * does it: the frontend/backend refuse to QUOTE-BUILD for flagged wallets.
 * Providers:
 *   SCREENING_PROVIDER=none       (default) no screening
 *   SCREENING_PROVIDER=denylist   static list in SCREENING_DENYLIST (comma-sep G...)
 *   SCREENING_PROVIDER=predicate  Predicate policy API:
 *       PREDICATE_API_URL   e.g. https://api.predicate.io/... (per your policy)
 *       PREDICATE_API_KEY   bearer token
 *
 * Fail-open vs fail-closed when the provider errors:
 *   SCREENING_FAIL_CLOSED=1 → provider outage blocks builds (strict)
 *   default                 → outage logs a warning and allows (available)
 *
 * Results are cached for CACHE_TTL_MS per address to keep the hot path fast.
 */

const PROVIDER = (process.env.SCREENING_PROVIDER ?? 'none').toLowerCase();
const DENYLIST = new Set(
  (process.env.SCREENING_DENYLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);
const PREDICATE_API_URL = process.env.PREDICATE_API_URL ?? '';
const PREDICATE_API_KEY = process.env.PREDICATE_API_KEY ?? '';
const FAIL_CLOSED = ['1', 'true'].includes(
  (process.env.SCREENING_FAIL_CLOSED ?? '').toLowerCase()
);
const CACHE_TTL_MS = 10 * 60 * 1000;

const cache = new Map<string, { blocked: boolean; ts: number }>();

export class BlockedAddressError extends Error {
  status = 403;
  constructor(address: string) {
    super(`Address ${address.slice(0, 6)}… failed compliance screening`);
  }
}

async function predicateCheck(address: string): Promise<boolean> {
  if (!PREDICATE_API_URL || !PREDICATE_API_KEY) {
    throw new Error('predicate screening selected but PREDICATE_API_URL/KEY unset');
  }
  const res = await fetch(PREDICATE_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${PREDICATE_API_KEY}`,
    },
    body: JSON.stringify({ chain: 'stellar', address }),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`predicate API ${res.status}`);
  const body: any = await res.json();
  // Predicate policy responses expose a boolean verdict; accept the
  // common shapes. Tighten to the exact schema once credentials exist.
  const allowed = body.allowed ?? body.compliant ?? body.is_compliant;
  if (typeof allowed !== 'boolean') throw new Error('predicate: unrecognized response shape');
  return !allowed;
}

/** True if the address is blocked. Never throws (applies fail-open/closed). */
export async function isBlocked(address: string): Promise<boolean> {
  if (PROVIDER === 'none') return false;
  if (PROVIDER === 'denylist') return DENYLIST.has(address);

  const hit = cache.get(address);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.blocked;
  try {
    const blocked = await predicateCheck(address);
    cache.set(address, { blocked, ts: Date.now() });
    return blocked;
  } catch (err) {
    console.warn(`screening: provider error for ${address.slice(0, 6)}…:`, err);
    return FAIL_CLOSED;
  }
}

/** Throws BlockedAddressError (HTTP 403) if the address is blocked. */
export async function assertNotBlocked(address: string): Promise<void> {
  if (await isBlocked(address)) throw new BlockedAddressError(address);
}
