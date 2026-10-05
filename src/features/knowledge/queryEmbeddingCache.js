import { createHash } from "node:crypto";

const DEFAULT_TTL_MS = 3_600_000;
const DEFAULT_MAX_ENTRIES = 500;

/** Exact input/provider/model/dimension key. No normalization or stored query text. */
export function queryEmbeddingCacheKey({ baseUrl, model, dimensions, text }) {
  const cacheIdentity = [baseUrl, model, dimensions, "query", "float", false, text];
  return createHash("sha256")
    .update(JSON.stringify(cacheIdentity))
    .digest("hex");
}

/** RAM-only TTL/LRU cache for successful query vectors, with in-flight deduplication. */
export function createQueryEmbeddingCache({
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  cleanupIntervalMs = 60_000,
  now = Date.now,
} = {}) {
  const ttl = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : DEFAULT_TTL_MS;
  const capacity = Number.isInteger(maxEntries) && maxEntries >= 0
    ? maxEntries
    : DEFAULT_MAX_ENTRIES;
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

  const cleanup = enabled && cleanupIntervalMs > 0
    ? setInterval(pruneExpired, cleanupIntervalMs)
    : null;
  cleanup?.unref?.();

  async function getOrCreate(key, create, onOutcome) {
    const reportOutcome = (outcome) => {
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
      reportOutcome("hit");
      return cached.vector.slice();
    }
    if (cached) {
      entries.delete(key);
      stats.expired += 1;
    }

    const existingRequest = inFlight.get(key);
    if (existingRequest) {
      stats.coalesced += 1;
      reportOutcome("coalesced");
      return (await existingRequest).slice();
    }

    stats.misses += 1;
    reportOutcome("miss");
    const pendingRequest = Promise.resolve()
      .then(create)
      .then((vector) => {
        const invalidVector = !Array.isArray(vector)
          || !vector.length
          || vector.some((value) => !Number.isFinite(value));
        if (invalidVector) {
          throw new Error("Cannot cache an invalid embedding vector");
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
      if (inFlight.get(key) === pendingRequest) inFlight.delete(key);
    }
  }

  return {
    getOrCreate,
    pruneExpired,
    getStats: () => ({
      ...stats,
      enabled,
      entries: entries.size,
      inFlight: inFlight.size,
    }),
    dispose: () => {
      if (cleanup) clearInterval(cleanup);
      entries.clear();
    },
  };
}
