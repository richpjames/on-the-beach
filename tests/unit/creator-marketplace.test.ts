import { describe, test, expect, spyOn, mock, afterEach, afterAll } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createMusicItemsFromUrl, AmbiguousLinkSelectionError } from "../../app/music-item-creator";
import { UnsupportedMusicLinkError } from "../../app/scrape";
import { musicItemRoutes } from "../../server/routes/music-items";
import { db } from "../../adapters/db/index";
import { musicLinks } from "../../adapters/db/schema";

// Marketplace listings resolve from the client-captured title, never from a
// page fetch. The extractor needs a key; the background lookups a fresh item
// kicks off must stay off the network. Set at module scope because the
// Mistral client reads its key when this file's imports evaluate.
const ENV_BEFORE = {
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY,
  OTB_DISABLE_EXTERNAL_LOOKUPS: process.env.OTB_DISABLE_EXTERNAL_LOOKUPS,
  EBAY_CLIENT_ID: process.env.EBAY_CLIENT_ID,
  EBAY_CLIENT_SECRET: process.env.EBAY_CLIENT_SECRET,
};
process.env.MISTRAL_API_KEY = "test-key";
process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";
// The eBay enricher is tested in its own file; here it must stay unconfigured
// so the creator's client-title branch is what runs.
delete process.env.EBAY_CLIENT_ID;
delete process.env.EBAY_CLIENT_SECRET;

// `bun test` runs every file in one process — restore what was here before,
// so whichever file runs next sees its own environment (see
// creator-page-source-notes.test.ts).
afterAll(() => {
  for (const [key, value] of Object.entries(ENV_BEFORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** The shape `@mistralai/mistralai` expects back from chat.complete. */
function mockChatCompletionResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "cmpl_test_1",
      object: "chat.completion",
      created: 1,
      model: "mistral-small-latest",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    }),
    { headers: { "content-type": "application/json" } },
  );
}

/**
 * Serve the extractor's JSON — and nothing else. A marketplace page is never
 * fetched, so any fetch beyond the Mistral call is the bug these tests watch
 * for; `expectNoPageFetch` asserts it.
 */
function mockExtraction(releasesJson: string) {
  const fetchSpy = spyOn(globalThis, "fetch");
  // A fresh Response per call: a body can only be read once, and one test may
  // file several listings off the same extraction.
  fetchSpy.mockImplementation(async () => mockChatCompletionResponse(releasesJson));
  return fetchSpy;
}

function expectNoPageFetch(fetchSpy: ReturnType<typeof spyOn>, host: string) {
  for (const call of fetchSpy.mock.calls) {
    const target = String(call[0] instanceof Request ? call[0].url : call[0]);
    expect(target).not.toContain(host);
  }
}

afterEach(() => {
  mock.restore();
});

// Every test files items in the same throwaway database, so each uses its own
// listing id — a shared URL would dedupe against an earlier test's item.
const wallapopUrl = (id: string) =>
  `https://es.wallapop.com/item/vinilo-camaron-la-leyenda-del-tiempo-1979-${id}`;
const ebayUrl = (tld: string, id: string) => `https://www.ebay.${tld}/itm/${id}`;

const CAMARON_JSON =
  '{"releases":[{"artist":"Camarón","title":"La leyenda del tiempo","itemType":"album","isPrimary":true}]}';
const LEER_JSON =
  '{"releases":[{"artist":"Thomas Leer","title":"Contradictions","itemType":"album","isPrimary":true}]}';

describe("marketplace listings resolve from the captured title, without fetching", () => {
  test("extracts a release from the listing title and keeps the listing as the link", async () => {
    const url = wallapopUrl("1320305358");
    const fetchSpy = mockExtraction(CAMARON_JSON);

    const results = await createMusicItemsFromUrl(url, {
      pageTitle: "Vinilo Camarón – La leyenda del tiempo (1979)",
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.created).toBe(true);
    expect(results[0]!.item.title).toBe("La Leyenda Del Tiempo");
    expect(results[0]!.item.artist_name).toBe("Camarón");
    expect(results[0]!.item.primary_url).toBe(url);
    expectNoPageFetch(fetchSpy, "wallapop.com");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("an eBay listing with no enricher keys resolves the same way", async () => {
    const url = ebayUrl("es", "800867457219");
    const fetchSpy = mockExtraction(LEER_JSON);

    const results = await createMusicItemsFromUrl(url, {
      pageTitle: "Thomas Leer – Contradictions LP (1982)",
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.created).toBe(true);
    expect(results[0]!.item.title).toBe("Contradictions");
    expect(results[0]!.item.primary_url).toBe(url);
    expectNoPageFetch(fetchSpy, "ebay.");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("the site's own name is stripped off a real title's end", async () => {
    mockExtraction(LEER_JSON);

    const results = await createMusicItemsFromUrl(ebayUrl("de", "111111111111"), {
      pageTitle: "Thomas Leer – Contradictions | eBay",
    });

    expect(results[0]!.item.title).toBe("Contradictions");
  });

  test("the user's own title wins over the captured one — no extraction needed", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");

    const results = await createMusicItemsFromUrl(ebayUrl("es", "121212121212"), {
      title: "Contradictions",
      artistName: "Thomas Leer",
      pageTitle: "THOMAS LEER contradictions vinyl LP record",
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.created).toBe(true);
    expect(results[0]!.item.title).toBe("Contradictions");
    expect(results[0]!.item.artist_name).toBe("Thomas Leer");
    // The override short-circuits before any extraction or scrape.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("marketplace junk titles are rejected, not filed", () => {
  test("a URL-only title on eBay asks for the listing title", async () => {
    const url = ebayUrl("es", "131313131313");
    const fetchSpy = spyOn(globalThis, "fetch");

    await expect(createMusicItemsFromUrl(url, { pageTitle: url })).rejects.toThrow(
      "This site blocks server requests — paste the listing title",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a URL with tracking params still reads as the URL itself", async () => {
    const url = ebayUrl("es", "141414141414");
    await expect(
      createMusicItemsFromUrl(url, { pageTitle: `${url}?itmprp=cks%3A123` }),
    ).rejects.toThrow(UnsupportedMusicLinkError);
  });

  test("a slug-bearing URL posted as the title is still the URL, not evidence", async () => {
    // eBay's normaliser drops the title slug, so the posted URL no longer equals
    // the normalised one — comparing against it would let this through and file
    // an item titled with the URL. It must still be rejected as a title.
    const sluggedUrl = "https://www.ebay.es/itm/Thomas-Leer-Contradictions-LP/181818181818";
    const fetchSpy = spyOn(globalThis, "fetch");

    await expect(createMusicItemsFromUrl(sluggedUrl, { pageTitle: sluggedUrl })).rejects.toThrow(
      "This site blocks server requests — paste the listing title",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a Wallapop URL posted as the title falls back to the slug's words", async () => {
    // Rejecting the URL as a title must not kill the slug fallback: Wallapop's
    // slug carries the seller's words, which are evidence in their own right.
    const url = wallapopUrl("1320305361");
    const fetchSpy = mockExtraction(CAMARON_JSON);

    const results = await createMusicItemsFromUrl(url, { pageTitle: url });

    expect(results[0]!.created).toBe(true);
    expect(results[0]!.item.title).toBe("La Leyenda Del Tiempo");
    expectNoPageFetch(fetchSpy, "wallapop.com");
  });

  test("a bare site name on eBay asks for the listing title", async () => {
    await expect(
      createMusicItemsFromUrl(ebayUrl("com", "222222222222"), { pageTitle: "eBay" }),
    ).rejects.toThrow("This site blocks server requests — paste the listing title");
  });

  test("a bare site name on Wallapop falls back to the slug's words", async () => {
    // es.wallapop.com's first hostname label is "es" — the source name is
    // what catches "Wallapop" as the site's own name.
    const fetchSpy = mockExtraction(CAMARON_JSON);

    const results = await createMusicItemsFromUrl(wallapopUrl("1320305359"), {
      pageTitle: "Wallapop",
    });

    expect(results[0]!.created).toBe(true);
    expect(results[0]!.item.title).toBe("La Leyenda Del Tiempo");
    expectNoPageFetch(fetchSpy, "wallapop.com");
  });

  test("no title at all on eBay asks for the listing title", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");

    await expect(createMusicItemsFromUrl(ebayUrl("com", "151515151515"))).rejects.toThrow(
      "This site blocks server requests — paste the listing title",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("marketplace fallbacks", () => {
  test("no extraction key: a usable raw title still creates the item", async () => {
    const keyBefore = process.env.MISTRAL_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      const results = await createMusicItemsFromUrl(ebayUrl("es", "333333333333"), {
        pageTitle: "Sade – Diamond Life vinyl LP",
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.created).toBe(true);
      // The listing *is* one item for sale: album-shaped, not the unknown
      // path's "mix".
      expect(results[0]!.item.title).toBe("Sade – Diamond Life Vinyl LP");
      expect(results[0]!.item.item_type).toBe("album");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      if (keyBefore === undefined) delete process.env.MISTRAL_API_KEY;
      else process.env.MISTRAL_API_KEY = keyBefore;
    }
  });

  test("extraction names nothing: the raw title becomes the single candidate", async () => {
    const fetchSpy = mockExtraction('{"releases":[]}');

    const results = await createMusicItemsFromUrl(ebayUrl("es", "444444444444"), {
      pageTitle: "Rare private press ambient LP 1983",
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.item.title).toBe("Rare Private Press Ambient LP 1983");
    expect(results[0]!.item.item_type).toBe("album");
    expectNoPageFetch(fetchSpy, "ebay.");
  });

  test("slug-only evidence: Wallapop's slug words feed the extraction", async () => {
    const fetchSpy = mockExtraction(CAMARON_JSON);

    const results = await createMusicItemsFromUrl(wallapopUrl("1320305360"));

    expect(results).toHaveLength(1);
    expect(results[0]!.created).toBe(true);
    expect(results[0]!.item.title).toBe("La Leyenda Del Tiempo");
    expectNoPageFetch(fetchSpy, "wallapop.com");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("the web form's recovery: a pasted title with no captured one", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");

    const results = await createMusicItemsFromUrl(ebayUrl("es", "555555555555"), {
      title: "Diamond Life",
      artistName: "Sade",
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.created).toBe(true);
    expect(results[0]!.item.title).toBe("Diamond Life");
    expect(results[0]!.item.artist_name).toBe("Sade");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("marketplace listings naming several releases", () => {
  test("a lot of LPs comes back as an ambiguous pick, then creates each selection", async () => {
    const lotUrl = ebayUrl("es", "666666666666");
    const lotJson =
      '{"releases":[{"artist":"Kalte Sterne","title":"Nachtfahrt","itemType":"album"},{"artist":"Rue Basse","title":"Onze","itemType":"album"}]}';
    const fetchSpy = mockExtraction(lotJson);

    let payload: AmbiguousLinkSelectionError["payload"] | null = null;
    try {
      await createMusicItemsFromUrl(lotUrl, { pageTitle: "Lot of 2 LPs: Nachtfahrt / Onze" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousLinkSelectionError);
      payload = (err as AmbiguousLinkSelectionError).payload;
    }

    expect(payload!.candidates).toHaveLength(2);
    expectNoPageFetch(fetchSpy, "ebay.");

    // The picker's answer: both releases, each filed under the listing URL.
    mockExtraction(lotJson);
    const results = await createMusicItemsFromUrl(lotUrl, {
      pageTitle: "Lot of 2 LPs: Nachtfahrt / Onze",
      selectedCandidateIds: ["cand-1-kalte-sterne-nachtfahrt", "cand-2-rue-basse-onze"],
    });

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.created)).toBe(true);
    expect(results.map((result) => result.item.primary_url)).toEqual([lotUrl, lotUrl]);
  });

  test("filing one release of a lot doesn't block adding another later", async () => {
    const lotUrl = ebayUrl("es", "171717171717");
    const lotJson =
      '{"releases":[{"artist":"Kalte Sterne","title":"Nachtfahrt","itemType":"album"},{"artist":"Rue Basse","title":"Onze","itemType":"album"}]}';

    // First share: pick just Nachtfahrt off the lot.
    mockExtraction(lotJson);
    const first = await createMusicItemsFromUrl(lotUrl, {
      pageTitle: "Lot of 2 LPs: Nachtfahrt / Onze",
      selectedCandidateIds: ["cand-1-kalte-sterne-nachtfahrt"],
    });
    expect(first).toHaveLength(1);
    expect(first[0]!.created).toBe(true);
    expect(first[0]!.item.title).toBe("Nachtfahrt");

    // Re-share the same listing and pick Onze. The listing key matches the
    // filed Nachtfahrt, but a lot dedupes per release — Onze is new, so it must
    // be added rather than the short-circuit handing back Nachtfahrt.
    mockExtraction(lotJson);
    const second = await createMusicItemsFromUrl(lotUrl, {
      pageTitle: "Lot of 2 LPs: Nachtfahrt / Onze",
      selectedCandidateIds: ["cand-2-rue-basse-onze"],
    });
    expect(second).toHaveLength(1);
    expect(second[0]!.created).toBe(true);
    expect(second[0]!.item.title).toBe("Onze");
    expect(second[0]!.item.id).not.toBe(first[0]!.item.id);

    // Picking Nachtfahrt again still dedupes to the item already filed.
    mockExtraction(lotJson);
    const again = await createMusicItemsFromUrl(lotUrl, {
      pageTitle: "Lot of 2 LPs: Nachtfahrt / Onze",
      selectedCandidateIds: ["cand-1-kalte-sterne-nachtfahrt"],
    });
    expect(again[0]!.created).toBe(false);
    expect(again[0]!.item.id).toBe(first[0]!.item.id);
  });
});

describe("marketplace dedupe runs on source + listing id", () => {
  test("the same listing on two country sites is one item", async () => {
    const esUrl = ebayUrl("es", "999999999991");
    const comUrl = ebayUrl("com", "999999999991");

    mockExtraction(LEER_JSON);
    const first = await createMusicItemsFromUrl(esUrl, {
      pageTitle: "Thomas Leer – Contradictions LP",
    });
    expect(first[0]!.created).toBe(true);

    // ebay.com carries the same listing id — the TLD-bearing URLs differ, the
    // listing key does not.
    mockExtraction(LEER_JSON);
    const second = await createMusicItemsFromUrl(comUrl, {
      pageTitle: "Thomas Leer – Contradictions LP",
    });

    expect(second).toHaveLength(1);
    expect(second[0]!.created).toBe(false);
    expect(second[0]!.item.id).toBe(first[0]!.item.id);
    // The first share's TLD-bearing URL is what stayed stored.
    expect(second[0]!.item.primary_url).toBe(esUrl);
  });

  test("the listing key is stamped on the marketplace link only", async () => {
    mockExtraction(
      '{"releases":[{"artist":"Marta Vega","title":"Bajamar","itemType":"album","isPrimary":true}]}',
    );
    const url = ebayUrl("fr", "777777777777");
    const results = await createMusicItemsFromUrl(url, {
      pageTitle: "Marta Vega – Bajamar LP",
    });

    const rows = await db
      .select({ listingKey: musicLinks.listingKey, url: musicLinks.url })
      .from(musicLinks)
      .where(eq(musicLinks.musicItemId, results[0]!.item.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.url).toBe(url);
    expect(rows[0]!.listingKey).toBe("ebay:777777777777");
  });

  test("a Wallapop slug with no id dedupes on the exact URL", async () => {
    const noIdUrl = "https://es.wallapop.com/item/vinilo-camaron-sin-id";
    mockExtraction(CAMARON_JSON);
    const first = await createMusicItemsFromUrl(noIdUrl);
    expect(first[0]!.created).toBe(true);

    const rows = await db
      .select({ listingKey: musicLinks.listingKey })
      .from(musicLinks)
      .where(eq(musicLinks.musicItemId, first[0]!.item.id));
    expect(rows[0]!.listingKey).toBeNull();

    // Same URL again: the exact-URL check catches it.
    mockExtraction(CAMARON_JSON);
    const again = await createMusicItemsFromUrl(noIdUrl);
    expect(again[0]!.created).toBe(false);
    expect(again[0]!.item.id).toBe(first[0]!.item.id);

    // A different slug with the same words is a different listing.
    mockExtraction(CAMARON_JSON);
    const other = await createMusicItemsFromUrl(
      "https://es.wallapop.com/item/vinilo-camaron-otro-anuncio",
    );
    expect(other[0]!.created).toBe(true);
    expect(other[0]!.item.id).not.toBe(first[0]!.item.id);
  });
});

describe("POST /api/music-items sanitises untrusted body fields", () => {
  async function postItem(body: Record<string, unknown>) {
    const app = new Hono();
    app.route("/api/music-items", musicItemRoutes);
    return app.request("http://localhost/api/music-items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("a non-string pageTitle is dropped, not passed through to the creator", async () => {
    // The body is untrusted JSON: `pageTitle: 42` must be dropped at the route,
    // not reach the creator's `.trim()` and blow up as a 500. With it gone, an
    // eBay listing with no slug has no evidence and gets the honest 400.
    const fetchSpy = spyOn(globalThis, "fetch");

    const response = await postItem({
      url: ebayUrl("com", "191919191919"),
      pageTitle: 42,
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("This site blocks server requests — paste the listing title");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a malformed price and currency are dropped, not bound to the insert", async () => {
    // `priceCents: {a: 1}` used to reach the SQLite bind and throw a 500; a
    // non-string currency was stored unchecked. Both are dropped at the route
    // and the listing still files, with no price and the default currency.
    mockExtraction(CAMARON_JSON);

    const response = await postItem({
      url: wallapopUrl("1320305370"),
      pageTitle: "Vinilo Camarón – La leyenda del tiempo (1979)",
      priceCents: { a: 1 },
      currency: 42,
    });

    expect(response.status).toBe(201);
    const item = (await response.json()) as { price_cents: number | null; currency: string };
    expect(item.price_cents).toBeNull();
    expect(item.currency).toBe("USD");
  });

  test("priceCents is integer cents: fractional rounds, negative and string drop", async () => {
    mockExtraction(CAMARON_JSON);
    const title = "Vinilo Camarón – La leyenda del tiempo (1979)";

    const fractional = await postItem({
      url: wallapopUrl("1320305371"),
      pageTitle: title,
      priceCents: 2499.6,
    });
    expect(fractional.status).toBe(201);
    expect(((await fractional.json()) as { price_cents: number }).price_cents).toBe(2500);

    const negative = await postItem({
      url: wallapopUrl("1320305372"),
      pageTitle: title,
      priceCents: -5,
    });
    expect(negative.status).toBe(201);
    expect(((await negative.json()) as { price_cents: number | null }).price_cents).toBeNull();

    const stringly = await postItem({
      url: wallapopUrl("1320305373"),
      pageTitle: title,
      priceCents: "2499",
    });
    expect(stringly.status).toBe(201);
    expect(((await stringly.json()) as { price_cents: number | null }).price_cents).toBeNull();
  });

  test("a valid price and currency pass through, the currency trimmed", async () => {
    mockExtraction(CAMARON_JSON);

    const response = await postItem({
      url: wallapopUrl("1320305374"),
      pageTitle: "Vinilo Camarón – La leyenda del tiempo (1979)",
      priceCents: 2499,
      currency: " EUR ",
    });

    expect(response.status).toBe(201);
    const item = (await response.json()) as { price_cents: number | null; currency: string };
    expect(item.price_cents).toBe(2499);
    expect(item.currency).toBe("EUR");
  });
});
