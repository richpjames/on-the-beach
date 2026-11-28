/**
 * The eBay enricher: a marketplace's official API, where one exists.
 *
 * eBay blocks server fetches of its listing pages like every marketplace, but
 * unlike most it publishes a Browse API. Where `EBAY_CLIENT_ID` and
 * `EBAY_CLIENT_SECRET` are configured, this adapter reads the listing through
 * `get_item_by_legacy_id` — the item id from the URL — and answers with the
 * canonical title, image, price and the seller's item aspects (music listings
 * often carry Artist / Record Label / Format). The share client's captured
 * title remains the fallback whenever the API is unconfigured or fails: the
 * creator falls back to its marketplace branch on a null scrape.
 *
 * Authentication is an OAuth client-credentials *application* token — no user
 * login, catalogue access only — cached for its ~2 h lifetime. The marketplace
 * header comes from the URL's TLD: ebay.es prices in EUR on EBAY_ES, ebay.co.uk
 * in GBP on EBAY_GB, and so on.
 */
import type { ScrapedMetadata } from "../web/html-metadata";
import { parseUrl } from "../registry";

const EBAY_API_BASE = "https://api.ebay.com";
const OAUTH_SCOPE = "https://api.ebay.com/oauth/api_scope";

/** The URL's TLD as the Browse API names its marketplaces. */
const MARKETPLACE_BY_TLD: Record<string, string> = {
  com: "EBAY_US",
  es: "EBAY_ES",
  "co.uk": "EBAY_GB",
  de: "EBAY_DE",
  fr: "EBAY_FR",
  it: "EBAY_IT",
  "com.au": "EBAY_AU",
  ca: "EBAY_CA",
  at: "EBAY_AT",
  ch: "EBAY_CH",
  ie: "EBAY_IE",
  nl: "EBAY_NL",
  pl: "EBAY_PL",
  be: "EBAY_BE",
  "com.hk": "EBAY_HK",
  "com.my": "EBAY_MY",
  "com.sg": "EBAY_SG",
  ph: "EBAY_PH",
  in: "EBAY_IN",
};

interface CachedToken {
  token: string;
  /** Unix milliseconds at which the cached token should be considered stale. */
  expiresAt: number;
}

let cache: CachedToken | null = null;

/** Refresh a minute before expiry so a request never rides a stale token. */
const REFRESH_MARGIN_MS = 60_000;

function readEbayCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.EBAY_CLIENT_ID?.trim();
  const clientSecret = process.env.EBAY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * A valid application token, minting and caching a new one when none is cached
 * or the cached one is near expiry. Null when eBay is unconfigured or the
 * token endpoint refuses — the caller settles that as "no enrichment".
 */
async function getApplicationToken(timeoutMs: number): Promise<string | null> {
  const credentials = readEbayCredentials();
  if (!credentials) return null;

  if (cache && cache.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return cache.token;
  }

  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString(
    "base64",
  );
  const response = await fetch(`${EBAY_API_BASE}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(OAUTH_SCOPE)}`,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return null;

  const payload = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof payload.access_token !== "string" || !payload.access_token) return null;

  // eBay application tokens live ~2 h; honour the answer's own lifetime.
  const expiresIn =
    typeof payload.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : 7200;
  cache = { token: payload.access_token, expiresAt: Date.now() + expiresIn * 1000 };
  return cache.token;
}

/** Clear the cached token. Exported for tests. */
export function resetEbayTokenCache(): void {
  cache = null;
}

interface BrowseItem {
  title?: unknown;
  image?: { imageUrl?: unknown };
  price?: { value?: unknown; currency?: unknown };
  itemAspects?: Record<string, unknown>;
}

/** One value of a seller-written item aspect ("Artist", "Record Label", …). */
function aspect(item: BrowseItem, name: string): string | undefined {
  const values = item.itemAspects?.[name];
  if (!Array.isArray(values)) return undefined;
  const first = values[0];
  return typeof first === "string" && first.trim() ? first.trim() : undefined;
}

/**
 * Read a listing through the Browse API. Null whenever enrichment isn't
 * available — unconfigured, a URL with no listing id, a failed or refused
 * request — so the creator's client-title path takes over.
 */
export async function scrapeEbay(url: string, timeoutMs: number): Promise<ScrapedMetadata | null> {
  if (!readEbayCredentials()) return null;

  const parsed = parseUrl(url);
  if (parsed.source !== "ebay" || !parsed.listingId) return null;

  try {
    const token = await getApplicationToken(timeoutMs);
    if (!token) return null;

    const tld = new URL(parsed.normalizedUrl).hostname.replace(/^www\./, "").replace(/^ebay\./, "");
    const response = await fetch(
      `${EBAY_API_BASE}/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${parsed.listingId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_BY_TLD[tld] ?? "EBAY_US",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) return null;

    const item = (await response.json()) as BrowseItem;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!title) return null;

    const metadata: ScrapedMetadata = { potentialTitle: title };
    const artist = aspect(item, "Artist");
    if (artist) metadata.potentialArtist = artist;
    const label = aspect(item, "Record Label");
    if (label) metadata.label = label;
    if (typeof item.image?.imageUrl === "string" && item.image.imageUrl) {
      metadata.imageUrl = item.image.imageUrl;
    }
    const priceValue = Number(item.price?.value);
    if (item.price && Number.isFinite(priceValue) && priceValue >= 0) {
      metadata.priceCents = Math.round(priceValue * 100);
      if (typeof item.price.currency === "string" && item.price.currency) {
        metadata.currency = item.price.currency;
      }
    }
    return metadata;
  } catch (err) {
    console.error("[ebay] Browse API lookup failed:", err);
    return null;
  }
}
