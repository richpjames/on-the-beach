# Marketplace support: capture at the client, resolve at the server

## Problem

Sharing a listing from a marketplace — eBay, Wallapop, Vinted, Mercadolibre —
fails today. Two verified examples:

- `https://www.ebay.es/itm/800867457219` (Thomas Leer – *Contradictions*):
  eBay answers the scraper's fetch with **HTTP 403** and a 1.7 KB "Error Page".
- `https://es.wallapop.com/item/vinilo-camaron-la-leyenda-del-tiempo-1979-1320305358`:
  Wallapop's CloudFront answers **403 "Request blocked"**.

Both blocks are IP-level: even the sites' homepages 403 with a full browser
user-agent. This is the norm for marketplaces, not an eBay quirk — they defend
their pages against datacenter traffic, and most have no public item API
(eBay's Browse API is the exception, not the rule).

The failure is also dishonest. `fetchPageHtml` (`adapters/web/fetch-page.ts`)
checks only the content-type, never `response.ok`, so the 403 error page is
read as if it were the listing. It contains no music vocabulary, so
`detectMusicRelatedHtml` rejects it: the user is told *"Link does not appear to
be music-related"* about a page that was never fetched.

A per-site scraper cannot generalise here: the server cannot reliably fetch
marketplace pages at all. But the missing metadata is small — a listing is
**one copy of one release for sale**, and its seller-written title
("Vinilo Camarón – La leyenda del tiempo (1979)") carries artist, album, year
and format. The domain already models what a marketplace is:
`SourceCapabilities.can_buy` without `can_play` ("Discogs sells without
playing"), `PurchaseIntent`, `priceCents`/`currency`.

**The key observation:** the share client is already on the loaded listing
page, in the user's browser, on a residential IP — no wall. iOS hands the
share sheet the page title with the URL (`"Page Title\nhttps://…"`), and both
clients currently *discard it*: the Shortcut ("extracts just the URL …
discarding any page title", `docs/ios-shortcut.md`) and the native extension
(`ShareViewController.swift`, `extractSharedContent`). The one piece of
metadata the server cannot fetch is being thrown away at the source.

## Approach

Capture the listing title at the client; let the server do what it already
does best — extract a release from messy text and resolve it against the
catalogues. The server never fetches a marketplace page.

### 1. Marketplaces as a capability, not N scrapers

Per-site `SourceName`s (`ebay`, `wallapop`, …), matching the existing pattern
(Discogs is a source; its marketplace listings already resolve to releases).
Each gets:

- a `URL_PATTERNS` entry in `adapters/registry.ts` with a normaliser that
  strips tracking params but **keeps the site's TLD** (the marketplace matters
  for currency and for any later API enricher):
  `https://www.ebay.es/itm/800867457219?itmprp=…` → `https://www.ebay.es/itm/800867457219`;
- a `SEED_SOURCES` row with `canPlay: false, canBuy: true, isEditorial: false`;
- a static `sourceIsMarketplace(source)` in the registry, beside
  `sourceNamesReleaseDate` — the same static-capability-query pattern. The
  `sources` table stays the display authority.

Adding a marketplace is then a registry entry + a seed row + a union member —
no new code, per the architecture rule. Phase 1 ships eBay (all TLDs) and
Wallapop; Vinted and Mercadolibre are the same recipe when wanted.

### 2. The share clients keep the title

- **Native extension**: `SharedInput.link` gains the page title where one is
  available — the text branch already sees `"Title\nURL"`, and
  `NSExtensionItem.attributedContentText` often carries the title even when a
  `public.url` attachment is present. The POST payload
  (`ShareViewController.swift`, ~line 721) adds `pageTitle`.
- **Shortcut**: split the share input instead of discarding the title — URL
  from "Get URLs from Input", title from the text before it — and post
  `pageTitle`. `docs/ios-shortcut.md` updated accordingly.

Both keep working exactly as today when no title is present.

### 3. One generic listing path on the server

`POST /api/ingest/link` accepts an optional `pageTitle` (trimmed, length-capped)
alongside `url`, passed through `CreateMusicItemInput`. It is **evidence, not
a correction**: `title` remains the user's override and wins; `pageTitle` is
raw seller text to be parsed.

In `resolveReleaseCandidates` (`app/music-item-creator.ts`), a marketplace
source takes a new branch **before** any fetch:

1. Run the existing `extractReleaseCandidatesFromWebText(url, pageTitle)`
   (`adapters/web/link-extractor.ts`) on the title. A messy listing title is
   precisely its input; it already returns artist/title/year/format candidates
   and handles several languages.
2. Feed the candidates into the unchanged downstream pipeline: selection,
   `ambiguous_link` 409 flow, duplicate check, release resolution
   (MusicBrainz/Discogs), secondary-link enrichment. The marketplace URL stays
   the item's primary link — the place to buy it.
3. **Fallback** when extraction names nothing (no `MISTRAL_API_KEY`, failure,
   or an unparseable title): the listing *is* one item for sale, so the raw
   title becomes a single release-shaped candidate (`itemType: "album"`
   default, evidence "listing title") — not the unknown-page path's "mix"
   fallback. The user corrects it in the form if needed.

The new branch lives in the creator; `scrapeUrl` and the streaming sources are
untouched. A marketplace with a bespoke adapter later (below) takes precedence
through the existing `SOURCE_SCRAPERS` lookup, exactly as Discogs does today.

### 4. The paste path tells the truth

`fetchPageHtml` returns null on any non-2xx response. A blocked page then reads
as *"Couldn't fetch this link's page to read it"* (the creator's existing
null-scrape message) instead of "not music-related".

For a marketplace URL pasted into the web form with no client title, the error
is marketplace-specific: *"This site blocks server requests — paste the
listing title"*. The add form already has title/artist fields, so the recovery
is one paste, not a dead end.

### 5. Optional per-site enrichers (phase 2)

Where an official API exists, an adapter enriches — never required:

- `adapters/ebay/` + a `SOURCE_SCRAPERS` entry: Browse API
  `GET /buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=<id>` with an
  OAuth client-credentials application token (`EBAY_CLIENT_ID` /
  `EBAY_CLIENT_SECRET`, cached ~2 h) and `X-EBAY-C-MARKETPLACE-ID` from the
  URL's TLD. Returns canonical title, image, price, condition and item aspects
  (music listings often carry Artist / Record Label / Format). Price lands in
  `priceCents`/`currency`; the client title remains the fallback when the API
  is unconfigured or fails.
- Discogs marketplace listings already work this way — the precedent.

## Edge decisions

- **No title, marketplace URL, share path**: the slug is the only evidence.
  Wallapop slugs carry words (`vinilo-camaron-la-leyenda-del-tiempo-1979`);
  hyphens-to-spaces, drop the trailing numeric id, and offer it to the
  extraction as supplementary text. eBay's numeric slug carries nothing —
  answer with the honest "paste the listing title" error rather than inventing
  an item.
- **No `MISTRAL_API_KEY`**: the raw-title fallback (3) still creates the item;
  a share is never held up by extraction, same principle as the link preview.
- **Several releases in one listing** (a lot of 5 LPs): extraction may name
  several candidates; the existing `ambiguous_link` picker handles it. The
  fallback stays single-candidate — one listing, one item.
- **Duplicate shares**: normalisation strips tracking params, so the same
  listing shared twice dedupes on the clean URL.
- **Ended listings**: the client captured the title while the page was live;
  the item is still created. Nothing re-fetches the page later.
- **`pageTitle` is untrusted input**: length-capped at the route, fed to the
  extractor as text only — it never becomes a fetch target or a query.

## Out of scope (YAGNI)

- Proxies, headless browsers, scraping-API services — fighting the wall is
  fragile, paid, and against the sites' terms; client capture makes it
  unnecessary.
- Per-site scrapers for marketplaces without an API.
- Price/condition capture in the share clients (needs DOM work per site);
  the eBay enricher provides them where available.
- Defaulting `purchaseIntent` for marketplace shares — a product decision for
  later; the UI already sets it.
- A browser extension; the iOS clients and the web form cover the entry routes
  that exist today.

## Phasing

1. **Foundation** — registry + seed rows (eBay, Wallapop), `pageTitle` on
   `/link`, the creator's marketplace branch, `response.ok` fix, honest paste
   errors. Unit tests: classification/normalisation, the branch extracts from
   the title **without fetching**, fallbacks (no key, no title, slug-only),
   non-2xx reads as null. Layer boundaries stay green.
2. **Clients** — native extension and Shortcut keep and post the title; docs
   updated.
3. **Enrichers** — `adapters/ebay/` with the Browse API when keys are set.
