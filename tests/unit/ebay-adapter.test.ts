import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { scrapeEbay, resetEbayTokenCache } from "../../adapters/ebay/index";

// The enricher reads its credentials at call time, so the environment is set
// per test and restored after — nothing leaks into whichever file runs next
// (`bun test` runs every file in one process).
const ENV_BEFORE = {
  EBAY_CLIENT_ID: process.env.EBAY_CLIENT_ID,
  EBAY_CLIENT_SECRET: process.env.EBAY_CLIENT_SECRET,
};

function configure() {
  process.env.EBAY_CLIENT_ID = "test-client-id";
  process.env.EBAY_CLIENT_SECRET = "test-client-secret";
}

beforeEach(() => {
  resetEbayTokenCache();
});

afterEach(() => {
  resetEbayTokenCache();
  mock.restore();
  for (const [key, value] of Object.entries(ENV_BEFORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const ITEM_URL_PREFIX = "https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id";

function tokenResponse(expiresIn = 7200): Response {
  return new Response(JSON.stringify({ access_token: "test-app-token", expires_in: expiresIn }), {
    headers: { "content-type": "application/json" },
  });
}

function itemResponse(item: Record<string, unknown>): Response {
  return new Response(JSON.stringify(item), { headers: { "content-type": "application/json" } });
}

const SAMPLE_ITEM = {
  title: "Thomas Leer – Contradictions LP (1982)",
  image: { imageUrl: "https://i.ebayimg.com/images/g/abc/s-l1600.jpg" },
  price: { value: "24.99", currency: "EUR" },
  itemAspects: {
    Artist: ["Thomas Leer"],
    "Record Label": ["Cherry Red"],
    Format: ["Vinyl"],
  },
};

/** Serve the OAuth token, then the Browse item, recording every call. */
function mockEbayApi(item: Record<string, unknown> = SAMPLE_ITEM, expiresIn = 7200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push({ url, init });
      if (url.startsWith(TOKEN_URL)) return tokenResponse(expiresIn);
      if (url.startsWith(ITEM_URL_PREFIX)) return itemResponse(item);
      throw new Error(`unexpected fetch: ${url}`);
    },
  );
  return { fetchSpy, calls };
}

describe("scrapeEbay — unconfigured or unusable", () => {
  test("no credentials: null without a single fetch", async () => {
    delete process.env.EBAY_CLIENT_ID;
    delete process.env.EBAY_CLIENT_SECRET;
    const fetchSpy = spyOn(globalThis, "fetch");

    expect(await scrapeEbay("https://www.ebay.es/itm/800867457219", 1_000)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a non-eBay URL is none of this adapter's business", async () => {
    configure();
    const fetchSpy = spyOn(globalThis, "fetch");

    expect(await scrapeEbay("https://es.wallapop.com/item/some-record-42", 1_000)).toBeNull();
    expect(await scrapeEbay("https://www.ebay.com/sch/i.html?_nkw=vinyl", 1_000)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a refused token endpoint settles as no enrichment", async () => {
    configure();
    spyOn(globalThis, "fetch").mockResolvedValue(new Response("denied", { status: 401 }));

    expect(await scrapeEbay("https://www.ebay.es/itm/800867457219", 1_000)).toBeNull();
  });

  test("a refused item lookup settles as no enrichment", async () => {
    configure();
    spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(TOKEN_URL)) return tokenResponse();
      return new Response("not found", { status: 404 });
    });

    expect(await scrapeEbay("https://www.ebay.es/itm/800867457219", 1_000)).toBeNull();
  });

  test("an item with no title names nothing", async () => {
    configure();
    mockEbayApi({ price: { value: "10.00", currency: "EUR" } });

    expect(await scrapeEbay("https://www.ebay.es/itm/800867457219", 1_000)).toBeNull();
  });

  test("a network failure settles as no enrichment", async () => {
    configure();
    spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    expect(await scrapeEbay("https://www.ebay.es/itm/800867457219", 1_000)).toBeNull();
  });
});

describe("scrapeEbay — reading a listing", () => {
  test("answers with the canonical title, aspects, image and price", async () => {
    configure();
    const { calls } = mockEbayApi();

    const metadata = await scrapeEbay("https://www.ebay.es/itm/800867457219", 1_000);

    expect(metadata).toEqual({
      potentialTitle: "Thomas Leer – Contradictions LP (1982)",
      potentialArtist: "Thomas Leer",
      label: "Cherry Red",
      imageUrl: "https://i.ebayimg.com/images/g/abc/s-l1600.jpg",
      priceCents: 2499,
      currency: "EUR",
    });

    // The item lookup carries the application token and the listing id.
    const itemCall = calls.find((call) => call.url.startsWith(ITEM_URL_PREFIX));
    expect(itemCall?.url).toBe(`${ITEM_URL_PREFIX}?legacy_item_id=800867457219`);
    const headers = itemCall?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-app-token");
  });

  test("the token request is client-credentials with the API scope", async () => {
    configure();
    const { calls } = mockEbayApi();

    await scrapeEbay("https://www.ebay.es/itm/800867457219", 1_000);

    const tokenCall = calls.find((call) => call.url.startsWith(TOKEN_URL));
    expect(tokenCall?.init?.method).toBe("POST");
    const headers = tokenCall?.init?.headers as Record<string, string>;
    const expectedBasic = Buffer.from("test-client-id:test-client-secret").toString("base64");
    expect(headers.Authorization).toBe(`Basic ${expectedBasic}`);
    expect(String(tokenCall?.init?.body)).toContain("grant_type=client_credentials");
    expect(String(tokenCall?.init?.body)).toContain(
      `scope=${encodeURIComponent("https://api.ebay.com/oauth/api_scope")}`,
    );
  });

  test.each([
    ["https://www.ebay.es/itm/1", "EBAY_ES"],
    ["https://www.ebay.co.uk/itm/1", "EBAY_GB"],
    ["https://www.ebay.com/itm/1", "EBAY_US"],
    ["https://www.ebay.de/itm/1", "EBAY_DE"],
    ["https://www.ebay.com.au/itm/1", "EBAY_AU"],
  ])("the marketplace header follows the URL's TLD: %s", async (url, marketplace) => {
    configure();
    const { calls } = mockEbayApi();

    await scrapeEbay(url, 1_000);

    const itemCall = calls.find((call) => call.url.startsWith(ITEM_URL_PREFIX));
    const headers = itemCall?.init?.headers as Record<string, string>;
    expect(headers["X-EBAY-C-MARKETPLACE-ID"]).toBe(marketplace);
  });

  test("an unmapped TLD falls back to EBAY_US rather than failing", async () => {
    configure();
    const { calls } = mockEbayApi();

    // ebay.pt parses as a listing but has no marketplace mapping.
    await scrapeEbay("https://www.ebay.pt/itm/1", 1_000);

    const itemCall = calls.find((call) => call.url.startsWith(ITEM_URL_PREFIX));
    const headers = itemCall?.init?.headers as Record<string, string>;
    expect(headers["X-EBAY-C-MARKETPLACE-ID"]).toBe("EBAY_US");
  });

  test("a missing price leaves the metadata unpriced", async () => {
    configure();
    mockEbayApi({ title: "Some LP" });

    const metadata = await scrapeEbay("https://www.ebay.es/itm/1", 1_000);

    expect(metadata).toEqual({ potentialTitle: "Some LP" });
  });
});

describe("scrapeEbay — token caching", () => {
  test("two lookups share one minted token", async () => {
    configure();
    const { calls } = mockEbayApi();

    await scrapeEbay("https://www.ebay.es/itm/1", 1_000);
    await scrapeEbay("https://www.ebay.com/itm/2", 1_000);

    expect(calls.filter((call) => call.url.startsWith(TOKEN_URL))).toHaveLength(1);
    expect(calls.filter((call) => call.url.startsWith(ITEM_URL_PREFIX))).toHaveLength(2);
  });

  test("a token inside the refresh margin is minted anew", async () => {
    configure();
    // 30 s of life sits inside the 60 s refresh margin — the next call must
    // not ride it.
    const { calls } = mockEbayApi(SAMPLE_ITEM, 30);

    await scrapeEbay("https://www.ebay.es/itm/1", 1_000);
    await scrapeEbay("https://www.ebay.es/itm/2", 1_000);

    expect(calls.filter((call) => call.url.startsWith(TOKEN_URL))).toHaveLength(2);
  });
});
