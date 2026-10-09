import { createHash } from 'node:crypto';

const DEFAULT_TTL_MS = 3_600_000;
const DEFAULT_MAX_ENTRIES = 500;

/**
 * Hash exact provider, model, dimensions, and query text without storing the query in the key.
 * @param {Object} options - Options: baseUrl, model, dimensions, text.
 * @returns {string} The deterministic query-vector cache key.
 */
export function queryEmbeddingCacheKey({ baseUrl, model, dimensions, text }) {
  const cacheIdentity = [baseUrl, model, dimensions, 'query', 'float', false, text];

  return createHash('sha256').update(JSON.stringify(cacheIdentity)).digest('hex');
}

/**
 * Create the bounded TTL and LRU query-vector cache with shared in-flight loaders.
 * @param {Object} options - Options: ttlMs, maxEntries, cleanupIntervalMs, now.
 * @returns {Object} Cache lookup and statistics operations.
 */
export function createQueryEmbeddingCache({
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  cleanupIntervalMs = 60_000,
  now = Date.now
} = {}) {
  const ttl = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : DEFAULT_TTL_MS;
  const capacity = Number.isInteger(maxEntries) && maxEntries >= 0 ? maxEntries : DEFAULT_MAX_ENTRIES;
  const enabled = ttl > 0 && capacity > 0;
  const entries = new Map();
  const inFlight = new Map();
  const stats = { hits: 0, misses: 0, coalesced: 0, expired: 0, evictions: 0 };

  function pruneExpired() {
    const timestamp = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= timestamp) {
        entries.delete(key);
        stats.expired += 1;
      }
    }
  }

  const cleanup = enabled && cleanupIntervalMs > 0 ? setInterval(pruneExpired, cleanupIntervalMs) : null;
  cleanup?.unref?.();

  /**
   * Return an independent cached vector or share one validated loader for concurrent same-key requests.
   * @param {string} key - Exact query-vector cache key.
   * @param {Function} create - Loader for a missing query vector.
   * @param {Function} onOutcome - Optional cache-outcome logging callback.
   * @returns {Promise<Array<number>>} A copy of the query vector; rejects without caching a failed loader.
   */
  async function getOrCreate(key, create, onOutcome) {
    const reportOutcome = outcome => {
      try {
        onOutcome?.(outcome);
      } catch {
        // Observability hooks must never change cache behavior.
      }
    };

    const cached = entries.get(key);
    if (cached && cached.expiresAt > now()) {
      stats.hits += 1;
      entries.delete(key);
      // Reinsert to update LRU order without extending the fixed expiry time.
      entries.set(key, cached);
      reportOutcome('hit');

      return cached.vector.slice();
    }
    if (cached) {
      entries.delete(key);
      stats.expired += 1;
    }

    const existingRequest = inFlight.get(key);
    if (existingRequest) {
      stats.coalesced += 1;
      reportOutcome('coalesced');

      return (await existingRequest).slice();
    }

    stats.misses += 1;
    reportOutcome('miss');
    const pendingRequest = Promise.resolve()
      .then(create)
      .then(vector => {
        const invalidVector = !Array.isArray(vector) || !vector.length || vector.some(value => !Number.isFinite(value));
        if (invalidVector) {
          throw new Error('Cannot cache an invalid embedding vector');
        }

        if (enabled) {
          pruneExpired();
          entries.set(key, { vector: vector.slice(), expiresAt: now() + ttl });
          while (entries.size > capacity) {
            const oldestKey = entries.keys().next().value;
            entries.delete(oldestKey);
            stats.evictions += 1;
          }
        }

        return vector;
      });
    inFlight.set(key, pendingRequest);

    try {
      return (await pendingRequest).slice();
    } finally {
      if (inFlight.get(key) === pendingRequest) {
        inFlight.delete(key);
      }
    }
  }

  return {
    getOrCreate,
    getStats: () => ({
      ...stats,
      enabled,
      entries: entries.size,
      inFlight: inFlight.size
    })
  };
}
