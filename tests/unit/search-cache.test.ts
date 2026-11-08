import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cachedSearch,
  clearSearchCache,
  expireSearchCache,
  SEARCH_CACHE_MAX_ENTRIES,
  searchCacheSize,
} from "../../adapters/search-cache";
import { searchReleases } from "../../adapters/discogs/index";

// The cache exists so the resolver's repeated catalogue questions stop paying
// the provider gates each time. These tests pin the cache's own contract;
// the wiring is exercised through a real adapter search below.

beforeEach(() => {
  clearSearchCache();
});

afterEach(() => {
  mock.restore();
  clearSearchCache();
});

describe("cachedSearch", () => {
  test("a second call for the same key never runs the fetcher", async () => {
    const fetcher = mock(() => Promise.resolve(["a result"]));
    await cachedSearch("key", fetcher);
    const second = await cachedSearch("key", fetcher);

    expect(second).toEqual(["a result"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("a rejected search is not cached — the retry reaches the network", async () => {
    const fetcher = mock(() => Promise.reject(new Error("503")));
    await expect(cachedSearch("key", fetcher)).rejects.toThrow("503");
    await expect(cachedSearch("key", fetcher)).rejects.toThrow("503");

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("an empty result is cached — 'no such record' is a real answer", async () => {
    const fetcher = mock(() => Promise.resolve([]));
    await cachedSearch("key", fetcher);
    await cachedSearch("key", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("an expired entry is fetched again", async () => {
    const fetcher = mock(() => Promise.resolve(["first"]));
    await cachedSearch("key", fetcher);

    expireSearchCache();
    fetcher.mockResolvedValue(["second"]);
    const refreshed = await cachedSearch("key", fetcher);

    expect(refreshed).toEqual(["second"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("the cache is FIFO-bounded", async () => {
    const fetcher = mock((key: string) => Promise.resolve(key));
    for (let i = 0; i <= SEARCH_CACHE_MAX_ENTRIES; i++) {
      await cachedSearch(`key-${i}`, () => fetcher(`key-${i}`));
    }

    expect(searchCacheSize()).toBe(SEARCH_CACHE_MAX_ENTRIES);
    // The oldest entry was evicted; the newest is still there.
    await cachedSearch("key-0", () => fetcher("key-0"));
    await cachedSearch(`key-${SEARCH_CACHE_MAX_ENTRIES}`, () =>
      fetcher(`key-${SEARCH_CACHE_MAX_ENTRIES}`),
    );
    expect(fetcher).toHaveBeenCalledTimes(SEARCH_CACHE_MAX_ENTRIES + 2);
  });
});

describe("the resolver's searches go through the cache", () => {
  test("the same Discogs search twice issues one network request", async () => {
    const fetchSpy = mock((url: string) =>
      Promise.resolve(
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      await searchReleases({ artist: "The Earons", releaseTitle: "Land of Hunger" });
      await searchReleases({ artist: "The Earons", releaseTitle: "Land of Hunger" });
    } finally {
      globalThis.fetch = original;
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
