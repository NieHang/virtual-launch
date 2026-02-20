/**
 * Simple in-memory TTL cache for expensive RPC lookups.
 * Prevents hammering the RPC on every API request.
 */
const cache = new Map<string, { value: any; expiresAt: number }>();

export function cacheGet<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function cacheSet(key: string, value: any, ttlMs: number = 10_000): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}
