// Tiny in-process TTL cache. Kept intentionally separate from the data-source
// adapters so the caching policy survives a source swap. Not shared across
// server instances — fine for a single Next.js node; swap for Redis if scaled.

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();

/**
 * Return a cached value for `key`, or compute it via `producer`, cache it for
 * `ttlMs`, and return it. Concurrent misses are NOT de-duplicated (acceptable
 * for this workload). A thrown producer is never cached.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  producer: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.expiresAt > now) return hit.value;

  const value = await producer();
  store.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

// TTL policy: static past data vs. volatile current-day data.
export const TTL = {
  /** Historical OHLCV whose range ends before today — immutable. */
  HISTORICAL: 24 * 60 * 60 * 1000, // 1 day
  /** OHLCV whose range includes today — the last bar keeps moving. */
  INTRADAY: 60 * 1000, // 60s
  /** Search results — names/listings change slowly. */
  SEARCH: 60 * 60 * 1000, // 1 hour
} as const;

/** Today's date (server local) as `YYYY-MM-DD`, for TTL bucketing. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
