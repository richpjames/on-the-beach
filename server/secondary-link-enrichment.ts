import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db/index";
import { artists, musicItems, musicLinks, sources } from "./db/schema";
import { parseUrl } from "./utils";
import type { ServiceSearchResult } from "../ports/service-search";
import { searchAppleMusic } from "./apple-music";
import { searchSpotify } from "./scraper";
import { searchYouTube } from "./youtube-search";
import { getLookupService, type LookupService } from "./settings";

// ---------------------------------------------------------------------------
// Shared secondary-link lookup
//
// A music item that isn't itself a link on the active streaming service can be
// enriched with a secondary link looked up from that service's catalogue. The
// active service (Apple Music or Spotify) is configurable via settings. This
// logic runs in three places that share the orchestration below so the skip
// rules and the lookup marker stay consistent:
//   1. Eagerly, fire-and-forget, when an item is created (music-item-creator).
//   2. Lazily, on demand, when a release page is viewed (routes/release).
//   3. In bulk, via the one-off backfill script for pre-existing items.
//
// When the active service has no match — common for small-label and
// out-of-print records — a second lookup runs against YouTube, which only
// yields a link when the match is unambiguous (see server/youtube-search.ts).
// ---------------------------------------------------------------------------

export interface ServiceConfig {
  /** sources.name value, e.g. "apple_music". */
  sourceName: string;
  displayName: string;
  /** Host fragment identifying a primary URL already on this service. */
  urlFragment: string;
  search: (title: string, artist: string | null) => Promise<ServiceSearchResult | null>;
}

export const LOOKUP_SERVICE_CONFIG: Record<LookupService, ServiceConfig> = {
  apple_music: {
    sourceName: "apple_music",
    displayName: "Apple Music",
    urlFragment: "music.apple.com",
    search: searchAppleMusic,
  },
  spotify: {
    sourceName: "spotify",
    displayName: "Spotify",
    urlFragment: "open.spotify.com",
    search: searchSpotify,
  },
};

/** The service used when the active one has nothing. */
export const FALLBACK_SERVICE = {
  sourceName: "youtube",
  displayName: "YouTube",
} as const;

export interface ItemInfoForLookup {
  title: string;
  artistName: string | null;
  primarySource: string | null;
  primaryUrl: string | null;
  /** The item's current cover art, if any — a lookup only fills a gap, never overwrites. */
  artworkUrl: string | null;
  /** Set once a lookup has been attempted (hit or miss); used to avoid re-querying. */
  lookupAttemptedAt: Date | null;
}

export type GetLookupServiceFn = () => Promise<LookupService>;
export type FetchItemForLookupFn = (id: number) => Promise<ItemInfoForLookup | null>;
export type GetExistingLinkFn = (itemId: number, sourceName: string) => Promise<string | null>;
export type SearchServiceFn = (
  title: string,
  artist: string | null,
  service: LookupService,
) => Promise<ServiceSearchResult | null>;
/** Second-chance search, only consulted when the active service has no match. */
export type SearchFallbackFn = (
  title: string,
  artist: string | null,
) => Promise<ServiceSearchResult | null>;
export type SaveLinkFn = (itemId: number, url: string, sourceName: string) => Promise<void>;
export type SaveArtworkFn = (itemId: number, artworkUrl: string) => Promise<void>;
export type StampLookupFn = (itemId: number) => Promise<void>;

export async function fetchItemForLookup(id: number): Promise<ItemInfoForLookup | null> {
  const rows = await db
    .select({
      title: musicItems.title,
      artistName: artists.name,
      primarySource: sources.name,
      primaryUrl: musicLinks.url,
      artworkUrl: musicItems.artworkUrl,
      lookupAttemptedAt: musicItems.lookupAttemptedAt,
    })
    .from(musicItems)
    .leftJoin(artists, eq(musicItems.artistId, artists.id))
    .leftJoin(
      musicLinks,
      and(eq(musicLinks.musicItemId, musicItems.id), eq(musicLinks.isPrimary, true)),
    )
    .leftJoin(sources, eq(musicLinks.sourceId, sources.id))
    .where(eq(musicItems.id, id))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    title: row.title,
    artistName: row.artistName ?? null,
    primarySource: row.primarySource ?? null,
    primaryUrl: row.primaryUrl ?? null,
    artworkUrl: row.artworkUrl ?? null,
    lookupAttemptedAt: row.lookupAttemptedAt ?? null,
  };
}

export async function getExistingLink(itemId: number, sourceName: string): Promise<string | null> {
  const rows = await db
    .select({ url: musicLinks.url })
    .from(musicLinks)
    .innerJoin(sources, eq(musicLinks.sourceId, sources.id))
    .where(and(eq(musicLinks.musicItemId, itemId), eq(sources.name, sourceName)))
    .limit(1);

  return rows[0]?.url ?? null;
}

/**
 * `sourceName` is nullable because a link can arrive from somewhere we don't
 * model — a MusicBrainz external link may point at an artist's own site. The
 * row is still worth keeping; it just carries no source.
 */
export async function saveLink(
  itemId: number,
  url: string,
  sourceName: string | null,
): Promise<void> {
  const sourceRows = sourceName
    ? await db.select({ id: sources.id }).from(sources).where(eq(sources.name, sourceName)).limit(1)
    : [];

  const sourceId = sourceRows[0]?.id ?? null;

  try {
    await db.insert(musicLinks).values({
      musicItemId: itemId,
      sourceId,
      url,
      isPrimary: false,
      metadata: null,
    });
  } catch {
    // Likely a unique constraint violation — link already exists
  }
}

export async function stampLookup(itemId: number): Promise<void> {
  await db
    .update(musicItems)
    .set({ lookupAttemptedAt: new Date() })
    .where(eq(musicItems.id, itemId));
}

/**
 * Persist cover art discovered during a lookup, but only when the item still has
 * none — the `IS NULL` guard means an artwork the user set (or an earlier lookup
 * found) is never clobbered, even under a concurrent enrichment.
 */
export async function saveArtwork(itemId: number, artworkUrl: string): Promise<void> {
  await db
    .update(musicItems)
    .set({ artworkUrl })
    .where(and(eq(musicItems.id, itemId), isNull(musicItems.artworkUrl)));
}

const defaultSearch: SearchServiceFn = (title, artist, service) =>
  LOOKUP_SERVICE_CONFIG[service].search(title, artist);

export interface SecondaryLookupDeps {
  getService: GetLookupServiceFn;
  fetchItem: FetchItemForLookupFn;
  getExisting: GetExistingLinkFn;
  search: SearchServiceFn;
  searchFallback: SearchFallbackFn;
  save: SaveLinkFn;
  saveArtwork: SaveArtworkFn;
  stamp: StampLookupFn;
}

export const defaultSecondaryLookupDeps: SecondaryLookupDeps = {
  getService: getLookupService,
  fetchItem: fetchItemForLookup,
  getExisting: getExistingLink,
  search: defaultSearch,
  searchFallback: (title, artist) => searchYouTube(title, artist),
  save: saveLink,
  saveArtwork,
  stamp: stampLookup,
};

export type SecondaryLookupOutcome =
  | { kind: "not_found" }
  | { kind: "skipped"; reason: "primary_is_active_service" | "already_attempted" }
  | {
      kind: "result";
      /** The active service the lookup ran against. */
      service: LookupService;
      /** Display name of the service `url` points at — the fallback's when it supplied the hit. */
      serviceDisplayName: string;
      url: string | null;
      /** Present only when `url` came from the YouTube fallback rather than the active service. */
      via?: "fallback";
    };

/** True when the item's primary link is already on the active service. */
function primaryIsActiveService(item: ItemInfoForLookup, cfg: ServiceConfig): boolean {
  if (item.primarySource === cfg.sourceName) return true;
  if (!item.primaryUrl) return false;
  return (
    parseUrl(item.primaryUrl).source === cfg.sourceName || item.primaryUrl.includes(cfg.urlFragment)
  );
}

/** True when the item is already a YouTube link — the fallback has nothing to add. */
function primaryIsFallbackService(item: ItemInfoForLookup): boolean {
  if (item.primarySource === FALLBACK_SERVICE.sourceName) return true;
  if (!item.primaryUrl) return false;
  return parseUrl(item.primaryUrl).source === FALLBACK_SERVICE.sourceName;
}

/**
 * Second chance for a release the active service doesn't carry: search YouTube
 * and save the result, but only when that search is confident it found the
 * right recording — it returns null rather than guessing. Any artwork the
 * fallback reports is ignored; a video thumbnail is not a cover.
 */
async function lookupFallbackLink(
  itemId: number,
  item: ItemInfoForLookup,
  deps: SecondaryLookupDeps,
): Promise<string | null> {
  // Already a YouTube link, or already carries one — the release page shows it
  // among the item's own links either way.
  if (primaryIsFallbackService(item)) return null;
  if (await deps.getExisting(itemId, FALLBACK_SERVICE.sourceName)) return null;

  const hit = await deps.searchFallback(item.title, item.artistName);
  if (!hit) return null;

  await deps.save(itemId, hit.url, FALLBACK_SERVICE.sourceName);
  return hit.url;
}

/**
 * Core lookup orchestration shared by the route, the eager creation hook, and
 * the backfill script. Resolves a secondary link on the active streaming
 * service for an item that isn't already on that service, persisting a hit and
 * stamping the lookup marker on both a hit and a miss.
 *
 * When the active service has nothing, a YouTube search runs as a fallback and
 * its (high-confidence only) hit is saved as a YouTube secondary link instead.
 */
export async function lookupSecondaryLinkForItem(
  itemId: number,
  deps: SecondaryLookupDeps = defaultSecondaryLookupDeps,
): Promise<SecondaryLookupOutcome> {
  const service = await deps.getService();
  const cfg = LOOKUP_SERVICE_CONFIG[service];

  const item = await deps.fetchItem(itemId);
  if (!item) return { kind: "not_found" };

  if (primaryIsActiveService(item, cfg)) {
    return { kind: "skipped", reason: "primary_is_active_service" };
  }

  const existing = await deps.getExisting(itemId, cfg.sourceName);
  if (existing) {
    return { kind: "result", service, serviceDisplayName: cfg.displayName, url: existing };
  }

  // A previous attempt already came up empty — don't re-query on every view.
  if (item.lookupAttemptedAt) {
    return { kind: "skipped", reason: "already_attempted" };
  }

  const result = await deps.search(item.title, item.artistName, service);
  await deps.stamp(itemId);

  if (!result) {
    const fallbackUrl = await lookupFallbackLink(itemId, item, deps);
    if (fallbackUrl) {
      return {
        kind: "result",
        service,
        serviceDisplayName: FALLBACK_SERVICE.displayName,
        url: fallbackUrl,
        via: "fallback",
      };
    }
    return { kind: "result", service, serviceDisplayName: cfg.displayName, url: null };
  }

  await deps.save(itemId, result.url, cfg.sourceName);

  // Backfill cover art from the same lookup when the item has none of its own.
  if (result.artworkUrl && !item.artworkUrl) {
    await deps.saveArtwork(itemId, result.artworkUrl);
  }

  return { kind: "result", service, serviceDisplayName: cfg.displayName, url: result.url };
}

/** Convenience wrapper returning just the resolved URL (or null). */
export async function enrichSecondaryLink(
  itemId: number,
  deps?: SecondaryLookupDeps,
): Promise<string | null> {
  const outcome = await lookupSecondaryLinkForItem(itemId, deps);
  return outcome.kind === "result" ? outcome.url : null;
}

/**
 * Fire-and-forget eager enrichment for a freshly created item. Never throws and
 * never blocks the caller — the catalogue search can take several seconds, so it
 * must not be awaited on the create/ingest request path. No-ops under
 * `OTB_DISABLE_EXTERNAL_LOOKUPS` (tests); all other skip rules (item already on
 * the active service, already attempted) are enforced by the core lookup.
 */
export function enrichSecondaryLinkInBackground(itemId: number): void {
  if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS) return;

  void enrichSecondaryLink(itemId).catch((err) => {
    console.error("[secondary-link] eager enrichment failed for item", itemId, err);
  });
}
