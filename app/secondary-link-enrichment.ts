import { and, eq, isNull } from "drizzle-orm";
import { db } from "../adapters/db/index";
import { artists, musicItems, musicLinks, sources } from "../adapters/db/schema";
import { parseUrl } from "../adapters/registry";
import type { ServiceSearchResult } from "../ports/service-search";
import { searchAppleMusic } from "../adapters/apple-music/index";
import { searchSpotify } from "../adapters/spotify/index";
import { searchYouTube } from "../adapters/youtube/index";
import {
  fetchReleaseGroupIdForRelease,
  fetchReleaseGroupUrlRelations,
  type MbUrlRelation,
} from "../adapters/musicbrainz/index";
import { scrapeBandcamp } from "../adapters/bandcamp/index";
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
// out-of-print records — two fallbacks run in order. First the item's
// MusicBrainz release group is checked for a Bandcamp page among its url
// relations: editors attach those links to the release itself, so no fuzzy
// matching is involved, and the page supplies the release's own cover art
// and record label. Then a YouTube search, which only yields a link when the
// match is unambiguous (see server/youtube-search.ts).
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

/** The service consulted between the active one and the YouTube fallback. */
export const BANDCAMP_FALLBACK_SERVICE = {
  sourceName: "bandcamp",
  displayName: "Bandcamp",
} as const;

export interface ItemInfoForLookup {
  title: string;
  artistName: string | null;
  primarySource: string | null;
  primaryUrl: string | null;
  /** The item's current cover art, if any — a lookup only fills a gap, never overwrites. */
  artworkUrl: string | null;
  /** The item's current record label, if any — filled the same gap-only way. */
  label: string | null;
  /** Set once a lookup has been attempted (hit or miss); used to avoid re-querying. */
  lookupAttemptedAt: Date | null;
  /**
   * The item's MusicBrainz ids, when a suggestion or the resolver captured
   * them — the Bandcamp fallback's way in to the release group's url relations.
   */
  musicbrainzReleaseId: string | null;
  musicbrainzReleaseGroupId: string | null;
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
/** Resolves the release's Bandcamp page via its MusicBrainz release group. */
export type FindBandcampLinkFn = (item: ItemInfoForLookup) => Promise<ServiceSearchResult | null>;
export type SaveLinkFn = (itemId: number, url: string, sourceName: string) => Promise<void>;
export type SaveArtworkFn = (itemId: number, artworkUrl: string) => Promise<void>;
export type SaveLabelFn = (itemId: number, label: string) => Promise<void>;
export type StampLookupFn = (itemId: number) => Promise<void>;

export async function fetchItemForLookup(id: number): Promise<ItemInfoForLookup | null> {
  const rows = await db
    .select({
      title: musicItems.title,
      artistName: artists.name,
      primarySource: sources.name,
      primaryUrl: musicLinks.url,
      artworkUrl: musicItems.artworkUrl,
      label: musicItems.label,
      lookupAttemptedAt: musicItems.lookupAttemptedAt,
      musicbrainzReleaseId: musicItems.musicbrainzReleaseId,
      musicbrainzReleaseGroupId: musicItems.musicbrainzReleaseGroupId,
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
    label: row.label ?? null,
    lookupAttemptedAt: row.lookupAttemptedAt ?? null,
    musicbrainzReleaseId: row.musicbrainzReleaseId ?? null,
    musicbrainzReleaseGroupId: row.musicbrainzReleaseGroupId ?? null,
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

/**
 * Persist the record label a lookup surfaced, under the same terms as the
 * artwork above: only into an empty `label` column, never over a label the
 * user set or another source supplied.
 */
export async function saveLabel(itemId: number, label: string): Promise<void> {
  await db
    .update(musicItems)
    .set({ label })
    .where(and(eq(musicItems.id, itemId), isNull(musicItems.label)));
}

const defaultSearch: SearchServiceFn = (title, artist, service) =>
  LOOKUP_SERVICE_CONFIG[service].search(title, artist);

export interface SecondaryLookupDeps {
  getService: GetLookupServiceFn;
  fetchItem: FetchItemForLookupFn;
  getExisting: GetExistingLinkFn;
  search: SearchServiceFn;
  searchFallback: SearchFallbackFn;
  findBandcampLink: FindBandcampLinkFn;
  save: SaveLinkFn;
  saveArtwork: SaveArtworkFn;
  saveLabel: SaveLabelFn;
  stamp: StampLookupFn;
}

export const defaultSecondaryLookupDeps: SecondaryLookupDeps = {
  getService: getLookupService,
  fetchItem: fetchItemForLookup,
  getExisting: getExistingLink,
  search: defaultSearch,
  searchFallback: (title, artist) => searchYouTube(title, artist),
  findBandcampLink: defaultFindBandcampLink,
  save: saveLink,
  saveArtwork,
  saveLabel,
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
      /** Present only when `url` came from a fallback rather than the active service. */
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
 * True when the item is already a Bandcamp link — the Bandcamp fallback has
 * nothing to add.
 */
function primaryIsBandcamp(item: ItemInfoForLookup): boolean {
  if (item.primarySource === BANDCAMP_FALLBACK_SERVICE.sourceName) return true;
  if (!item.primaryUrl) return false;
  return parseUrl(item.primaryUrl).source === BANDCAMP_FALLBACK_SERVICE.sourceName;
}

/** True for a Bandcamp URL that names a release (an album or track page). */
function isBandcampReleaseUrl(url: string): boolean {
  try {
    return /^\/(album|track)\//.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * MB relation types that point at a Bandcamp page the release can be heard on,
 * most useful first. Anything else ("discography" and friends) tends to name
 * the artist's homepage rather than this record.
 */
const BANDCAMP_RELATION_TYPE_RANK: Record<string, number> = {
  "free streaming": 0,
  streaming: 1,
  "purchase for download": 2,
};

/**
 * The Bandcamp release page among a release group's url relations, or null.
 * Only album/track URLs qualify — a relation to the artist's Bandcamp homepage
 * is not a link to this record. Ties keep MusicBrainz's own ordering.
 */
export function pickBandcampReleaseUrl(relations: MbUrlRelation[]): string | null {
  const candidates = relations.filter(
    (relation) =>
      parseUrl(relation.url).source === BANDCAMP_FALLBACK_SERVICE.sourceName &&
      isBandcampReleaseUrl(relation.url),
  );
  const rank = (relation: MbUrlRelation) =>
    BANDCAMP_RELATION_TYPE_RANK[relation.type ?? ""] ?? Number.MAX_SAFE_INTEGER;
  const ranked = [...candidates].sort((a, b) => rank(a) - rank(b));
  return ranked[0]?.url ?? null;
}

/**
 * Resolve the release's Bandcamp page through MusicBrainz: the release group's
 * url relations often name it, attached there by MB editors, so unlike the
 * catalogue searches there is no fuzzy matching to get wrong. The page is
 * scraped for its cover art and label — a Bandcamp page *is* the release's
 * own account of itself, so unlike the YouTube fallback this hit may carry
 * both.
 *
 * Failures return null (logged) rather than throwing: this runs inside
 * background enrichment, where the YouTube fallback is still worth a try.
 */
async function defaultFindBandcampLink(
  item: ItemInfoForLookup,
): Promise<ServiceSearchResult | null> {
  if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS) return null;

  const groupId =
    item.musicbrainzReleaseGroupId ??
    (item.musicbrainzReleaseId ? await resolveReleaseGroupId(item.musicbrainzReleaseId) : null);
  if (!groupId) return null;

  let relations: MbUrlRelation[];
  try {
    relations = await fetchReleaseGroupUrlRelations(groupId);
  } catch (err) {
    console.error("[secondary-link] MusicBrainz url-rels lookup failed:", err);
    return null;
  }

  const url = pickBandcampReleaseUrl(relations);
  if (!url) return null;

  const scraped = await scrapeBandcamp(url, 8000).catch(() => null);
  return {
    url,
    artworkUrl: scraped?.imageUrl ?? null,
    label: scraped?.label ?? null,
  };
}

async function resolveReleaseGroupId(releaseId: string): Promise<string | null> {
  try {
    return await fetchReleaseGroupIdForRelease(releaseId);
  } catch (err) {
    console.error("[secondary-link] MusicBrainz release lookup failed:", err);
    return null;
  }
}

/**
 * Bandcamp fallback for a release the active service doesn't carry: resolve
 * the release's Bandcamp page via MusicBrainz and save it, with its cover art
 * when the item has none of its own.
 */
async function lookupBandcampLink(
  itemId: number,
  item: ItemInfoForLookup,
  deps: SecondaryLookupDeps,
): Promise<ServiceSearchResult | null> {
  // Already a Bandcamp link, or already carries one — the release page shows
  // it among the item's own links either way.
  if (primaryIsBandcamp(item)) return null;
  if (await deps.getExisting(itemId, BANDCAMP_FALLBACK_SERVICE.sourceName)) return null;

  const hit = await deps.findBandcampLink(item);
  if (!hit) return null;

  await deps.save(itemId, hit.url, BANDCAMP_FALLBACK_SERVICE.sourceName);
  if (hit.artworkUrl && !item.artworkUrl) {
    await deps.saveArtwork(itemId, hit.artworkUrl);
  }
  // The credits' copyright line names the label the same way the page's image
  // is the cover — a Bandcamp page *is* the release's own account of itself.
  if (hit.label && !item.label) {
    await deps.saveLabel(itemId, hit.label);
  }
  return hit;
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
 * When the active service has nothing, the MusicBrainz url relations are
 * checked for a Bandcamp page for the release, and failing that a YouTube
 * search runs — its (high-confidence only) hit is saved as a YouTube
 * secondary link instead.
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
    const bandcamp = await lookupBandcampLink(itemId, item, deps);
    if (bandcamp) {
      return {
        kind: "result",
        service,
        serviceDisplayName: BANDCAMP_FALLBACK_SERVICE.displayName,
        url: bandcamp.url,
        via: "fallback",
      };
    }
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

  // Backfill cover art and the record label from the same lookup when the item
  // has neither of its own.
  if (result.artworkUrl && !item.artworkUrl) {
    await deps.saveArtwork(itemId, result.artworkUrl);
  }
  if (result.label && !item.label) {
    await deps.saveLabel(itemId, result.label);
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
