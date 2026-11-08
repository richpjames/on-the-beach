// ---------------------------------------------------------------------------
// Search-result cache
//
// The release resolver's cascade re-asks the same catalogue questions: the
// same record scanned twice, a re-add of a known link, or the cascade's own
// overlapping variants (quoted, credit-stripped, free-text) all issue
// byte-identical searches. Each of those costs a request through the ~1.1s
// provider gates, so a scan of a known record is a handful of seconds for an
// answer the process already had.
//
// This cache sits in the adapters' *search* entry points only — never in the
// shared fetch gates — because the gates also serve pollers (the artist
// release watcher browses MusicBrainz for *new* releases), and a cached poll
// would blind them for the TTL.
//
// Catalogue search results drift on the scale of weeks, so entries live for
// seven days. Failures are never stored: a rejected or non-2xx search (which
// the adapters surface as a throw) falls through uncached and stays retryable.
// An empty result IS cached — "no such record" is a real answer, the same
// terminal verdict the resolution backfill records.
// ---------------------------------------------------------------------------

interface SearchCacheEntry<T> {
  expiresAt: number;
  value: T;
}

export const SEARCH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SEARCH_CACHE_MAX_ENTRIES = 500;

const store = new Map<string, SearchCacheEntry<unknown>>();

/**
 * Return the cached value for `key`, or run `fetcher`, store what it resolves
 * with, and return that. Rejections propagate uncached. FIFO-bounded: at the
 * cap the oldest entry is evicted — search keys recur heavily, so simple
 * insertion order is a good enough victim.
 */
export function cachedSearch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return Promise.resolve(hit.value as T);
  }
  if (hit) {
    // Expired: drop it so re-insertion refreshes its eviction position.
    store.delete(key);
  }

  return fetcher().then((value) => {
    if (store.size >= SEARCH_CACHE_MAX_ENTRIES) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
    store.set(key, { expiresAt: Date.now() + SEARCH_CACHE_TTL_MS, value });
    return value;
  });
}

/** Test seam: the cache outlives a single test, and tests share a process. */
export function clearSearchCache(): void {
  store.clear();
}

/** Test seam: age every entry past the TTL without waiting a week. */
export function expireSearchCache(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    store.set(key, { ...entry, expiresAt: now - 1 });
  }
}

export function searchCacheSize(): number {
  return store.size;
}
